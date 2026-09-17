import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import type { Context } from "hono";
import { buildProjectActivityStatements, COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, computeInsertPosition, createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { externalCollectionLinkListResponseSchema, externalCollectionLinkSchema, projectActivityDeepLink, publishNotificationOutbox, roleHasCapability, type CollectionKind, type ProjectActivityIntent } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { audit, auditMeta } from "../lib/audit";
import { newId, safeFilename } from "../lib/ids";
import { abortMultipart, completeMultipart, createMultipartPresign } from "../lib/r2s3";
import { jsonInput } from "./helpers";
import { resolveVisibleProject } from "../lib/visible-project-scope";

const collectionKinds = ["video", "floorplan", "copy"] as const;
const fileInput = z.object({ filename: z.string().trim().min(1).max(255), bytes: z.number().int().positive(), contentType: z.string() });
const documentPresignInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("copy_pdf"), versionGroupId: z.string().uuid().optional(), pdf: fileInput }),
  z.object({ kind: z.literal("floorplan"), versionGroupId: z.string().uuid().optional(), pdf: fileInput, preview: fileInput }),
]);
const multipartPart = z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) });
const documentCompleteInput = z.object({ sessionId: z.string().uuid(), pdf: z.object({ uploadId: z.string().optional(), parts: z.array(multipartPart).optional() }), preview: z.object({ uploadId: z.string().optional(), parts: z.array(multipartPart).optional() }).optional() });
const linkInput = z.object({
  collection: z.enum(collectionKinds),
  url: z.string().url().refine((value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } }, "URL must use HTTPS"),
  label: z.string().trim().min(1).max(240).optional(),
});
const linkEditInput = linkInput.pick({ url: true, label: true });
const linkReorderInput = z.object({ beforeId: z.string().uuid().nullable(), afterId: z.string().uuid().nullable() }).strict()
  .refine((value) => value.beforeId !== value.afterId || value.beforeId === null, "Neighbors must be distinct");
const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const DOCUMENT_COMPLETING_LEASE_MS = 15 * 60 * 1000;

type Db = ReturnType<typeof createDb>;
type DocumentUpload = typeof schema.documentUploads.$inferSelect;

function canManageCollection(c: Context<AppEnv>) {
  const role = c.get("user").role;
  return roleHasCapability(role, "editProject") || roleHasCapability(role, "manageExtras");
}
function canManageVideoLinks(c: Context<AppEnv>) {
  return canManageCollection(c) || roleHasCapability(c.get("user").role, "uploadExtras");
}
// Per the approved §5 "Document-upload response shape" decision, these routes intentionally
// return their internal response shape to an uploadExtras principal. This is a scoped,
// owner-approved trust-boundary exception; do not add a proxy or projection here.
function canManageDocuments(c: Context<AppEnv>) {
  return canManageCollection(c) || roleHasCapability(c.get("user").role, "uploadExtras");
}
// `manageExtras` is legacy diagnostic text shared by all collection mutations; authorization is
// defined by the broad and surface-specific helpers above, not by this response field.
function forbidden(c: Context<AppEnv>) { return c.json({ error: "Forbidden", capability: "manageExtras" }, 403); }
function documentCollection(kind: "copy_pdf" | "floorplan"): "copy" | "floorplan" { return kind === "floorplan" ? "floorplan" : "copy"; }
function expectedPdfKind(kind: "copy_pdf" | "floorplan") { return kind === "floorplan" ? "floorplan_pdf" : "copy_pdf"; }
function documentKey(projectId: string, collection: "copy" | "floorplan", assetId: string, filename: string) { return `projects/${projectId}/${collection}/${assetId}/${safeFilename(filename)}`; }
function validFile(file: { filename: string; bytes: number; contentType: string }, type: "application/pdf" | "image/jpeg", maxBytes: number) {
  const extension = type === "application/pdf" ? /\.pdf$/i : /\.jpe?g$/i;
  return file.filename.length > 0 && extension.test(file.filename) && file.bytes > 0 && file.bytes <= maxBytes && file.contentType === type;
}

async function ensureCollection(db: Db, projectId: string, kind: CollectionKind) {
  await db.insert(schema.collections).values({ id: newId(), projectId, kind, status: "empty", receivedCount: 0, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  return db.select().from(schema.collections).where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, kind))).get();
}

/** Collections are delivery counts, not mutation counters. This is safe after retries and concurrent writers. */
export async function reconcileCollectionReceivedCount(db: Db, collectionId: string, now = new Date()) {
  const count = sql<number>`(SELECT count(*) FROM collection_links WHERE collection_id = ${collectionId}) + (SELECT count(*) FROM assets WHERE collection_id = ${collectionId} AND publish_status = 'ready' AND superseded_at IS NULL)`;
  await db.update(schema.collections).set({ receivedCount: count, status: sql<string>`CASE WHEN ${count} > 0 THEN 'received' ELSE 'empty' END`, updatedAt: now }).where(eq(schema.collections.id, collectionId));
  const collection = await db.select({ receivedCount: schema.collections.receivedCount }).from(schema.collections).where(eq(schema.collections.id, collectionId)).get();
  return collection?.receivedCount ?? 0;
}

async function abortReservation(c: Context<AppEnv>, upload: Pick<DocumentUpload, "pdfKey" | "pdfUploadId" | "previewKey" | "previewUploadId">) {
  // 404 is handled as already-aborted by abortMultipart. Other errors retain ownership so
  // the caller can leave the reservation retryable rather than orphaning multipart parts.
  try {
    await Promise.all([
      upload.pdfUploadId ? abortMultipart(c.env, upload.pdfKey, upload.pdfUploadId) : undefined,
      upload.previewKey && upload.previewUploadId ? abortMultipart(c.env, upload.previewKey, upload.previewUploadId) : undefined,
    ]);
    return true;
  } catch { return false; }
}

