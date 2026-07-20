import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { COLLECTION_KINDS, isStageKey, ROLE_CAPABILITIES, type CollectionKind } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { createZipStream } from "../lib/zip-stream";
import { jsonInput } from "./helpers";
import { ensurePipelineStages } from "./stages";

const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullable().optional();
const projectFields = z.object({ street: z.string().min(1), suburb: nullable(z.string()), postcode: nullable(z.string()), agencyName: nullable(z.string()), agentName: nullable(z.string()), agentEmail: nullable(z.string().email()), agentPhone: nullable(z.string()), agencyId: nullable(z.string().uuid()), agentId: nullable(z.string().uuid()), shootDate: nullable(z.string()), timeWindow: nullable(z.string()), orderNo: nullable(z.string()), orderId: nullable(z.string()), invoiceAmount: nullable(z.number()), paymentStatus: nullable(z.string()), notes: nullable(z.string()), rawFolderLink: nullable(z.string().url()), rawFolderPath: nullable(z.string()), orderedServices: z.array(z.enum(COLLECTION_KINDS)).optional(), photographerUserIds: z.array(z.string().uuid()).optional(), editorUserIds: z.array(z.string().uuid()).optional() });
const editFields = projectFields.partial();
const coverInput = z.object({ assetId: z.string().uuid().nullable() });
const idCheck = (v: string) => z.string().uuid().safeParse(v).success;

function chunked<T>(items: T[], size = 80): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function coverMaps(db: ReturnType<typeof createDb>, projectIds: string[], photographersOnlySeeRaw = false) {
  const storedByProject = new Map<string, string>();
  const automaticByProject = new Map<string, string>();
  for (const ids of chunked(projectIds)) {
    // Mirror media.ts: photographers may only view RAW assets.
    const storedCollectionJoin = photographersOnlySeeRaw
      ? and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw"))
      : and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id));
    // D1/Drizzle mis-renders correlated scalar subqueries. Keep both lookups set-based;
    // the grouped RAW query uses SQLite's bare-column-with-min() behaviour for its asset id.
    const [storedCovers, automaticCovers] = await Promise.all([
      db.select({ projectId: schema.projects.id, assetId: schema.assets.id }).from(schema.projects)
        .innerJoin(schema.assets, eq(schema.projects.coverAssetId, schema.assets.id))
        .innerJoin(schema.collections, storedCollectionJoin)
        .where(inArray(schema.projects.id, ids)).all(),
      db.select({ projectId: schema.collections.projectId, assetId: schema.assets.id, filename: sql<string>`min(${schema.assets.originalFilename})` }).from(schema.assets)
        .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
        .where(and(inArray(schema.collections.projectId, ids), eq(schema.collections.kind, "raw")))
        .groupBy(schema.collections.projectId).all(),
    ]);
    for (const row of storedCovers) storedByProject.set(row.projectId, row.assetId);
    for (const row of automaticCovers) automaticByProject.set(row.projectId, row.assetId);
  }
  return { storedByProject, automaticByProject };
}

