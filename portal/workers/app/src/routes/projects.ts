import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { COLLECTION_KINDS, isStageKey, ROLE_CAPABILITIES, STAGE_TRANSITIONS, type CollectionKind } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";

const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullable().optional();
const projectFields = z.object({ street: z.string().min(1), suburb: nullable(z.string()), postcode: nullable(z.string()), agencyName: nullable(z.string()), agentName: nullable(z.string()), agentEmail: nullable(z.string().email()), agentPhone: nullable(z.string()), agencyId: nullable(z.string().uuid()), agentId: nullable(z.string().uuid()), shootDate: nullable(z.string()), timeWindow: nullable(z.string()), orderNo: nullable(z.string()), orderId: nullable(z.string()), invoiceAmount: nullable(z.number()), paymentStatus: nullable(z.string()), notes: nullable(z.string()), rawFolderLink: nullable(z.string().url()), rawFolderPath: nullable(z.string()), orderedServices: z.array(z.enum(COLLECTION_KINDS)).min(1).optional(), photographerUserIds: z.array(z.string().uuid()).optional(), editorUserIds: z.array(z.string().uuid()).optional() });
const editFields = projectFields.omit({ orderedServices: true, photographerUserIds: true, editorUserIds: true }).partial();
const idCheck = (v: string) => z.string().uuid().safeParse(v).success;

async function addMembers(db: ReturnType<typeof createDb>, projectId: string, ids: string[] | undefined, roleOnProject: "photographer" | "editor") {
  for (const userId of [...new Set(ids ?? [])]) await db.insert(schema.projectMembers).values({ id: newId(), projectId, userId, roleOnProject, createdAt: new Date() }).onConflictDoNothing();
}
async function details(db: ReturnType<typeof createDb>, projectId: string) {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return null;
  const [collections, members] = await Promise.all([db.select().from(schema.collections).where(eq(schema.collections.projectId, projectId)).all(), db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId, roleOnProject: schema.projectMembers.roleOnProject, name: schema.user.name, email: schema.user.email }).from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id)).where(eq(schema.projectMembers.projectId, projectId)).all()]);
  return { ...project, collections, members };
}
export const projectsRoutes = new Hono<AppEnv>();
projectsRoutes.get("/projects", async (c) => {
  const db = createDb(c.env.DB); const user = c.get("user");
  const base = db.select({ project: schema.projects, receivedCount: schema.collections.receivedCount, expectedCount: schema.collections.expectedCount }).from(schema.projects).leftJoin(schema.collections, and(eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw")));
  const rows = user.role === "photographer" ? await base.innerJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id))).where(isNull(schema.projects.archivedAt)).orderBy(asc(schema.projects.shootDate)).all() : await base.where(isNull(schema.projects.archivedAt)).orderBy(asc(schema.projects.shootDate)).all();
  return c.json({ projects: rows.map((r) => ({ ...r.project, receivedCount: r.receivedCount ?? 0, expectedCount: r.expectedCount })) });
});
projectsRoutes.post("/projects", requireCapability("createProject"), async (c) => {
  const data = await jsonInput(c, projectFields); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId(); const { orderedServices, photographerUserIds, editorUserIds, ...fields } = data;
  await db.insert(schema.projects).values({ id, ...fields, stageKey: "awaiting_raw", createdAt: new Date(), updatedAt: new Date() });
  const services = new Set<CollectionKind>(["raw", ...(orderedServices ?? [])]);
  for (const kind of services) await db.insert(schema.collections).values({ id: newId(), projectId: id, kind, status: "empty", receivedCount: 0, createdAt: new Date(), updatedAt: new Date() });
  await addMembers(db, id, photographerUserIds, "photographer"); await addMembers(db, id, editorUserIds, "editor");
  await audit(c.env, c.get("user").id, "project.create", "project", id, { orderedServices: [...services] });
  return c.json(await details(db, id), 201);
});
projectsRoutes.patch("/projects/:id", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    if (!ROLE_CAPABILITIES[c.get("user").role].includes("editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
    const data = await jsonInput(c, editFields); if (data instanceof Response) return data;
    const db = createDb(c.env.DB); if (!await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, id)).get()) return c.json({ error: "Project not found" }, 404);
    await db.update(schema.projects).set({ ...data, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, "project.update", "project", id, data); return c.json(await details(db, id));
  }
});
projectsRoutes.post("/projects/:id/dropbox-sync", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  if (!ROLE_CAPABILITIES[user.role].includes("uploadRaw")) return c.json({ error: "Forbidden", capability: "uploadRaw" }, 403);
  if (!(await hasProjectAccess(c, id))) return c.json({ error: "Not found" }, 404);
  const project = await createDb(c.env.DB).select({ rawFolderPath: schema.projects.rawFolderPath, rawFolderLink: schema.projects.rawFolderLink }).from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project?.rawFolderPath && !project?.rawFolderLink) return c.json({ error: "No Dropbox folder configured for this project" }, 400);
  const { jobId } = await c.env.BACKGROUND.triggerDropboxSync(id);
  await audit(c.env, user.id, "project.dropbox_sync", "project", id, { jobId });
  return c.json({ ok: true, jobId });
});

for (const [path, archived] of [["/projects/:id/archive", true], ["/projects/:id/restore", false]] as const) projectsRoutes.post(path, async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("archiveProject")) return c.json({ error: "Forbidden", capability: "archiveProject" }, 403);
  const db = createDb(c.env.DB); await db.update(schema.projects).set({ archivedAt: archived ? new Date() : null, archivedBy: archived ? c.get("user").id : null, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, archived ? "project.archive" : "project.restore", "project", id); return c.json({ ok: true });
});
projectsRoutes.post("/projects/:id/stage", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    if (!ROLE_CAPABILITIES[c.get("user").role].includes("editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
    const data = await jsonInput(c, z.object({ stageKey: z.string() })); if (data instanceof Response) return data;
    if (!isStageKey(data.stageKey)) return c.json({ error: "Unknown stage" }, 400);
    const db = createDb(c.env.DB); const project = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).get(); if (!project) return c.json({ error: "Project not found" }, 404);
    const force = c.get("user").role === "admin"; if (!force && !STAGE_TRANSITIONS[project.stageKey as keyof typeof STAGE_TRANSITIONS]?.includes(data.stageKey)) return c.json({ error: "Invalid stage transition" }, 409);
    await db.update(schema.projects).set({ stageKey: data.stageKey, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, force ? "stage.force" : "stage.transition", "project", id, { from: project.stageKey, to: data.stageKey }); return c.json({ ok: true, stageKey: data.stageKey });
  }
});
projectsRoutes.get("/projects/:id", async (c) => { const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400); if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); const value = await details(createDb(c.env.DB), id); return value ? c.json(value) : c.json({ error: "Project not found" }, 404); });
