import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { and, eq, isNull } from "drizzle-orm";
import { isEmbeddedHeicContentType, isEmbeddedMediaContentType, ifRangeAllows, parseByteRange, DNG_CONTENT_TYPE, RENDITION_SPECS, RENDITION_SPEC_VERSION, TRANSFORM_CACHE_VERSION, dngPreviewKey, rawMediaContentType } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, hasProjectCollaborationAccess } from "../middleware/capability";
import { roleHasCapability } from "@quincy/shared";
import { issueTransformSource } from "../lib/transform-source";
import { isUserVisibleAsset, unpublishedAssetResponse } from "../lib/asset-visibility";
import { visibleProjectWhere } from "../lib/visible-project-scope";
import { getEmbeddedMedia } from "../lib/embedded-media";

export const mediaRoutes = new Hono<AppEnv>();

function sourceContentType(kind: string, filename: string): string {
  if (kind === "floorplan_pdf" || kind === "copy_pdf") return "application/pdf";
  return rawMediaContentType(filename) ?? "image/jpeg";
}

function dngSourceKey(key: string, filename: string): string {
  return rawMediaContentType(filename) === DNG_CONTENT_TYPE ? dngPreviewKey(key) : key;
}

function dngPreviewUnavailable(c: Context<AppEnv>): Response {
  return c.json({ error: "DNG preview is still processing", code: "dng_preview_unavailable", renditionStatus: "processing" }, 409);
}

async function externalAsset(c: Context<AppEnv>, assetId: string) {
  const user = c.get("user");
  return createDb(c.env.DB).select({
    id: schema.assets.id, kind: schema.assets.kind, originalFilename: schema.assets.originalFilename,
    r2Key: schema.assets.r2Key, publishStatus: schema.assets.publishStatus, projectId: schema.collections.projectId,
    collectionKind: schema.collections.kind,
  }).from(schema.assets)
    .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .innerJoin(schema.projects, eq(schema.collections.projectId, schema.projects.id))
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))
    .where(and(eq(schema.assets.id, assetId), isNull(schema.assets.supersededAt), visibleProjectWhere(user)))
    .get();
}

async function externalAnnotation(c: Context<AppEnv>, annotationId: string) {
  const user = c.get("user");
  return createDb(c.env.DB).select({
    strokeR2Key: schema.annotations.strokeR2Key, publishStatus: schema.assets.publishStatus,
    projectId: schema.collections.projectId, collectionKind: schema.collections.kind,
  }).from(schema.annotations)
    .innerJoin(schema.assets, and(eq(schema.annotations.assetId, schema.assets.id), isNull(schema.assets.supersededAt)))
    .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .innerJoin(schema.projects, eq(schema.collections.projectId, schema.projects.id))
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))
    .where(and(eq(schema.annotations.id, annotationId), visibleProjectWhere(user)))
    .get();
}

/** The production-only fallback URL; exported to pin its encoding/cache-buster contract. */
export function liveTransformLocation(baseUrl: string, key: string, variant: "web" | "thumb", issued: { expiresAt: number; signature: string; principalId: string; authorizationEpoch: number }): string {
  const spec = RENDITION_SPECS[variant];
  const sourcePath = "/__transform-source/" + key.split("/").map(encodeURIComponent).join("/");
  const sourceUrl = new URL(sourcePath, baseUrl);
  sourceUrl.searchParams.set("v", TRANSFORM_CACHE_VERSION);
  sourceUrl.searchParams.set("exp", String(issued.expiresAt));
  sourceUrl.searchParams.set("p", issued.principalId);
  sourceUrl.searchParams.set("ae", String(issued.authorizationEpoch));
  sourceUrl.searchParams.set("sig", issued.signature);
  return new URL(`/cdn-cgi/image/width=${spec.maxEdge},height=${spec.maxEdge},fit=scale-down,quality=${spec.quality},format=auto/${sourceUrl.href}`, baseUrl).href;
}

const RENDITION_CACHE_HEADERS = { "cache-control": "private, max-age=300", vary: "Cookie" } as const;

