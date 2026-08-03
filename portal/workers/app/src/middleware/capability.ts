import type { MiddlewareHandler } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { PHOTOGRAPHER_VISIBLE_STAGES, roleHasCapability, type Capability } from "@quincy/shared";
import type { AppEnv, SessionUser } from "../env";

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
  return hasProjectAccessForUser(c.env, c.get("user"), projectId);
}

/** Use when a route has reloaded the principal and must not trust session-cached role state. */
export async function hasProjectAccessForUser(env: AppEnv["Bindings"], user: Pick<SessionUser, "id" | "role">, projectId: string) {
  if (roleHasCapability(user.role, "viewAllProjects")) return true;
  const db = createDb(env.DB);
  const member = await db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, user.id))).get();
  if (!member) return false;
  if (user.role === "photographer") {
    const project = await db.select({ stageKey: schema.projects.stageKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    return Boolean(project && (PHOTOGRAPHER_VISIBLE_STAGES as readonly string[]).includes(project.stageKey));
  }
  return true;
}
