import { Hono } from "hono";
import { editorFolderAvailability, editorFolderProjection } from "../lib/editor-folders";
import { readEditorFolderAttention } from "../lib/attention";
import { terminalRoute } from "../lib/terminal-route";
import type { Context } from "hono";
import { boardContractEnabled, boardSchemaVariant, buildAutomaticDeadlineBundle, buildAutomaticDeadlineMoveBundle, buildDeadlineSuppressionBundle, buildProjectActivityStatements, buildSubtaskReminderMaterialization, buildSubtaskReminderSuppression, createDb, selectEffectiveDefaultEditorIds, dashboardProjectOrder, orderDashboardStreetTies, projectColumnsForVariant, schema, type BoardSchemaVariant } from "@quincy/db";
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { automaticDeadlineFor, capDashboardSearchText, compareBoardCards, COLLECTION_KINDS, DASHBOARD_PROJECTS_FILTER_QUERY_NAMES, dashboardFilterArchivedMode, dashboardFilterHasArchivedLeaf, dashboardFilterHasPriorityLeaf, dashboardFilterTreeOf, dashboardProjectsFilterQuerySchema, DOWNLOAD_SELECTION_MAX_ASSETS, DOWNLOAD_SELECTION_MAX_BYTES, moveProjectStageRequestSchema, PHOTOGRAPHER_VISIBLE_STAGES, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES, PROJECT_DEADLINE_ZONE, planDeadlineOccurrences, projectActivityDeepLink, roleHasCapability, stripUnsafeText, type CollectionKind, type DashboardFilter, type MoveProjectStageRequest, type ProjectActivityIntent, type ProjectMemberRole, type ProjectMembershipDto, type Role, type StageKey, type StageTransportKey } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, hasProjectAccessForUser, requireCapability } from "../middleware/capability";
import { audit, auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { addProjectMemberWithAssignmentIntent, buildInitialProjectMemberStatementTuples, ProjectMemberIneligibleError, ProjectMembershipArchivedError, removeProjectMemberCycle, type InitialProjectMemberSlot } from "../lib/project-members";
import { createZipStream } from "../lib/zip-stream";
import { jsonInput } from "./helpers";
import { projectStageForRole } from "./stages";
import { abortMultipart } from "../lib/r2s3";
import { isUserVisibleAsset } from "../lib/asset-visibility";
import { ProjectDeadlineError, readProjectDeadlineSchedule, resolveDeadlineSet, type ResolvedDeadlineSet } from "../lib/project-deadline";
import { listExternalProjects, readExternalProjectDetail } from "../lib/external-project-query";
import { activeEditorRefsByProject } from "../lib/project-editors";
import { boardContractDisabled, boardSchemaMaintenance } from "../lib/board-schema-maintenance";
import { moveProjectStage } from "../lib/project-stage";
import { boardCardOrderOptionsFor } from "../lib/project-board-order";
import { classifyProjectArchiveLoser, type ProjectArchiveSource } from "../lib/project-archive";
import { chunked, coverMaps } from "../lib/project-covers";
import { matchingProjectIds, normalizeProjectSearch } from "../lib/project-search";
import { projectsMatchingDashboardFilter } from "../lib/project-relation-filter";
import { publishOutboxDetached } from "../lib/server-timing";
import { queueProjectShootDateFollowUps } from "../lib/project-shoot-date";

const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullable().optional();
const baseProjectFields = z.object({ street: z.string().min(1), suburb: nullable(z.string()), postcode: nullable(z.string()), agencyName: nullable(z.string()), agentName: nullable(z.string()), agentEmail: nullable(z.string().email()), agentPhone: nullable(z.string()), agencyId: nullable(z.string().uuid()), agentId: nullable(z.string().uuid()), shootDate: nullable(z.string()), timeWindow: nullable(z.string()), orderNo: nullable(z.string()), orderId: nullable(z.string()), invoiceAmount: nullable(z.number()), paymentStatus: nullable(z.string()), notes: nullable(z.string()), productionNotes: nullable(z.string()), rawFolderLink: nullable(z.string().url()), rawFolderPath: nullable(z.string()), orderedServices: z.array(z.enum(COLLECTION_KINDS)).optional() });
// #488: `deadline` absent or null means "Automatic Deadline from the shoot date, if one is given"; an object is always stored
// manual. The client never names a source (`.strict()`), so an automatic value can never be submitted as a manual one.
const createDeadlineField = z.object({ localCivil: z.string(), disambiguation: z.enum(["earlier", "later"]).optional(), reminderOffsetsMinutes: z.array(z.number()).optional() }).strict();
const createProjectFields = baseProjectFields.extend({
  photographerUserIds: z.array(z.string().uuid()).optional(), editorUserIds: z.array(z.string().uuid()).optional(),
  priority: z.number().int().min(1).max(5).nullable().optional(), deadline: createDeadlineField.nullable().optional(),
});
const editFields = baseProjectFields.partial().strict();
const deleteProjectMembershipInput = z.discriminatedUnion("clearSubtaskAssignments", [
  z.object({ membershipCycle: z.string().uuid(), clearSubtaskAssignments: z.literal(false), confirmedAssignmentCount: z.literal(0), confirmAccessLoss: z.boolean().optional() }).strict(),
  z.object({ membershipCycle: z.string().uuid(), clearSubtaskAssignments: z.literal(true), confirmedAssignmentCount: z.number().int().nonnegative(), confirmAccessLoss: z.boolean().optional() }).strict(),
]);
const coverInput = z.object({ assetId: z.string().uuid().nullable() });
const priorityInput = z.object({ priority: z.number().int().min(1).max(5).nullable() });
const downloadSelectionInput = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(DOWNLOAD_SELECTION_MAX_ASSETS)
    .superRefine((assetIds, ctx) => {
      if (new Set(assetIds).size !== assetIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Asset IDs must be unique" });
    }),
}).strict();
const idCheck = (v: string) => z.string().uuid().safeParse(v).success;
/** #475: the `between` placement is retired with the position it wrote; a stale tab that still sends it reloads. */
function isRetiredBetweenPlacement(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const placement = (body as { placement?: unknown }).placement;
  return typeof placement === "object" && placement !== null && (placement as { kind?: unknown }).kind === "between";
}
function isExactLegacyStageBody(body: unknown): body is { stageKey: string } {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, "stageKey")
    && typeof (body as { stageKey?: unknown }).stageKey === "string";
}
const DOWNLOAD_SELECTION_TICKET_MS = 5 * 60 * 1000;
const unavailableSelectionError = "One or more selected assets are not available in this project";
const unsupportedSelectionError = "Download Selection supports one RAW or Edited photo selection";

type DropboxSyncResult = {
  raw: { jobId: string } | { skipped: "no_raw_folder" | "not_permitted" | "error"; message?: string };
  edited: { jobId: string } | { skipped: "not_ready" | "not_admin" | "error"; message?: string } | { blocked: { code: string; message: string } };
};

type DownloadSelectionEntry = {
  id: string;
  r2Key: string;
  originalFilename: string;
  bytes: number;
  collectionKind: "raw" | "edited";
};

type ValidatedDownloadSelection = {
  entries: DownloadSelectionEntry[];
  collection: "raw" | "edited";
  totalBytes: number;
  principal: { id: string; role: AppEnv["Variables"]["user"]["role"]; impersonatedBy: string | null };
};

/**
 * Revalidates every condition at POST and GET time. Tickets deliberately contain only ids, so
 * a later role change, deactivation, asset replacement, or unpublished edit cannot replay an
 * authorization decision that was true at ticket creation.
 */
async function validateDownloadSelection(c: Context<AppEnv>, projectId: string, assetIds: string[]): Promise<ValidatedDownloadSelection | Response> {
  const db = createDb(c.env.DB);
  const principal = await db.select({ id: schema.user.id, role: schema.user.role, active: schema.user.active })
    .from(schema.user).where(eq(schema.user.id, c.get("user").id)).get();
  if (!principal?.active) return c.json({ error: "Authentication required" }, 401);
  if (!await hasProjectAccessForUser(c.env, principal, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);

  const rows: Array<{
    id: string; r2Key: string; originalFilename: string; bytes: number; collectionKind: string; publishStatus: string; assetKind: string;
  }> = [];
  // Sequential chunks are intentional: D1 has a 100-bind limit and only six simultaneous
  // connections. Do not make this a Promise.all.
  for (const assetIdChunk of chunked(assetIds, 80)) {
    rows.push(...await db.select({
      id: schema.assets.id,
      r2Key: schema.assets.r2Key,
      originalFilename: schema.assets.originalFilename,
      bytes: schema.assets.bytes,
      collectionKind: schema.collections.kind,
      publishStatus: schema.assets.publishStatus,
      assetKind: schema.assets.kind,
    }).from(schema.assets)
      .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, projectId)))
      .where(and(inArray(schema.assets.id, assetIdChunk), isNull(schema.assets.supersededAt)))
      .all());
  }

  if (rows.length !== assetIds.length || rows.some((row) => !isUserVisibleAsset(row.collectionKind, row.publishStatus))) {
    return c.json({ error: unavailableSelectionError }, 404);
  }
  if (rows.some((row) => row.assetKind !== "photo") || !rows.every((row) => row.collectionKind === "raw" || row.collectionKind === "edited") || new Set(rows.map((row) => row.collectionKind)).size !== 1) {
    return c.json({ error: unsupportedSelectionError }, 400);
  }

  const collection = rows[0]!.collectionKind as "raw" | "edited";
  const capability = collection === "raw" ? "selectForEditing" : "downloadFinal";
  if (!roleHasCapability(principal.role, capability)) return c.json({ error: "Forbidden", capability }, 403);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const entries = assetIds.map((assetId) => byId.get(assetId)!).map((row) => ({
    id: row.id, r2Key: row.r2Key, originalFilename: row.originalFilename, bytes: row.bytes,
    collectionKind: row.collectionKind as "raw" | "edited",
  }));
  let totalBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || totalBytes > Number.MAX_SAFE_INTEGER - entry.bytes) return c.json({ error: unavailableSelectionError }, 404);
    totalBytes += entry.bytes;
  }
  if (totalBytes > DOWNLOAD_SELECTION_MAX_BYTES) return c.json({ error: "Selected assets exceed the 256 MiB download limit" }, 413);
  return { entries, collection, totalBytes, principal: { id: principal.id, role: principal.role, impersonatedBy: c.get("user").impersonatedBy } };
}

async function addCollections(db: ReturnType<typeof createDb>, projectId: string, orderedServices: CollectionKind[] | undefined) {
  const services = new Set<CollectionKind>(["raw", ...(orderedServices ?? [])]);
  for (const kind of services) await db.insert(schema.collections).values({ id: newId(), projectId, kind, status: "empty", receivedCount: 0, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  return services;
}
async function abortActiveDocumentSessions(c: Context<AppEnv>, projectId: string) {
  const db = createDb(c.env.DB); const now = new Date();
  const sessions = await db.select().from(schema.documentUploads).where(and(eq(schema.documentUploads.projectId, projectId), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`)).all();
  for (const session of sessions) {
    await db.update(schema.documentUploads).set({ status: "aborting", updatedAt: now }).where(and(eq(schema.documentUploads.id, session.id), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`));
    let aborted = true;
    try { await Promise.all([
      session.pdfUploadId ? abortMultipart(c.env, session.pdfKey, session.pdfUploadId) : undefined,
      session.previewKey && session.previewUploadId ? abortMultipart(c.env, session.previewKey, session.previewUploadId) : undefined,
    ]); } catch { aborted = false; }
    if (aborted) await db.update(schema.documentUploads).set({ status: "failed", updatedAt: now }).where(and(eq(schema.documentUploads.id, session.id), eq(schema.documentUploads.status, "aborting")));
  }
  return sessions.length;
}
async function details(db: ReturnType<typeof createDb>, d1: D1Database, projectId: string, role: AppEnv["Variables"]["user"]["role"], variant: BoardSchemaVariant, contractEnabled: boolean, viewerSeesRawOnly = false, editorEnv?: AppEnv["Bindings"]) {
  // Do not replace this with select(). The post-0037 Drizzle schema contains board_revision.
  const project = await db.select(projectColumnsForVariant(variant)).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return null;
  const [{ storedByProject, automaticByProject }, collections, members, assignedCounts] = await Promise.all([
    coverMaps(db, [projectId], viewerSeesRawOnly),
    db.select().from(schema.collections).where(eq(schema.collections.projectId, projectId)).all(),
    db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId, roleOnProject: schema.projectMembers.roleOnProject, name: schema.user.name, email: schema.user.email, globalRole: schema.user.role, active: schema.user.active }).from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id)).where(eq(schema.projectMembers.projectId, projectId)).all(),
    db.select({ userId: schema.projectSubtaskAssignees.userId, assignedSubtaskCount: sql<number>`count(*)` }).from(schema.projectSubtaskAssignees).innerJoin(schema.projectSubtasks, eq(schema.projectSubtasks.id, schema.projectSubtaskAssignees.subtaskId)).where(eq(schema.projectSubtasks.projectId, projectId)).groupBy(schema.projectSubtaskAssignees.userId).all(),
  ]);
  const counts = new Map(assignedCounts.map((row) => [row.userId, Number(row.assignedSubtaskCount ?? 0)]));
  const memberDtos: ProjectMembershipDto[] = members.map((member) => ({ ...member, active: Boolean(member.active), assignedSubtaskCount: counts.get(member.userId) ?? 0 }));
  const deadlineSchedule = await readProjectDeadlineSchedule(d1, projectId);
  const projection = editorEnv ? await editorFolderProjection(editorEnv, projectId) : null;
  // Visibility of the Editor Input path rides on reaching this function at all: `external_editor`
  // is short-circuited into `readExternalProjectDetail` before it runs, and that DTO carries no
  // RAW folder fields. A `viewRaw` check here would read like the rule and is not one — every
  // role holds `viewRaw`, `external_editor` included (EXTERNAL_EDITOR_CAPABILITIES).
  const monitoredRawFolder = projection?.monitoredRawFolder ?? null;
  // Checked on the role, not `viewerSeesRawOnly`: the PATCH handlers pass `false` for that flag
  // whatever the caller's role, so it cannot be what keeps a photographer from seeing this.
  const editorFolderAttention = role === "photographer" ? undefined : await readEditorFolderAttention(d1, projectId, role, Date.now());
  return projectStageForRole({
    ...project,
    boardRevision: variant === "tb5a_0037" && "boardRevision" in project ? Number(project.boardRevision) : 0,
    contractEnabled,
    editedUploadAvailable: projection ? projection.availability.outputReady : Boolean(project.rawFolderPath || project.rawFolderLink),
    monitoredRawFolder,
    effectiveCoverAssetId: storedByProject.get(projectId) ?? automaticByProject.get(projectId) ?? null,
    collections,
    members: memberDtos,
    deadlineSchedule,
    ...(editorFolderAttention === undefined ? {} : { editorFolderAttention }),
  }, role);
}