async function addMembers(db: ReturnType<typeof createDb>, projectId: string, ids: string[] | undefined, roleOnProject: "photographer" | "editor") {
  for (const userId of [...new Set(ids ?? [])]) await db.insert(schema.projectMembers).values({ id: newId(), projectId, userId, roleOnProject, createdAt: new Date() }).onConflictDoNothing();
}
async function addCollections(db: ReturnType<typeof createDb>, projectId: string, orderedServices: CollectionKind[] | undefined) {
  const services = new Set<CollectionKind>(["raw", ...(orderedServices ?? [])]);
  for (const kind of services) await db.insert(schema.collections).values({ id: newId(), projectId, kind, status: "empty", receivedCount: 0, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  return services;
}
async function syncMembers(db: ReturnType<typeof createDb>, projectId: string, ids: string[], roleOnProject: "photographer" | "editor") {
  const desired = [...new Set(ids)];
  const existing = await db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.roleOnProject, roleOnProject))).all();
  await addMembers(db, projectId, desired, roleOnProject);
  const removed = existing.filter((member) => !desired.includes(member.userId));
  for (const member of removed) await db.delete(schema.projectMembers).where(eq(schema.projectMembers.id, member.id));
  return { added: desired.filter((userId) => !existing.some((member) => member.userId === userId)), removed: removed.map((member) => member.userId) };
}
async function details(db: ReturnType<typeof createDb>, projectId: string, viewerSeesRawOnly = false) {
  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return null;
  const [{ storedByProject, automaticByProject }, collections, members] = await Promise.all([
    coverMaps(db, [projectId], viewerSeesRawOnly),
    db.select().from(schema.collections).where(eq(schema.collections.projectId, projectId)).all(),
    db.select({ id: schema.projectMembers.id, userId: schema.projectMembers.userId, roleOnProject: schema.projectMembers.roleOnProject, name: schema.user.name, email: schema.user.email }).from(schema.projectMembers).innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id)).where(eq(schema.projectMembers.projectId, projectId)).all(),
  ]);
  return { ...project, effectiveCoverAssetId: storedByProject.get(projectId) ?? automaticByProject.get(projectId) ?? null, collections, members };
}
export const projectsRoutes = new Hono<AppEnv>();
projectsRoutes.get("/projects", async (c) => {
  const db = createDb(c.env.DB); const user = c.get("user");
  const base = db.select({ project: schema.projects, receivedCount: schema.collections.receivedCount, expectedCount: schema.collections.expectedCount }).from(schema.projects).leftJoin(schema.collections, and(eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw")));
  const rows = user.role === "photographer" ? await base.innerJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id))).where(isNull(schema.projects.archivedAt)).orderBy(asc(schema.projects.shootDate)).all() : await base.where(isNull(schema.projects.archivedAt)).orderBy(asc(schema.projects.shootDate)).all();
  const projectIds = rows.map(({ project }) => project.id);
  const { storedByProject, automaticByProject } = await coverMaps(db, projectIds, user.role === "photographer");
  return c.json({ projects: rows.map((r) => ({ ...r.project, coverAssetId: storedByProject.get(r.project.id) ?? automaticByProject.get(r.project.id) ?? null, receivedCount: r.receivedCount ?? 0, expectedCount: r.expectedCount })) });
});
projectsRoutes.post("/projects", requireCapability("createProject"), async (c) => {
  const data = await jsonInput(c, projectFields); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId(); const { orderedServices, photographerUserIds, editorUserIds, ...fields } = data;
  await db.insert(schema.projects).values({ id, ...fields, stageKey: "awaiting_raw", createdAt: new Date(), updatedAt: new Date() });
  const services = await addCollections(db, id, orderedServices);
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
    const { orderedServices, photographerUserIds, editorUserIds, ...projectUpdates } = data;
    const auditMeta: Record<string, unknown> = { ...projectUpdates };
    if (orderedServices !== undefined) {
      // Grouped counts merged in JS — a correlated scalar subquery via sql`${schema.assets}` renders
      // incorrectly under drizzle/D1 and silently returned 0 (caught by the blocked-payload tests).
      const countsFor = async (collectionIds: string[]) => {
        const [assetRows, manifestRows] = await Promise.all([
          db.select({ collectionId: schema.assets.collectionId, n: sql<number>`count(*)` }).from(schema.assets).where(inArray(schema.assets.collectionId, collectionIds)).groupBy(schema.assets.collectionId).all(),
          db.select({ collectionId: schema.uploadManifests.collectionId, n: sql<number>`count(*)` }).from(schema.uploadManifests).where(inArray(schema.uploadManifests.collectionId, collectionIds)).groupBy(schema.uploadManifests.collectionId).all(),
        ]);
        return { assets: new Map(assetRows.map((row) => [row.collectionId, row.n])), manifests: new Map(manifestRows.map((row) => [row.collectionId, row.n])) };
      };
      const existing = await db.select({ id: schema.collections.id, kind: schema.collections.kind, receivedCount: schema.collections.receivedCount }).from(schema.collections).where(eq(schema.collections.projectId, id)).all();
      const desiredServices = new Set<CollectionKind>(["raw", ...orderedServices]);
      const removedCollections = existing.filter((collection) => collection.kind !== "raw" && !desiredServices.has(collection.kind as CollectionKind));
      const blockedPayload = (list: typeof removedCollections, counts: Awaited<ReturnType<typeof countsFor>>, removedKinds: string[] = []) =>
        c.json({ error: "Services with received media cannot be removed.", blocked: list.map((collection) => ({ kind: collection.kind, assetCount: counts.assets.get(collection.id) ?? 0, manifestCount: counts.manifests.get(collection.id) ?? 0 })), ...(removedKinds.length ? { removed: removedKinds } : {}) }, 409);
      if (removedCollections.length) {
        // Pre-screen so the COMMON blocked case mutates nothing at all (no partial removals on 409).
        const pre = await countsFor(removedCollections.map((collection) => collection.id));
        const preBlocked = removedCollections.filter((collection) => collection.receivedCount > 0 || (pre.assets.get(collection.id) ?? 0) > 0 || (pre.manifests.get(collection.id) ?? 0) > 0);
        if (preBlocked.length) return blockedPayload(preBlocked, pre);
      }
      // Correctness (no cascade-deleting a mid-flight upload) lives in the guarded DELETE itself —
      // the pre-screen above only shapes UX. A race between the two can still block a delete here;
      // in that rare case we audit what WAS removed and report both halves honestly.
      const guardedDeletes = await Promise.all(removedCollections.map((collection) => db.delete(schema.collections).where(and(eq(schema.collections.id, collection.id), eq(schema.collections.receivedCount, 0), notExists(db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.collectionId, schema.collections.id))), notExists(db.select({ id: schema.uploadManifests.id }).from(schema.uploadManifests).where(eq(schema.uploadManifests.collectionId, schema.collections.id))))).returning({ id: schema.collections.id })));
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
    if (photographerUserIds !== undefined) auditMeta.photographerMembers = await syncMembers(db, id, photographerUserIds, "photographer");
    if (editorUserIds !== undefined) auditMeta.editorMembers = await syncMembers(db, id, editorUserIds, "editor");
    await db.update(schema.projects).set({ ...projectUpdates, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, "project.update", "project", id, auditMeta); return c.json(await details(db, id));
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
    const asset = await db.select({ id: schema.assets.id }).from(schema.assets)
      .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id)))
      .where(and(eq(schema.assets.id, data.assetId), eq(schema.assets.kind, "photo"))).get();
    if (!asset) return c.json({ error: "Asset not in this project" }, 404);
  }
  await db.update(schema.projects).set({ coverAssetId: data.assetId, updatedAt: new Date() }).where(eq(schema.projects.id, id));
  await audit(c.env, c.get("user").id, "project.cover.set", "project", id, { assetId: data.assetId });
  return c.json({ coverAssetId: data.assetId });
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

