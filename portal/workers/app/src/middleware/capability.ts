import type { MiddlewareHandler } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { PHOTOGRAPHER_VISIBLE_STAGES, roleHasCapability, type Capability } from "@quincy/shared";
import type { AppEnv } from "../env";

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
  const user = c.get("user");
  if (roleHasCapability(user.role, "viewAllProjects")) return true;
  const db = createDb(c.env.DB);
  const member = await db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, user.id))).get();
  if (!member) return false;
  if (user.role === "photographer") {
    const project = await db.select({ stageKey: schema.projects.stageKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    return Boolean(project && (PHOTOGRAPHER_VISIBLE_STAGES as readonly string[]).includes(project.stageKey));
  }
  return true;
}
