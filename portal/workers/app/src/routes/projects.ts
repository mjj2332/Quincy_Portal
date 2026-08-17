import { Hono } from "hono";
import type { Context } from "hono";
import { appendToStageBottomExpr, computeInsertPosition, createDb, dashboardProjectOrder, orderDashboardStreetTies, schema } from "@quincy/db";
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { COLLECTION_KINDS, computeRemovalAssetIds, DOWNLOAD_SELECTION_MAX_ASSETS, DOWNLOAD_SELECTION_MAX_BYTES, isStageKey, PHOTOGRAPHER_VISIBLE_STAGES, ROLE_CAPABILITIES, roleHasCapability, type CollectionKind } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, hasProjectAccessForUser, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { notifyProject, notifyProjectAssignments } from "../lib/notifications";
import { insertProjectMembers, syncProjectMembersAndClearSubtaskAssignments } from "../lib/project-members";
import { createZipStream } from "../lib/zip-stream";
import { jsonInput } from "./helpers";
import { ensurePipelineStages, projectStageForRole } from "./stages";
import { abortMultipart } from "../lib/r2s3";
import { isUserVisibleAsset } from "../lib/asset-visibility";
import { manualInsertNeighbors, needsPositionRenumber, orderedBoardRows, priorityInsertNeighbors, renumberedInsertPosition, type BoardRow } from "../lib/kanban-ordering";

const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullable().optional();
const projectFields = z.object({ street: z.string().min(1), suburb: nullable(z.string()), postcode: nullable(z.string()), agencyName: nullable(z.string()), agentName: nullable(z.string()), agentEmail: nullable(z.string().email()), agentPhone: nullable(z.string()), agencyId: nullable(z.string().uuid()), agentId: nullable(z.string().uuid()), shootDate: nullable(z.string()), timeWindow: nullable(z.string()), orderNo: nullable(z.string()), orderId: nullable(z.string()), invoiceAmount: nullable(z.number()), paymentStatus: nullable(z.string()), notes: nullable(z.string()), rawFolderLink: nullable(z.string().url()), rawFolderPath: nullable(z.string()), orderedServices: z.array(z.enum(COLLECTION_KINDS)).optional(), photographerUserIds: z.array(z.string().uuid()).optional(), editorUserIds: z.array(z.string().uuid()).optional() });
const editFields = projectFields.partial();
const coverInput = z.object({ assetId: z.string().uuid().nullable() });
const priorityInput = z.object({ priority: z.number().int().min(1).max(10).nullable() });
const boardPositionInput = z.object({ direction: z.enum(["up", "down"]) });
const downloadSelectionInput = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(DOWNLOAD_SELECTION_MAX_ASSETS)
    .superRefine((assetIds, ctx) => {
      if (new Set(assetIds).size !== assetIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Asset IDs must be unique" });
    }),
}).strict();
const idCheck = (v: string) => z.string().uuid().safeParse(v).success;
const DOWNLOAD_SELECTION_TICKET_MS = 5 * 60 * 1000;
const unavailableSelectionError = "One or more selected assets are not available in this project";
const unsupportedSelectionError = "Download Selection supports one RAW or Edited photo selection";

async function guardedBoardUpdate(
  db: ReturnType<typeof createDb>,
  d1: D1Database,
  target: BoardRow,
  rows: BoardRow[],
  beforeId: string | null,
  afterId: string | null,
  position: number,
  newPriority: number | null | undefined,
) {
  const before = beforeId ? rows.find((row) => row.id === beforeId)?.boardPosition ?? null : null;
  const after = afterId ? rows.find((row) => row.id === afterId)?.boardPosition ?? null : null;
  const renumber = needsPositionRenumber(position, before, after);
  const snapshot = target.stageKey;

  if (!renumber) {
    const values = newPriority === undefined
      ? { boardPosition: position, updatedAt: new Date() }
      : { priority: newPriority, boardPosition: position, updatedAt: new Date() };
    const result = await db.update(schema.projects).set(values).where(and(eq(schema.projects.id, target.id), eq(schema.projects.stageKey, snapshot), isNull(schema.projects.archivedAt))).returning({ priority: schema.projects.priority, boardPosition: schema.projects.boardPosition }).all();
    return result[0] ?? null;
  }

  const { renumbered, position: recomputedPosition } = renumberedInsertPosition(rows, beforeId, afterId);
  const sorted = orderedBoardRows(rows);
  const statements = sorted.map((row) => d1.prepare(
    "UPDATE projects SET board_position = ? WHERE id = ? AND stage_key = ? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL)",
  ).bind(renumbered.get(row.id), row.id, snapshot, target.id, snapshot));
  const finalSql = newPriority === undefined
    ? "UPDATE projects SET board_position = ?, updated_at = ? WHERE id = ? AND stage_key = ? AND archived_at IS NULL"
    : "UPDATE projects SET priority = ?, board_position = ?, updated_at = ? WHERE id = ? AND stage_key = ? AND archived_at IS NULL";
  const finalStatement = newPriority === undefined
    ? d1.prepare(finalSql).bind(recomputedPosition, Date.now(), target.id, snapshot)
    : d1.prepare(finalSql).bind(newPriority, recomputedPosition, Date.now(), target.id, snapshot);
  const result = await d1.batch([...statements, finalStatement]);
  if ((result.at(-1)?.meta.changes ?? 0) !== 1) return null;
  return { priority: newPriority === undefined ? target.priority : newPriority, boardPosition: recomputedPosition };
}