/** Only pending reservations may expire. Completing owns an external R2 operation and must
 * be resolved by completion/abort, never silently stolen by a later presign. */
async function expirePendingUploads(c: Context<AppEnv>, db: Db, projectId: string) {
  const now = new Date();
  const expired = await db.select().from(schema.documentUploads).where(and(
    eq(schema.documentUploads.projectId, projectId), eq(schema.documentUploads.status, "pending"),
    sql`${schema.documentUploads.expiresAt} <= ${now.getTime()}`,
  )).all();
  for (const upload of expired) {
    const aborted = await abortReservation(c, upload);
    if (!aborted) {
      await db.update(schema.documentUploads).set({ status: "aborting", updatedAt: now }).where(and(eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "pending")));
      continue;
    }
    await db.update(schema.documentUploads).set({ status: "expired", updatedAt: now }).where(and(
      eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "pending"), sql`${schema.documentUploads.expiresAt} <= ${now.getTime()}`,
    ));
  }
  const recoverable = await db.select().from(schema.documentUploads).where(and(
    eq(schema.documentUploads.projectId, projectId),
    sql`${schema.documentUploads.status} = 'aborting' OR (${schema.documentUploads.status} = 'completing' AND ${schema.documentUploads.completingAt} <= ${now.getTime() - DOCUMENT_COMPLETING_LEASE_MS})`,
  )).all();
  for (const upload of recoverable) {
    await db.update(schema.documentUploads).set({ status: "aborting", updatedAt: now }).where(and(eq(schema.documentUploads.id, upload.id), sql`${schema.documentUploads.status} in ('aborting', 'completing')`));
    if (await abortReservation(c, upload)) await db.update(schema.documentUploads).set({ status: "expired", updatedAt: now }).where(and(eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "aborting")));
  }
}

async function activeProject(db: Db, projectId: string) {
  return db.select({ id: schema.projects.id, archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

export function uniqueVersionError(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed:\s*(assets\.version_group_id|document_uploads\.version_group_id)/i.test(e.message)) return true;
  }
  return false;
}

export function collectionLinkUrlConflict(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed:\s*collection_links\.collection_id,\s*collection_links\.url/i.test(e.message)) return true;
  }
  return false;
}

function responseFor(upload: DocumentUpload) {
  const pdf = { id: upload.pdfAssetId, kind: upload.kind === "floorplan" ? "floorplan_pdf" : "copy_pdf", originalFilename: upload.pdfFilename, bytes: upload.pdfBytes, version: upload.version, versionGroupId: upload.versionGroupId, supersedesAssetId: upload.pdfSupersedesAssetId, createdAt: upload.createdAt };
  const preview = upload.kind === "floorplan" ? { id: upload.previewAssetId!, kind: "floorplan_preview", originalFilename: upload.previewFilename!, bytes: upload.previewBytes!, version: upload.version, versionGroupId: upload.versionGroupId, supersedesAssetId: upload.previewSupersedesAssetId, createdAt: upload.createdAt } : null;
  return { ...pdf, preview, assets: preview ? [pdf, preview] : [pdf] };
}

async function ownedUpload(c: Context<AppEnv>, projectId: string, sessionId: string) {
  const pending = await createDb(c.env.DB).select().from(schema.documentUploads).where(and(eq(schema.documentUploads.id, sessionId), eq(schema.documentUploads.projectId, projectId), eq(schema.documentUploads.createdBy, c.get("user").id))).get();
  return pending ?? null;
}

async function verifyObject(c: Context<AppEnv>, key: string, bytes: number, contentType: string) {
  const object = await c.env.MEDIA.head(key);
  if (!object) throw new Error("The uploaded document was not found in R2");
  if (object.size !== bytes || object.httpMetadata?.contentType !== contentType) throw new Error("The uploaded document does not match its reserved size or content type");
}

async function finishObject(c: Context<AppEnv>, upload: DocumentUpload, slot: "pdf" | "preview", client: { uploadId?: string; parts?: { partNumber: number; etag: string }[] }) {
  const key = slot === "pdf" ? upload.pdfKey : upload.previewKey!;
  const bytes = slot === "pdf" ? upload.pdfBytes : upload.previewBytes!;
  const contentType = slot === "pdf" ? upload.pdfContentType : upload.previewContentType!;
  const reservedUploadId = slot === "pdf" ? upload.pdfUploadId : upload.previewUploadId;
  const existing = await c.env.MEDIA.head(key);
  if (!existing) {
    if (!reservedUploadId || client.uploadId !== reservedUploadId || !client.parts?.length) throw new Error(`The ${slot} upload has not completed`);
    await completeMultipart(c.env, key, reservedUploadId, client.parts, bytes);
  }
  await verifyObject(c, key, bytes, contentType);
}

export const collectionsRoutes = new Hono<AppEnv>();

collectionsRoutes.get("/projects/:id/links", terminalRoute("/projects/:id/links", async (c) => {
  const projectId = c.req.param("id"); const collectionKind = c.req.query("collection");
  if (!z.string().uuid().safeParse(projectId).success || !z.enum(collectionKinds).safeParse(collectionKind).success) return c.json({ error: "A valid project and collection are required" }, 400);
  if (c.get("user").role === "external_editor") {
    if (!await resolveVisibleProject(c.env, c.get("user"), projectId)) return c.json({ error: "Project not found" }, 404);
    const rows = await createDb(c.env.DB).select({ id: schema.collectionLinks.id, url: schema.collectionLinks.url, label: schema.collectionLinks.label, source: schema.collectionLinks.source, position: schema.collectionLinks.position, createdAt: schema.collectionLinks.createdAt })
      .from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
      .where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, collectionKind as CollectionKind))).orderBy(asc(schema.collectionLinks.position), asc(schema.collectionLinks.id)).all();
    return c.json(externalCollectionLinkListResponseSchema.parse({ links: rows.map((row) => externalCollectionLinkSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })) }));
  }
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!roleHasCapability(c.get("user").role, "viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
  const rows = await createDb(c.env.DB).select({ id: schema.collectionLinks.id, url: schema.collectionLinks.url, label: schema.collectionLinks.label, source: schema.collectionLinks.source, position: schema.collectionLinks.position, createdAt: schema.collectionLinks.createdAt })
    .from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collections.projectId, projectId), eq(schema.collections.kind, collectionKind as CollectionKind))).orderBy(asc(schema.collectionLinks.position), asc(schema.collectionLinks.id)).all();
  return c.json({ links: rows });
}));

