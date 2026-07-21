import { Hono } from "hono";
import type { Context } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ROLE_CAPABILITIES, type CollectionKind } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId, safeFilename } from "../lib/ids";
import { jsonInput } from "./helpers";

const collectionKinds = ["video", "floorplan", "copy"] as const;
const documentKinds = ["floorplan_pdf", "copy_pdf", "floorplan_preview"] as const;
const linkInput = z.object({
  collection: z.enum(collectionKinds),
  url: z.string().url().refine((value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } }, "URL must use HTTPS"),
  label: z.string().trim().min(1).max(240).optional(),
});

function canManageCollection(c: Context<AppEnv>) {
  const role = c.get("user").role;
  // `manageExtras` is the existing Admin + Editor capability; `uploadRaw` also
  // includes photographers, who must not manage delivery collections (D-12).
  return ROLE_CAPABILITIES[role].includes("editProject") || ROLE_CAPABILITIES[role].includes("manageExtras");
}

async function ensureCollection(db: ReturnType<typeof createDb>, projectId: string, kind: CollectionKind) {
  await db.insert(schema.collections).values({ id: newId(), projectId, kind, status: "empty", receivedCount: 0, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  return db.select().from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, kind))).get();
}

function forbidden(c: Context<AppEnv>) {
  return c.json({ error: "Forbidden", capability: "manageExtras" }, 403);
}

export function uniqueVersionError(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed:\s*assets\.version_group_id/i.test(e.message)) return true;
  }
  return false;
}

export const collectionsRoutes = new Hono<AppEnv>();

collectionsRoutes.get("/projects/:id/links", async (c) => {
  const projectId = c.req.param("id"); const collectionKind = c.req.query("collection");
  if (!z.string().uuid().safeParse(projectId).success || !z.enum(collectionKinds).safeParse(collectionKind).success) return c.json({ error: "A valid project and collection are required" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!ROLE_CAPABILITIES[c.get("user").role].includes("viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
  const rows = await createDb(c.env.DB).select({ id: schema.collectionLinks.id, url: schema.collectionLinks.url, label: schema.collectionLinks.label, source: schema.collectionLinks.source, createdAt: schema.collectionLinks.createdAt })
    .from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, collectionKind as CollectionKind))).orderBy(asc(schema.collectionLinks.createdAt)).all();
  return c.json({ links: rows });
});

collectionsRoutes.post("/projects/:id/links", async (c) => {
  const projectId = c.req.param("id"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageCollection(c)) return forbidden(c);
  const data = await jsonInput(c, linkInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const collection = await ensureCollection(db, projectId, data.collection);
  if (!collection) return c.json({ error: "Project not found" }, 404);
  const id = newId(); const now = new Date();
  await db.insert(schema.collectionLinks).values({ id, collectionId: collection.id, url: data.url, label: data.label, source: "manual", createdAt: now, updatedAt: now });
  await db.update(schema.collections).set({ status: "received", updatedAt: now }).where(eq(schema.collections.id, collection.id));
  await audit(c.env, c.get("user").id, "collection_link.create", "collection_link", id, { projectId, ...data });
  return c.json({ id, url: data.url, label: data.label ?? null, source: "manual", createdAt: now }, 201);
});

collectionsRoutes.delete("/projects/:id/links/:linkId", async (c) => {
  const projectId = c.req.param("id"), linkId = c.req.param("linkId");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(linkId).success) return c.json({ error: "Invalid project or link id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageCollection(c)) return forbidden(c);
  const db = createDb(c.env.DB); const link = await db.select({ source: schema.collectionLinks.source, collectionId: schema.collectionLinks.collectionId }).from(schema.collectionLinks)
    .innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collectionLinks.id, linkId), eq(schema.collections.projectId, projectId))).get();
  if (!link) return c.json({ error: "Link not found" }, 404);
  if (link.source !== "manual") return c.json({ error: "Tonomo delivery links are immutable" }, 409);
  await db.delete(schema.collectionLinks).where(eq(schema.collectionLinks.id, linkId));
  const [remainingLinks, remainingAssets] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, link.collectionId)).get(),
    db.select({ count: sql<number>`count(*)` }).from(schema.assets).where(eq(schema.assets.collectionId, link.collectionId)).get(),
  ]);
  const emptied = Number(remainingLinks?.count ?? 0) === 0 && Number(remainingAssets?.count ?? 0) === 0;
  // A concurrent insert can still race this last-link reconciliation; an empty status is acceptable until the next write.
  if (emptied) await db.update(schema.collections).set({ status: "empty", updatedAt: new Date() }).where(eq(schema.collections.id, link.collectionId));
  await audit(c.env, c.get("user").id, "collection_link.delete", "collection_link", linkId, { projectId, collectionStatus: emptied ? "empty" : undefined });
  return c.body(null, 204);
});

