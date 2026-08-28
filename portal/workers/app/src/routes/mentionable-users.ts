import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { externalMentionableUserSchema, ROLE_LABELS, roleHasCapability } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { projectMentionableUsers } from "../lib/project-collaboration";
import { resolveVisibleProject } from "../lib/visible-project-scope";

const query = z.object({ scope: z.literal("notice-board").optional(), projectId: z.string().uuid().optional(), q: z.string().trim().max(200).optional() }).superRefine((value, ctx) => {
  if ((value.scope && value.projectId) || (!value.scope && !value.projectId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Specify exactly one scope" });
});
export const mentionableUsersRoutes = new Hono<AppEnv>();

mentionableUsersRoutes.get("/mentionable-users", terminalRoute("/mentionable-users", async (c) => {
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const rawQuery = parsed.data.q?.toLocaleLowerCase();
  const q = rawQuery?.replace(/[\\%_]/g, "\\$&");
  if (parsed.data.projectId) {
    if (c.get("user").role === "external_editor") {
      if (!await resolveVisibleProject(c.env, c.get("user"), parsed.data.projectId)) return c.json({ error: "Project not found" }, 404);
      let users = await projectMentionableUsers(c.env, parsed.data.projectId);
      if (rawQuery) users = users.filter((candidate) => candidate.name.toLocaleLowerCase().includes(rawQuery));
      return c.json({ users: users.slice(0, 20).map((candidate) => externalMentionableUserSchema.parse({ id: candidate.id, name: candidate.name, roleLabel: ROLE_LABELS[candidate.role], isExternal: candidate.role === "external_editor", active: true })) });
    }
    // Access deliberately precedes existence so non-members cannot probe IDs.
    if (!await hasProjectCollaborationAccess(c, parsed.data.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
    const db = createDb(c.env.DB);
    if (!await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, parsed.data.projectId)).get()) return c.json({ error: "Project not found" }, 404);
    let users = await projectMentionableUsers(c.env, parsed.data.projectId);
    if (rawQuery) users = users.filter((candidate) => candidate.name.toLocaleLowerCase().includes(rawQuery));
    return c.json({ users: users.slice(0, 20) });
  }
  if (!roleHasCapability(c.get("user").role, "viewNoticeBoard")) return c.json({ error: "Forbidden", capability: "viewNoticeBoard" }, 403);
  const users = await createDb(c.env.DB).select({ id: schema.user.id, name: schema.user.name, role: schema.user.role })
    .from(schema.user)
    .where(and(eq(schema.user.active, true), sql`${schema.user.role} <> 'external_editor'`, q ? sql`lower(${schema.user.name}) like ${`%${q}%`} escape '\\'` : undefined))
    .orderBy(asc(schema.user.name), asc(schema.user.id)).limit(20).all();
  return c.json({ users });
}));
