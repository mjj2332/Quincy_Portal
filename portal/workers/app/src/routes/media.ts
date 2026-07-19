import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, eq } from "drizzle-orm";
import { RENDITION_SPECS } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";

export const mediaRoutes = new Hono<AppEnv>();
mediaRoutes.get("/asset/:assetId/:variant", async (c) => {
  const assetId = c.req.param("assetId"), variant = c.req.param("variant"); if (!z.string().uuid().safeParse(assetId).success || !["web", "thumb", "original"].includes(variant)) return c.json({ error: "Invalid media request" }, 400);
  const db = createDb(c.env.DB); const row = await db.select({ asset: schema.assets, projectId: schema.collections.projectId, collectionKind: schema.collections.kind }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.assets.id, assetId)).get(); if (!row) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, row.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  {
    const user = c.get("user"); if (row.collectionKind !== "raw" && user.role === "photographer") return c.json({ error: "Photographers may only view RAW assets" }, 403); if (row.collectionKind !== "raw" && !["admin", "editor"].includes(user.role)) return c.json({ error: "Forbidden" }, 403);
    if (variant === "original" || c.env.APP_ENV === "dev") { const object = await c.env.MEDIA.get(row.asset.r2Key); if (!object) return c.json({ error: "Media object not found" }, 404); return new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } }); }
    const spec = RENDITION_SPECS[variant as "web" | "thumb"];
    try { const response = await fetch(new URL(`/media/asset/${assetId}/original`, c.req.url), { headers: c.req.raw.headers, cf: { image: { width: spec.maxEdge, quality: spec.quality, format: "auto" } } as unknown as RequestInitCfProperties }); if (response.ok) { const headers = new Headers(response.headers); headers.set("cache-control", "private, max-age=3600"); return new Response(response.body, { headers }); } } catch { /* serve original if Image Transformations is unavailable */ }
    const object = await c.env.MEDIA.get(row.asset.r2Key); if (!object) return c.json({ error: "Media object not found" }, 404); return new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
  }
});
