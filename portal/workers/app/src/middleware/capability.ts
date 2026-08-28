import type { MiddlewareHandler } from "hono";
import { roleHasCapability, type Capability } from "@quincy/shared";
import type { AppEnv, SessionUser } from "../env";
import { resolveVisibleProject } from "../lib/visible-project-scope";

export const requireCapability = (capability: Capability): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = c.get("user");
  if (!roleHasCapability(user.role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  await next();
};

export const requireProjectAccess = (projectId: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (await hasProjectAccess(c, projectId)) return next();
  return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
};

export async function hasProjectAccess(c: { env: AppEnv["Bindings"]; get: (key: "user") => AppEnv["Variables"]["user"] }, projectId: string) {
  return Boolean(await resolveVisibleProject(c.env, c.get("user"), projectId));
}

/**
 * Collaboration is intentionally narrower than ordinary project visibility:
 * active admins participate everywhere; every other staff member needs an
 * explicit project_members row, regardless of role or pipeline stage.
 */
export async function hasProjectCollaborationAccess(c: { env: AppEnv["Bindings"]; get: (key: "user") => AppEnv["Variables"]["user"] }, projectId: string) {
  return hasProjectCollaborationAccessForUser(c.env, c.get("user"), projectId);
}

/** Context-free collaboration guard for route-independent commands. */
export async function hasProjectCollaborationAccessForUser(
  env: AppEnv["Bindings"],
  currentUser: Pick<SessionUser, "id" | "role" | "active">,
  projectId: string,
) {
  if (currentUser.active !== true || !roleHasCapability(currentUser.role, "collaborateOnProject")) return false;
  const context = await resolveVisibleProject(env, currentUser, projectId);
  if (context) return true;
  // Admin collaboration on an archived project is retained for internal operations; External
  // and other scoped roles never take this branch because their visibility is assignment-bound.
  if (currentUser.role !== "admin") return false;
  return true;
}

/** Use when a route has reloaded the principal and must not trust session-cached role state. */
export async function hasProjectAccessForUser(env: AppEnv["Bindings"], user: Pick<SessionUser, "id" | "role">, projectId: string) {
  return Boolean(await resolveVisibleProject(env, { ...user, active: true }, projectId));
}