collectionsRoutes.post("/projects/:id/links", terminalRoute("/projects/:id/links", async (c) => {
  const projectId = c.req.param("id"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const data = await jsonInput(c, linkInput); if (data instanceof Response) return data;
  if (!canManageVideoLinks(c) || (data.collection !== "video" && !canManageCollection(c))) return forbidden(c);
  const db = createDb(c.env.DB); const collection = await ensureCollection(db, projectId, data.collection);
  if (!collection) return c.json({ error: "Project not found" }, 404);
  const id = newId(); const now = new Date(); const auditId = newId();
  const activityId = newId();
  const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.collection.video_link_added", projectId, actorId: c.get("user").id, occurredAt: now.getTime(), source: { kind: "project_video_link", id, key: `project-video-link:${id}:added` }, safePayload: { linkId: id, collectionKind: "video" }, deepLink: projectActivityDeepLink("project.collection.video_link_added", projectId) }, broadDelivery: { registryKey: "project.collection.video_link_added", sourceActivityId: activityId, coalesce: null } };
  const activityBundle = data.collection === "video" ? buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId, createdAt: now.getTime() }) : null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', COALESCE((SELECT MAX(position) FROM collection_links WHERE collection_id = ?), 0) + 1024, ?, ?) ON CONFLICT(collection_id, url) DO NOTHING RETURNING id").bind(id, collection.id, data.url, data.label ?? null, collection.id, now.getTime(), now.getTime()),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'collection_link.create', 'collection_link', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(auditId, c.get("user").id, id, auditMeta(c.get("user"), { projectId, ...data }), now.getTime()),
    c.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
  ];
  if (activityBundle) statements.push(...activityBundle.statements);
  const results = await c.env.DB.batch(statements);
  const saved = await db.select().from(schema.collectionLinks).where(and(eq(schema.collectionLinks.collectionId, collection.id), eq(schema.collectionLinks.url, data.url))).get();
  if (!saved) return c.json({ error: "Could not save collection link" }, 409);
  if (activityBundle && ((results[0]?.results?.length ?? 0) === 1)) {
    const publicationIds = ((results[3 + activityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
    if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  }
  return c.json({ id: saved.id, url: saved.url, label: saved.label, source: saved.source, position: saved.position, createdAt: saved.createdAt }, saved.id === id ? 201 : 200);
}));

collectionsRoutes.patch("/projects/:id/links/:linkId", terminalRoute("/projects/:id/links/:linkId", async (c) => {
  const projectId = c.req.param("id"), linkId = c.req.param("linkId");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(linkId).success) return c.json({ error: "Invalid project or link id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageVideoLinks(c)) return forbidden(c);
  const data = await jsonInput(c, linkEditInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const link = await db.select({ id: schema.collectionLinks.id, source: schema.collectionLinks.source, collectionId: schema.collectionLinks.collectionId, url: schema.collectionLinks.url, label: schema.collectionLinks.label, position: schema.collectionLinks.position, createdAt: schema.collectionLinks.createdAt })
    .from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collectionLinks.id, linkId), eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "video"))).get();
  if (!link) return c.json({ error: "Link not found" }, 404);
  if (link.source !== "manual") return c.json({ error: "Tonomo delivery links are immutable" }, 409);

  const updatedLabel = data.label ?? null;
  const existing = await db.select({ id: schema.collectionLinks.id }).from(schema.collectionLinks).where(and(
    eq(schema.collectionLinks.collectionId, link.collectionId), eq(schema.collectionLinks.url, data.url), ne(schema.collectionLinks.id, linkId),
  )).get();
  if (existing) return c.json({ error: "A link with this URL already exists in this collection" }, 409);

  const now = new Date();
  if (link.url === data.url && link.label === updatedLabel) return c.json({ id: link.id, url: link.url, label: link.label, source: link.source, position: link.position, createdAt: link.createdAt });
  const auditId = newId(); const activityId = newId();
  const changedFields = [...(link.url !== data.url ? ["url" as const] : []), ...(link.label !== updatedLabel ? ["label" as const] : [])];
  const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.collection.video_link_changed", projectId, actorId: c.get("user").id, occurredAt: now.getTime(), source: { kind: "project_video_link", id: linkId, key: `project-video-link:${linkId}:changed:${activityId}` }, safePayload: { linkId, collectionKind: "video", changedFields }, deepLink: projectActivityDeepLink("project.collection.video_link_changed", projectId) }, broadDelivery: { registryKey: "project.collection.video_link_changed", sourceActivityId: activityId, coalesce: null } };
  const activityBundle = buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId, createdAt: now.getTime() });
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE collection_links SET url = ?, label = ?, updated_at = ?
        WHERE id = ? AND collection_id = ? AND source = 'manual' AND url = ? AND label IS ?
          AND EXISTS (SELECT 1 FROM collections WHERE id = collection_links.collection_id AND project_id = ? AND kind = 'video')`)
        .bind(data.url, updatedLabel, now.getTime(), linkId, link.collectionId, link.url, link.label, projectId),
      c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?, ?, 'collection_link.update', 'collection_link', ?, ?, ? WHERE changes() > 0 RETURNING id`)
        .bind(auditId, c.get("user").id, linkId, auditMeta(c.get("user"), { projectId, previous: { url: link.url, label: link.label }, updated: { url: data.url, label: updatedLabel } }), now.getTime()),
      ...activityBundle.statements,
    ]);
  } catch (error) {
    if (collectionLinkUrlConflict(error)) return c.json({ error: "A link with this URL already exists in this collection" }, 409);
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) > 0) {
    const publicationIds = ((results[2 + activityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
    if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
    return c.json({ id: link.id, url: data.url, label: updatedLabel, source: "manual", position: link.position, createdAt: link.createdAt });
  }

  const current = await db.select({ id: schema.collectionLinks.id, source: schema.collectionLinks.source, url: schema.collectionLinks.url, label: schema.collectionLinks.label, position: schema.collectionLinks.position, createdAt: schema.collectionLinks.createdAt }).from(schema.collectionLinks)
    .innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collectionLinks.id, linkId), eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "video"))).get();
  if (!current) return c.json({ error: "Link not found" }, 404);
  if (current.source !== "manual") return c.json({ error: "Tonomo delivery links are immutable" }, 409);
  if (current.url === data.url && current.label === updatedLabel) return c.json({ id: current.id, url: current.url, label: current.label, source: current.source, position: current.position, createdAt: current.createdAt });
  return c.json({ error: "This link changed while you were editing; reload and try again" }, 409);
}));