collectionsRoutes.post("/projects/:id/documents", async (c) => {
  const projectId = c.req.param("id"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageCollection(c)) return forbidden(c);
  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: "Malformed multipart document upload" }, 400); }
  const kindResult = z.enum(documentKinds).safeParse(form.get("kind"));
  const versionGroupResult = z.string().uuid().optional().safeParse(form.get("versionGroupId") || undefined);
  const file = form.get("file");
  if (!kindResult.success || !versionGroupResult.success || !(file instanceof File) || !file.name) return c.json({ error: "A document kind and file are required" }, 400);
  const kind = kindResult.data; const isPreview = kind === "floorplan_preview";
  if ((!isPreview && (file.type !== "application/pdf" || file.size > 50 * 1024 * 1024)) || (isPreview && (file.type !== "image/jpeg" || file.size > 10 * 1024 * 1024))) return c.json({ error: isPreview ? "Floorplan previews must be JPEGs no larger than 10 MB" : "Documents must be PDFs no larger than 50 MB" }, 400);
  if (isPreview && !versionGroupResult.data) return c.json({ error: "A floorplan preview must reference its PDF version group" }, 400);
  const collectionKind: CollectionKind = kind.startsWith("floorplan") ? "floorplan" : "copy";
  const db = createDb(c.env.DB); const collection = await ensureCollection(db, projectId, collectionKind);
  if (!collection) return c.json({ error: "Project not found" }, 404);

  let versionGroupId: string;
  if (versionGroupResult.data) {
    const groupDocument = await db.select({ id: schema.assets.id }).from(schema.assets)
      .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
      .where(and(eq(schema.collections.projectId, projectId), eq(schema.assets.versionGroupId, versionGroupResult.data), eq(schema.assets.kind, isPreview ? "floorplan_pdf" : kind)))
      .orderBy(desc(schema.assets.version)).get();
    if (!groupDocument) return c.json({ error: isPreview ? "Floorplan PDF version group not found" : "Document version group not found" }, 404);
    versionGroupId = versionGroupResult.data;
  } else versionGroupId = newId();

  let assetId = versionGroupResult.data ? newId() : versionGroupId; let version = 1; let supersedesAssetId: string | null = null; let now = new Date();
  // TODO(uploads): presign large documents like the RAW flow.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const previous = await db.select({ id: schema.assets.id, version: schema.assets.version }).from(schema.assets)
      .where(and(eq(schema.assets.versionGroupId, versionGroupId), eq(schema.assets.kind, kind))).orderBy(desc(schema.assets.version)).get();
    version = (previous?.version ?? 0) + 1; supersedesAssetId = previous?.id ?? null;
    assetId = versionGroupResult.data ? newId() : versionGroupId;
    const key = `projects/${projectId}/${collectionKind}/${assetId}/${safeFilename(file.name)}`;
    await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    now = new Date();
    try {
      await db.insert(schema.assets).values({ id: assetId, collectionId: collection.id, kind, r2Key: key, originalFilename: file.name, bytes: file.size, source: "upload", version, versionGroupId, supersedesAssetId, createdAt: now, updatedAt: now });
      break;
    } catch (error) {
      if (!uniqueVersionError(error) || attempt === 4) throw error;
    }
  }
  await db.update(schema.collections).set({ receivedCount: sql`${schema.collections.receivedCount} + 1`, status: "received", updatedAt: now }).where(eq(schema.collections.id, collection.id));
  await audit(c.env, c.get("user").id, "document.upload", "asset", assetId, { projectId, kind, version, versionGroupId, supersedesAssetId });
  return c.json({ id: assetId, kind, originalFilename: file.name, bytes: file.size, version, versionGroupId, supersedesAssetId, createdAt: now }, 201);
});