type DropboxSyncResult = {
  raw: { jobId: string } | { skipped: "no_raw_folder" | "not_permitted" | "error"; message?: string };
  edited: { jobId: string } | { skipped: "not_ready" | "not_admin" | "error"; message?: string } | { blocked: { code: string; message: string } };
};

function chunked<T>(items: T[], size = 80): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

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
  principal: { id: string; role: AppEnv["Variables"]["user"]["role"] };
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
  return { entries, collection, totalBytes, principal: { id: principal.id, role: principal.role } };
}

async function coverMaps(db: ReturnType<typeof createDb>, projectIds: string[], photographersOnlySeeRaw = false) {
  const storedByProject = new Map<string, string>();
  const automaticByProject = new Map<string, string>();
  for (const ids of chunked(projectIds)) {
    // Mirror media.ts: photographers may only view RAW assets.
    const storedCollectionJoin = photographersOnlySeeRaw
      ? and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw"), sql`${schema.assets.supersededAt} IS NULL`)
      : and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id), sql`(${schema.collections.kind} <> 'edited' OR ${schema.assets.publishStatus} = 'ready')`, sql`${schema.assets.supersededAt} IS NULL`);
    // D1/Drizzle mis-renders correlated scalar subqueries. Keep both lookups set-based;
    // the grouped RAW query uses SQLite's bare-column-with-min() behaviour for its asset id.
    const [storedCovers, automaticCovers] = await Promise.all([
      db.select({ projectId: schema.projects.id, assetId: schema.assets.id }).from(schema.projects)
        .innerJoin(schema.assets, eq(schema.projects.coverAssetId, schema.assets.id))
        .innerJoin(schema.collections, storedCollectionJoin)
        .where(inArray(schema.projects.id, ids)).all(),
      db.select({ projectId: schema.collections.projectId, assetId: schema.assets.id, filename: sql<string>`min(${schema.assets.originalFilename})` }).from(schema.assets)
        .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
        .where(and(inArray(schema.collections.projectId, ids), eq(schema.collections.kind, "raw"), sql`${schema.assets.supersededAt} IS NULL`))
        .groupBy(schema.collections.projectId).all(),
    ]);
    for (const row of storedCovers) storedByProject.set(row.projectId, row.assetId);
    for (const row of automaticCovers) automaticByProject.set(row.projectId, row.assetId);
  }
  return { storedByProject, automaticByProject };
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
async function details(db: ReturnType<typeof createDb>, projectId: string, role: AppEnv["Variables"]["user"]["role"], viewerSeesRawOnly = false) {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return null;
  const [{ storedByProject, automaticByProject }, collections, members] = await Promise.all([
    coverMaps(db, [projectId], viewerSeesRawOnly),
    db.select().from(schema.collections).where(eq(schema.collections.projectId, projectId)).all(),
    db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId, roleOnProject: schema.projectMembers.roleOnProject, name: schema.user.name, email: schema.user.email }).from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id)).where(eq(schema.projectMembers.projectId, projectId)).all(),
  ]);
  return projectStageForRole({ ...project, effectiveCoverAssetId: storedByProject.get(projectId) ?? automaticByProject.get(projectId) ?? null, collections, members }, role);
}
export const projectsRoutes = new Hono<AppEnv>();
projectsRoutes.get("/projects", async (c) => {
  const db = createDb(c.env.DB); const user = c.get("user");
  const archived = c.req.query("archived") === "1" && ROLE_CAPABILITIES[user.role].includes("adminBackend");
  const archivedFilter = archived ? isNotNull(schema.projects.archivedAt) : isNull(schema.projects.archivedAt);
  const base = db.select({ project: schema.projects, receivedCount: schema.collections.receivedCount, expectedCount: schema.collections.expectedCount }).from(schema.projects).leftJoin(schema.collections, and(eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw")));
  const rows = user.role === "photographer"
    ? await base.where(and(archivedFilter, exists(db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))), inArray(schema.projects.stageKey, PHOTOGRAPHER_VISIBLE_STAGES))).orderBy(...dashboardProjectOrder).all()
    : await base.where(archivedFilter).orderBy(...dashboardProjectOrder).all();
  const orderedRows = orderDashboardStreetTies(rows);
  const projectIds = orderedRows.map(({ project }) => project.id);
  const { storedByProject, automaticByProject } = await coverMaps(db, projectIds, user.role === "photographer");
  return c.json({ projects: orderedRows.map((r) => projectStageForRole({ ...r.project, coverAssetId: storedByProject.get(r.project.id) ?? automaticByProject.get(r.project.id) ?? null, receivedCount: r.receivedCount ?? 0, expectedCount: r.expectedCount }, user.role)) });
});
projectsRoutes.post("/projects", requireCapability("createProject"), async (c) => {
  const data = await jsonInput(c, projectFields); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId(); const { orderedServices, photographerUserIds, editorUserIds, ...fields } = data;
  await db.insert(schema.projects).values({ id, ...fields, stageKey: "awaiting_raw", boardPosition: appendToStageBottomExpr("awaiting_raw", id), createdAt: new Date(), updatedAt: new Date() });
  if (fields.rawFolderPath !== undefined) {
    await c.env.BACKGROUND.ensureAutoHdrScaffold(id).catch((error) =>
      console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
  }
  const services = await addCollections(db, id, orderedServices);
  const photographerAdded = await insertProjectMembers(db, id, photographerUserIds ?? [], "photographer");
  const editorAdded = await insertProjectMembers(db, id, editorUserIds ?? [], "editor");
  await notifyProjectAssignments(c.env, id, [
    ...photographerAdded.map((userId) => ({ userId, roleOnProject: "photographer" as const })),
    ...editorAdded.map((userId) => ({ userId, roleOnProject: "editor" as const })),
  ]);
  await audit(c.env, c.get("user").id, "project.create", "project", id, { orderedServices: [...services] });
  return c.json(await details(db, id, c.get("user").role), 201);
});

projectsRoutes.post("/projects/:id/priority", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("prioritizeProjects")) return c.json({ error: "Forbidden", capability: "prioritizeProjects" }, 403);
  const data = await jsonInput(c, priorityInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const target = await db.select({ id: schema.projects.id, stageKey: schema.projects.stageKey, priority: schema.projects.priority, boardPosition: schema.projects.boardPosition })
    .from(schema.projects).where(and(eq(schema.projects.id, id), isNull(schema.projects.archivedAt))).get() as BoardRow | undefined;
  if (!target) return c.json({ error: "Project not found" }, 404);
  const others = await db.select({ id: schema.projects.id, stageKey: schema.projects.stageKey, priority: schema.projects.priority, boardPosition: schema.projects.boardPosition })
    .from(schema.projects).where(and(eq(schema.projects.stageKey, target.stageKey), isNull(schema.projects.archivedAt), sql`${schema.projects.id} <> ${id}`)).all() as BoardRow[];
  const desiredPriority = data.priority;
  const neighbors = priorityInsertNeighbors([target, ...others], id, desiredPriority);
  const { beforeId, afterId, before, after } = neighbors;
  const position = computeInsertPosition(before, after);
  const result = await guardedBoardUpdate(db, c.env.DB, target, [target, ...others], beforeId, afterId, position, data.priority);
  if (!result) return c.json({ error: "Project stage changed while priority was being updated" }, 409);
  await audit(c.env, c.get("user").id, "project.priority_set", "project", id, { from: target.priority, to: data.priority });
  return c.json({ priority: result.priority, boardPosition: result.boardPosition });
});