collectionsRoutes.post("/projects/:id/links/:linkId/reorder", terminalRoute("/projects/:id/links/:linkId/reorder", async (c) => {
  const projectId = c.req.param("id"), linkId = c.req.param("linkId");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(linkId).success) return c.json({ error: "Invalid project or link id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageVideoLinks(c)) return forbidden(c);
  const data = await jsonInput(c, linkReorderInput); if (data instanceof Response) return data;
  if (data.beforeId === linkId || data.afterId === linkId) return c.json({ error: "A link cannot be its own neighbor" }, 400);

  const db = createDb(c.env.DB);
  const target = await db.select({ id: schema.collectionLinks.id, collectionId: schema.collectionLinks.collectionId, position: schema.collectionLinks.position })
    .from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id))
    .where(and(eq(schema.collectionLinks.id, linkId), eq(schema.collections.projectId, projectId), eq(schema.collections.kind, "video"))).get();
  if (!target) return c.json({ error: "Link not found" }, 404);
  const snapshot = await db.select({ id: schema.collectionLinks.id, position: schema.collectionLinks.position })
    .from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, target.collectionId))
    .orderBy(asc(schema.collectionLinks.position), asc(schema.collectionLinks.id)).all();
  const snapshotIds = snapshot.map((item) => item.id);
  const remaining = snapshot.filter((item) => item.id !== linkId);
  const beforeIndex = data.beforeId ? remaining.findIndex((item) => item.id === data.beforeId) : -1;
  const afterIndex = data.afterId ? remaining.findIndex((item) => item.id === data.afterId) : -1;
  if ((data.beforeId && beforeIndex < 0) || (data.afterId && afterIndex < 0)) return c.json({ error: "Neighbor link not found" }, 404);
  const expectedAfterIndex = data.beforeId ? beforeIndex + 1 : 0;
  if (data.beforeId === null && data.afterId === null ? remaining.length !== 0 : data.afterId ? afterIndex !== expectedAfterIndex : beforeIndex !== remaining.length - 1) return c.json({ error: "Link order changed; reload and try again" }, 409);
  const before = data.beforeId ? remaining[beforeIndex]! : null; const after = data.afterId ? remaining[afterIndex]! : null;
  const insertAt = before ? beforeIndex + 1 : 0;
  const desired = [...remaining]; desired.splice(insertAt, 0, target);
  if (JSON.stringify(desired.map((item) => item.id)) === JSON.stringify(snapshotIds)) return c.json({ position: target.position });
  const position = computeInsertPosition(before?.position ?? null, after?.position ?? null); const now = Date.now();
  const tied = position === before?.position || position === after?.position;
  const reorderAuditId = newId(); const reorderActivityId = newId();
  const reorderActivity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: reorderActivityId, type: "project.collection.video_links_reordered", projectId, actorId: c.get("user").id, occurredAt: now, source: { kind: "project_video_links", id: target.collectionId, key: `project-video-links:${target.collectionId}:reordered:${reorderActivityId}` }, safePayload: { collectionKind: "video", count: snapshot.length }, deepLink: projectActivityDeepLink("project.collection.video_links_reordered", projectId) }, broadDelivery: { registryKey: "project.collection.video_links_reordered", sourceActivityId: reorderActivityId, coalesce: null } };
  const reorderActivityBundle = buildProjectActivityStatements({ db: c.env.DB, intent: reorderActivity, winnerAuditId: reorderAuditId, createdAt: now });

  // Keep the audit in the D1 batch. A failed audit write rolls back the position mutation rather
  // than returning a 500 after a successful, un-audited reorder.
  if (tied) {
    const plannedPositions = desired.map((item, index) => ({ id: item.id, oldPosition: item.position, newPosition: (index + 1) * 1024 }));
    const expectedChangedCount = plannedPositions.filter((item) => item.oldPosition !== item.newPosition).length;
    if (expectedChangedCount === 0) return c.json({ position: target.position });
    const snapshotJson = JSON.stringify(plannedPositions);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE collection_links SET position = (SELECT CAST(json_extract(value, '$.newPosition') AS INTEGER) FROM json_each(?1) WHERE json_extract(value, '$.id') = collection_links.id), updated_at = ?2 WHERE collection_id = ?3 AND (id, position) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.oldPosition') FROM json_each(?1)) AND (SELECT COUNT(*) FROM collection_links WHERE collection_id = ?3 AND (id, position) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.oldPosition') FROM json_each(?1))) = json_array_length(?1) AND (SELECT COUNT(*) FROM collection_links WHERE collection_id = ?3) = json_array_length(?1) AND position IS NOT (SELECT CAST(json_extract(desired.value, '$.newPosition') AS INTEGER) FROM json_each(?1) desired WHERE json_extract(desired.value, '$.id') = collection_links.id)`).bind(snapshotJson, now, target.collectionId),
      c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'collection_link.reorder', 'collection_link', ?, ?, ? WHERE changes() = ? RETURNING id").bind(reorderAuditId, c.get("user").id, linkId, auditMeta(c.get("user"), { projectId, beforeId: data.beforeId, afterId: data.afterId }), now, expectedChangedCount),
      ...reorderActivityBundle.statements,
    ]);
    if ((results[0]?.meta.changes ?? 0) !== expectedChangedCount) {
      const current = await db.select({ id: schema.collectionLinks.id, position: schema.collectionLinks.position }).from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, target.collectionId)).orderBy(asc(schema.collectionLinks.position), asc(schema.collectionLinks.id)).all();
      if (JSON.stringify(current.map((item) => item.id)) === JSON.stringify(desired.map((item) => item.id))) return c.json({ position: current.find((item) => item.id === linkId)?.position ?? target.position });
      return c.json({ error: "Link order changed; reload and try again" }, 409);
    }
    const publicationIds = ((results[2 + reorderActivityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
    if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
    return c.json({ position: (desired.findIndex((item) => item.id === linkId) + 1) * 1024 });
  }

  const params: unknown[] = [position, now, target.id, target.collectionId, target.position, position, projectId, target.collectionId, snapshot.length];
  let guard = "";
  if (before) { guard += " AND EXISTS (SELECT 1 FROM collection_links WHERE id = ? AND collection_id = ? AND position = ?)"; params.push(before.id, target.collectionId, before.position); }
  if (after) { guard += " AND EXISTS (SELECT 1 FROM collection_links WHERE id = ? AND collection_id = ? AND position = ?)"; params.push(after.id, target.collectionId, after.position); }
  if (before && after) { guard += " AND NOT EXISTS (SELECT 1 FROM collection_links AS candidate WHERE candidate.collection_id = ? AND candidate.id <> ? AND (candidate.position > ? OR (candidate.position = ? AND candidate.id > ?)) AND (candidate.position < ? OR (candidate.position = ? AND candidate.id < ?)))"; params.push(target.collectionId, target.id, before.position, before.position, before.id, after.position, after.position, after.id); }
  else if (before) { guard += " AND NOT EXISTS (SELECT 1 FROM collection_links AS candidate WHERE candidate.collection_id = ? AND candidate.id <> ? AND (candidate.position > ? OR (candidate.position = ? AND candidate.id > ?)))"; params.push(target.collectionId, target.id, before.position, before.position, before.id); }
  else if (after) { guard += " AND NOT EXISTS (SELECT 1 FROM collection_links AS candidate WHERE candidate.collection_id = ? AND candidate.id <> ? AND (candidate.position < ? OR (candidate.position = ? AND candidate.id < ?)))"; params.push(target.collectionId, target.id, after.position, after.position, after.id); }
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE collection_links SET position = ?, updated_at = ? WHERE id = ? AND collection_id = ? AND position = ? AND position IS NOT ? AND EXISTS (SELECT 1 FROM collections WHERE id = collection_links.collection_id AND project_id = ? AND kind = 'video') AND (SELECT COUNT(*) FROM collection_links WHERE collection_id = ?) = ?${guard}`).bind(...params),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'collection_link.reorder', 'collection_link', ?, ?, ? WHERE changes() > 0 RETURNING id").bind(reorderAuditId, c.get("user").id, linkId, auditMeta(c.get("user"), { projectId, beforeId: data.beforeId, afterId: data.afterId }), now),
    ...reorderActivityBundle.statements,
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const current = await db.select({ id: schema.collectionLinks.id, position: schema.collectionLinks.position }).from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, target.collectionId)).orderBy(asc(schema.collectionLinks.position), asc(schema.collectionLinks.id)).all();
    if (JSON.stringify(current.map((item) => item.id)) === JSON.stringify(desired.map((item) => item.id))) return c.json({ position: current.find((item) => item.id === linkId)?.position ?? target.position });
    return c.json({ error: "Link order changed; reload and try again" }, 409);
  }
  const publicationIds = ((results[2 + reorderActivityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
  if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  return c.json({ position });
}));