projectsRoutes.post("/projects/:id/send-to-autohdr", requireCapability("selectForEditing"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const db = createDb(c.env.DB);
  const selected = await db.select({ id: schema.selections.id })
    .from(schema.selections)
    .innerJoin(schema.assets, eq(schema.selections.assetId, schema.assets.id))
    .innerJoin(schema.collections, and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, id), eq(schema.collections.kind, "raw")))
    .where(eq(schema.selections.state, "selected_for_editing"))
    .get();
  if (!selected) return c.json({ error: "Select at least one RAW asset before sending to autoHDR" }, 400);
  const { jobId } = await c.env.BACKGROUND.startAutoHdr(id);
  await audit(c.env, c.get("user").id, "project.send_to_autohdr", "project", id, { jobId });
  return c.json({ jobId });
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

projectsRoutes.get("/projects/:id/jobs", async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const rows = await createDb(c.env.DB).select({
    id: schema.jobs.id, kind: schema.jobs.kind, status: schema.jobs.status, error: schema.jobs.error,
    createdAt: schema.jobs.createdAt, updatedAt: schema.jobs.updatedAt,
  }).from(schema.jobs).where(and(eq(schema.jobs.projectId, id), eq(schema.jobs.kind, "autohdr"))).orderBy(desc(schema.jobs.createdAt)).limit(20).all();
  return c.json({ jobs: rows });
});