projectsRoutes.post("/projects/:id/board-position", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("prioritizeProjects")) return c.json({ error: "Forbidden", capability: "prioritizeProjects" }, 403);
  const data = await jsonInput(c, boardPositionInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const rows = await db.select({ id: schema.projects.id, stageKey: schema.projects.stageKey, priority: schema.projects.priority, boardPosition: schema.projects.boardPosition })
    .from(schema.projects).where(and(isNull(schema.projects.archivedAt), eq(schema.projects.id, id))).get();
  if (!rows) return c.json({ error: "Project not found" }, 404);
  const target = rows as BoardRow;
  const column = orderedBoardRows(await db.select({ id: schema.projects.id, stageKey: schema.projects.stageKey, priority: schema.projects.priority, boardPosition: schema.projects.boardPosition })
    .from(schema.projects).where(and(eq(schema.projects.stageKey, target.stageKey), isNull(schema.projects.archivedAt))).all() as BoardRow[]);
  const neighbors = manualInsertNeighbors(column, id, data.direction);
  if (!neighbors) return c.json({ boardPosition: target.boardPosition });
  const { beforeId, afterId, before, after } = neighbors;
  const position = computeInsertPosition(before, after);
  const result = await guardedBoardUpdate(db, c.env.DB, target, column, beforeId, afterId, position, undefined);
  if (!result) return c.json({ error: "Project stage changed while board position was being updated" }, 409);
  await audit(c.env, c.get("user").id, "project.board_position_set", "project", id, { direction: data.direction });
  return c.json({ boardPosition: result.boardPosition });
});
projectsRoutes.patch("/projects/:id", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    if (!ROLE_CAPABILITIES[c.get("user").role].includes("editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
    const data = await jsonInput(c, editFields); if (data instanceof Response) return data;
    const db = createDb(c.env.DB); if (!await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, id)).get()) return c.json({ error: "Project not found" }, 404);
    const { orderedServices, photographerUserIds, editorUserIds, ...projectUpdates } = data;
    const auditMeta: Record<string, unknown> = { ...projectUpdates };
    if (orderedServices !== undefined) {
      // Grouped counts merged in JS — a correlated scalar subquery via sql`${schema.assets}` renders
      // incorrectly under drizzle/D1 and silently returned 0 (caught by the blocked-payload tests).
      const countsFor = async (collectionIds: string[]) => {
        const [assetRows, manifestRows, documentRows] = await Promise.all([
          db.select({ collectionId: schema.assets.collectionId, n: sql<number>`count(*)` }).from(schema.assets).where(inArray(schema.assets.collectionId, collectionIds)).groupBy(schema.assets.collectionId).all(),
          db.select({ collectionId: schema.uploadManifests.collectionId, n: sql<number>`count(*)` }).from(schema.uploadManifests).where(inArray(schema.uploadManifests.collectionId, collectionIds)).groupBy(schema.uploadManifests.collectionId).all(),
          db.select({ collectionId: schema.documentUploads.collectionId, n: sql<number>`count(*)` }).from(schema.documentUploads).where(and(inArray(schema.documentUploads.collectionId, collectionIds), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`)).groupBy(schema.documentUploads.collectionId).all(),
        ]);
        return { assets: new Map(assetRows.map((row) => [row.collectionId, row.n])), manifests: new Map(manifestRows.map((row) => [row.collectionId, row.n])), documents: new Map(documentRows.map((row) => [row.collectionId, row.n])) };
      };
      const existing = await db.select({ id: schema.collections.id, kind: schema.collections.kind, receivedCount: schema.collections.receivedCount }).from(schema.collections).where(eq(schema.collections.projectId, id)).all();
      const desiredServices = new Set<CollectionKind>(["raw", ...orderedServices]);
      const removedCollections = existing.filter((collection) => collection.kind !== "raw" && !desiredServices.has(collection.kind as CollectionKind));
      const blockedPayload = (list: typeof removedCollections, counts: Awaited<ReturnType<typeof countsFor>>, removedKinds: string[] = []) =>
        c.json({ error: "Services with received media or active document uploads cannot be removed.", blocked: list.map((collection) => ({ kind: collection.kind, assetCount: counts.assets.get(collection.id) ?? 0, manifestCount: counts.manifests.get(collection.id) ?? 0, activeDocumentSessions: counts.documents.get(collection.id) ?? 0 })), ...(removedKinds.length ? { removed: removedKinds } : {}) }, 409);
      if (removedCollections.length) {
        // Pre-screen so the COMMON blocked case mutates nothing at all (no partial removals on 409).
        const pre = await countsFor(removedCollections.map((collection) => collection.id));
        const links = await db.select({ collectionId: schema.collectionLinks.collectionId, n: sql<number>`count(*)` }).from(schema.collectionLinks).where(inArray(schema.collectionLinks.collectionId, removedCollections.map((collection) => collection.id))).groupBy(schema.collectionLinks.collectionId).all();
        const linkCounts = new Map(links.map((row) => [row.collectionId, row.n]));
        const preBlocked = removedCollections.filter((collection) => collection.receivedCount > 0 || (pre.assets.get(collection.id) ?? 0) > 0 || (pre.manifests.get(collection.id) ?? 0) > 0 || (pre.documents.get(collection.id) ?? 0) > 0 || (linkCounts.get(collection.id) ?? 0) > 0);
        if (preBlocked.length) return blockedPayload(preBlocked, pre);
      }
      // Correctness (no cascade-deleting a mid-flight upload) lives in the guarded DELETE itself —
      // the pre-screen above only shapes UX. A race between the two can still block a delete here;
      // in that rare case we audit what WAS removed and report both halves honestly.
      const guardedDeletes = await Promise.all(removedCollections.map((collection) => db.delete(schema.collections).where(and(eq(schema.collections.id, collection.id), eq(schema.collections.receivedCount, 0), notExists(db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.collectionId, schema.collections.id))), notExists(db.select({ id: schema.collectionLinks.id }).from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, schema.collections.id))), notExists(db.select({ id: schema.uploadManifests.id }).from(schema.uploadManifests).where(eq(schema.uploadManifests.collectionId, schema.collections.id))), notExists(db.select({ id: schema.documentUploads.id }).from(schema.documentUploads).where(and(eq(schema.documentUploads.collectionId, schema.collections.id), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`))))).returning({ id: schema.collections.id })));
      const deletedIds = new Set(guardedDeletes.flatMap((rows) => rows.map((row) => row.id)));
      const guardedBlocked = removedCollections.filter((collection) => !deletedIds.has(collection.id));
      if (guardedBlocked.length) {
        const removedKinds = removedCollections.filter((collection) => deletedIds.has(collection.id)).map((collection) => collection.kind);
        if (removedKinds.length) await audit(c.env, c.get("user").id, "project.update", "project", id, { servicesRemoved: removedKinds, partial: true });
        return blockedPayload(guardedBlocked, await countsFor(guardedBlocked.map((collection) => collection.id)), removedKinds);
      }
      const existingKinds = new Set(existing.map((collection) => collection.kind as CollectionKind));
      const services = await addCollections(db, id, orderedServices);
      auditMeta.servicesAdded = [...services].filter((kind) => !existingKinds.has(kind));
      auditMeta.servicesRemoved = removedCollections.map((collection) => collection.kind);
    }
    const [existingPhotographers, existingEditors] = await Promise.all([
      photographerUserIds === undefined ? Promise.resolve(undefined) : db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.roleOnProject, "photographer"))).all(),
      editorUserIds === undefined ? Promise.resolve(undefined) : db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, id), eq(schema.projectMembers.roleOnProject, "editor"))).all(),
    ]);
    // Derive both role diffs before making a write. The one D1 batch then performs every
    // membership INSERT...RETURNING / DELETE plus the post-diff subtask scrub atomically.
    const membershipPlans = [
      ...(photographerUserIds === undefined ? [] : [{ existing: existingPhotographers!, desired: photographerUserIds, roleOnProject: "photographer" as const }]),
      ...(editorUserIds === undefined ? [] : [{ existing: existingEditors!, desired: editorUserIds, roleOnProject: "editor" as const }]),
    ];
    const membershipSync = membershipPlans.length
      ? await syncProjectMembersAndClearSubtaskAssignments(db, id, membershipPlans)
      : undefined;
    let resultIndex = 0;
    const photographerResult = photographerUserIds === undefined ? undefined : membershipSync!.results[resultIndex++];
    const editorResult = editorUserIds === undefined ? undefined : membershipSync!.results[resultIndex++];
    if (photographerResult) auditMeta.photographerMembers = photographerResult;
    if (editorResult) auditMeta.editorMembers = editorResult;
    if (membershipSync) auditMeta.subtaskAssignmentsCleared = membershipSync.subtaskAssignmentsCleared;
    await db.update(schema.projects).set({ ...projectUpdates, updatedAt: new Date() }).where(eq(schema.projects.id, id));
    await notifyProjectAssignments(c.env, id, [
      ...(photographerResult?.added ?? []).map((userId) => ({ userId, roleOnProject: "photographer" as const })),
      ...(editorResult?.added ?? []).map((userId) => ({ userId, roleOnProject: "editor" as const })),
    ]);
    if (projectUpdates.rawFolderPath !== undefined) {
      await c.env.BACKGROUND.ensureAutoHdrScaffold(id).catch((error) =>
        console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
    }
    await audit(c.env, c.get("user").id, "project.update", "project", id, auditMeta);
    return c.json(await details(db, id, c.get("user").role));
  }
});
projectsRoutes.post("/projects/:id/cover", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  const data = await jsonInput(c, coverInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  // hasProjectAccess passes for any id under viewAllProjects — without this check an admin
  // posting to an unknown UUID would get 200 and an orphan audit row (matches PATCH).
  if (!await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, id)).get()) return c.json({ error: "Project not found" }, 404);
  if (data.assetId !== null) {
    const asset = await db.select({ id: schema.assets.id, collectionKind: schema.collections.kind, publishStatus: schema.assets.publishStatus }).from(schema.assets)
      .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id)))
      .where(and(eq(schema.assets.id, data.assetId), eq(schema.assets.kind, "photo"), isNull(schema.assets.supersededAt))).get();
    if (!asset || !isUserVisibleAsset(asset.collectionKind, asset.publishStatus)) return c.json({ error: "Asset not in this project" }, 404);
  }
  await db.update(schema.projects).set({ coverAssetId: data.assetId, updatedAt: new Date() }).where(eq(schema.projects.id, id));
  await audit(c.env, c.get("user").id, "project.cover.set", "project", id, { assetId: data.assetId });
  return c.json({ coverAssetId: data.assetId });
});
projectsRoutes.post("/projects/:id/dropbox-sync", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  if (!ROLE_CAPABILITIES[user.role].includes("uploadRaw")) return c.json({ error: "Forbidden", capability: "uploadRaw" }, 403);
  if (!(await hasProjectAccess(c, id))) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const project = await createDb(c.env.DB).select({ rawFolderPath: schema.projects.rawFolderPath, rawFolderLink: schema.projects.rawFolderLink }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project?.rawFolderPath && !project?.rawFolderLink) return c.json({ error: "No Dropbox folder configured for this project" }, 400);
  const { jobId } = await c.env.BACKGROUND.triggerDropboxSync(id);
  await audit(c.env, user.id, "project.dropbox_sync", "project", id, { jobId });
  return c.json({ ok: true, jobId });
});