collectionsRoutes.delete("/projects/:id/links/:linkId", terminalRoute("/projects/:id/links/:linkId", async (c) => {
  const projectId = c.req.param("id"), linkId = c.req.param("linkId");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(linkId).success) return c.json({ error: "Invalid project or link id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageVideoLinks(c)) return forbidden(c);
  const broadCollectionAuthority = canManageCollection(c);
  const db = createDb(c.env.DB); const link = await db.select({ source: schema.collectionLinks.source, collectionId: schema.collectionLinks.collectionId, kind: schema.collections.kind }).from(schema.collectionLinks).innerJoin(schema.collections, eq(schema.collectionLinks.collectionId, schema.collections.id)).where(and(eq(schema.collectionLinks.id, linkId), eq(schema.collections.projectId, projectId))).get();
  if (!link || (!broadCollectionAuthority && link.kind !== "video")) return c.json({ error: "Link not found" }, 404);
  if (link.source !== "manual") return c.json({ error: "Tonomo delivery links are immutable" }, 409);
  const now = new Date();
  const auditId = newId(); const activityId = newId();
  const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.collection.video_link_removed", projectId, actorId: c.get("user").id, occurredAt: now.getTime(), source: { kind: "project_video_link", id: linkId, key: `project-video-link:${linkId}:removed` }, safePayload: { linkId, collectionKind: "video" }, deepLink: projectActivityDeepLink("project.collection.video_link_removed", projectId) }, broadDelivery: { registryKey: "project.collection.video_link_removed", sourceActivityId: activityId, coalesce: null } };
  const activityBundle = link.kind === "video" ? buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: auditId, createdAt: now.getTime() }) : null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare("DELETE FROM collection_links WHERE id = ? AND source = 'manual' RETURNING id").bind(linkId),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'collection_link.delete', 'collection_link', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(auditId, c.get("user").id, linkId, auditMeta(c.get("user"), { projectId }), now.getTime()),
    c.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(link.collectionId, now.getTime())),
  ];
  if (activityBundle) statements.push(...activityBundle.statements);
  const results = await c.env.DB.batch(statements);
  if (!((results[0]?.results?.length ?? 0) > 0)) return c.json({ error: "Link not found" }, 404);
  if (activityBundle) {
    const publicationIds = ((results[3 + activityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
    if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  }
  return c.body(null, 204);
}));