/** Deprecated: the web derives the order itself (#470, #475). Still emitted for stale tabs until #476 removes it from the wire. */
function authorizedInternalBoardOrder(rows: Array<{ project: { id: string; stageKey: string; street: string; priority: number | null; shootDate: string | null } }>, role: Role): Partial<Record<StageTransportKey, string[]>> {
  const groups = new Map<StageTransportKey, Array<{ id: string; street: string; priority: number | null; shootDate: string | null }>>();
  for (const { project } of rows) {
    const stageKey = projectStageForRole(project, role).stageKey as StageTransportKey;
    const group = groups.get(stageKey) ?? [];
    group.push(project);
    groups.set(stageKey, group);
  }
  const orderedProjectIdsByStage: Partial<Record<StageTransportKey, string[]>> = {};
  const options = boardCardOrderOptionsFor(role);
  for (const [stageKey, group] of groups) {
    group.sort((left, right) => compareBoardCards(left, right, options));
    orderedProjectIdsByStage[stageKey] = group.map((project) => project.id);
  }
  return orderedProjectIdsByStage;
}

/**
 * #217 -- the Dashboard's `q`. Unsafe characters (backslash, the C0 controls, DEL -- the same
 * class `sanitizeDashboardCalendarSearch` strips client-side) come out first, then
 * `normalizeProjectSearch` (the #218 shared helper) collapses whitespace and trims, then the
 * result is capped to `PROJECT_SEARCH_MAX_LENGTH` code points -- the ACTIVE cap here is the
 * shared Dashboard cap (`@quincy/shared`'s `DASHBOARD_SEARCH_MAX_CHARS`, below), not a
 * locally-invented number that merely happens to agree with it. Not lowercased here: the match
 * itself is case-insensitive via SQL `lower(...)` on both sides (`projectSearchSql`), so the
 * ORIGINAL casing survives into the `search.query` echoed back in the response.
 *
 * #217 fix round 3, item 4 (Sol's whole-branch review): the strip and the cap now come from
 * `@quincy/shared` (`stripUnsafeText`/`capDashboardSearchText`) instead of a hand-rolled local
 * copy of each -- one definition shared with `staff-routes.ts`'s own serializer and the web
 * store's commit path, so the 200-char cap in particular can never drift between them.
 * `PROJECT_SEARCH_MAX_LENGTH` itself stays defined in `../lib/project-search.ts`, an unmodified
 * #218 cherry-pick this file must not edit -- `project-search.test.ts` asserts it stays
 * numerically equal to the shared `DASHBOARD_SEARCH_MAX_CHARS` cap instead.
 */
function normalizeProjectListSearch(raw: string): string {
  const stripped = stripUnsafeText(raw);
  const collapsed = normalizeProjectSearch(stripped);
  return capDashboardSearchText(collapsed);
}

/**
 * The internal path's own column/table shape for `lib/project-search.ts`'s shared
 * `matchingProjectIds` (#217) -- `projects p LEFT JOIN project_subtasks s`, matching
 * `p.agency_name`/`p.agent_name` directly (not the Calendar's own `COALESCE(agencies.name,
 * ...)`), since the list response renders the denormalised columns.
 */
async function matchingInternalProjectIds(database: D1Database, authorizedIds: string[], search: string): Promise<Set<string>> {
  return matchingProjectIds(database, authorizedIds, search, {
    idColumn: "p.id",
    fromClause: "projects p LEFT JOIN project_subtasks s ON s.project_id = p.id",
    columns: {
      checklistTitle: "s.title",
      street: "p.street",
      suburb: "COALESCE(p.suburb, '')",
      agency: "COALESCE(p.agency_name, '')",
      agent: "COALESCE(p.agent_name, '')",
    },
  });
}

type AssignmentCandidate = { id: string; name: string; email: string; globalRole: Role; active: true };
/** #487: editors also carry `defaultEditor`. The list is already active + editor-eligible, so the stored flag is the effective Default editor rule. */
type EditorAssignmentCandidate = AssignmentCandidate & { defaultEditor: boolean };
type ProjectAssignmentCandidatesResponse = { photographers: AssignmentCandidate[]; editors: EditorAssignmentCandidate[] };

async function assignmentCandidates(db: ReturnType<typeof createDb>): Promise<ProjectAssignmentCandidatesResponse> {
  const [photographers, editors] = await Promise.all([
    db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, globalRole: schema.user.role, active: schema.user.active })
      .from(schema.user).where(and(eq(schema.user.active, true), inArray(schema.user.role, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.photographer)))
      .orderBy(sql`lower(${schema.user.name})`, sql`lower(${schema.user.email})`, schema.user.id).all(),
    db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, globalRole: schema.user.role, active: schema.user.active, defaultEditor: schema.user.defaultEditor })
      .from(schema.user).where(and(eq(schema.user.active, true), inArray(schema.user.role, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor)))
      .orderBy(sql`lower(${schema.user.name})`, sql`lower(${schema.user.email})`, schema.user.id).all(),
  ]);
  return { photographers: photographers.map((user) => ({ ...user, active: true as const })), editors: editors.map((user) => ({ ...user, active: true as const })) };
}

function normalizedProjectSlots(photographerUserIds: string[] | undefined, editorUserIds: string[] | undefined) {
  const slots: Array<{ userId: string; roleOnProject: ProjectMemberRole }> = [];
  for (const userId of new Set(photographerUserIds ?? [])) slots.push({ userId, roleOnProject: "photographer" });
  for (const userId of new Set(editorUserIds ?? [])) slots.push({ userId, roleOnProject: "editor" });
  return slots.sort((left, right) => left.roleOnProject.localeCompare(right.roleOnProject) || left.userId.localeCompare(right.userId));
}

function createProjectResponse(data: z.infer<typeof createProjectFields>, id: string, memberships: ProjectMembershipDto[]) {
  return {
    id, street: data.street, suburb: data.suburb ?? null, postcode: data.postcode ?? null,
    agencyName: data.agencyName ?? null, agentName: data.agentName ?? null, agentEmail: data.agentEmail ?? null, agentPhone: data.agentPhone ?? null,
    agencyId: data.agencyId ?? null, agentId: data.agentId ?? null, shootDate: data.shootDate ?? null, timeWindow: data.timeWindow ?? null,
    stageKey: "awaiting_raw", priority: data.priority ?? null, boardRevision: 0, orderNo: data.orderNo ?? null, orderId: data.orderId ?? null,
    invoiceAmount: data.invoiceAmount ?? null, paymentStatus: data.paymentStatus ?? null, notes: data.notes ?? null, productionNotes: data.productionNotes ?? null,
    rawFolderLink: data.rawFolderLink ?? null, rawFolderPath: data.rawFolderPath ?? null, coverAssetId: null, effectiveCoverAssetId: null,
    archivedAt: null, archivedBy: null, members: memberships,
  };
}