projectsRoutes.post("/projects/:id/sync-dropbox", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const user = c.get("user");
  const hasUploadRaw = ROLE_CAPABILITIES[user.role].includes("uploadRaw");
  const isAdmin = ROLE_CAPABILITIES[user.role].includes("adminBackend");
  if (!hasUploadRaw && !isAdmin) return c.json({ error: "Forbidden" }, 403);
  const db = createDb(c.env.DB);
  const project = await db.select({ rawFolderPath: schema.projects.rawFolderPath, rawFolderLink: schema.projects.rawFolderLink, archivedAt: schema.projects.archivedAt })
    .from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt) return c.json({ error: "Project is archived" }, 409);

  const hasRawFolder = Boolean(project.rawFolderPath || project.rawFolderLink);
  const result: DropboxSyncResult = {
    raw: { skipped: hasUploadRaw ? "no_raw_folder" : "not_permitted" },
    edited: { skipped: isAdmin ? "not_ready" : "not_admin" },
  };

  if (hasUploadRaw && hasRawFolder) {
    try {
      const raw = await c.env.BACKGROUND.triggerDropboxSync(id);
      result.raw = { jobId: raw.jobId };
      await audit(c.env, user.id, "project.dropbox_sync", "project", id, { jobId: raw.jobId })
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
        await audit(c.env, user.id, "project.fetch_edited", "project", id, { jobId: fetchResult.jobId })
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
});

