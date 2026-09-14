import { boardContractEnabled, boardSchemaVariant, createDb, projectColumnsForVariant, schema, type BoardSchemaVariant } from "@quincy/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { externalProjectDetailSchema, externalProjectListResponseSchema, externalProjectSummarySchema, ROLE_LABELS, stageTransportKeyForRole, type ExternalProjectDetailDto, type ExternalProjectListResponse, type ExternalProjectSummaryDto, type ProjectEditorRef, type Role, type StageKey, type StageTransportKey } from "@quincy/shared";
import type { Env } from "../env";
import { readProjectDeadlineSchedule } from "./project-deadline";
import { activeEditorRefsByProject } from "./project-editors";
import { visibleProjectWhere } from "./visible-project-scope";
import { editorFolderAvailability } from "./editor-folders";

type Db = ReturnType<typeof createDb>;

type ProjectRow = {
  id: string;
  street: string;
  suburb: string | null;
  postcode: string | null;
  agencyName: string | null;
  agentName: string | null;
  directoryAgencyName: string | null;
  directoryAgentName: string | null;
  shootDate: string | null;
  timeWindow: string | null;
  stageKey: string;
  productionNotes: string | null;
  coverAssetId: string | null;
  editedUploadAvailable: boolean;
  boardRevision: number;
  priority: number | null;
  boardPosition: number;
};

type ServiceRow = { projectId: string; id: string; kind: string; status: string; expectedCount: number | null; receivedCount: number };
type MemberRow = { id: string; userId: string; roleOnProject: "photographer" | "editor"; name: string; email: string; globalRole: Role; active: boolean };

function person(row: { id: string; name: string; role: Role; active: boolean }) {
  return { id: row.id, name: row.name, roleLabel: ROLE_LABELS[row.role], isExternal: row.role === "external_editor", active: Boolean(row.active) };
}

function coverUrl(origin: string, assetId: string | null) {
  return assetId ? { assetId, url: new URL(`/media/asset/${assetId}/thumb`, origin).href } : null;
}

async function projectRows(db: Db, userId: string, role: Role, variant: BoardSchemaVariant, projectId?: string) {
  // This explicit variant selection is reached only after the one old-schema-safe marker query.
  const projectColumns = projectColumnsForVariant(variant);
  return db.select({
    ...projectColumns,
    directoryAgencyName: schema.agencies.name,
    directoryAgentName: schema.agents.name,
    editedUploadAvailable: sql<boolean>`(${schema.projects.rawFolderPath} IS NOT NULL OR ${schema.projects.rawFolderLink} IS NOT NULL)`,
    serviceId: schema.collections.id,
    serviceProjectId: schema.collections.projectId,
    serviceKind: schema.collections.kind,
    serviceStatus: schema.collections.status,
    serviceExpectedCount: schema.collections.expectedCount,
    serviceReceivedCount: schema.collections.receivedCount,
  }).from(schema.projects)
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, userId)))
    .leftJoin(schema.collections, eq(schema.collections.projectId, schema.projects.id))
    .leftJoin(schema.agencies, eq(schema.projects.agencyId, schema.agencies.id))
    .leftJoin(schema.agents, eq(schema.projects.agentId, schema.agents.id))
    .where(visibleProjectWhere({ id: userId, role, active: true }, projectId))
    .orderBy(asc(schema.projects.street), asc(schema.projects.id), asc(schema.collections.kind), asc(schema.collections.id))
    .all();
}

async function coverFor(db: Db, project: ProjectRow) {
  if (project.coverAssetId) {
    const stored = await db.select({ id: schema.assets.id }).from(schema.assets)
      .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, project.id)))
      .where(and(eq(schema.assets.id, project.coverAssetId), isNull(schema.assets.supersededAt), sql`(${schema.collections.kind} <> 'edited' OR ${schema.assets.publishStatus} = 'ready')`)).get();
    if (stored) return stored.id;
  }
  const fallback = await db.select({ id: schema.assets.id }).from(schema.assets)
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, project.id), eq(schema.collections.kind, "raw")))
    .where(isNull(schema.assets.supersededAt)).orderBy(asc(schema.assets.originalFilename), asc(schema.assets.id)).get();
  return fallback?.id ?? null;
}