mediaRoutes.get("/asset/:assetId/:variant", terminalRoute("/asset/:assetId/:variant", async (c) => {
  const assetId = c.req.param("assetId"), variant = c.req.param("variant"); if (!z.string().uuid().safeParse(assetId).success || !["web", "thumb", "original"].includes(variant)) return c.json({ error: "Invalid media request" }, 400);
  if (c.get("user").role === "external_editor") {
    const row = await externalAsset(c, assetId);
    if (!row || !isUserVisibleAsset(row.collectionKind, row.publishStatus)) return c.json({ error: "Media access denied" }, 403);
    if (!roleHasCapability(c.get("user").role, row.collectionKind === "raw" ? "viewRaw" : "viewEdited")) return c.json({ error: "Media access denied" }, 403);
    if (variant === "original") {
      const object = await c.env.MEDIA.get(row.r2Key);
      if (!object) return c.json({ error: "Media object not found" }, 404);
      const contentType = sourceContentType(row.kind, row.originalFilename);
      const headers: Record<string, string> = { "content-type": contentType, "cache-control": "private, no-store", "content-length": String(object.size), "x-content-type-options": "nosniff" };
      if (contentType === "application/pdf") {
        const safeName = row.originalFilename.replace(/[\x00-\x1f"\\]/g, "");
        headers["content-disposition"] = `inline; filename="${safeName}"`;
      }
      return new Response(object.body, { headers });
    }
    const cached = await createDb(c.env.DB).select({ r2Key: schema.assetRenditions.r2Key, contentType: schema.assetRenditions.contentType })
      .from(schema.assetRenditions).where(and(eq(schema.assetRenditions.assetId, row.id), eq(schema.assetRenditions.variant, variant as "web" | "thumb"), eq(schema.assetRenditions.specVersion, RENDITION_SPEC_VERSION))).get();
    if (!cached || (cached.contentType !== "image/webp" && cached.contentType !== "image/jpeg")) return c.json({ error: "Rendition is still processing", code: "rendition_processing", renditionStatus: "processing" }, 409);
    const object = await c.env.MEDIA.get(cached.r2Key);
    if (!object || object.httpMetadata?.contentType !== cached.contentType) return c.json({ error: "Rendition is still processing", code: "rendition_processing", renditionStatus: "processing" }, 409);
    const headers: Record<string, string> = { "content-type": cached.contentType, ...RENDITION_CACHE_HEADERS, "content-length": String(object.size), "x-content-type-options": "nosniff" };
    if (object.httpEtag) headers.etag = object.httpEtag;
    return new Response(object.body, { headers });
  }
  const db = createDb(c.env.DB); const row = await db.select({ asset: schema.assets, projectId: schema.collections.projectId, collectionKind: schema.collections.kind }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(and(eq(schema.assets.id, assetId), isNull(schema.assets.supersededAt))).get(); if (!row) return c.json({ error: "Asset not found" }, 404);
  if (!isUserVisibleAsset(row.collectionKind, row.asset.publishStatus)) return unpublishedAssetResponse(c);
  if (!await hasProjectAccess(c, row.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    const user = c.get("user"); if (row.collectionKind !== "raw" && user.role === "photographer") return c.json({ error: "Photographers may only view RAW assets" }, 403); if (row.collectionKind !== "raw" && !roleHasCapability(user.role, "viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
    if (variant === "original") {
      const object = await c.env.MEDIA.get(row.asset.r2Key); if (!object) return c.json({ error: "Media object not found" }, 404);
      const contentType = sourceContentType(row.asset.kind, row.asset.originalFilename);
      const headers: Record<string, string> = { "content-type": contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
      if (contentType === "application/pdf") {
        const safeName = row.asset.originalFilename.replace(/[\x00-\x1f"\\]/g, "");
        headers["content-disposition"] = `inline; filename="${safeName}"`;
      }
      return new Response(object.body, { headers });
    }
    // Authorization above applies equally to the durable cache. Never resolve its R2 key
    // before project/role checks, even though the bytes are immutable.
    const cached = await db.select().from(schema.assetRenditions).where(and(
      eq(schema.assetRenditions.assetId, row.asset.id),
      eq(schema.assetRenditions.variant, variant as "web" | "thumb"),
      eq(schema.assetRenditions.specVersion, RENDITION_SPEC_VERSION),
    )).get();
    if (cached && (cached.contentType === "image/webp" || cached.contentType === "image/jpeg")) {
      const object = await c.env.MEDIA.get(cached.r2Key);
      if (object?.httpMetadata?.contentType === cached.contentType) {
        const headers: Record<string, string> = {
          "content-type": cached.contentType,
          // #362: the viewer's own browser may reuse an authorised rendition for 5 minutes;
          // `private` keeps every shared cache out and Vary: Cookie separates principals. After
          // expiry the Worker re-runs session and project-access checks (docs/lessons.md).
          ...RENDITION_CACHE_HEADERS,
          "content-length": String(object.size),
          "x-content-type-options": "nosniff",
        };
        if (object.httpEtag) headers.etag = object.httpEtag;
        return new Response(object.body, { headers });
      }
    }
    // Avoid turning a missing original into an opaque Images error. Both direct-dev and live
    // transform fallbacks use the same source object after this check.
    const original = await c.env.MEDIA.head(row.asset.r2Key);
    if (!original) return c.json({ error: "Media object not found" }, 404);
    const transformKey = dngSourceKey(row.asset.r2Key, row.asset.originalFilename);
    if (transformKey !== row.asset.r2Key && !await c.env.MEDIA.head(transformKey)) return dngPreviewUnavailable(c);
    // Dev retains a practical direct-original fallback when a cache has not been generated.
    if (c.env.APP_ENV === "dev") {
      const object = await c.env.MEDIA.get(transformKey); if (!object) return c.json({ error: "Media object not found" }, 404);
      return new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    const issued = await issueTransformSource(c.env, transformKey, user.id, user.authorizationEpoch);
    if (!issued) return c.json({ error: "Image transformations are not configured" }, 503);
    // Redirect the authenticated client to the /cdn-cgi/image/ URL instead of proxying:
    // a Worker's same-zone subrequest skips the entire Cloudflare pipeline (loop
    // prevention) — both fetch(cf.image) and an in-Worker /cdn-cgi/image/ fetch dead-end
    // at the assets layer with 404. As an eyeball request, /cdn-cgi/image/ runs the Images
    // engine at the edge, whose source fetch re-enters this Worker's signed
    // /__transform-source route. Both legs verified live 2026-07-19.
    // Session auth gates this redirect; its versioned HMAC binds the exact key and a short
    // expiry. The cache version makes prior cached 9401 failures a different URL after repair.
    // width+height+fit=scale-down is a bounding box that preserves aspect ratio without
    // upscaling — width alone lets a portrait exceed maxEdge on its long side.
    const response = c.redirect(liveTransformLocation(c.req.url, transformKey, variant as "web" | "thumb", { ...issued, principalId: user.id, authorizationEpoch: user.authorizationEpoch }), 302);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}));

mediaRoutes.get("/annotation/:annotationId", terminalRoute("/annotation/:annotationId", async (c) => {
  const annotationId = c.req.param("annotationId");
  if (!z.string().uuid().safeParse(annotationId).success) return c.json({ error: "Invalid annotation id" }, 400);
  if (c.get("user").role === "external_editor") {
    const row = await externalAnnotation(c, annotationId);
    if (!row || !isUserVisibleAsset(row.collectionKind, row.publishStatus) || !["raw", "edited"].includes(row.collectionKind)) return c.json({ error: "Media access denied" }, 403);
    if (!roleHasCapability(c.get("user").role, row.collectionKind === "raw" ? "annotateRaw" : "annotateEdited")) return c.json({ error: "Media access denied" }, 403);
    if (!row.strokeR2Key) return c.json({ error: "This annotation has no markup" }, 404);
    const object = await c.env.MEDIA.get(row.strokeR2Key);
    if (!object) return c.json({ error: "Annotation markup was not found" }, 404);
    return new Response(object.body, { headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  const row = await createDb(c.env.DB).select({
    strokeR2Key: schema.annotations.strokeR2Key, projectId: schema.collections.projectId, collectionKind: schema.collections.kind,
    publishStatus: schema.assets.publishStatus,
  }).from(schema.annotations)
    .innerJoin(schema.assets, eq(schema.annotations.assetId, schema.assets.id))
    .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .where(and(eq(schema.annotations.id, annotationId), isNull(schema.assets.supersededAt))).get();
  if (!row) return c.json({ error: "Annotation not found" }, 404);
  if (!isUserVisibleAsset(row.collectionKind, row.publishStatus)) return c.json({ error: "Annotation not found" }, 404);
  if (!await hasProjectAccess(c, row.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (row.collectionKind === "edited" && !roleHasCapability(c.get("user").role, "viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
  if (row.collectionKind !== "raw" && row.collectionKind !== "edited") return c.json({ error: "Annotation is not attached to a photo collection" }, 400);
  if (!row.strokeR2Key) return c.json({ error: "This annotation has no markup" }, 404);
  const object = await c.env.MEDIA.get(row.strokeR2Key);
  if (!object) return c.json({ error: "Annotation markup was not found" }, 404);
  return new Response(object.body, { headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}));

/**
 * Embedded media (#493). An attached image follows its post: anyone who can collaborate on the Project
 * may read it, an assigned External editor included. A Notice board image (#496) needs the Notice board capability. Until it is attached (and after it is edited out)
 * only the person who uploaded it can see it. Every refusal is `no-store` through the /media default. A video (#494) follows exactly the same rules.
 * A Project whiteboard's media (#501) is the exception: any state but `uploading` is readable by anyone who can collaborate on the ROW's Project
 * (an assigned External editor included), because the board attaches on snapshot, 30 s after a peer placed it, and an undone image is detached
 * while it can still come back. Access follows the row's Project, never the board that references it, so an id placed on another Project's board
 * shows only to people who already see its own Project.
 * Returns the row when the caller may read it, or the refusal.
 */
async function readableEmbeddedMedia(c: Context<AppEnv>, mediaId: string): Promise<NonNullable<Awaited<ReturnType<typeof getEmbeddedMedia>>> | Response> {
  const row = await getEmbeddedMedia(c.env.DB, mediaId);
  if (!row || row.state === "uploading") return c.json({ error: "Media not found" }, 404);
  const user = c.get("user");
  if (row.ownerKind === "notice_post") {
    // Notice board media (#496) needs the Notice board capability in every state, the uploader included (a demoted uploader, or an
    // Admin impersonating one, is told nothing exists). Then an attached image follows its post; pending and detached ones are the uploader's.
    if (!roleHasCapability(user.role, "viewNoticeBoard")) return c.json({ error: "Media not found" }, 404);
    if (row.state !== "attached" && row.uploaderId !== user.id) return c.json({ error: "Media not found" }, 404);
  } else if (row.ownerKind === "whiteboard") {
    if (!row.projectId) return c.json({ error: "Media not found" }, 404);
    if (!await hasProjectCollaborationAccess(c, row.projectId)) return user.role === "external_editor" ? c.json({ error: "Media not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  } else if (row.state === "attached") {
    if (!row.projectId) return c.json({ error: "Media not found" }, 404);
    if (!await hasProjectCollaborationAccess(c, row.projectId)) return user.role === "external_editor" ? c.json({ error: "Media not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  } else if (row.uploaderId !== user.id) return c.json({ error: "Media not found" }, 404);
  return row;
}

const EMBEDDED_RESPONSE_HEADERS = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", ...RENDITION_CACHE_HEADERS } as const;

mediaRoutes.get("/embedded/:mediaId", terminalRoute("/embedded/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  if (!z.string().uuid().safeParse(mediaId).success) return c.json({ error: "Invalid media id" }, 400);
  const row = await readableEmbeddedMedia(c, mediaId); if (row instanceof Response) return row;
  // A HEIC image (#495) is served as its JPEG display copy and never as the original: pending is 409 (the whiteboard resolver retries it), failed is a final 404.
  let objectKey = row.originalKey; let storedType = row.contentType;
  // Defence in depth: a HEIC row that somehow says `not_required` would otherwise stream the original.
  if (row.kind === "image" && row.renditionStatus === "not_required" && isEmbeddedHeicContentType(row.contentType)) return c.json({ error: "Media not found" }, 404);
  if (row.kind === "image" && row.renditionStatus !== "not_required") {
    if (row.renditionStatus === "pending") return c.json({ error: "This image is still being prepared", code: "rendition_pending" }, 409, { "retry-after": "5" });
    if (row.renditionStatus === "failed" || !row.displayKey || !row.displayContentType) return c.json({ error: "This image could not be prepared", code: "rendition_failed" }, 404);
    objectKey = row.displayKey; storedType = row.displayContentType;
  }
  // A single byte range is served (#494): a browser plays a video by asking for pieces of it, and cannot seek without. `head` gives
  // the size and ETag, then the parser decides; the body is a second, ranged read, so no behaviour depends on how R2 treats a range it cannot satisfy.
  let object: R2ObjectBody | null; let status = 200; let contentRange: string | undefined; let length: number | undefined;
  const rangeHeader = c.req.header("range");
  if (rangeHeader) {
    const meta = await c.env.MEDIA.head(objectKey);
    if (!meta) return c.json({ error: "Media object not found" }, 404);
    const parsed = parseByteRange(rangeHeader, meta.size);
    // If-Range comes first (RFC 9110 §13.1.5): a validator that does not match means the range is ignored, so the whole body is sent, even when the range could not have been satisfied.
    const rangeApplies = ifRangeAllows(c.req.header("if-range"), meta.httpEtag);
    if (parsed.kind === "unsatisfiable" && rangeApplies) return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
    if (parsed.kind === "partial" && rangeApplies) {
      object = await c.env.MEDIA.get(objectKey, { range: { offset: parsed.offset, length: parsed.length } });
      status = 206; length = parsed.length; contentRange = `bytes ${parsed.offset}-${parsed.offset + parsed.length - 1}/${meta.size}`;
    } else object = await c.env.MEDIA.get(objectKey);
  } else object = await c.env.MEDIA.get(objectKey);
  if (!object) return c.json({ error: "Media object not found" }, 404);
  const headers: Record<string, string> = {
    "content-type": isEmbeddedMediaContentType(storedType) ? storedType : "application/octet-stream",
    "content-length": String(length ?? object.size),
    "accept-ranges": "bytes",
    ...EMBEDDED_RESPONSE_HEADERS,
  };
  if (contentRange) headers["content-range"] = contentRange;
  if (object.httpEtag) headers.etag = object.httpEtag;
  // The viewer's fallback when a video cannot play in its browser (#494): the file itself, named by its type.
  if (c.req.query("download") === "1" && row.kind === "video") headers["content-disposition"] = `attachment; filename="video.${row.contentType === "video/quicktime" ? "mov" : "mp4"}"`;
  return new Response(object.body, { status, headers });
}));

/** A video's poster frame (#494), under the video's own access rules. */
mediaRoutes.get("/embedded/:mediaId/poster", terminalRoute("/embedded/:mediaId/poster", async (c) => {
  const mediaId = c.req.param("mediaId");
  if (!z.string().uuid().safeParse(mediaId).success) return c.json({ error: "Invalid media id" }, 400);
  const row = await readableEmbeddedMedia(c, mediaId); if (row instanceof Response) return row;
  if (row.kind !== "video" || !row.posterKey) return c.json({ error: "Poster not found" }, 404);
  const object = await c.env.MEDIA.get(row.posterKey);
  if (!object) return c.json({ error: "Poster not found" }, 404);
  const headers: Record<string, string> = { "content-type": "image/jpeg", "content-length": String(object.size), ...EMBEDDED_RESPONSE_HEADERS };
  if (object.httpEtag) headers.etag = object.httpEtag;
  return new Response(object.body, { headers });
}));