projectsRoutes.post("/projects/:id/send-to-autohdr", requireCapability("adminBackend"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const db = createDb(c.env.DB);
  const target = await db.select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (target?.archivedAt) return c.json({ error: "Project is archived" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const parsedBody = z.object({ startNewRound: z.boolean().optional(), removalSetHash: z.string().min(1).optional() }).safeParse(body);
  if (!parsedBody.success) return c.json({ error: "Invalid input", details: parsedBody.error.flatten() }, 400);
  const selectedAssets = await db.select({ assetId: schema.assets.id, filename: schema.assets.originalFilename })
    .from(schema.selections)
    .innerJoin(schema.assets, eq(schema.selections.assetId, schema.assets.id))
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id), eq(schema.collections.kind, "raw")))
    .where(and(eq(schema.selections.state, "selected_for_editing"), sql`${schema.assets.supersededAt} IS NULL`));
  if (!selectedAssets.length) return c.json({ error: "Select at least one RAW asset before sending to autoHDR" }, 400);
  let removalInfo: { count: number; hash: string } | undefined;
  const activeHandoff = await db.select({ id: schema.autoHdrHandoffs.id }).from(schema.autoHdrHandoffs)
    .where(and(eq(schema.autoHdrHandoffs.projectId, id), inArray(schema.autoHdrHandoffs.state, ["starting", "started", "blocked"]))).get();
  if (activeHandoff) {
    const sentFiles = await db.select({ assetId: schema.autoHdrSentFiles.assetId, dropboxPathKey: schema.autoHdrSentFiles.dropboxPathKey })
      .from(schema.autoHdrSentFiles).where(eq(schema.autoHdrSentFiles.handoffId, activeHandoff.id));
    const removalIds = computeRemovalAssetIds(sentFiles, selectedAssets);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(removalIds)));
    removalInfo = { count: removalIds.length, hash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  }
  const result = await c.env.BACKGROUND.startAutoHdr(id, c.get("user").id, parsedBody.data);
  if (!result.ok) {
    const details = result.code === "ERR_HANDOFF_ALREADY_ACTIVE" ? {
      removalCount: result.removalCount ?? removalInfo?.count ?? 0,
      removalSetHash: result.removalSetHash ?? removalInfo?.hash,
    } : {};
    return c.json(
      { error: result.message, code: result.code, ...details },
      result.code === "ERR_NO_RAW_SELECTION" ? 400 : 409,
    );
  }
  await audit(c.env, c.get("user").id, "project.send_to_autohdr", "project", id, { jobId: result.jobId });
  return c.json({ jobId: result.jobId });
});