function toProjectRow(row: Awaited<ReturnType<typeof projectRows>>[number]): { project: ProjectRow; service: ServiceRow | null } {
  return {
    project: {
      id: row.id, street: row.street, suburb: row.suburb, postcode: row.postcode,
      agencyName: row.agencyName, agentName: row.agentName,
      directoryAgencyName: row.directoryAgencyName, directoryAgentName: row.directoryAgentName,
      shootDate: row.shootDate, timeWindow: row.timeWindow, stageKey: row.stageKey,
      productionNotes: row.productionNotes, coverAssetId: row.coverAssetId,
      editedUploadAvailable: Boolean(row.editedUploadAvailable),
      boardRevision: Number("boardRevision" in row ? row.boardRevision ?? 0 : 0),
      priority: row.priority,
      boardPosition: Number(row.boardPosition),
    },
    service: row.serviceId ? {
      projectId: row.serviceProjectId!, id: row.serviceId, kind: row.serviceKind!, status: row.serviceStatus!,
      expectedCount: row.serviceExpectedCount, receivedCount: Number(row.serviceReceivedCount ?? 0),
    } : null,
  };
}

function summaryFields(project: ProjectRow, services: ServiceRow[], deadline: Awaited<ReturnType<typeof readProjectDeadlineSchedule>>, coverAsset: string | null, origin: string, editors: ProjectEditorRef[], editedUploadAvailable = project.editedUploadAvailable): ExternalProjectSummaryDto {
  return externalProjectSummarySchema.parse({
    id: project.id,
    address: { street: project.street, suburb: project.suburb, postcode: project.postcode },
    agencyDisplayName: project.directoryAgencyName ?? project.agencyName,
    agentDisplayName: project.directoryAgentName ?? project.agentName,
    shootDate: project.shootDate,
    timeWindow: project.timeWindow,
    stageKey: stageTransportKeyForRole(project.stageKey as StageKey, "external_editor"),
    boardRevision: project.boardRevision,
    deadline,
    productionNotes: project.productionNotes,
    services: services.map(({ id, kind, status, expectedCount, receivedCount }) => ({ id, kind, status, expectedCount, receivedCount })),
    cover: coverUrl(origin, coverAsset),
    editors,
  });
}

async function membersFor(db: Db, projectId: string): Promise<MemberRow[]> {
  const rows = await db.select({
    id: schema.projectMembers.id,
    userId: schema.user.id,
    roleOnProject: schema.projectMembers.roleOnProject,
    name: schema.user.name,
    email: schema.user.email,
    globalRole: schema.user.role,
    active: schema.user.active,
  }).from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id))
    .where(eq(schema.projectMembers.projectId, projectId))
    .orderBy(asc(schema.projectMembers.roleOnProject), asc(schema.user.name), asc(schema.user.id)).all();
  return rows;
}

export async function assignedSubtaskCounts(db: Db, projectId: string): Promise<Map<string, number>> {
  const rows = await db.select({
    userId: schema.projectSubtasks.assigneeId,
    count: sql<number>`count(*)`,
  }).from(schema.projectSubtasks)
    .where(and(eq(schema.projectSubtasks.projectId, projectId), sql`${schema.projectSubtasks.assigneeId} IS NOT NULL`))
    .groupBy(schema.projectSubtasks.assigneeId).all();
  return new Map(rows.flatMap((row) => row.userId ? [[row.userId, Number(row.count)]] as const : []));
}