projectsRoutes.post("/jobs/:id/retry", requireCapability("selectForEditing"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid job id" }, 400);
  const job = await createDb(c.env.DB).select({ id: schema.jobs.id, projectId: schema.jobs.projectId, kind: schema.jobs.kind, status: schema.jobs.status })
    .from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  if (!job || job.kind !== "autohdr" || !job.projectId) return c.json({ error: "autoHDR job not found" }, 404);
  if (!await hasProjectAccess(c, job.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (job.status !== "stuck" && job.status !== "failed") return c.json({ error: "Only stuck or failed autoHDR jobs can be retried" }, 409);
  const { jobId } = await c.env.BACKGROUND.startAutoHdr(job.projectId);
  await audit(c.env, c.get("user").id, "project.retry_autohdr", "project", job.projectId, { previousJobId: id, jobId });
  return c.json({ jobId });
});

for (const [path, archived] of [["/projects/:id/archive", true], ["/projects/:id/restore", false]] as const) projectsRoutes.post(path, async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("archiveProject")) return c.json({ error: "Forbidden", capability: "archiveProject" }, 403);
  const db = createDb(c.env.DB); await db.update(schema.projects).set({ archivedAt: archived ? new Date() : null, archivedBy: archived ? c.get("user").id : null, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, archived ? "project.archive" : "project.restore", "project", id); return c.json({ ok: true });
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
  const r2Prefix = `projects/${id}/`;
  const assetCount = (await db.select({ count: sql<number>`count(*)` }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.collections.projectId, id)).get())?.count ?? 0;
  // Audit BEFORE destruction so the trail survives even if a later step dies mid-way.
  await audit(c.env, c.get("user").id, "project.delete", "project", id, { street: project.street, assetCount, r2Prefix });
  const keys: string[] = []; let cursor: string | undefined;
  while (true) {
    const page = await c.env.MEDIA.list({ prefix: r2Prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (let index = 0; index < keys.length; index += 1000) await c.env.MEDIA.delete(keys.slice(index, index + 1000));
  await db.delete(schema.jobs).where(eq(schema.jobs.projectId, id));
  await db.delete(schema.projects).where(eq(schema.projects.id, id));
  return c.json({ ok: true, deletedObjects: keys.length });
});
projectsRoutes.post("/projects/:id/stage", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    if (!ROLE_CAPABILITIES[c.get("user").role].includes("selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
    const data = await jsonInput(c, z.object({ stageKey: z.string() })); if (data instanceof Response) return data;
    if (!isStageKey(data.stageKey)) return c.json({ error: "Unknown stage" }, 400);
    const db = createDb(c.env.DB); const project = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).get(); if (!project) return c.json({ error: "Project not found" }, 404);
    await ensurePipelineStages(db);
    const target = await db.select({ active: schema.pipelineStages.active }).from(schema.pipelineStages).where(eq(schema.pipelineStages.key, data.stageKey)).get();
    if (!target?.active) return c.json({ error: "Stage is deactivated" }, 409);
    await db.update(schema.projects).set({ stageKey: data.stageKey, updatedAt: new Date() }).where(eq(schema.projects.id, id)); await audit(c.env, c.get("user").id, "stage.set", "project", id, { from: project.stageKey, to: data.stageKey }); return c.json({ ok: true, stageKey: data.stageKey });
  }
});
projectsRoutes.get("/projects/:id", async (c) => { const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400); if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); const value = await details(createDb(c.env.DB), id, c.get("user").role === "photographer"); return value ? c.json(value) : c.json({ error: "Project not found" }, 404); });