// Kept only to make old clients fail explicitly; document bytes must never enter Worker formData().
collectionsRoutes.post("/projects/:id/documents", terminalRoute("/projects/:id/documents", (c) => c.json({ error: "Document uploads now use the presign and completion endpoints" }, 410)));

collectionsRoutes.post("/projects/:id/documents/presign", terminalRoute("/projects/:id/documents/presign", async (c) => {
  const projectId = c.req.param("id"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageDocuments(c)) return forbidden(c);
  const data = await jsonInput(c, documentPresignInput); if (data instanceof Response) return data;
  if (!validFile(data.pdf, "application/pdf", PDF_MAX_BYTES) || (data.kind === "floorplan" && !validFile(data.preview, "image/jpeg", PREVIEW_MAX_BYTES))) return c.json({ error: "PDFs must be application/pdf up to 50 MiB and floorplan previews must be image/jpeg up to 10 MiB" }, 400);
  const db = createDb(c.env.DB); const project = await activeProject(db, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt) return c.json({ error: "Archived projects cannot accept document uploads" }, 409);
  const collectionKind = documentCollection(data.kind); const previewFile = data.kind === "floorplan" ? data.preview : null; const collection = await ensureCollection(db, projectId, collectionKind);
  if (!collection) return c.json({ error: "Project not found" }, 404);
  // Request-driven reaper: every new reservation gives stale completing/aborting work a
  // bounded cleanup attempt, even if its caller supplied an invalid/old version group.
  await expirePendingUploads(c, db, projectId);
  const groupId = data.versionGroupId ?? newId();
  if (data.versionGroupId) {
    const existing = await db.select({ id: schema.assets.id }).from(schema.assets).where(and(eq(schema.assets.collectionId, collection.id), eq(schema.assets.versionGroupId, groupId), eq(schema.assets.kind, expectedPdfKind(data.kind)))).get();
    if (!existing) return c.json({ error: "Document version group not found in this project" }, 404);
  }
  const now = new Date();
  const previousPdf = await db.select({ id: schema.assets.id, version: schema.assets.version }).from(schema.assets).where(and(eq(schema.assets.collectionId, collection.id), eq(schema.assets.versionGroupId, groupId), eq(schema.assets.kind, expectedPdfKind(data.kind)))).orderBy(desc(schema.assets.version)).get();
  const previousPreview = data.kind === "floorplan" ? await db.select({ id: schema.assets.id }).from(schema.assets).where(and(eq(schema.assets.collectionId, collection.id), eq(schema.assets.versionGroupId, groupId), eq(schema.assets.kind, "floorplan_preview"))).orderBy(desc(schema.assets.version)).get() : null;
  const pdfAssetId = newId(); const previewAssetId = data.kind === "floorplan" ? newId() : null;
  const values = { id: newId(), projectId, collectionId: collection.id, createdBy: c.get("user").id, kind: data.kind, versionGroupId: groupId, version: (previousPdf?.version ?? 0) + 1, pdfAssetId, pdfKey: documentKey(projectId, collectionKind, pdfAssetId, data.pdf.filename), pdfFilename: data.pdf.filename, pdfBytes: data.pdf.bytes, pdfContentType: data.pdf.contentType, pdfSupersedesAssetId: previousPdf?.id ?? null, previewAssetId, previewKey: previewAssetId && previewFile ? documentKey(projectId, collectionKind, previewAssetId, previewFile.filename) : null, previewFilename: previewFile?.filename ?? null, previewBytes: previewFile?.bytes ?? null, previewContentType: previewFile?.contentType ?? null, previewSupersedesAssetId: previousPreview?.id ?? null, completionAuditId: newId(), status: "pending" as const, expiresAt: new Date(now.getTime() + DOCUMENT_UPLOAD_TTL_MS), createdAt: now, updatedAt: now };
  let upload: DocumentUpload | undefined;
  try { await db.insert(schema.documentUploads).values(values); upload = await db.select().from(schema.documentUploads).where(eq(schema.documentUploads.id, values.id)).get(); }
  catch (error) { if (uniqueVersionError(error)) return c.json({ error: "A document upload is already active for this version group" }, 409); throw error; }
  if (!upload) return c.json({ error: "Could not reserve a document version" }, 409);
  let pdfMultipart: Awaited<ReturnType<typeof createMultipartPresign>> | null = null;
  let previewMultipart: Awaited<ReturnType<typeof createMultipartPresign>> | null = null;
  try {
    pdfMultipart = await createMultipartPresign(c.env, upload.pdfKey, upload.pdfBytes, upload.pdfContentType);
    try { previewMultipart = upload.previewKey ? await createMultipartPresign(c.env, upload.previewKey, upload.previewBytes!, upload.previewContentType!) : null; }
    catch (error) { if (pdfMultipart?.uploadId) await abortMultipart(c.env, upload.pdfKey, pdfMultipart.uploadId).catch(() => undefined); throw error; }
    if ((!pdfMultipart || (upload.previewKey && !previewMultipart)) && c.env.APP_ENV !== "dev") {
      const aborted = await abortReservation(c, { ...upload, pdfUploadId: pdfMultipart?.uploadId ?? null, previewUploadId: previewMultipart?.uploadId ?? null });
      await db.update(schema.documentUploads).set({ status: aborted ? "failed" : "aborting", updatedAt: new Date() }).where(and(eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "pending")));
      return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
    }
    await db.update(schema.documentUploads).set({ pdfUploadId: pdfMultipart?.uploadId ?? null, previewUploadId: previewMultipart?.uploadId ?? null, updatedAt: new Date() }).where(eq(schema.documentUploads.id, upload.id));
    const file = (assetId: string, key: string, multipart: Awaited<ReturnType<typeof createMultipartPresign>> | null) => ({ assetId, key, ...(multipart ?? { devDirect: true }) });
    await audit(c.env, c.get("user"), "document.presign", "document_upload", upload.id, { projectId, kind: upload.kind, versionGroupId: upload.versionGroupId, version: upload.version });
    return c.json({ sessionId: upload.id, kind: upload.kind, versionGroupId: upload.versionGroupId, version: upload.version, files: { pdf: file(upload.pdfAssetId, upload.pdfKey, pdfMultipart), ...(upload.previewKey ? { preview: file(upload.previewAssetId!, upload.previewKey, previewMultipart) } : {}) } }, 201);
  } catch (error) {
    const aborted = await abortReservation(c, { ...upload, pdfUploadId: pdfMultipart?.uploadId ?? null, previewUploadId: previewMultipart?.uploadId ?? null });
    await db.update(schema.documentUploads).set({ status: aborted ? "failed" : "aborting", updatedAt: new Date() }).where(and(eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "pending")));
    throw error;
  }
}));