async function createProjectAtomically(c: Context<AppEnv>, data: z.infer<typeof createProjectFields>, manualDeadline: ResolvedDeadlineSet | null, slots: Array<{ userId: string; roleOnProject: ProjectMemberRole }>, candidates: ProjectAssignmentCandidatesResponse) {
  const now = Date.now();
  const projectId = newId();
  const services = [...new Set<CollectionKind>(["raw", ...(data.orderedServices ?? [])])];
  const raw = c.env.DB;
  // #135: pre-read the effective-default-editor set once. Default slots are appended below but
  // deliberately excluded from `diagnostics`/`eligibilityPredicates` — a default editor going
  // stale between this read and the batch just isn't added, it never fails project creation.
  const explicitEditorIds = new Set(slots.filter((slot) => slot.roleOnProject === "editor").map((slot) => slot.userId));
  const defaultEditorIds = (await selectEffectiveDefaultEditorIds(raw)).filter((id) => !explicitEditorIds.has(id));
  const diagnostics = slots.map((slot) => {
    const eligibleRoles = [...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[slot.roleOnProject]];
    return raw.prepare(`
      SELECT ? AS userId, ? AS roleOnProject,
        u.name, u.email, u.role AS globalRole, u.active,
        CASE WHEN u.active = 1 AND u.role IN (${eligibleRoles.map(() => "?").join(", ")}) THEN 1 ELSE 0 END AS eligible
      FROM (SELECT 1) AS marker
      LEFT JOIN user u ON u.id = ?
    `).bind(slot.userId, slot.roleOnProject, ...eligibleRoles, slot.userId);
  });
  const eligibilityPredicates = slots.map((slot) => {
    const eligibleRoles = [...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[slot.roleOnProject]];
    return `EXISTS (SELECT 1 FROM user WHERE id = ? AND active = 1 AND role IN (${eligibleRoles.map(() => "?").join(", ")}))`;
  });
  const fieldValues = [
    projectId, data.street, data.suburb ?? null, data.postcode ?? null, data.agencyName ?? null, data.agentName ?? null,
    data.agentEmail ?? null, data.agentPhone ?? null, data.agencyId ?? null, data.agentId ?? null, data.shootDate ?? null,
    data.timeWindow ?? null, data.orderNo ?? null, data.orderId ?? null, data.invoiceAmount ?? null, data.paymentStatus ?? null,
    data.notes ?? null, data.productionNotes ?? null, data.rawFolderLink ?? null, data.rawFolderPath ?? null, now, now,
    // #488: appended last so the `.slice(0, 12)` / `.slice(12)` bind split below stays valid. A manual Deadline is written by
    // the INSERT itself (version 1, source manual): it is never a second save after create, so it cannot half-land.
    data.priority ?? null,
    manualDeadline?.localCivil ?? null, manualDeadline ? PROJECT_DEADLINE_ZONE : null, manualDeadline?.offset ?? null, manualDeadline?.fold ?? null,
    manualDeadline?.deadlineAt ?? null, manualDeadline ? JSON.stringify(manualDeadline.offsets) : null, manualDeadline ? 1 : 0, manualDeadline ? "manual" : "none",
  ];
  const projectInsert = raw.prepare(`
    INSERT INTO projects (
      id, street, suburb, postcode, agency_name, agent_name, agent_email, agent_phone,
      agency_id, agent_id, shoot_date, time_window, stage_key,
      board_revision,
      order_no, order_id, invoice_amount, payment_status, notes, production_notes, raw_folder_link, raw_folder_path,
      created_at, updated_at, priority,
      deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_at,
      deadline_reminder_offsets_json, deadline_version, deadline_source
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_raw',
      0,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${eligibilityPredicates.length ? eligibilityPredicates.join(" AND ") : "1 = 1"}
    RETURNING id
  `).bind(...fieldValues, ...slots.flatMap((slot) => [slot.userId, ...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[slot.roleOnProject]]));
  const collectionRecords = services.map((kind) => ({ id: newId(), kind }));
  const collectionStatements = collectionRecords.map((collection) => raw.prepare(`
    INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at)
    SELECT ?, ?, ?, 'empty', 0, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
  `).bind(collection.id, projectId, collection.kind, now, now, projectId));
  const initialSlots: InitialProjectMemberSlot[] = slots.map((slot) => {
    const list = slot.roleOnProject === "photographer" ? candidates.photographers : candidates.editors;
    const candidate = list.find((item) => item.id === slot.userId);
    return { userId: slot.userId, roleOnProject: slot.roleOnProject, name: candidate?.name ?? "", email: candidate?.email ?? "", globalRole: candidate?.globalRole ?? "photographer", active: candidate?.active ?? false };
  });
  // Display fields are placeholders: the response reads default memberships back from the batch below.
  const defaultSlots: InitialProjectMemberSlot[] = defaultEditorIds.map((userId) => ({ userId, roleOnProject: "editor", name: "", email: "", globalRole: "editor", active: false, source: "default_editor" }));
  const memberTuples = buildInitialProjectMemberStatementTuples(raw, { projectId, projectMarkerId: projectId, slots: [...initialSlots, ...defaultSlots], actorId: c.get("user").id, auditPrincipal: c.get("user"), now });
  // #135: default memberships are not in `initialSlots`' 1:1 diagnostics alignment, so their
  // observed name/email/active come from this dedicated post-member-statements SELECT instead —
  // it only returns rows for defaults that actually got a project_members row.
  const defaultMembershipsSelect = defaultEditorIds.length
    ? raw.prepare(`
      SELECT pm.id, pm.user_id AS userId, pm.role_on_project AS roleOnProject, u.name, u.email, u.role AS globalRole, u.active, 0 AS assignedSubtaskCount
      FROM project_members pm JOIN user u ON u.id = pm.user_id
      WHERE pm.project_id = ? AND pm.role_on_project = 'editor' AND pm.user_id IN (${defaultEditorIds.map(() => "?").join(", ")})
    `).bind(projectId, ...defaultEditorIds)
    : null;
  const projectAuditId = newId();
  const projectAudit = raw.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'project.create', 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
  `).bind(projectAuditId, c.get("user").id, projectId, auditMeta(c.get("user"), { orderedServices: services, ...(data.priority != null ? { priority: data.priority } : {}) }), now, projectId);
  // #484: a Project created with a canonical Shoot date and no Deadline gets its Automatic Deadline in this same batch, appended
  // last so every result index below stays valid and gated on this create's own audit row.
  const automaticDeadline = !manualDeadline && typeof data.shootDate === "string"
    ? buildAutomaticDeadlineBundle({ db: raw, projectId, shootDate: data.shootDate, gate: { kind: "audit", auditId: projectAuditId }, auditId: newId(), reason: "create", now })
    : undefined;
  // #488: a person's manual Deadline records one `schedule_saved` audit row (gated on the create's own audit row) and its
  // reminder occurrences (gated on that row). No activity, outbox row or notification: the creator is the actor.
  const manualDeadlineStatements: D1PreparedStatement[] = [];
  if (manualDeadline) {
    const scheduleAuditId = newId();
    manualDeadlineStatements.push(raw.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'project.deadline.schedule_saved', 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(scheduleAuditId, c.get("user").id, projectId, auditMeta(c.get("user"), { version: 1, operation: "set", via: "create" }), now, projectAuditId));
    for (const occurrence of planDeadlineOccurrences(manualDeadline.deadlineAt, manualDeadline.offsets, now)) {
      manualDeadlineStatements.push(raw.prepare(`
        INSERT INTO project_deadline_occurrences
          (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at,
           deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold,
           status, terminal_reason, fired_at, created_by, created_at, updated_at)
        SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      `).bind(newId(), projectId, occurrence.kind, occurrence.offsetMinutes, occurrence.fireAt, manualDeadline.deadlineAt, manualDeadline.localCivil, PROJECT_DEADLINE_ZONE, manualDeadline.offset, manualDeadline.fold, occurrence.status, occurrence.terminalReason, c.get("user").id, now, now, scheduleAuditId));
    }
  }
  const memberStatementStart = diagnostics.length + 1 + collectionStatements.length;
  const defaultMembershipsIndex = memberStatementStart + memberTuples.statements.length;
  const result = await raw.batch([...diagnostics, projectInsert, ...collectionStatements, ...memberTuples.statements, ...(defaultMembershipsSelect ? [defaultMembershipsSelect] : []), projectAudit, ...(automaticDeadline?.statements ?? []), ...manualDeadlineStatements]);
  const projectIndex = diagnostics.length;
  const created = rowsFromD1<{ id: string }>(result[projectIndex]).length > 0;
  if (!created) {
    const ineligibleSlots = diagnostics.map((_, index) => firstD1<{ userId: string; roleOnProject: ProjectMemberRole; eligible: number }>(result[index])).filter((row): row is { userId: string; roleOnProject: ProjectMemberRole; eligible: number } => Boolean(row && row.eligible !== 1)).map(({ userId, roleOnProject }) => ({ userId, roleOnProject }));
    return { created: false as const, ineligibleSlots: ineligibleSlots.sort((left, right) => left.roleOnProject.localeCompare(right.roleOnProject) || left.userId.localeCompare(right.userId)) };
  }
  const outboxIds = memberTuples.outboxResultOffsets.map((offset) => firstD1<{ id: string }>(result[memberStatementStart + offset])?.id).filter((id): id is string => Boolean(id));
  const broadIds = memberTuples.broadResultOffsets.flatMap((offset) => rowsFromD1<{ id: string }>(result[memberStatementStart + offset]).map((row) => row.id));
  const publicationIds = [...outboxIds, ...broadIds];
  if (publicationIds.length) c.executionCtx.waitUntil(Promise.resolve().then(() => publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds)).catch((error) => console.error("Project assignment outbox publication failed", { projectId, error })));
  if (data.rawFolderPath !== undefined) c.executionCtx.waitUntil(c.env.BACKGROUND.ensureAutoHdrScaffold(projectId).catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId, error })));
  if (c.env.DROPBOX_EDITOR_AUTOMATION_ENABLED === "1" || c.env.DROPBOX_EDITOR_AUTOMATION_ENABLED === true) c.executionCtx.waitUntil(c.env.BACKGROUND.ensureEditorFolder(projectId).catch((error) => console.error("Editor scaffold trigger failed", { projectId, error })));
  const collectionsForResponse = collectionRecords.map((collection) => ({ id: collection.id, projectId, kind: collection.kind, status: "empty", expectedCount: null, receivedCount: 0 }));
  const observedExplicitMemberships = memberTuples.memberships.slice(0, initialSlots.length).map((membership, index) => {
    const observed = firstD1<{ name: string | null; email: string | null; globalRole: Role | null; active: number | null }>(result[index]);
    return {
      ...membership,
      name: observed?.name ?? membership.name,
      email: observed?.email ?? membership.email,
      globalRole: observed?.globalRole ?? membership.globalRole,
      active: observed?.active === 1,
    };
  });
  const observedDefaultMemberships: ProjectMembershipDto[] = defaultMembershipsSelect
    ? rowsFromD1<{ id: string; userId: string; roleOnProject: ProjectMemberRole; name: string; email: string; globalRole: Role; active: number; assignedSubtaskCount: number }>(result[defaultMembershipsIndex]).map((row) => ({
      id: row.id, userId: row.userId, roleOnProject: row.roleOnProject, name: row.name, email: row.email, globalRole: row.globalRole, active: row.active === 1, assignedSubtaskCount: 0,
    }))
    : [];
  const observedMemberships = [...observedExplicitMemberships, ...observedDefaultMemberships];
  return { created: true as const, response: { ...createProjectResponse(data, projectId, observedMemberships), collections: collectionsForResponse } };
}

function rowsFromD1<T>(result: unknown): T[] {
  return ((result as { results?: T[] } | undefined)?.results ?? []);
}

function firstD1<T>(result: unknown): T | undefined { return rowsFromD1<T>(result)[0]; }
export const projectsRoutes = new Hono<AppEnv>();
/**
 * #428/#429: the shared Dashboard Filter on the Projects-list request — `stages`, `priority`,
 * `archived`, and the relation and date facets `editors`, `unassigned`, `shoot`, `deadline`,
 * `overdue`, `mine` — validated by the ONE shared schema and authorised before ANY role branch, so an
 * External Editor reaches neither the archived rows nor a priority filter through the early return.
 * `archived` other than Hide needs the Admin back-end capability (`viewAllProjects` is not enough),
 * `priority` is unavailable to an External Editor (their DTO withholds it, so a filter would leak it
 * through which rows match), and a malformed or duplicated parameter is a 400.
 */
function projectsListFilter(c: Context<AppEnv>, role: Role): { filter: DashboardFilter } | { response: Response } {
  const queries = c.req.queries();
  const raw: Record<string, string> = {};
  for (const name of DASHBOARD_PROJECTS_FILTER_QUERY_NAMES) {
    const values = queries[name];
    if (values === undefined) continue;
    if (values.length !== 1) return { response: c.json({ error: "Invalid project filter", code: "project_filter_invalid" }, 400) };
    raw[name] = values[0]!;
  }
  const parsed = dashboardProjectsFilterQuerySchema.safeParse(raw);
  if (!parsed.success) return { response: c.json({ error: "Invalid project filter", code: "project_filter_invalid" }, 400) };
  const filter = parsed.data;
  // #461: the walk covers the whole tree: a rule hidden inside a group or behind a negation is still refused.
  const tree = dashboardFilterTreeOf(filter);
  if (dashboardFilterHasArchivedLeaf(tree) && !roleHasCapability(role, "adminBackend")) return { response: c.json({ error: "Forbidden", capability: "adminBackend" }, 403) };
  if (dashboardFilterHasPriorityLeaf(tree) && role === "external_editor") return { response: c.json({ error: "Project priority is not available to this role", code: "project_filter_priority_unavailable" }, 400) };
  return { filter };
}

projectsRoutes.get("/projects", terminalRoute("/projects", async (c) => {
  const variant = await boardSchemaVariant(c.env.DB);
  const db = createDb(c.env.DB); const user = c.get("user");
  // #217: normalised once, shared by both roles below -- empty means current behaviour, byte for
  // byte (no `search` key in the response, no id-set query, no filtering).
  const search = normalizeProjectListSearch(c.req.query("q") ?? "");
  const authorised = projectsListFilter(c, user.role);
  if ("response" in authorised) return authorised.response;
  const { filter } = authorised;
  if (user.role === "external_editor") return c.json(await listExternalProjects(c.env, user.id, user.role, search, filter));
  // Archived mode is the ONLY change to the query's WHERE: Hide (the default) and Only select on
  // `archived_at`, Include selects both. Stage and Priority narrow in memory below, over the same
  // set `q` narrows, so the Board-order envelope and `total` never move with them.
  const tree = dashboardFilterTreeOf(filter);
  const archivedMode = dashboardFilterArchivedMode(tree);
  const archivedFilter = archivedMode === "hide" ? isNull(schema.projects.archivedAt) : archivedMode === "only" ? isNotNull(schema.projects.archivedAt) : undefined;
  const projectColumns = projectColumnsForVariant(variant);
  const base = db.select({ project: projectColumns, receivedCount: schema.collections.receivedCount, expectedCount: schema.collections.expectedCount }).from(schema.projects).leftJoin(schema.collections, and(eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw")));
  const rows = user.role === "photographer"
    ? await base.where(and(archivedFilter, exists(db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))), inArray(schema.projects.stageKey, PHOTOGRAPHER_VISIBLE_STAGES))).orderBy(...dashboardProjectOrder).all()
    : await base.where(archivedFilter).orderBy(...dashboardProjectOrder).all();
  // `orderedRows` stays UNFILTERED: it feeds `authorizedInternalBoardOrder` below and `total`,
  // both of which describe the full authorised set regardless of `q`, Stage or Priority. Filtering
  // it here would make the deprecated per-Stage order a rank within the filtered set.
  const orderedRows = orderDashboardStreetTies(rows);
  const matchingIds = search === "" ? null : await matchingInternalProjectIds(c.env.DB, orderedRows.map(({ project }) => project.id), search);
  // #429, #461: the whole filter tree (Stage, Priority, Archived, People, Unassigned, My tasks, Overdue, the date
  // ranges; AND / OR / groups / negation) as one id-set question over the authorised ids. It narrows
  // `matchedRows` only, so Stage and Priority still never move the order or `total`.
  const relationIds = await projectsMatchingDashboardFilter(c.env.DB, { id: user.id, role: user.role }, orderedRows.map(({ project }) => ({ id: project.id, stageKey: project.stageKey, priority: project.priority })), tree, Date.now());
  const facetNarrows = relationIds !== null;
  const matchedRows = orderedRows.filter(({ project }) =>
    (matchingIds === null || matchingIds.has(project.id))
    && (relationIds === null || relationIds.has(project.id)));
  // Enrichment (covers, editors) runs only over matches, not the full authorised set.
  const projectIds = matchedRows.map(({ project }) => project.id);
  const { storedByProject, automaticByProject } = await coverMaps(db, projectIds, user.role === "photographer");
  const editorsByProject = await activeEditorRefsByProject(db, projectIds);
  const enabled = await boardContractEnabled(c.env.DB, variant);
  return c.json({
    projects: matchedRows.map((r) => projectStageForRole({
      ...r.project,
      boardRevision: variant === "tb5a_0037" && "boardRevision" in r.project ? Number(r.project.boardRevision) : 0,
      coverAssetId: storedByProject.get(r.project.id) ?? automaticByProject.get(r.project.id) ?? null,
      receivedCount: r.receivedCount ?? 0,
      expectedCount: r.expectedCount,
      deadlineAt: r.project.deadlineAt,
      deadlineLocalCivil: r.project.deadlineLocalCivil,
      deadlineZone: r.project.deadlineZone,
      editors: editorsByProject.get(r.project.id) ?? [],
    }, user.role)),
    board: {
      contractEnabled: enabled,
      // Built from the UNFILTERED `orderedRows` -- the authorised Board-order envelope, not a
      // rank-within-the-filtered-set -- and from ACTIVE rows only: an archived Project never has a
      // Board position (Include), and Only has no mutation envelope at all.
      orderedProjectIdsByStage: variant === "tb5a_0037" && archivedMode !== "only" ? authorizedInternalBoardOrder(orderedRows.filter(({ project }) => project.archivedAt === null), user.role) : {},
    },
    ...(matchingIds === null && !facetNarrows ? {} : { search: { query: search, matching: matchedRows.length, total: orderedRows.length } }),
  });
}));
projectsRoutes.get("/project-assignment-candidates", terminalRoute("/project-assignment-candidates", async (c) => {
  const user = c.get("user");
  if (!roleHasCapability(user.role, "createProject") && !roleHasCapability(user.role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  return c.json(await assignmentCandidates(createDb(c.env.DB)));
}));

projectsRoutes.post("/projects", requireCapability("createProject"), terminalRoute("/projects", async (c) => {
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  // Creation is an INSERT of a new row (board_revision 0; the Board order is derived from data, so
  // no position is written). It does not mutate an existing Board row, so it is not flag-gated: the
  // studio must be able to onboard shoots throughout the flag-OFF rollout window. Stage move /
  // archive / restore stay flag-gated because they change existing rows' revision.
  const data = await jsonInput(c, createProjectFields); if (data instanceof Response) return data;
  // #488: defence in depth. Only Admin holds `createProject` today, so neither branch is reachable over HTTP yet; they keep
  // create from becoming a way round the Priority and Deadline capabilities if `createProject` is ever granted more widely.
  const principal = c.get("user");
  if (data.priority != null && !roleHasCapability(principal.role, "prioritizeProjects")) return c.json({ error: "Forbidden", capability: "prioritizeProjects" }, 403);
  if (data.deadline != null && !roleHasCapability(principal.role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  let manualDeadline: ResolvedDeadlineSet | null = null;
  if (data.deadline) {
    try { manualDeadline = resolveDeadlineSet(data.deadline, data.deadline.reminderOffsetsMinutes ?? []); }
    catch (error) {
      if (!(error instanceof ProjectDeadlineError)) throw error;
      return c.json({ error: error.message, code: error.code, ...(error.details ?? {}) }, error.status);
    }
  }
  const slots = normalizedProjectSlots(data.photographerUserIds, data.editorUserIds);
  const candidates = await assignmentCandidates(createDb(c.env.DB));
  const photographerIds = new Set(candidates.photographers.map((candidate) => candidate.id));
  const editorIds = new Set(candidates.editors.map((candidate) => candidate.id));
  const prevalidationFailures = slots.filter((slot) => !(slot.roleOnProject === "photographer" ? photographerIds : editorIds).has(slot.userId));
  // This early response is only a useful UX guard. The same eligibility is rechecked inside the
  // conditional project INSERT in createProjectAtomically, which is the write authority.
  if (prevalidationFailures.length) return c.json({ error: "One or more project assignments are not eligible", code: "ineligible_project_assignments", ineligibleSlots: prevalidationFailures }, 422);
  const result = await createProjectAtomically(c, data, manualDeadline, slots, candidates);
  if (!result.created) return c.json({ error: "One or more project assignments are not eligible", code: "ineligible_project_assignments", ineligibleSlots: result.ineligibleSlots }, 422);
  return c.json({ ...result.response, contractEnabled: await boardContractEnabled(c.env.DB, variant) }, 201);
}));

projectsRoutes.post("/projects/:id/priority", terminalRoute("/projects/:id/priority", async (c) => {
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!roleHasCapability(c.get("user").role, "prioritizeProjects")) return c.json({ error: "Forbidden", capability: "prioritizeProjects" }, 403);
  const data = await jsonInput(c, priorityInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const target = await c.env.DB.prepare(`
    SELECT id, stage_key AS stageKey, priority, board_revision AS boardRevision
    FROM projects WHERE id = ? AND archived_at IS NULL
  `).bind(id).first<{ id: string; stageKey: StageKey; priority: number | null; boardRevision: number }>();
  if (!target) return c.json({ error: "Project not found" }, 404);
  if (target.priority === data.priority) return c.json({ priority: target.priority, boardRevision: target.boardRevision });
  const now = Date.now();
  const auditId = newId(); const activityId = newId();
  const activity: ProjectActivityIntent = {
    schemaVersion: 1,
    activity: { id: activityId, type: "project.priority.changed", projectId: id, actorId: c.get("user").id, occurredAt: now, source: { kind: "project_priority", id, key: `project-priority:${id}:change:${activityId}` }, safePayload: { priority: data.priority }, deepLink: projectActivityDeepLink("project.priority.changed", id) },
    broadDelivery: { registryKey: "project.priority.changed", sourceActivityId: activityId, coalesce: null },
  };
  const activityStatements = buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId, createdAt: now });
  const auditStatement = c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project.priority_set', 'project', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(auditId, c.get("user").id, id, auditMeta(c.get("user"), { from: target.priority, to: data.priority }), now);
  const updateStatement = c.env.DB.prepare(`
    UPDATE projects
    SET priority = ?1, updated_at = ?2
    WHERE id = ?3 AND archived_at IS NULL AND priority IS NOT ?1
      AND stage_key = ?4 AND board_revision = ?5
    RETURNING priority, board_revision
  `).bind(data.priority, now, id, target.stageKey, target.boardRevision);
  const result = await c.env.DB.batch([updateStatement, auditStatement, ...activityStatements.statements]);
  const rawUpdated = firstD1<{ priority: number | null; boardRevision?: number; board_revision?: number }>(result[0]);
  const updated = rawUpdated && {
    priority: rawUpdated.priority,
    boardRevision: rawUpdated.boardRevision ?? rawUpdated.board_revision,
  };
  if (!updated || updated.boardRevision === undefined || !rowsFromD1(result[1]).length) {
    const current = await c.env.DB.prepare("SELECT priority, stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ priority: number | null; stageKey: StageKey; boardRevision: number }>();
    if (current && current.priority === data.priority && current.stageKey === target.stageKey && current.boardRevision === target.boardRevision) return c.json({ priority: current.priority, boardRevision: current.boardRevision });
    return c.json({ error: "Project changed while priority was being updated", code: "project_priority_conflict" }, 409);
  }
  const publicationIds = rowsFromD1<{ id: string }>(result[2 + activityStatements.broadOutboxIndex]).map((row) => row.id);
  if (publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  return c.json(updated);
}));

/** #455. An archived Project's details are read-only; Restore first. */
const DETAILS_ARCHIVED_BODY = { error: "Archived projects are read-only; restore the project to edit its details.", code: "details_project_archived" } as const;
/** #455. Sync is refused on an archived Project (the consumer is fenced too). */
const DROPBOX_SYNC_ARCHIVED_BODY = { error: "Archived projects can't sync from Dropbox. Restore the project first.", code: "dropbox_sync_project_archived" } as const;
projectsRoutes.patch("/projects/:id", terminalRoute("/projects/:id", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!roleHasCapability(c.get("user").role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  const data = await jsonInput(c, editFields); if (data instanceof Response) return data;
  const variant = await boardSchemaVariant(c.env.DB);
  const db = createDb(c.env.DB);
  // Explicit variant selection prevents a 0036 deployment from preparing board_revision.
  const existingProject = await db.select(projectColumnsForVariant(variant)).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!existingProject) return c.json({ error: "Project not found" }, 404);
  if (existingProject.archivedAt) return c.json(DETAILS_ARCHIVED_BODY, 409);
  const { orderedServices, ...projectUpdates } = data;
  const existing = await db.select({ id: schema.collections.id, kind: schema.collections.kind, receivedCount: schema.collections.receivedCount }).from(schema.collections).where(eq(schema.collections.projectId, id)).all();
  const desiredServices = orderedServices === undefined ? null : new Set<CollectionKind>(["raw", ...orderedServices]);
  const desiredKinds = desiredServices ? [...desiredServices] : [];
  const removedCollections = desiredServices ? existing.filter((collection) => collection.kind !== "raw" && !desiredServices.has(collection.kind as CollectionKind)) : [];
  const addedKinds = desiredServices ? [...desiredServices].filter((kind) => !existing.some((collection) => collection.kind === kind)) : [];
  const countsFor = async (collectionIds: string[]) => {
    if (!collectionIds.length) return { assets: new Map<string, number>(), manifests: new Map<string, number>(), documents: new Map<string, number>(), links: new Map<string, number>() };
    const [assetRows, manifestRows, documentRows, linkRows] = await Promise.all([
      db.select({ collectionId: schema.assets.collectionId, n: sql<number>`count(*)` }).from(schema.assets).where(inArray(schema.assets.collectionId, collectionIds)).groupBy(schema.assets.collectionId).all(),
      db.select({ collectionId: schema.uploadManifests.collectionId, n: sql<number>`count(*)` }).from(schema.uploadManifests).where(inArray(schema.uploadManifests.collectionId, collectionIds)).groupBy(schema.uploadManifests.collectionId).all(),
      db.select({ collectionId: schema.documentUploads.collectionId, n: sql<number>`count(*)` }).from(schema.documentUploads).where(and(inArray(schema.documentUploads.collectionId, collectionIds), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`)).groupBy(schema.documentUploads.collectionId).all(),
      db.select({ collectionId: schema.collectionLinks.collectionId, n: sql<number>`count(*)` }).from(schema.collectionLinks).where(inArray(schema.collectionLinks.collectionId, collectionIds)).groupBy(schema.collectionLinks.collectionId).all(),
    ]);
    return { assets: new Map(assetRows.map((row) => [row.collectionId, Number(row.n)])), manifests: new Map(manifestRows.map((row) => [row.collectionId, Number(row.n)])), documents: new Map(documentRows.map((row) => [row.collectionId, Number(row.n)])), links: new Map(linkRows.map((row) => [row.collectionId, Number(row.n)])) };
  };
  const preCounts = await countsFor(removedCollections.map((collection) => collection.id));
  const blocked = removedCollections.filter((collection) => collection.receivedCount > 0 || (preCounts.assets.get(collection.id) ?? 0) > 0 || (preCounts.manifests.get(collection.id) ?? 0) > 0 || (preCounts.documents.get(collection.id) ?? 0) > 0 || (preCounts.links.get(collection.id) ?? 0) > 0);
  if (blocked.length) return c.json({ error: "Services with received media or active document uploads cannot be removed.", blocked: blocked.map((collection) => ({ kind: collection.kind, assetCount: preCounts.assets.get(collection.id) ?? 0, manifestCount: preCounts.manifests.get(collection.id) ?? 0, activeDocumentSessions: preCounts.documents.get(collection.id) ?? 0 })) }, 409);

  const dbFieldMap: Record<string, string> = { street: "street", suburb: "suburb", postcode: "postcode", agencyName: "agency_name", agentName: "agent_name", agentEmail: "agent_email", agentPhone: "agent_phone", agencyId: "agency_id", agentId: "agent_id", shootDate: "shoot_date", timeWindow: "time_window", orderNo: "order_no", orderId: "order_id", invoiceAmount: "invoice_amount", paymentStatus: "payment_status", notes: "notes", productionNotes: "production_notes", rawFolderLink: "raw_folder_link", rawFolderPath: "raw_folder_path" };
  const updateParts: string[] = []; const updateBindings: unknown[] = []; const snapshotParts: string[] = []; const snapshotBindings: unknown[] = []; const changeParts: string[] = []; const changeBindings: unknown[] = [];
  for (const [key, column] of Object.entries(dbFieldMap)) {
    if (!Object.prototype.hasOwnProperty.call(projectUpdates, key)) continue;
    const value = (projectUpdates as Record<string, unknown>)[key];
    const previousValue = (existingProject as unknown as Record<string, unknown>)[key === "agencyName" ? "agencyName" : key];
    updateParts.push(`${column} = ?`); updateBindings.push(value ?? null);
    snapshotParts.push(`${column} IS ?`); snapshotBindings.push(previousValue ?? null);
    changeParts.push(`${column} IS NOT ?`); changeBindings.push(value ?? null);
  }
  if (orderedServices !== undefined) {
    const requestedKinds = desiredKinds;
    const snapshotKinds = existing.map((collection) => collection.kind as CollectionKind);
    const valuesSelect = (kinds: CollectionKind[]) => `SELECT ? AS kind${kinds.slice(1).map(() => " UNION ALL SELECT ? AS kind").join("")}`;
    const serviceDelta = `EXISTS (SELECT 1 FROM collections current_service WHERE current_service.project_id = projects.id AND current_service.kind NOT IN (${requestedKinds.map(() => "?").join(",")})) OR EXISTS (SELECT 1 FROM (${valuesSelect(requestedKinds)}) desired_service WHERE NOT EXISTS (SELECT 1 FROM collections current_service WHERE current_service.project_id = projects.id AND current_service.kind = desired_service.kind))`;
    const serviceSnapshot = `NOT EXISTS (SELECT 1 FROM collections current_service WHERE current_service.project_id = projects.id AND current_service.kind NOT IN (${snapshotKinds.map(() => "?").join(",")})) AND NOT EXISTS (SELECT 1 FROM (${valuesSelect(snapshotKinds)}) snapshot_service WHERE NOT EXISTS (SELECT 1 FROM collections current_service WHERE current_service.project_id = projects.id AND current_service.kind = snapshot_service.kind))`;
    snapshotParts.push(`(${serviceSnapshot})`); snapshotBindings.push(...snapshotKinds, ...snapshotKinds);
    changeParts.push(`(${serviceDelta})`); changeBindings.push(...requestedKinds, ...requestedKinds);
  }
  const auditId = newId(); const activityId = newId();
  const safeFieldMap = { street: "address", shootDate: "shootDate", timeWindow: "timeWindow", agencyName: "agency", agentName: "agent", productionNotes: "productionNotes" } as const;
  const safeChangedFields: string[] = (Object.keys(safeFieldMap) as Array<keyof typeof safeFieldMap>).flatMap((key) => Object.prototype.hasOwnProperty.call(projectUpdates, key) && projectUpdates[key] !== (existingProject as unknown as Record<string, unknown>)[key] ? [safeFieldMap[key]] : []);
  const servicesChanged = orderedServices !== undefined && (removedCollections.length > 0 || addedKinds.length > 0);
  if (servicesChanged) safeChangedFields.push("services");
  const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.details.changed", projectId: id, actorId: c.get("user").id, occurredAt: Date.now(), source: { kind: "project_details", id, key: `project-details:${id}:change:${activityId}` }, safePayload: { changedFields: [...new Set(safeChangedFields)] }, deepLink: projectActivityDeepLink("project.details.changed", id) }, broadDelivery: { registryKey: "project.details.changed", sourceActivityId: activityId, coalesce: null } };
  const activityBundle = safeChangedFields.length ? buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId }) : null;
  const removalSafe = orderedServices === undefined
    ? "1 = 1"
    : `NOT EXISTS (SELECT 1 FROM collections doomed WHERE doomed.project_id = projects.id AND doomed.kind <> 'raw' AND doomed.kind NOT IN (${desiredKinds.map(() => "?").join(",")}) AND (doomed.received_count > 0 OR EXISTS (SELECT 1 FROM assets WHERE collection_id = doomed.id) OR EXISTS (SELECT 1 FROM collection_links WHERE collection_id = doomed.id) OR EXISTS (SELECT 1 FROM upload_manifests WHERE collection_id = doomed.id) OR EXISTS (SELECT 1 FROM document_uploads WHERE collection_id = doomed.id AND status IN ('pending', 'completing', 'aborting'))))`;
  const snapshotPredicate = snapshotParts.length ? snapshotParts.join(" AND ") : "1 = 1";
  const changePredicate = changeParts.length ? changeParts.join(" OR ") : "0 = 1";
  const updateWhere = ["id = ?", "stage_key = ?", "archived_at IS NULL", `(${snapshotPredicate})`, `(${changePredicate})`, removalSafe].join(" AND ");
  const projectUpdate = c.env.DB.prepare(`UPDATE projects SET ${[...updateParts, "updated_at = ?"].join(", ")} WHERE ${updateWhere} RETURNING id`).bind(...updateBindings, Date.now(), id, existingProject.stageKey, ...snapshotBindings, ...changeBindings, ...(orderedServices === undefined ? [] : desiredKinds));
  const projectAuditMeta: Record<string, unknown> = Object.fromEntries(Object.entries(projectUpdates).filter(([key]) => key !== "productionNotes"));
  if (Object.prototype.hasOwnProperty.call(projectUpdates, "productionNotes")) projectAuditMeta.changedFields = [...(Array.isArray(projectAuditMeta.changedFields) ? projectAuditMeta.changedFields : []), "productionNotes"];
  if (orderedServices !== undefined) { projectAuditMeta.servicesAdded = addedKinds; projectAuditMeta.servicesRemoved = removedCollections.map((collection) => collection.kind); }
  const serviceStatements: D1PreparedStatement[] = [];
  if (orderedServices !== undefined) {
    serviceStatements.push(c.env.DB.prepare(`DELETE FROM collections WHERE project_id = ? AND kind <> 'raw' AND kind NOT IN (${desiredKinds.map(() => "?").join(",")}) AND received_count = 0 AND NOT EXISTS (SELECT 1 FROM assets WHERE collection_id = collections.id) AND NOT EXISTS (SELECT 1 FROM collection_links WHERE collection_id = collections.id) AND NOT EXISTS (SELECT 1 FROM upload_manifests WHERE collection_id = collections.id) AND NOT EXISTS (SELECT 1 FROM document_uploads WHERE collection_id = collections.id AND status IN ('pending', 'completing', 'aborting')) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?) RETURNING id`).bind(id, ...desiredKinds, auditId));
    for (const kind of desiredKinds) serviceStatements.push(c.env.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) SELECT ?, ?, ?, 'empty', 0, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM collections WHERE project_id = ? AND kind = ?)").bind(newId(), id, kind, Date.now(), Date.now(), auditId, id, kind));
  }
  const statements: D1PreparedStatement[] = [projectUpdate, c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project.update', 'project', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(auditId, c.get("user").id, id, auditMeta(c.get("user"), projectAuditMeta), Date.now())];
  statements.push(...serviceStatements); if (activityBundle) statements.push(...activityBundle.statements);
  // #484: gaining a canonical Shoot date (empty or free text before) gives an empty Deadline its Automatic Deadline, in this same
  // batch. Appended last so every result index above stays valid, and gated on this save's own audit row so a lost race writes nothing.
  // A canonical date moving to another canonical date is a reschedule (#485), not a gain, so it never qualifies here.
  const gainedShootDate = Object.prototype.hasOwnProperty.call(projectUpdates, "shootDate") && typeof projectUpdates.shootDate === "string" && automaticDeadlineFor(projectUpdates.shootDate) !== null && automaticDeadlineFor(existingProject.shootDate) === null;
  const automaticDeadline = gainedShootDate
    ? buildAutomaticDeadlineBundle({ db: c.env.DB, projectId: id, shootDate: projectUpdates.shootDate as string, gate: { kind: "audit", auditId }, auditId: newId(), reason: "details", now: Date.now() })
    : undefined;
  if (automaticDeadline) statements.push(...automaticDeadline.statements);
  // #485: a canonical Shoot date that differs from the stored one moves a Deadline the system set and nobody has saved. Appended
  // whenever the date changes, with no pre-read of the Deadline: the bundle's own predicates (source `automatic`, a held Deadline,
  // the date this save wrote) decide, so a Deadline version bumped by a concurrent write cannot make the move silently lose, and a
  // Project with no Deadline is never backfilled. Clearing the date or writing free text never gets here. Gated on this save's audit row.
  const rescheduledShootDate = Object.prototype.hasOwnProperty.call(projectUpdates, "shootDate") && typeof projectUpdates.shootDate === "string" && automaticDeadlineFor(projectUpdates.shootDate) !== null && projectUpdates.shootDate !== existingProject.shootDate;
  const automaticDeadlineMove = rescheduledShootDate
    ? buildAutomaticDeadlineMoveBundle({ db: c.env.DB, projectId: id, shootDate: projectUpdates.shootDate as string, gate: { kind: "audit", auditId }, auditId: newId(), reason: "details", now: Date.now() })
    : undefined;
  if (automaticDeadlineMove) statements.push(...automaticDeadlineMove.statements);
  const result = await c.env.DB.batch(statements);
  if (!rowsFromD1<{ id: string }>(result[0]).length) {
    const currentProject = await db.select(projectColumnsForVariant(variant)).from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (currentProject?.archivedAt != null) return c.json(DETAILS_ARCHIVED_BODY, 409);
    const currentCollections = await db.select({ kind: schema.collections.kind }).from(schema.collections).where(eq(schema.collections.projectId, id)).all();
    const projectMatches = currentProject?.archivedAt === null && Object.entries(projectUpdates).every(([key, value]) => (currentProject as unknown as Record<string, unknown>)[key] === (value ?? null));
    const servicesMatch = orderedServices === undefined || (currentCollections.length === desiredServices!.size && currentCollections.every((collection) => desiredServices!.has(collection.kind as CollectionKind)));
    if (projectMatches && servicesMatch) return c.json(await details(db, c.env.DB, id, c.get("user").role, variant, await boardContractEnabled(c.env.DB, variant), false, c.env));
    const currentCounts = await countsFor(removedCollections.map((collection) => collection.id));
    return c.json({ error: "Services or project details changed while saving; reload and try again", blocked: removedCollections.filter((collection) => collection.receivedCount > 0 || (currentCounts.assets.get(collection.id) ?? 0) > 0 || (currentCounts.manifests.get(collection.id) ?? 0) > 0 || (currentCounts.documents.get(collection.id) ?? 0) > 0 || (currentCounts.links.get(collection.id) ?? 0) > 0).map((collection) => ({ kind: collection.kind, assetCount: currentCounts.assets.get(collection.id) ?? 0, manifestCount: currentCounts.manifests.get(collection.id) ?? 0, activeDocumentSessions: currentCounts.documents.get(collection.id) ?? 0 })) }, 409);
  }
  if (activityBundle) {
    const publicationIds = rowsFromD1<{ id: string }>(result[2 + serviceStatements.length + activityBundle.broadOutboxIndex]).map((row) => row.id);
    if (publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  }
  if (projectUpdates.rawFolderPath !== undefined && projectUpdates.rawFolderPath !== existingProject.rawFolderPath) c.executionCtx.waitUntil(c.env.BACKGROUND.ensureAutoHdrScaffold(id).catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error })));
  c.executionCtx.waitUntil(queueProjectShootDateFollowUps(c.env, id));
  return c.json(await details(db, c.env.DB, id, c.get("user").role, variant, await boardContractEnabled(c.env.DB, variant), false, c.env));
}));

