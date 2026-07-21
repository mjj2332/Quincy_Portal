import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { RENDITION_SPECS } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { roleHasCapability } from "@quincy/shared";
import { signTransformSource } from "../lib/transform-source";

export const mediaRoutes = new Hono<AppEnv>();
mediaRoutes.get("/asset/:assetId/:variant", async (c) => {
  const assetId = c.req.param("assetId"), variant = c.req.param("variant"); if (!z.string().uuid().safeParse(assetId).success || !["web", "thumb", "original"].includes(variant)) return c.json({ error: "Invalid media request" }, 400);
  const db = createDb(c.env.DB); const row = await db.select({ asset: schema.assets, projectId: schema.collections.projectId, collectionKind: schema.collections.kind }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.assets.id, assetId)).get(); if (!row) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, row.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    const user = c.get("user"); if (row.collectionKind !== "raw" && user.role === "photographer") return c.json({ error: "Photographers may only view RAW assets" }, 403); if (row.collectionKind !== "raw" && !["admin", "editor"].includes(user.role)) return c.json({ error: "Forbidden" }, 403);
    if (variant === "original" || c.env.APP_ENV === "dev") {
      const object = await c.env.MEDIA.get(row.asset.r2Key); if (!object) return c.json({ error: "Media object not found" }, 404);
      const contentType = row.asset.kind === "floorplan_pdf" || row.asset.kind === "copy_pdf" ? "application/pdf" : "image/jpeg";
      const headers: Record<string, string> = { "content-type": contentType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
      if (contentType === "application/pdf") {
        const safeName = row.asset.originalFilename.replace(/[\x00-\x1f"\\]/g, "");
        headers["content-disposition"] = `inline; filename="${safeName}"`;
      }
      return new Response(object.body, { headers });
    }
    const spec = RENDITION_SPECS[variant as "web" | "thumb"];
    const signature = await signTransformSource(c.env, row.asset.r2Key);
    if (!signature) return c.json({ error: "Image transformations are not configured" }, 503);
    const sourcePath = "/__transform-source/" + row.asset.r2Key.split("/").map(encodeURIComponent).join("/");
    const sourceUrl = new URL(sourcePath, c.req.url);
    sourceUrl.searchParams.set("sig", signature);
    // Redirect the authenticated client to the /cdn-cgi/image/ URL instead of proxying:
    // a Worker's same-zone subrequest skips the entire Cloudflare pipeline (loop
    // prevention) — both fetch(cf.image) and an in-Worker /cdn-cgi/image/ fetch dead-end
    // at the assets layer with 404. As an eyeball request, /cdn-cgi/image/ runs the Images
    // engine at the edge, whose source fetch re-enters this Worker's signed
    // /__transform-source route. Both legs verified live 2026-07-19.
    // Session auth gates this redirect; the source URL is HMAC-bound to the exact R2 key.
    // TODO(hardening): add an expiry to the source signature so redirect URLs age out.
    // width+height+fit=scale-down is a bounding box that preserves aspect ratio without
    // upscaling — width alone lets a portrait exceed maxEdge on its long side.
    const transformUrl = new URL(`/cdn-cgi/image/width=${spec.maxEdge},height=${spec.maxEdge},fit=scale-down,quality=${spec.quality},format=auto/${sourceUrl.href}`, c.req.url);
    const response = c.redirect(transformUrl.href, 302);
    response.headers.set("cache-control", "private, max-age=86400");
    return response;
  }
});

mediaRoutes.get("/annotation/:annotationId", async (c) => {
  const annotationId = c.req.param("annotationId");
  if (!z.string().uuid().safeParse(annotationId).success) return c.json({ error: "Invalid annotation id" }, 400);
  const row = await createDb(c.env.DB).select({
    strokeR2Key: schema.annotations.strokeR2Key, projectId: schema.collections.projectId, collectionKind: schema.collections.kind,
  }).from(schema.annotations)
    .innerJoin(schema.assets, eq(schema.annotations.assetId, schema.assets.id))
    .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .where(eq(schema.annotations.id, annotationId)).get();
  if (!row) return c.json({ error: "Annotation not found" }, 404);
  if (!await hasProjectAccess(c, row.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (row.collectionKind === "edited" && !roleHasCapability(c.get("user").role, "viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
  if (row.collectionKind !== "raw" && row.collectionKind !== "edited") return c.json({ error: "Annotation is not attached to a photo collection" }, 400);
  if (!row.strokeR2Key) return c.json({ error: "This annotation has no markup" }, 404);
  const object = await c.env.MEDIA.get(row.strokeR2Key);
  if (!object) return c.json({ error: "Annotation markup was not found" }, 404);
  return new Response(object.body, { headers: { "content-type": "application/json", "cache-control": "private, max-age=3600" } });
});