collectionsRoutes.put("/projects/:id/documents/direct/:sessionId/:slot", terminalRoute("/projects/:id/documents/direct/:sessionId/:slot", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const projectId = c.req.param("id"), sessionId = c.req.param("sessionId"), slot = c.req.param("slot");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(sessionId).success || (slot !== "pdf" && slot !== "preview")) return c.json({ error: "Invalid document upload session" }, 400);
  if (!await hasProjectAccess(c, projectId) || !canManageDocuments(c)) return forbidden(c);
  const upload = await ownedUpload(c, projectId, sessionId);
  if (!upload || upload.status !== "pending" || upload.expiresAt <= new Date()) return c.json({ error: "Document upload session is unavailable" }, 404);
  if (slot === "preview" && !upload.previewKey) return c.json({ error: "This upload has no preview file" }, 400);
  await c.env.MEDIA.put(slot === "pdf" ? upload.pdfKey : upload.previewKey!, c.req.raw.body, { httpMetadata: { contentType: slot === "pdf" ? upload.pdfContentType : upload.previewContentType! } });
  return c.body(null, 204);
}));

collectionsRoutes.post("/projects/:id/documents/complete", terminalRoute("/projects/:id/documents/complete", async (c) => {
  const projectId = c.req.param("id"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (!canManageDocuments(c)) return forbidden(c);
  const data = await jsonInput(c, documentCompleteInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const project = await activeProject(db, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt) return c.json({ error: "Archived projects cannot complete document uploads" }, 409);
  let upload = await ownedUpload(c, projectId, data.sessionId);
  if (!upload) return c.json({ error: "Document upload session not found" }, 404);
  if (upload.status === "completed") return c.json(responseFor(upload));
  let claimedHere = false;
  if (upload.status === "pending") {
    const now = new Date();
    const claimed = await c.env.DB.prepare("UPDATE document_uploads SET status = 'completing', completing_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND created_by = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)")
      .bind(now.getTime(), now.getTime(), upload.id, projectId, c.get("user").id, now.getTime(), projectId).run();
    if ((claimed.meta.changes ?? 0) === 0) {
      const current = await ownedUpload(c, projectId, data.sessionId);
      if (current?.status === "completed") return c.json(responseFor(current));
      if (current?.status !== "completing") return c.json({ error: "Document upload session has expired or was aborted" }, 409);
      upload = current;
    } else {
      upload = { ...upload, status: "completing", completingAt: now, updatedAt: now };
      claimedHere = true;
    }
  } else if (upload.status !== "completing") return c.json({ error: "Document upload session has expired or was aborted" }, 409);
  // The claim is a lease for a worker that stalls mid-batch, not a hold on every way a request
  // can be refused. Answering a request *and* keeping its claim left the row `completing` for the
  // full 15 minutes, and archive treats that as an active upload — so an admin told "that upload
  // failed" could not archive the project and nothing explained why (#174). Release on the paths
  // this request has already decided, and only when this request is the one that took the claim;
  // a claim held by another in-flight completion is not ours to drop. The batch-abort path below
  // deliberately keeps its claim: that one really is a completion left in an unknown state, which
  // is what the lease and the presign reaper are for.
  const releaseClaim = async (status: "pending" | "failed") => {
    if (!claimedHere) return;
    await c.env.DB.prepare("UPDATE document_uploads SET status = ?, completing_at = NULL, updated_at = ? WHERE id = ? AND status = 'completing'")
      .bind(status, Date.now(), upload.id).run();
  };
  // Retryable: the session and its presigned objects are still good, the request body was not.
  if ((upload.kind === "floorplan") !== Boolean(data.preview)) { await releaseClaim("pending"); return c.json({ error: upload.kind === "floorplan" ? "Floorplan completion requires both PDF and JPEG preview" : "Copy uploads do not accept a preview" }, 400); }
  try {
    await finishObject(c, upload, "pdf", data.pdf);
    if (upload.kind === "floorplan") await finishObject(c, upload, "preview", data.preview!);
  } catch (error) {
    // Terminal: bytes and content type are verified against what the presign declared, so no
    // retry on this session can pass. A new presign is the only way forward.
    await releaseClaim("failed");
    return c.json({ error: error instanceof Error ? error.message : "Document object verification failed" }, 409);
  }
  const now = new Date(); const statements: D1PreparedStatement[] = [
    // This is the batch guard. A stale completion claim tries to insert a NULL NOT NULL
    // asset id and aborts the entire D1 batch before any document asset can commit.
    c.env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, supersedes_asset_id, version_group_id, created_at, updated_at) SELECT CASE WHEN EXISTS (SELECT 1 FROM document_uploads WHERE id = ? AND status = 'completing') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) THEN ? ELSE NULL END, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?").bind(upload.id, projectId, upload.pdfAssetId, upload.collectionId, expectedPdfKind(upload.kind), upload.pdfKey, upload.pdfFilename, upload.pdfBytes, upload.version, upload.pdfSupersedesAssetId, upload.versionGroupId, now.getTime(), now.getTime()),
  ];
  if (upload.kind === "floorplan") statements.push(c.env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, supersedes_asset_id, version_group_id, created_at, updated_at) SELECT CASE WHEN EXISTS (SELECT 1 FROM document_uploads WHERE id = ? AND status = 'completing') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) THEN ? ELSE NULL END, ?, 'floorplan_preview', ?, ?, ?, 'upload', ?, ?, ?, ?, ?").bind(upload.id, projectId, upload.previewAssetId, upload.collectionId, upload.previewKey, upload.previewFilename, upload.previewBytes, upload.version, upload.previewSupersedesAssetId, upload.versionGroupId, now.getTime(), now.getTime()));
  // The version chain was only ever written forward: the new asset records what it supersedes,
  // but the predecessor was never marked, so it stayed "current" for ever. `received_count`
  // counts `superseded_at IS NULL`, so a corrected floorplan and the thing it corrected were
  // both counted as delivered and the client's number grew on every re-upload (#176). Retiring
  // the predecessor here keeps the count derived state inside the one batch that produces it,
  // so a rollback cannot leave a version retired by a completion that never committed. This
  // must stay ahead of COLLECTION_RECEIVED_COUNT_SQL below, which reads what these write.
  for (const supersededId of [upload.pdfSupersedesAssetId, ...(upload.kind === "floorplan" ? [upload.previewSupersedesAssetId] : [])]) {
    if (!supersededId) continue;
    statements.push(c.env.DB.prepare("UPDATE assets SET superseded_at = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL").bind(now.getTime(), now.getTime(), supersededId));
  }
  statements.push(
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'document.complete', 'document_upload', ?, ?, ?)").bind(upload.completionAuditId, c.get("user").id, upload.id, auditMeta(c.get("user"), { projectId, kind: upload.kind, versionGroupId: upload.versionGroupId, version: upload.version, assetIds: responseFor(upload).assets.map((asset) => asset.id) }), now.getTime()),
    c.env.DB.prepare("UPDATE document_uploads SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'completing' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)").bind(now.getTime(), now.getTime(), upload.id, projectId),
    c.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(upload.collectionId, now.getTime())),
  );
  const activityId = newId();
  const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.collection.document_completed", projectId, actorId: c.get("user").id, occurredAt: now.getTime(), source: { kind: "project_document", id: upload.id, key: `project-document:${upload.id}:completed` }, safePayload: { collectionKind: upload.kind === "floorplan" ? "floorplan" : "copy", version: upload.version, assetCount: responseFor(upload).assets.length }, deepLink: projectActivityDeepLink("project.collection.document_completed", projectId) }, broadDelivery: { registryKey: "project.collection.document_completed", sourceActivityId: activityId, coalesce: null } };
  const activityBundle = buildProjectActivityStatements({ db: c.env.DB, intent: activity, winnerAuditId: upload.completionAuditId, createdAt: now.getTime() });
  statements.push(...activityBundle.statements);
  let completionResults: D1Result[];
  try { completionResults = await c.env.DB.batch(statements); }
  catch (error) {
    const completed = await ownedUpload(c, projectId, upload.id);
    if (completed?.status === "completed") return c.json(responseFor(completed));
    return c.json({ error: uniqueVersionError(error) ? "Document version was reserved concurrently; request a new upload" : "Could not finalize document metadata" }, 409);
  }
  const completed: DocumentUpload = { ...upload, status: "completed", completedAt: now, updatedAt: now };
  // The completion batch has already committed the authoritative audit and assets. Queue only
  // broad IDs returned by the same batch; no per-PDF/preview event is emitted.
  const activityStart = statements.length - activityBundle.statements.length;
  const publicationIds = ((completionResults![activityStart + activityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
  if (publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, publicationIds));
  return c.json(responseFor(completed), 201);
}));