/** #452. An archived Project's Team is read-only. Role changes (users.ts) still count archived memberships as blockers: restore, remove the member, re-archive. */
const MEMBERSHIP_ARCHIVED_BODY = { error: "Archived projects are read-only; the team can't be changed.", code: "membership_project_archived" } as const;

function projectMembershipRoute(roleOnProject: ProjectMemberRole, method: "put" | "delete") {
  const path = {
    photographer: "/projects/:projectId/photographers/:userId",
    editor: "/projects/:projectId/editors/:userId",
  }[roleOnProject];
  return projectsRoutes[method](path, terminalRoute(path, async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const userId = c.req.param("userId") ?? "";
    if (!idCheck(projectId) || !idCheck(userId)) return c.json({ error: "Invalid project or user id" }, 400);
    let body: z.infer<typeof deleteProjectMembershipInput> | undefined;
    if (method === "delete") {
      const parsed = await jsonInput(c, deleteProjectMembershipInput);
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
    const principal = c.get("user");
    if (!roleHasCapability(principal.role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
    const db = createDb(c.env.DB);
    if (!await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get()) return c.json({ error: "Project not found" }, 404);
    const target = await db.select({ id: schema.user.id, active: schema.user.active, globalRole: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).get();
    if (!target) return c.json({ error: "User not found" }, 404);

    if (method === "put") {
      try {
        const result = await addProjectMemberWithAssignmentIntent(c.env.DB, { projectId, userId, roleOnProject, actorId: principal.id, auditPrincipal: principal });
        if (result.created && result.notificationOutboxIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, result.notificationOutboxIds));
        if (roleOnProject === "photographer" && (c.env.DROPBOX_EDITOR_AUTOMATION_ENABLED === "1" || c.env.DROPBOX_EDITOR_AUTOMATION_ENABLED === true)) c.executionCtx.waitUntil(c.env.BACKGROUND.ensureEditorFolder(projectId).catch((error) => console.error("Editor scaffold trigger failed", { projectId, error })));
        return c.json({ outcome: result.created ? "created" : "unchanged", membership: result.membership }, result.created ? 201 : 200);
      } catch (error) {
        if (error instanceof ProjectMembershipArchivedError) return c.json(MEMBERSHIP_ARCHIVED_BODY, 409);
        if (error instanceof ProjectMemberIneligibleError) return c.json({ error: "User is not eligible for this project role", code: "ineligible_project_member", roleOnProject }, 422);
        throw error;
      }
    }

    const result = await removeProjectMemberCycle(c.env.DB, { projectId, userId, roleOnProject, membershipCycle: body!.membershipCycle, clearSubtaskAssignments: body!.clearSubtaskAssignments, confirmedAssignmentCount: body!.confirmedAssignmentCount, confirmAccessLoss: body!.confirmAccessLoss, actorId: principal.id, auditPrincipal: principal });
    if (result.outcome === "stale") return c.json({ error: "Project membership changed; refreshed current assignment", code: "membership_cycle_changed", requestedMembershipCycle: body!.membershipCycle, currentMembership: result.currentMembership }, 409);
    if (result.outcome === "project_archived") return c.json(MEMBERSHIP_ARCHIVED_BODY, 409);
    if (result.outcome === "confirmation_required") return c.json({ error: "Project access will be lost immediately; confirm final-role removal again", code: "subtask_assignment_confirmation_required", assignmentCount: result.assignmentCount, accessWillBeLost: result.accessWillBeLost, message: `Project access will be lost immediately. ${result.assignmentCount} checklist assignments will be cleared.`, currentMembership: result.currentMembership }, 422);
    if (result.notificationOutboxIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, result.notificationOutboxIds));
    return c.json({ outcome: "removed", removed: { membershipCycle: body!.membershipCycle, userId, roleOnProject }, subtaskAssignmentsCleared: result.subtaskAssignmentsCleared }, 200);
  }));
}

projectMembershipRoute("photographer", "put");
projectMembershipRoute("photographer", "delete");
projectMembershipRoute("editor", "put");
projectMembershipRoute("editor", "delete");

const COVER_ARCHIVED_BODY = { error: "Archived projects are read-only; restore the project to change its cover.", code: "cover_project_archived" } as const;

projectsRoutes.post("/projects/:id/cover", terminalRoute("/projects/:id/cover", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!roleHasCapability(c.get("user").role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  const data = await jsonInput(c, coverInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  // hasProjectAccess passes for any id under viewAllProjects — without this check an admin
  // posting to an unknown UUID would get 200 and an orphan audit row (matches PATCH).
  const existing = await db.select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!existing) return c.json({ error: "Project not found" }, 404);
  if (existing.archivedAt) return c.json(COVER_ARCHIVED_BODY, 409);
  if (data.assetId !== null) {
    const asset = await db.select({ id: schema.assets.id, collectionKind: schema.collections.kind, publishStatus: schema.assets.publishStatus }).from(schema.assets)
      .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id)))
      .where(and(eq(schema.assets.id, data.assetId), eq(schema.assets.kind, "photo"), isNull(schema.assets.supersededAt))).get();
    if (!asset || !isUserVisibleAsset(asset.collectionKind, asset.publishStatus)) return c.json({ error: "Asset not in this project" }, 404);
  }
  // One batch: the UPDATE is fenced on `archived_at IS NULL`, the audit row on `changes() = 1`, and the trailing SELECT is a snapshot
  // that classifies a lost race. Results are read by position; never reorder these statements.
  const now = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE projects SET cover_asset_id = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL RETURNING id").bind(data.assetId, now, id),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project.cover.set', 'project', ?, ?, ? WHERE changes() = 1").bind(newId(), c.get("user").id, id, auditMeta(c.get("user"), { assetId: data.assetId }), now),
    c.env.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(id),
  ]);
  if (!rowsFromD1(results[0]).length) {
    const snapshot = rowsFromD1<{ archived_at: number | null }>(results[2])[0];
    if (!snapshot) return c.json({ error: "Project not found" }, 404);
    if (snapshot.archived_at !== null) return c.json(COVER_ARCHIVED_BODY, 409);
    return c.json({ error: "The project changed while saving; reload and try again.", code: "cover_conflict" }, 409);
  }
  return c.json({ coverAssetId: data.assetId });
}));