function canonicalExternalBoardOrder(groups: Iterable<{ project: ProjectRow }>): Partial<Record<"awaiting_raw" | "raw_review" | "editing" | "edited_review" | "delivered", string[]>> {
  const byStage = new Map<StageTransportKey, ProjectRow[]>();
  for (const { project } of groups) {
    const stageKey = stageTransportKeyForRole(project.stageKey as StageKey, "external_editor");
    const rows = byStage.get(stageKey) ?? [];
    rows.push(project);
    byStage.set(stageKey, rows);
  }
  const orderedProjectIdsByStage: Partial<Record<"awaiting_raw" | "raw_review" | "editing" | "edited_review" | "delivered", string[]>> = {};
  for (const [stageKey, rows] of byStage) {
    rows.sort((left, right) => (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0) || left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
    orderedProjectIdsByStage[stageKey as keyof typeof orderedProjectIdsByStage] = rows.map((row) => row.id);
  }
  return orderedProjectIdsByStage;
}

export async function listExternalProjects(env: Env, userId: string, role: Role): Promise<ExternalProjectListResponse> {
  const variant = await boardSchemaVariant(env.DB);
  const db = createDb(env.DB);
  const rows = await projectRows(db, userId, role, variant);
  const grouped = new Map<string, { project: ProjectRow; services: ServiceRow[] }>();
  for (const raw of rows) {
    const { project, service } = toProjectRow(raw);
    const current = grouped.get(project.id) ?? { project, services: [] };
    if (service && !current.services.some((item) => item.id === service.id)) current.services.push(service);
    grouped.set(project.id, current);
  }
  const editorsByProject = await activeEditorRefsByProject(db, [...grouped.keys()]);
  const projects = await Promise.all([...grouped.values()].map(async ({ project, services }) => {
    const editorFolders = await editorFolderAvailability(env, project.id);
    return summaryFields(
      project,
      services,
      await readProjectDeadlineSchedule(env.DB, project.id),
      await coverFor(db, project),
      env.APP_ORIGIN,
      editorsByProject.get(project.id) ?? [],
      editorFolders?.outputReady ?? project.editedUploadAvailable,
    );
  }));
  return externalProjectListResponseSchema.parse({
    projects,
    board: {
      contractEnabled: await boardContractEnabled(env.DB, variant),
      orderedProjectIdsByStage: variant === "tb5a_0037" ? canonicalExternalBoardOrder(grouped.values()) : {},
    },
  });
}

export async function readExternalProjectDetail(env: Env, userId: string, role: Role, projectId: string): Promise<ExternalProjectDetailDto | null> {
  const variant = await boardSchemaVariant(env.DB);
  const db = createDb(env.DB);
  const rows = await projectRows(db, userId, role, variant, projectId);
  if (!rows.length) return null;
  const first = toProjectRow(rows[0]!);
  const services = rows.flatMap((row) => {
    const service = toProjectRow(row).service;
    return service ? [service] : [];
  }).filter((service, index, all) => all.findIndex((item) => item.id === service.id) === index);
  const [members, deadline, coverAsset, subtaskCounts, editorsByProject] = await Promise.all([
    membersFor(db, projectId),
    readProjectDeadlineSchedule(env.DB, projectId),
    coverFor(db, first.project),
    assignedSubtaskCounts(db, projectId),
    activeEditorRefsByProject(db, [projectId]),
  ]);
  const summary = summaryFields(first.project, services, deadline, coverAsset, env.APP_ORIGIN, editorsByProject.get(projectId) ?? []);
  return externalProjectDetailSchema.parse({
    ...summary,
    contractEnabled: await boardContractEnabled(env.DB, variant),
    editedUploadAvailable: (await editorFolderAvailability(env, projectId))?.outputReady ?? first.project.editedUploadAvailable,
    collections: summary.services,
    members: members.map((member) => ({
      id: member.userId,
      membershipCycleId: member.id,
      roleOnProject: member.roleOnProject,
      name: member.name,
      email: member.email,
      roleLabel: ROLE_LABELS[member.globalRole],
      isExternal: member.globalRole === "external_editor",
      active: Boolean(member.active),
      assignedSubtaskCount: subtaskCounts.get(member.userId) ?? 0,
    })),
  });
}