collectionsRoutes.post("/projects/:id/documents/:sessionId/abort", terminalRoute("/projects/:id/documents/:sessionId/abort", async (c) => {
  const projectId = c.req.param("id"), sessionId = c.req.param("sessionId");
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(sessionId).success) return c.json({ error: "Invalid document upload session" }, 400);
  if (!await hasProjectAccess(c, projectId) || !canManageDocuments(c)) return forbidden(c);
  const upload = await ownedUpload(c, projectId, sessionId);
  if (!upload) return c.json({ error: "Document upload session not found" }, 404);
  if (upload.status === "completed") return c.json({ error: "Completed document uploads cannot be aborted" }, 409);
  await createDb(c.env.DB).update(schema.documentUploads).set({ status: "aborting", updatedAt: new Date() }).where(and(eq(schema.documentUploads.id, upload.id), sql`${schema.documentUploads.status} in ('pending', 'completing', 'aborting')`));
  if (!await abortReservation(c, upload)) return c.json({ error: "Multipart abort is pending; retry this request" }, 503);
  await createDb(c.env.DB).update(schema.documentUploads).set({ status: "failed", updatedAt: new Date() }).where(and(eq(schema.documentUploads.id, upload.id), eq(schema.documentUploads.status, "aborting")));
  return c.body(null, 204);
}));