projectsRoutes.post("/projects/:id/sync-dropbox", terminalRoute("/projects/:id/sync-dropbox", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const user = c.get("user");
  const hasUploadRaw = roleHasCapability(user.role, "uploadRaw");
  const isAdmin = roleHasCapability(user.role, "adminBackend");
  if (!hasUploadRaw && !isAdmin) return c.json({ error: "Forbidden" }, 403);
  const db = createDb(c.env.DB);
  const project = await db.select({ rawFolderPath: schema.projects.rawFolderPath, rawFolderLink: schema.projects.rawFolderLink, archivedAt: schema.projects.archivedAt })
    .from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt) return c.json(DROPBOX_SYNC_ARCHIVED_BODY, 409);

  const editorFolders = await editorFolderAvailability(c.env, id);
  const hasRawFolder = Boolean(editorFolders?.inputReady || project.rawFolderPath || project.rawFolderLink);
  const result: DropboxSyncResult = {
    raw: { skipped: hasUploadRaw ? "no_raw_folder" : "not_permitted" },
    edited: { skipped: isAdmin ? "not_ready" : "not_admin" },
  };

  if (editorFolders) {
    if (!editorFolders.ready) {
      if (!hasRawFolder || !hasUploadRaw) return c.json({ error: "Editor folders need review before synchronization" }, 409);
      const { jobId } = await c.env.BACKGROUND.triggerDropboxSync(id);
      result.raw = { jobId };
      await audit(c.env, user, "project.dropbox_sync", "project", id, { jobId, scope: "legacy_raw_pending_editor" });
      return c.json(result);
    }
    // The combined mapped operation does not initiate an AutoHDR handoff or client publication.
    const { jobId } = isAdmin
      ? await c.env.BACKGROUND.triggerEditorSync(id)
      : await c.env.BACKGROUND.triggerDropboxSync(id);
    result.raw = { jobId };
    if (isAdmin) result.edited = { jobId };
    await audit(c.env, user, "project.dropbox_sync", "project", id, { jobId, scope: "editor" });
    return c.json(result);
  }

  if (hasUploadRaw && hasRawFolder) {
    try {
      const raw = await c.env.BACKGROUND.triggerDropboxSync(id);
      result.raw = { jobId: raw.jobId };
      await audit(c.env, user, "project.dropbox_sync", "project", id, { jobId: raw.jobId })
        .catch((error) => console.error("sync-dropbox: RAW audit write failed", { projectId: id, error }));
    } catch (error) {
      result.raw = { skipped: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (isAdmin) {
    try {
      const fetchResult = await c.env.BACKGROUND.fetchEditedFromAutoHdr(id);
      if (fetchResult.ok) {
        result.edited = { jobId: fetchResult.jobId };
        await audit(c.env, user, "project.fetch_edited", "project", id, { jobId: fetchResult.jobId })
          .catch((error) => console.error("sync-dropbox: edited audit write failed", { projectId: id, error }));
      } else if (fetchResult.code === "ERR_FOLDER_NOT_READY") {
        result.edited = { skipped: "not_ready" };
      } else if (fetchResult.code === "ERR_FETCH_CLAIM_FAILED") {
        result.edited = { skipped: "error", message: fetchResult.message };
      } else {
        result.edited = { blocked: { code: fetchResult.code, message: fetchResult.message } };
      }
    } catch (error) {
      result.edited = { skipped: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const rawNotApplicable = "skipped" in result.raw && (result.raw.skipped === "no_raw_folder" || result.raw.skipped === "not_permitted");
  const editedNotApplicable = "skipped" in result.edited && (result.edited.skipped === "not_ready" || result.edited.skipped === "not_admin");
  if (rawNotApplicable && editedNotApplicable) return c.json({ error: "Nothing available to sync right now", result }, 409);
  return c.json(result);
}));

projectsRoutes.post("/projects/:id/send-to-autohdr", requireCapability("adminBackend"), terminalRoute("/projects/:id/send-to-autohdr", async (c) => {
  const id = c.req.param("id");
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const result = await c.env.BACKGROUND.sendSelectedToAutoHdr(id, c.get("user").id);
  if (!result.ok) {
    const status = result.code === "ERR_NO_RAW_SELECTION" ? 400
      : result.code === "ERR_PROJECT_NOT_FOUND" ? 404
        : result.code === "ERR_PROVIDER_NOT_CONFIGURED" || result.code === "ERR_SEND_SETUP_FAILED" ? 503
          : 409;
    return c.json({ error: result.message, code: result.code }, status);
  }
  await audit(c.env, c.get("user"), "project.send_to_autohdr", "project", id, {
    jobId: result.jobId,
    provider: "autohdr_api_v4",
    retrievalEnabled: false,
  });
  return c.json({ jobId: result.jobId });
}));

projectsRoutes.post("/projects/:id/fetch-edited", requireCapability("adminBackend"), terminalRoute("/projects/:id/fetch-edited", async (c) => {
  const id = c.req.param("id");
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const target = await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (target?.archivedAt) return c.json({ error: "Project is archived" }, 409);
  const result = await c.env.BACKGROUND.fetchEditedFromAutoHdr(id);
  if (!result.ok) {
    return c.json(
      { error: result.message, code: result.code },
      result.code === "ERR_NO_RAW_SELECTION" ? 400 : 409,
    );
  }
  await audit(c.env, c.get("user"), "project.fetch_edited", "project", id, { jobId: result.jobId });
  return c.json({ jobId: result.jobId });
}));

projectsRoutes.get("/projects/:id/autohdr-status", requireCapability("adminBackend"), terminalRoute("/projects/:id/autohdr-status", async (c) => {
  const projectId = c.req.param("id");
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden" }, 403);
  const db = createDb(c.env.DB);
  const handoff = await db.select({
    id: schema.autoHdrHandoffs.id,
    generation: schema.autoHdrHandoffs.generation,
    state: schema.autoHdrHandoffs.state,
    readinessUnitsJson: schema.autoHdrHandoffs.readinessUnitsJson,
    selectionHash: schema.autoHdrHandoffs.selectionHash,
    manifestVersion: schema.autoHdrHandoffs.manifestVersion,
    mappingState: schema.autoHdrOutputMappings.state,
    finalPath: schema.autoHdrOutputMappings.finalPath,
    diagnostic: schema.autoHdrOutputMappings.diagnostic,
  }).from(schema.autoHdrHandoffs)
    .innerJoin(schema.autoHdrOutputMappings, eq(schema.autoHdrOutputMappings.handoffId, schema.autoHdrHandoffs.id))
    .where(eq(schema.autoHdrHandoffs.projectId, projectId))
    .orderBy(desc(schema.autoHdrHandoffs.generation)).get();
  if (!handoff) return c.json({ handoff: null });
  const associations = await db.select({
    assetId: schema.autoHdrFinalAssociations.assetId,
    readinessUnitKey: schema.autoHdrFinalAssociations.readinessUnitKey,
    matchKind: schema.autoHdrFinalAssociations.matchKind,
  }).from(schema.autoHdrFinalAssociations)
    .innerJoin(schema.assets, and(eq(schema.autoHdrFinalAssociations.assetId, schema.assets.id), isNull(schema.assets.supersededAt)))
    .where(eq(schema.autoHdrFinalAssociations.handoffId, handoff.id)).all();
  return c.json({
    handoff: {
      ...handoff,
      readinessUnits: JSON.parse(handoff.readinessUnitsJson),
      associations,
    },
  });
}));

projectsRoutes.get("/projects/:id/autohdr-history", requireCapability("adminBackend"), terminalRoute("/projects/:id/autohdr-history", async (c) => {
  const projectId = c.req.param("id");
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.assets.id,
    filename: schema.assets.originalFilename,
    sourcePath: schema.assets.sourcePath,
    sourcePathKey: schema.assets.sourcePathKey,
    contentHash: schema.assets.contentHash,
    handoffId: schema.assets.autoHdrHandoffId,
    supersededAt: schema.assets.supersededAt,
    replacedByAssetId: schema.assets.replacedByAssetId,
    createdAt: schema.assets.createdAt,
  }).from(schema.assets)
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "edited")))
    .where(eq(schema.assets.source, "dropbox"))
    .orderBy(desc(schema.assets.createdAt)).all();
  return c.json({ assets: rows });
}));

