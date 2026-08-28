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
  // viewAllProjects reaches any project by id regardless of archive state (list-mode archive
  // filtering is the list route's job). State the "no predicate" case explicitly rather than
  // letting a bare `undefined` silently mean "no filter".
  if (roleHasCapability(user.role, "viewAllProjects")) return project ?? sql`1 = 1`;
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
