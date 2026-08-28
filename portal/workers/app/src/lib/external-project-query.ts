import { createDb, schema } from "@quincy/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { externalProjectDetailSchema, externalProjectListResponseSchema, externalProjectSummarySchema, ROLE_LABELS, type ExternalProjectDetailDto, type ExternalProjectSummaryDto, type Role } from "@quincy/shared";
import type { Env } from "../env";
import { readProjectDeadlineSchedule } from "./project-deadline";
import { visibleProjectWhere } from "./visible-project-scope";

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
};

type ServiceRow = { projectId: string; id: string; kind: string; status: string; expectedCount: number | null; receivedCount: number };
type MemberRow = { id: string; userId: string; roleOnProject: "photographer" | "editor"; name: string; email: string; globalRole: Role; active: boolean };

function person(row: { id: string; name: string; role: Role; active: boolean }) {
  return { id: row.id, name: row.name, roleLabel: ROLE_LABELS[row.role], isExternal: row.role === "external_editor", active: Boolean(row.active) };
}

function coverUrl(origin: string, assetId: string | null) {
  return assetId ? { assetId, url: new URL(`/media/asset/${assetId}/thumb`, origin).href } : null;
}

/** External projections never expose provider-specific workflow stage identifiers. */
export function externalStageKey(stageKey: string) {
  return stageKey === "editing_autohdr" ? "editing" : stageKey;
}

async function projectRows(db: Db, userId: string, role: Role, projectId?: string) {
  return db.select({
    id: schema.projects.id,
    street: schema.projects.street,
    suburb: schema.projects.suburb,
    postcode: schema.projects.postcode,
    agencyName: schema.projects.agencyName,
    agentName: schema.projects.agentName,
    directoryAgencyName: schema.agencies.name,
    directoryAgentName: schema.agents.name,
    shootDate: schema.projects.shootDate,
    timeWindow: schema.projects.timeWindow,
    stageKey: schema.projects.stageKey,
    productionNotes: schema.projects.productionNotes,
    coverAssetId: schema.projects.coverAssetId,
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
    },
    service: row.serviceId ? {
      projectId: row.serviceProjectId!, id: row.serviceId, kind: row.serviceKind!, status: row.serviceStatus!,
      expectedCount: row.serviceExpectedCount, receivedCount: Number(row.serviceReceivedCount ?? 0),
    } : null,
  };
}

function summaryFields(project: ProjectRow, services: ServiceRow[], deadline: Awaited<ReturnType<typeof readProjectDeadlineSchedule>>, coverAsset: string | null, origin: string): ExternalProjectSummaryDto {
  return externalProjectSummarySchema.parse({
    id: project.id,
    address: { street: project.street, suburb: project.suburb, postcode: project.postcode },
    agencyDisplayName: project.directoryAgencyName ?? project.agencyName,
    agentDisplayName: project.directoryAgentName ?? project.agentName,
    shootDate: project.shootDate,
    timeWindow: project.timeWindow,
    stageKey: externalStageKey(project.stageKey),
    deadline,
    productionNotes: project.productionNotes,
    services: services.map(({ id, kind, status, expectedCount, receivedCount }) => ({ id, kind, status, expectedCount, receivedCount })),
    cover: coverUrl(origin, coverAsset),
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

export async function listExternalProjects(env: Env, userId: string, role: Role): Promise<{ projects: ExternalProjectSummaryDto[] }> {
  const db = createDb(env.DB);
  const rows = await projectRows(db, userId, role);
  const grouped = new Map<string, { project: ProjectRow; services: ServiceRow[] }>();
  for (const raw of rows) {
    const { project, service } = toProjectRow(raw);
    const current = grouped.get(project.id) ?? { project, services: [] };
    if (service && !current.services.some((item) => item.id === service.id)) current.services.push(service);
    grouped.set(project.id, current);
  }
  const projects = await Promise.all([...grouped.values()].map(async ({ project, services }) => summaryFields(project, services, await readProjectDeadlineSchedule(env.DB, project.id), await coverFor(db, project), env.APP_ORIGIN)));
  return externalProjectListResponseSchema.parse({ projects });
}

export async function readExternalProjectDetail(env: Env, userId: string, role: Role, projectId: string): Promise<ExternalProjectDetailDto | null> {
  const db = createDb(env.DB);
  const rows = await projectRows(db, userId, role, projectId);
  if (!rows.length) return null;
  const first = toProjectRow(rows[0]!);
  const services = rows.flatMap((row) => {
    const service = toProjectRow(row).service;
    return service ? [service] : [];
  }).filter((service, index, all) => all.findIndex((item) => item.id === service.id) === index);
  const [members, deadline, coverAsset, subtaskCounts] = await Promise.all([
    membersFor(db, projectId),
    readProjectDeadlineSchedule(env.DB, projectId),
    coverFor(db, first.project),
    assignedSubtaskCounts(db, projectId),
  ]);
  const summary = summaryFields(first.project, services, deadline, coverAsset, env.APP_ORIGIN);
  return externalProjectDetailSchema.parse({
    ...summary,
    editedUploadAvailable: first.project.editedUploadAvailable,
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