projectsRoutes.post("/projects/:id/autohdr-coverage", requireCapability("adminBackend"), terminalRoute("/projects/:id/autohdr-coverage", async (c) => {
  const projectId = c.req.param("id");
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden" }, 403);
  const data = await jsonInput(c, z.object({ handoffId: z.string().uuid(), assetId: z.string().uuid(), readinessUnitKey: z.string().min(1).max(240) }));
  if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const handoff = await db.select({ unitsJson: schema.autoHdrHandoffs.readinessUnitsJson }).from(schema.autoHdrHandoffs)
    .where(and(eq(schema.autoHdrHandoffs.id, data.handoffId), eq(schema.autoHdrHandoffs.projectId, projectId))).get();
  const asset = await db.select({ id: schema.assets.id }).from(schema.assets)
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "edited")))
    .where(and(eq(schema.assets.id, data.assetId), isNull(schema.assets.supersededAt))).get();
  const units = handoff ? JSON.parse(handoff.unitsJson) as { key: string }[] : [];
  if (!handoff || !asset || !units.some((unit) => unit.key === data.readinessUnitKey)) return c.json({ error: "Handoff, current asset, or readiness unit is invalid" }, 409);
  await db.insert(schema.autoHdrFinalAssociations).values({
    id: newId(), handoffId: data.handoffId, assetId: data.assetId,
    readinessUnitKey: data.readinessUnitKey, matchKind: "manual", createdAt: new Date(),
  }).onConflictDoNothing();
  await audit(c.env, c.get("user"), "autohdr.coverage.resolve", "asset", data.assetId, { projectId, handoffId: data.handoffId, readinessUnitKey: data.readinessUnitKey });
  return c.json({ ok: true });
}));