projectsRoutes.post("/projects/:id/fetch-edited", requireCapability("adminBackend"), async (c) => {
  const id = c.req.param("id");
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
  await audit(c.env, c.get("user").id, "project.fetch_edited", "project", id, { jobId: result.jobId });
  return c.json({ jobId: result.jobId });
});

projectsRoutes.get("/projects/:id/autohdr-status", requireCapability("adminBackend"), async (c) => {
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
});

projectsRoutes.get("/projects/:id/autohdr-history", requireCapability("adminBackend"), async (c) => {
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
});

projectsRoutes.post("/projects/:id/autohdr-coverage", requireCapability("adminBackend"), async (c) => {
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
  await audit(c.env, c.get("user").id, "autohdr.coverage.resolve", "asset", data.assetId, { projectId, handoffId: data.handoffId, readinessUnitKey: data.readinessUnitKey });
  return c.json({ ok: true });
});

projectsRoutes.get("/projects/:id/selected-raw.zip", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
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
  await audit(c.env, c.get("user").id, "project.download_selected", "project", id, { count: selected.length });
  return new Response(createZipStream(entries()), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` } });
});

projectsRoutes.post("/projects/:id/download-selection", async (c) => {
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
});

// `archive.zip` must remain a static path segment: in Hono, `:ticket.zip` creates a
// parameter named "ticket.zip", rather than a `ticket` parameter with a literal suffix.
projectsRoutes.get("/projects/:id/download-selection/:ticket/archive.zip", async (c) => {
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
  await audit(c.env, principal.id, "project.download_selection", "project", projectId, {
    collection, count: validatedEntries.length, totalBytes, assetIds,
  });
  return new Response(createZipStream(entries()), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
});

projectsRoutes.get("/projects/:id/manual-upload-jobs", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.jobs.id, status: schema.jobs.status, error: schema.jobs.error,
  }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), inArray(schema.jobs.kind, ["manual_edited_publish", "manual_raw_publish"]))).orderBy(desc(schema.jobs.createdAt)).limit(50).all();
  return c.json({ jobs: rows });
});

projectsRoutes.get("/projects/:id/jobs", requireCapability("adminBackend"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.jobs.id, kind: schema.jobs.kind, status: schema.jobs.status, error: schema.jobs.error,
    correlationId: schema.jobs.correlationId,
    createdAt: schema.jobs.createdAt, updatedAt: schema.jobs.updatedAt,
  }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), inArray(schema.jobs.kind, ["autohdr", "fetch_edited", "autohdr_scaffold", "manual_edited_publish", "manual_raw_publish"]))).orderBy(desc(schema.jobs.createdAt)).limit(20).all();
  return c.json({ jobs: rows });
});

projectsRoutes.post("/jobs/:id/retry", requireCapability("adminBackend"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid job id" }, 400);
  const job = await createDb(c.env.DB).select({ id: schema.jobs.id, projectId: schema.jobs.projectId, kind: schema.jobs.kind, status: schema.jobs.status, payloadJson: schema.jobs.payloadJson })
    .from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  if (!job || !job.projectId || !["autohdr", "fetch_edited", "autohdr_scaffold", "manual_edited_publish", "manual_raw_publish"].includes(job.kind)) return c.json({ error: "Background job not found" }, 404);
  if (!await hasProjectAccess(c, job.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (job.status !== "stuck" && job.status !== "failed") return c.json({ error: "Only stuck or failed background jobs can be retried" }, 409);
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
  await audit(c.env, c.get("user").id, job.kind === "autohdr" ? "project.retry_autohdr" : job.kind === "fetch_edited" ? "project.retry_fetch_edited" : job.kind === "autohdr_scaffold" ? "project.retry_autohdr_scaffold" : job.kind === "manual_raw_publish" ? "project.retry_manual_raw_publish" : "project.retry_manual_edited_publish", "project", job.projectId, { previousJobId: id, jobId });
  return c.json({ jobId });
});

for (const [path, archived] of [["/projects/:id/archive", true], ["/projects/:id/restore", false]] as const) projectsRoutes.post(path, async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("archiveProject")) return c.json({ error: "Forbidden", capability: "archiveProject" }, 403);
  const db = createDb(c.env.DB); const now = new Date();
  if (archived) {
    // Ownership survives archive: retire the mapping and tombstone both permanent candidate
    // claims, never release them for silent reuse.
    const archivedAt = now.getTime();
    const result = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM document_uploads WHERE project_id = ? AND status in ('pending', 'completing', 'aborting'))")
        .bind(archivedAt, c.get("user").id, archivedAt, id, id),
      c.env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'retired', retired_at = ?, updated_at = ? WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, archivedAt, id, id, archivedAt),
      c.env.DB.prepare("UPDATE autohdr_path_claims SET state = 'tombstone', updated_at = ? WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, id, id, archivedAt),
      c.env.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired', updated_at = ? WHERE project_id = ? AND state in ('starting', 'started', 'blocked') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at = ?)")
        .bind(archivedAt, id, id, archivedAt),
    ]);
    if ((result[0]?.meta.changes ?? 0) !== 1) return c.json({ error: "Active document uploads must be aborted before archiving." }, 409);
  } else {
    const result = await db.update(schema.projects).set({ archivedAt: null, archivedBy: null, updatedAt: now }).where(eq(schema.projects.id, id)).returning({ id: schema.projects.id });
    if (!result.length) return c.json({ error: "Project not found" }, 404);
  }
  await audit(c.env, c.get("user").id, archived ? "project.archive" : "project.restore", "project", id); return c.json({ ok: true });
});
projectsRoutes.delete("/projects/:id", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  const db = createDb(c.env.DB); const project = await db.select({ id: schema.projects.id, street: schema.projects.street, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  // Inline capability check like every other route — invoking the middleware factory manually
  // with a body-closure `next` discards the closure's c.json() return and falls through to 404.
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("adminBackend")) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
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
  const r2Prefix = `projects/${id}/`;
  const assetIds = (await db.select({ id: schema.assets.id }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.collections.projectId, id)).all()).map((asset) => asset.id);
  const assetCount = assetIds.length;
  // Audit BEFORE destruction so the trail survives even if a later step dies mid-way.
  await audit(c.env, c.get("user").id, "project.delete", "project", id, { street: project.street, assetCount, r2Prefix });
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
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM autohdr_path_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_fetch_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_final_associations WHERE handoff_id IN (SELECT id FROM autohdr_handoffs WHERE project_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM edited_source_claims WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_output_mappings WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM autohdr_handoffs WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM raw_reconciliation_claims WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM jobs WHERE project_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true, deletedObjects: keys.length });
});
projectsRoutes.post("/projects/:id/stage", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    if (!ROLE_CAPABILITIES[c.get("user").role].includes("selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
    const data = await jsonInput(c, z.object({ stageKey: z.string() })); if (data instanceof Response) return data;
    if (data.stageKey === "editing_autohdr" && !ROLE_CAPABILITIES[c.get("user").role].includes("adminBackend")) return c.json({ error: "Forbidden" }, 403);
    if (!isStageKey(data.stageKey)) return c.json({ error: "Unknown stage" }, 400);
    const db = createDb(c.env.DB); const project = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).get(); if (!project) return c.json({ error: "Project not found" }, 404);
    await ensurePipelineStages(db);
    const target = await db.select({ active: schema.pipelineStages.active }).from(schema.pipelineStages).where(eq(schema.pipelineStages.key, data.stageKey)).get();
    if (!target?.active) return c.json({ error: "Stage is deactivated" }, 409);
    const updated = await db.update(schema.projects).set({ stageKey: data.stageKey, boardPosition: appendToStageBottomExpr(data.stageKey, id), updatedAt: new Date() }).where(eq(schema.projects.id, id)).returning({ boardPosition: schema.projects.boardPosition }).all();
    await audit(c.env, c.get("user").id, "stage.set", "project", id, { from: project.stageKey, to: data.stageKey });
    if (project.stageKey !== "delivered" && data.stageKey === "delivered") await notifyProject(c.env, id, "delivered");
    return c.json({ ok: true, stageKey: data.stageKey, boardPosition: updated[0]?.boardPosition ?? 0 });
  }
});
projectsRoutes.get("/projects/:id", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const value = await details(createDb(c.env.DB), id, c.get("user").role, c.get("user").role === "photographer");
  return value ? c.json(value) : c.json({ error: "Project not found" }, 404);
});
