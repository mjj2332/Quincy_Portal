import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import { PHOTOGRAPHER_VISIBLE_STAGES, roleHasCapability, type Capability, type Role } from "@quincy/shared";
import type { Env, SessionUser } from "../env";

export type VisibleProjectContext = {
  projectId: string;
  membershipCycleIds: string[];
  role: Role;
  isExternal: boolean;
};

export type VisibleProjectWhereInput = Pick<SessionUser, "id" | "role" | "active">;

/**
 * The one project visibility predicate used by lists and direct resource guards. It deliberately
 * starts from projects and joins the current membership for scoped roles, so a zero-row result is
 * the same for an invisible and a nonexistent project.
 */
export function visibleProjectWhere(user: VisibleProjectWhereInput, projectId?: string) {
  const project = projectId ? eq(schema.projects.id, projectId) : undefined;
  if (roleHasCapability(user.role, "viewAllProjects")) return and(project, isNull(schema.projects.archivedAt));
  const membership = and(
    eq(schema.projectMembers.userId, user.id),
    user.role === "external_editor" ? eq(schema.projectMembers.roleOnProject, "editor") : undefined,
  );
  const photographerStage = user.role === "photographer"
    ? (PHOTOGRAPHER_VISIBLE_STAGES as readonly string[]).map((stage) => eq(schema.projects.stageKey, stage))
    : [];
  return and(
    project,
    isNull(schema.projects.archivedAt),
    membership,
    photographerStage.length ? or(...photographerStage) : undefined,
  );
}

export function visibleProjectScopeSql(user: VisibleProjectWhereInput, projectAlias = "p", memberAlias = "pm") {
  const projectId = projectAlias === "p" ? "p.id" : `${projectAlias}.id`;
  const archive = `${projectAlias}.archived_at IS NULL`;
  if (roleHasCapability(user.role, "viewAllProjects")) return { sql: `${projectId} IS NOT NULL AND ${archive}`, bindings: [] as unknown[] };
  const stage = user.role === "photographer"
    ? ` AND ${projectAlias}.stage_key IN (${PHOTOGRAPHER_VISIBLE_STAGES.map(() => "?").join(",")})`
    : "";
  return {
    sql: `${projectId} IS NOT NULL AND ${archive} AND ${memberAlias}.user_id = ?${user.role === "external_editor" ? ` AND ${memberAlias}.role_on_project = 'editor'` : ""}${stage}`,
    bindings: [user.id, ...(user.role === "photographer" ? [...PHOTOGRAPHER_VISIBLE_STAGES] : [])],
  };
}

/** One scoped SELECT resolves visibility before any child-resource lookup or serialization. */
export async function resolveVisibleProject(env: Env["DB"] | Env, user: VisibleProjectWhereInput, projectId: string): Promise<VisibleProjectContext | null> {
  const d1 = "DB" in env ? env.DB : env;
  const db = createDb(d1);
  const rows = await db.select({ projectId: schema.projects.id, membershipCycleId: schema.projectMembers.id })
    .from(schema.projects)
    .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .where(visibleProjectWhere(user, projectId))
    .all();
  if (!rows.length) return null;
  return {
    projectId,
    membershipCycleIds: rows.map((row) => row.membershipCycleId).filter((id): id is string => Boolean(id)),
    role: user.role,
    isExternal: user.role === "external_editor",
  };
}

export async function resolveVisibleProjectWithCapability(
  env: Env["DB"] | Env,
  user: VisibleProjectWhereInput,
  projectId: string,
  capability: Capability,
) {
  if (!roleHasCapability(user.role, capability)) return null;
  return resolveVisibleProject(env, user, projectId);
}