projectsRoutes.get("/projects/:id/selected-raw.zip", terminalRoute("/projects/:id/selected-raw.zip", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!roleHasCapability(c.get("user").role, "selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
  const db = createDb(c.env.DB);
  const selected = await db.select({ r2Key: schema.assets.r2Key, originalFilename: schema.assets.originalFilename, bytes: schema.assets.bytes })
    .from(schema.selections)
    .innerJoin(schema.assets, eq(schema.selections.assetId, schema.assets.id))
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id), eq(schema.collections.kind, "raw")))
    .where(eq(schema.selections.state, "selected_for_editing"))
    .orderBy(asc(schema.assets.createdAt))
    .all();
  if (!selected.length) return c.json({ error: "Select at least one RAW asset before downloading" }, 400);
  const project = await db.select({ street: schema.projects.street }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  const filename = `${(project?.street || id).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || id}-selected-raw.zip`;
  async function* entries() {
    for (const asset of selected) {
      const object = await c.env.MEDIA.get(asset.r2Key);
      if (!object) throw new Error(`Media object not found: ${asset.r2Key}`);
      yield { name: asset.originalFilename, size: asset.bytes, stream: object.body as ReadableStream<Uint8Array> };
    }
  }
  await audit(c.env, c.get("user"), "project.download_selected", "project", id, { count: selected.length });
  return new Response(createZipStream(entries()), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` } });
}));

projectsRoutes.post("/projects/:id/download-selection", terminalRoute("/projects/:id/download-selection", async (c) => {
  const projectId = c.req.param("id");
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  const data = await jsonInput(c, downloadSelectionInput); if (data instanceof Response) return data;
  const validated = await validateDownloadSelection(c, projectId, data.assetIds); if (validated instanceof Response) return validated;
  const db = createDb(c.env.DB);
  const now = new Date();
  const ticket = newId();
  await db.delete(schema.downloadSelectionTickets).where(lte(schema.downloadSelectionTickets.expiresAt, now));
  await db.insert(schema.downloadSelectionTickets).values({
    id: ticket,
    userId: validated.principal.id,
    projectId,
    assetIdsJson: JSON.stringify(data.assetIds),
    expiresAt: new Date(now.getTime() + DOWNLOAD_SELECTION_TICKET_MS),
    createdAt: now,
  });
  return c.json({ downloadUrl: `/api/projects/${projectId}/download-selection/${ticket}/archive.zip` }, 201);
}));

// `archive.zip` must remain a static path segment: in Hono, `:ticket.zip` creates a
// parameter named "ticket.zip", rather than a `ticket` parameter with a literal suffix.
projectsRoutes.get("/projects/:id/download-selection/:ticket/archive.zip", terminalRoute("/projects/:id/download-selection/:ticket/archive.zip", async (c) => {
  const projectId = c.req.param("id");
  const ticketId = c.req.param("ticket");
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  if (!idCheck(ticketId)) return c.json({ error: "Download selection not found" }, 404);
  const db = createDb(c.env.DB);
  const ticket = await db.select({ assetIdsJson: schema.downloadSelectionTickets.assetIdsJson })
    .from(schema.downloadSelectionTickets)
    .where(and(
      eq(schema.downloadSelectionTickets.id, ticketId),
      eq(schema.downloadSelectionTickets.projectId, projectId),
      eq(schema.downloadSelectionTickets.userId, c.get("user").id),
      gt(schema.downloadSelectionTickets.expiresAt, new Date()),
    )).get();
  if (!ticket) return c.json({ error: "Download selection not found" }, 404);
  let assetIds: string[];
  try {
    const parsed: unknown = JSON.parse(ticket.assetIdsJson);
    const result = downloadSelectionInput.safeParse({ assetIds: parsed });
    if (!result.success) throw new Error("invalid ticket asset ids");
    assetIds = result.data.assetIds;
  } catch {
    return c.json({ error: "Download selection not found" }, 404);
  }
  const validated = await validateDownloadSelection(c, projectId, assetIds); if (validated instanceof Response) return validated;
  const { entries: validatedEntries, collection, principal, totalBytes } = validated;
  const project = await db.select({ street: schema.projects.street }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  const safeName = (project?.street || projectId).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || projectId;
  const filename = `${safeName}-selection-${collection}.zip`;
  async function* entries() {
    for (const asset of validatedEntries) {
      const object = await c.env.MEDIA.get(asset.r2Key);
      if (!object) throw new Error(`Media object not found for download selection ${ticketId}: ${asset.r2Key}`);
      if (object.size !== asset.bytes) throw new Error(`Media object size mismatch for download selection ${ticketId}: ${asset.r2Key}`);
      yield { name: asset.originalFilename, size: asset.bytes, stream: object.body as ReadableStream<Uint8Array> };
    }
  }
  // This is an authorization/initiation audit, intentionally written before the streaming
  // response; a stream cannot truthfully establish that every byte reached the client.
  await audit(c.env, principal, "project.download_selection", "project", projectId, {
    collection, count: validatedEntries.length, totalBytes, assetIds,
  });
  return new Response(createZipStream(entries()), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}));

projectsRoutes.get("/projects/:id/manual-upload-jobs", requireCapability("adminBackend"), terminalRoute("/projects/:id/manual-upload-jobs", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.jobs.id, status: schema.jobs.status, error: schema.jobs.error,
  }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), inArray(schema.jobs.kind, ["manual_edited_publish", "manual_raw_publish"]))).orderBy(desc(schema.jobs.createdAt)).limit(50).all();
  return c.json({ jobs: rows });
}));

projectsRoutes.get("/projects/:id/jobs", requireCapability("adminBackend"), terminalRoute("/projects/:id/jobs", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.jobs.id, kind: schema.jobs.kind, status: schema.jobs.status, error: schema.jobs.error,
    correlationId: schema.jobs.correlationId,
    createdAt: schema.jobs.createdAt, updatedAt: schema.jobs.updatedAt,
  }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), inArray(schema.jobs.kind, ["autohdr_api_send", "autohdr", "fetch_edited", "autohdr_scaffold", "editor_reconcile", "editor_sync", "manual_edited_publish", "manual_raw_publish"]))).orderBy(desc(schema.jobs.createdAt)).limit(20).all();
  return c.json({ jobs: rows });
}));

projectsRoutes.post("/jobs/:id/retry", requireCapability("adminBackend"), terminalRoute("/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid job id" }, 400);
  const job = await createDb(c.env.DB).select({ id: schema.jobs.id, projectId: schema.jobs.projectId, kind: schema.jobs.kind, status: schema.jobs.status, payloadJson: schema.jobs.payloadJson })
    .from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  if (!job || !job.projectId || !["autohdr", "fetch_edited", "autohdr_scaffold", "editor_reconcile", "editor_sync", "manual_edited_publish", "manual_raw_publish"].includes(job.kind)) return c.json({ error: "Background job not found" }, 404);
  if (["autohdr", "fetch_edited", "autohdr_scaffold"].includes(job.kind)) {
    const variant = await boardSchemaVariant(c.env.DB);
    if (variant === "pre_0037") return boardSchemaMaintenance(c);
  }
  if (!await hasProjectAccess(c, job.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (job.status !== "stuck" && job.status !== "failed") return c.json({ error: "Only stuck or failed background jobs can be retried" }, 409);
  if (job.kind === "editor_reconcile" || job.kind === "editor_sync") {
    const result = job.kind === "editor_reconcile"
      ? await c.env.BACKGROUND.ensureEditorFolder(job.projectId)
      : await c.env.BACKGROUND.triggerEditorSync(job.projectId);
    if (!result) return c.json({ error: "Editor automation is disabled or this Project needs reviewed folder linking" }, 409);
    await audit(c.env, c.get("user"), "job.retry", "job", job.id, { newJobId: result.jobId });
    return c.json({ ok: true, jobId: result.jobId });
  }
  const isManualPublish = job.kind === "manual_edited_publish" || job.kind === "manual_raw_publish";
  const manualAssetId = isManualPublish ? (() => { try { const payload = JSON.parse(job.payloadJson ?? "{}"); return typeof payload.assetId === "string" ? payload.assetId : null; } catch { return null; } })() : null;
  if (isManualPublish && !manualAssetId) return c.json({ error: "Manual upload job has no asset" }, 409);
  const outcome = job.kind === "autohdr"
    ? await c.env.BACKGROUND.startAutoHdr(job.projectId, c.get("user").id, { resumeExisting: true })
    : job.kind === "fetch_edited"
      ? await c.env.BACKGROUND.fetchEditedFromAutoHdr(job.projectId)
      : job.kind === "autohdr_scaffold"
        ? { ok: true as const, jobId: await c.env.BACKGROUND.ensureAutoHdrScaffold(job.projectId).then((result) => result.jobId) }
        : { ok: true as const, jobId: await c.env.BACKGROUND.publishManualUpload(job.projectId, manualAssetId!).then((result) => result.jobId) };
  if (!outcome.ok) {
    return c.json(
      { error: outcome.message, code: outcome.code },
      outcome.code === "ERR_NO_RAW_SELECTION" ? 400 : 409,
    );
  }
  const jobId = outcome.jobId;
  await audit(c.env, c.get("user"), job.kind === "autohdr" ? "project.retry_autohdr" : job.kind === "fetch_edited" ? "project.retry_fetch_edited" : job.kind === "autohdr_scaffold" ? "project.retry_autohdr_scaffold" : job.kind === "manual_raw_publish" ? "project.retry_manual_raw_publish" : "project.retry_manual_edited_publish", "project", job.projectId, { previousJobId: id, jobId });
  return c.json({ jobId });
}));

for (const [path, archived] of [["/projects/:id/archive", true], ["/projects/:id/restore", false]] as const) projectsRoutes.post(path, terminalRoute(path, async (c) => {
  if (!roleHasCapability(c.get("user").role, "archiveProject")) return c.json({ error: "Forbidden", capability: "archiveProject" }, 403);
  const variant = await boardSchemaVariant(c.env.DB);
  if (variant === "pre_0037") return boardSchemaMaintenance(c);
  if (!await boardContractEnabled(c.env.DB, variant)) return boardContractDisabled(c);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  const now = new Date();
  const classifyLoser = async (source: ProjectArchiveSource | null) => {
    const current = await c.env.DB.prepare("SELECT id, archived_at AS archivedAt, stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?")
      .bind(id).first<{ id: string; archivedAt: number | null; stageKey: StageKey; boardRevision: number }>();
    const hasActiveUpload = archived && Boolean(await c.env.DB.prepare("SELECT id FROM document_uploads WHERE project_id = ? AND status IN ('pending', 'completing', 'aborting') LIMIT 1").bind(id).first<{ id: string }>());
    const outcome = classifyProjectArchiveLoser({ archived, source, current, hasActiveUpload });
    if (outcome.kind === "not_found") return c.json({ error: "Project not found" }, 404);
    if (outcome.kind === "already_done") return c.json({ ok: true });
    if (outcome.kind === "active_upload") return c.json({ error: "Active document uploads must be aborted before archiving." }, 409);
    return c.json({
      error: archived ? "Project changed while archiving." : "Project changed while restoring.",
      code: "project_stage_conflict",
      current: { projectId: id, stageKey: outcome.current.stageKey, boardRevision: Number(outcome.current.boardRevision) },
    }, 409);
  };
  if (archived) {
    // Ownership survives archive: retire the mapping and tombstone both permanent candidate
    // claims, never release them for silent reuse.
    const archivedAt = now.getTime();
    const archiveAuditId = newId();
    const archiveActivityId = newId();
    const archiveActivity: ProjectActivityIntent = {
      schemaVersion: 1,
      activity: { id: archiveActivityId, type: "project.archived", projectId: id, actorId: c.get("user").id, occurredAt: archivedAt, source: { kind: "project", id, key: `project:${id}:archived:${archiveAuditId}` }, safePayload: {}, deepLink: projectActivityDeepLink("project.archived", id) },
      broadDelivery: { registryKey: "project.archived", sourceActivityId: archiveActivityId, coalesce: null },
    };
    const archiveActivityStatements = buildProjectActivityStatements({ db: c.env.DB, intent: archiveActivity, winnerAuditId: archiveAuditId, createdAt: archivedAt });
    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
    if (!source) {
      return classifyLoser(null);
    }
    const deadlineSuppression = buildDeadlineSuppressionBundle({ db: c.env.DB, projectId: id, now: archivedAt, reason: "project_archived", auditId: archiveAuditId });
    const archiveStatementStart = 8;
    const result = await c.env.DB.batch([
        c.env.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ?, board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NULL AND stage_key = ? AND board_revision = ? AND NOT EXISTS (SELECT 1 FROM document_uploads WHERE project_id = ? AND status in ('pending', 'completing', 'aborting')) RETURNING id")
        .bind(archivedAt, c.get("user").id, archivedAt, id, source.stageKey, source.boardRevision, id),
      c.env.DB.prepare(`
        INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?, ?, 'project.archive', 'project', ?, ?, ?
        WHERE changes() = 1 RETURNING id
      `).bind(archiveAuditId, c.get("user").id, id, auditMeta(c.get("user")), archivedAt),
      ...deadlineSuppression.statements,
      c.env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'retired', retired_at = ?, updated_at = ? WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, archivedAt, id, id, archivedAt),
      c.env.DB.prepare("UPDATE autohdr_path_claims SET state = 'tombstone', updated_at = ? WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, id, id, archivedAt),
      c.env.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired', updated_at = ? WHERE project_id = ? AND state in ('starting', 'started', 'blocked') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, id, id, archivedAt),
      ...archiveActivityStatements.statements,
      // After the activity statements, so archiveStatementStart and the positional reads stay valid. Pending Subtask reminders are
      // superseded and any written but unsent one is suppressed (#424). Restore recomputes the future ones.
      ...buildSubtaskReminderSuppression({ db: c.env.DB, scope: { kind: "project", projectId: id }, reason: "project_archived", now: archivedAt, gateAuditId: archiveAuditId }).statements,
    ]);
    if ((result[0]?.meta.changes ?? 0) !== 1) {
      return classifyLoser(source);
    }
    const publicationIds = rowsFromD1<{ id: string }>(result[archiveStatementStart + archiveActivityStatements.broadOutboxIndex]).map((row) => row.id);
    if (publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  } else {
    const restoreAuditId = newId(); const restoreActivityId = newId();
    const restoreActivity: ProjectActivityIntent = {
      schemaVersion: 1,
      activity: { id: restoreActivityId, type: "project.restored", projectId: id, actorId: c.get("user").id, occurredAt: now.getTime(), source: { kind: "project", id, key: `project:${id}:restored:${restoreAuditId}` }, safePayload: {}, deepLink: projectActivityDeepLink("project.restored", id) },
      broadDelivery: { registryKey: "project.restored", sourceActivityId: restoreActivityId, coalesce: null },
    };
    const restoreActivityStatements = buildProjectActivityStatements({ db: c.env.DB, intent: restoreActivity, winnerAuditId: restoreAuditId, createdAt: now.getTime() });
    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NOT NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
    if (!source) {
      return classifyLoser(null);
    }
    const result = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL, board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL AND stage_key = ? AND board_revision = ? RETURNING id").bind(now.getTime(), id, source.stageKey, source.boardRevision),
      c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'project.restore', 'project', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(restoreAuditId, c.get("user").id, id, auditMeta(c.get("user")), now.getTime()),
      ...restoreActivityStatements.statements,
      // Recompute the future Subtask reminders of the restored Project (#424). Only fire times still ahead are written.
      ...buildSubtaskReminderMaterialization({ db: c.env.DB, scope: { kind: "project", projectId: id }, now: now.getTime(), createdBy: c.get("user").id, gateAuditId: restoreAuditId }).statements,
    ]);
    const restored = rowsFromD1<{ id: string }>(result[0]).length > 0;
    if (!restored) {
      return classifyLoser(source);
    }
    const publicationIds = rowsFromD1<{ id: string }>(result[2 + restoreActivityStatements.broadOutboxIndex]).map((row) => row.id);
    if (publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  }
  return c.json({ ok: true });
}));
projectsRoutes.delete("/projects/:id", terminalRoute("/projects/:id", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  // Keep this constant pre-lookup: a caller without the destructive capability must not learn
  // whether a project id exists from a 404/403 distinction.
  if (!roleHasCapability(c.get("user").role, "adminBackend")) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB); const project = await db.select({ id: schema.projects.id, street: schema.projects.street, orderId: schema.projects.orderId, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (!project.archivedAt) return c.json({ error: "Archive the project before deleting it." }, 409);
  const activeJobs = (await db.select({ count: sql<number>`count(*)` }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), inArray(schema.jobs.status, ["queued", "running"]))).get())?.count ?? 0;
  if (activeJobs) return c.json({ error: "Background work is still running for this project — wait for it to finish and try again.", activeJobs }, 409);
  const activeDocuments = (await db.select({ count: sql<number>`count(*)` }).from(schema.documentUploads).where(and(eq(schema.documentUploads.projectId, id), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`)).get())?.count ?? 0;
  if (activeDocuments) {
    // Abort known R2 uploads and terminally fail their reservations before permitting a
    // destructive retry. This leaves late presigned PUTs untracked only until their <=1h URL
    // expiry, and prevents the project cascade from erasing the ownership record first.
    await abortActiveDocumentSessions(c, id);
    return c.json({ error: "Active document uploads were aborted. Confirm deletion again after the sessions are terminal.", activeDocuments }, 409);
  }
  // Abort any embedded-media upload that was started but never completed, so no upload outlives the Project (fast path).
  // An abort that fails is not forgotten: the batch below queues every media key before the cascade erases the rows, and the
  // queue entries of uploads whose abort failed survive until the background sweep has aborted them and deleted the object.
  const startedUploads = (await c.env.DB.prepare("SELECT original_key, upload_id FROM embedded_media WHERE project_id = ? AND state = 'uploading'").bind(id).all<{ original_key: string; upload_id: string | null }>()).results;
  const unresolvedUploadKeys: string[] = [];
  await Promise.all(startedUploads.map(async (row) => {
    // A dev-direct upload has no upload id: nothing to abort, but its key stays queued like any in-flight upload.
    if (!row.upload_id) { unresolvedUploadKeys.push(row.original_key); return; }
    try { await abortMultipart(c.env, row.original_key, row.upload_id); } catch { unresolvedUploadKeys.push(row.original_key); }
  }));
  const r2Prefix = `projects/${id}/`;
  const assetIds = (await db.select({ id: schema.assets.id }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.collections.projectId, id)).all()).map((asset) => asset.id);
  const assetCount = assetIds.length;
  // Audit BEFORE destruction so the trail survives even if a later step dies mid-way.
  await audit(c.env, c.get("user"), "project.delete", "project", id, { street: project.street, orderId: project.orderId, assetCount, r2Prefix });
  // #498 (ADR 0017): the Project whiteboard's Durable Object holds the live board outside D1 and R2,
  // so tear it down beside the R2 purge. It runs first and idempotently: a failure leaves the Project
  // archived with every other store intact, so the delete can simply be retried.
  try { await c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(id)).purge(); }
  catch (error) {
    console.error("Project whiteboard purge failed", { event: "project_whiteboard_purge_failed", projectId: id, message: error instanceof Error ? error.message : String(error) });
    return c.json({ error: "The project whiteboard could not be cleared. Nothing else was deleted; try again." }, 502);
  }
  const keys: string[] = [];
  for (const prefix of [r2Prefix, ...assetIds.map((assetId) => `renditions/${assetId}/`)]) {
    let cursor: string | undefined;
    while (true) {
      const page = await c.env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map((object) => object.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }
  for (let index = 0; index < keys.length; index += 1000) await c.env.MEDIA.delete(keys.slice(index, index + 1000));
  const deletedAt = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM autohdr_path_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_fetch_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_final_associations WHERE handoff_id IN (SELECT id FROM autohdr_handoffs WHERE project_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM edited_source_claims WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_output_mappings WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_handoffs WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM raw_reconciliation_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM jobs WHERE project_id = ?").bind(id),
    // No FK to projects/assets, so the cascade below misses these (orphans swept by hand 2026-09-28).
    c.env.DB.prepare("DELETE FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM notification_outbox WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM rendition_dlq_events WHERE asset_id IN (SELECT assets.id FROM assets INNER JOIN collections ON collections.id = assets.collection_id WHERE collections.project_id = ?)").bind(id),
    // Tombstone BEFORE the project row goes: Tonomo re-sends an order on every change and would
    // otherwise recreate the Project (its order_id is lost with the row). Same batch, so either both
    // happen or neither. A live Project holding the order_id still wins over a tombstone.
    c.env.DB.prepare("INSERT INTO tonomo_order_tombstones (order_id, deleted_project_id, street, deleted_at, deleted_by, source, created_at) SELECT order_id, id, street, ?, ?, 'project_delete', ? FROM projects WHERE id = ? AND order_id IS NOT NULL AND TRIM(order_id) != '' ON CONFLICT(order_id) DO UPDATE SET deleted_project_id=excluded.deleted_project_id, street=excluded.street, deleted_at=excluded.deleted_at, deleted_by=excluded.deleted_by, source=excluded.source").bind(deletedAt, c.get("user").id, deletedAt, id),
    // Cleanup ownership survives the cascade: every media key of this Project (plus the upload id of one still uploading) is queued first.
    c.env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) SELECT original_key, CASE WHEN state = 'uploading' THEN upload_id END, project_id, ? FROM embedded_media WHERE project_id = ? ON CONFLICT(storage_key) DO NOTHING").bind(deletedAt, id),
    c.env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) SELECT display_key, NULL, project_id, ? FROM embedded_media WHERE project_id = ? AND display_key IS NOT NULL ON CONFLICT(storage_key) DO NOTHING").bind(deletedAt, id),
    c.env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) SELECT poster_key, NULL, project_id, ? FROM embedded_media WHERE project_id = ? AND poster_key IS NOT NULL ON CONFLICT(storage_key) DO NOTHING").bind(deletedAt, id),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id),
  ]);
  // Dequeue only what THIS request resolved: a key it queued in the batch above (queued_at = deletedAt), whose object the purge deleted,
  // and whose upload (if any) it aborted. Entries queued by anyone else (a sweep whose abort failed, a completion mid-purge) and uploads
  // whose abort failed here all stay for the drain. Never a Project-wide delete.
  const deletedKeys = new Set(keys); const unresolved = new Set(unresolvedUploadKeys);
  const mine = (await c.env.DB.prepare("SELECT storage_key FROM embedded_media_cleanup WHERE project_id = ? AND queued_at = ?").bind(id, deletedAt).all<{ storage_key: string }>()).results
    .map((row) => row.storage_key).filter((key) => deletedKeys.has(key) && !unresolved.has(key));
  for (let index = 0; index < mine.length; index += 50) {
    const chunk = mine.slice(index, index + 50);
    await c.env.DB.prepare(`DELETE FROM embedded_media_cleanup WHERE queued_at = ? AND storage_key IN (${chunk.map(() => "?").join(",")})`).bind(deletedAt, ...chunk).run();
  }
  return c.json({ ok: true, deletedObjects: keys.length });
}));
const stageHandler = async (c: Context<AppEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (isExactLegacyStageBody(body) || isRetiredBetweenPlacement(body)) {
    return c.json({ error: "Reload the application before moving this project.", code: "stage_contract_reload_required" }, 409);
  }
  const parsed = moveProjectStageRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
  const result = await moveProjectStage({ env: c.env, principal: c.get("user"), projectId: id, request: parsed.data as MoveProjectStageRequest });
  if (result.kind === "moved") {
    if (result.finalizer.publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, result.finalizer.publicationIds));
    if (result.shootDateFilled) c.executionCtx.waitUntil(queueProjectShootDateFollowUps(c.env, id));
    return c.json(result.response);
  }
  if (result.kind === "no_change") return c.json(result.response);
  if (result.kind === "forbidden") return c.json({ error: "Forbidden", capability: result.capability }, 403);
  if (result.kind === "not_found") return c.json({ error: "Project not found" }, 404);
  if (result.kind === "archived") return c.json({ error: "Project is archived and read-only.", code: "project_archived_read_only", current: result.current }, 409);
  if (result.kind === "inactive_destination") return c.json({ error: "Destination Stage is inactive.", code: "inactive_destination", current: result.current }, 409);
  if (result.kind === "confirmation_required") return c.json({
    error: "Confirmation is required for this Stage move.", code: "stage_confirmation_required",
    requiredConfirmation: {
      fromStageKey: result.required.fromStageKey,
      toStageKey: result.required.toStageKey,
      reasons: result.required.reasons,
    },
    current: result.current,
  }, 409);
  if (result.kind === "conflict") {
    if (result.shootDateFilled) c.executionCtx.waitUntil(queueProjectShootDateFollowUps(c.env, id));
    return c.json({ error: "Project stage changed; reload and try again.", code: "project_stage_conflict", current: result.current }, 409);
  }
  if (result.kind === "disabled") return boardContractDisabled(c);
  if (result.kind === "schema_maintenance") return boardSchemaMaintenance(c);
  return c.json({ error: "Stage move failed" }, 500);
};
projectsRoutes.post("/projects/:id/stage", terminalRoute("/projects/:id/stage", stageHandler));
projectsRoutes.post("/projects/:id/stage/", terminalRoute("/projects/:id/stage/", stageHandler));
projectsRoutes.get("/projects/:id", terminalRoute("/projects/:id", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (c.get("user").role === "external_editor") {
    const value = await readExternalProjectDetail(c.env, c.get("user").id, c.get("user").role, id);
    return value ? c.json(value) : c.json({ error: "Project not found" }, 404);
  }
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const variant = await boardSchemaVariant(c.env.DB);
  const value = await details(createDb(c.env.DB), c.env.DB, id, c.get("user").role, variant, await boardContractEnabled(c.env.DB, variant), c.get("user").role === "photographer", c.env);
  return value ? c.json(value) : c.json({ error: "Project not found" }, 404);
}));
