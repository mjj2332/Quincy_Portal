import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { roleHasCapability } from "@quincy/shared";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";
import { isUserVisibleAsset, unpublishedAssetResponse } from "../lib/asset-visibility";
import { notifyProject } from "../lib/notifications";

const strokeInput = z.object({
  points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1).max(2000),
  color: z.string().trim().min(1).max(32),
  width: z.number().positive().max(100),
});
// Creation intentionally uses the same stroke contract as PATCH. A note-only
// annotation remains valid, but an empty/absent markup plus empty note does not.
const annotationInput = z.object({ strokes: z.array(strokeInput).max(200).optional(), noteText: z.string().trim().max(10_000).optional() })
  .refine((value) => (value.strokes?.length ?? 0) > 0 || Boolean(value.noteText), { message: "A markup or note is required" });
const annotationEditInput = z.object({ noteText: z.string().trim().max(10_000).nullable().optional(), strokes: z.array(strokeInput).max(200).optional() })
  .refine((value) => value.noteText !== undefined || value.strokes !== undefined, { message: "A note or markup change is required" });

// .length counts UTF-16 code units, not bytes — a JSON string full of multibyte
// characters (e.g. non-ASCII color names) could pass a .length check while exceeding
// the real 2 MB R2/D1-adjacent budget. Measure actual encoded bytes instead.
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

type AssetContext = { assetId: string; projectId: string; kind: "raw" | "edited" | "video" | "floorplan" | "copy"; publishStatus: "pending" | "ready" | "failed" };

async function assetContext(c: Context<AppEnv>, assetId: string): Promise<AssetContext | undefined> {
  return createDb(c.env.DB).select({ assetId: schema.assets.id, projectId: schema.collections.projectId, kind: schema.collections.kind, publishStatus: schema.assets.publishStatus })
    .from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .where(and(eq(schema.assets.id, assetId), isNull(schema.assets.supersededAt))).get();
}

function scopeForAsset(c: Context<AppEnv>, asset: AssetContext): "raw" | "edited" | Response {
  if (!isUserVisibleAsset(asset.kind, asset.publishStatus)) return unpublishedAssetResponse(c);
  if (asset.kind !== "raw" && asset.kind !== "edited") return c.json({ error: "Annotations are available for RAW and edited photo assets only" }, 400);
  const capability = asset.kind === "raw" ? "annotateRaw" : "annotateEdited";
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  return asset.kind;
}

async function canViewAsset(c: Context<AppEnv>, asset: AssetContext): Promise<Response | null> {
  if (!isUserVisibleAsset(asset.kind, asset.publishStatus)) return unpublishedAssetResponse(c);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (asset.kind === "edited" && !roleHasCapability(c.get("user").role, "viewEdited")) return c.json({ error: "Forbidden", capability: "viewEdited" }, 403);
  if (asset.kind !== "raw" && asset.kind !== "edited") return c.json({ error: "Annotations are available for RAW and edited photo assets only" }, 400);
  return null;
}

export const annotationsRoutes = new Hono<AppEnv>();

annotationsRoutes.get("/assets/:id/annotations", async (c) => {
  const assetId = c.req.param("id");
  if (!z.string().uuid().safeParse(assetId).success) return c.json({ error: "Invalid asset id" }, 400);
  const asset = await assetContext(c, assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  const denied = await canViewAsset(c, asset); if (denied) return denied;
  const db = createDb(c.env.DB);
  const annotationRows = await db.select({ annotation: schema.annotations, author: schema.user }).from(schema.annotations)
    .innerJoin(schema.user, eq(schema.annotations.authorId, schema.user.id))
    .where(eq(schema.annotations.assetId, assetId)).orderBy(asc(schema.annotations.createdAt)).all();
  return c.json({
    annotations: annotationRows.map(({ annotation, author }) => ({
      id: annotation.id, authorId: annotation.authorId, author: { id: author.id, name: author.name, role: annotation.authorRole }, scope: annotation.scope,
      strokeR2Key: annotation.strokeR2Key, noteText: annotation.noteText, createdAt: annotation.createdAt, editedAt: annotation.editedAt,
    })),
  });
});

annotationsRoutes.post("/assets/:id/annotations", async (c) => {
  const assetId = c.req.param("id");
  if (!z.string().uuid().safeParse(assetId).success) return c.json({ error: "Invalid asset id" }, 400);
  const asset = await assetContext(c, assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const scope = scopeForAsset(c, asset); if (scope instanceof Response) return scope;
  const data = await jsonInput(c, annotationInput); if (data instanceof Response) return data;
  let strokeJson: string | undefined;
  if (data.strokes !== undefined) {
    try { strokeJson = JSON.stringify(data.strokes); } catch { return c.json({ error: "Markup must be JSON-serializable" }, 400); }
    if (strokeJson === undefined || byteLength(strokeJson) > 2_000_000) return c.json({ error: "Markup is too large" }, 400);
  }
  const id = newId();
  const strokeR2Key = strokeJson ? `projects/${asset.projectId}/${scope}/${assetId}/annotations/${id}.json` : null;
  if (strokeR2Key && strokeJson) await c.env.MEDIA.put(strokeR2Key, strokeJson, { httpMetadata: { contentType: "application/json" } });
  const createdAt = new Date();
  await createDb(c.env.DB).insert(schema.annotations).values({
    id, assetId, authorId: c.get("user").id, authorRole: c.get("user").role, scope,
    strokeR2Key, noteText: data.noteText || null, createdAt,
  });
  await audit(c.env, c.get("user"), "asset.annotate", "asset", assetId, { annotationId: id, scope, hasStrokes: Boolean(strokeR2Key) });
  await notifyProject(c.env, asset.projectId, "comment_added", { editorOnly: true, excludeUserId: c.get("user").id });
  const user = c.get("user");
  return c.json({ id, authorId: user.id, author: { id: user.id, name: user.name, role: user.role }, scope, strokeR2Key, noteText: data.noteText || null, createdAt: createdAt.toISOString(), editedAt: null }, 201);
});

annotationsRoutes.delete("/annotations/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid annotation id" }, 400);
  const db = createDb(c.env.DB);
  const annotation = await db.select().from(schema.annotations).where(eq(schema.annotations.id, id)).get();
  if (!annotation) return c.json({ error: "Annotation not found" }, 404);
  const asset = await assetContext(c, annotation.assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const scope = scopeForAsset(c, asset); if (scope instanceof Response) return scope;
  if (annotation.authorId !== c.get("user").id) return c.json({ error: "Forbidden: only the author can delete this annotation." }, 403);
  // Retain stroke objects in R2: deletes only remove the D1 reference, preserving cheap, audit-friendly history.
  await db.delete(schema.annotations).where(eq(schema.annotations.id, id));
  await audit(c.env, c.get("user"), "annotation.delete", "annotation", id, { assetId: asset.assetId, scope, hadStrokes: Boolean(annotation.strokeR2Key) });
  return c.json({ ok: true });
});

annotationsRoutes.patch("/annotations/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid annotation id" }, 400);
  const db = createDb(c.env.DB);
  const annotation = await db.select().from(schema.annotations).where(eq(schema.annotations.id, id)).get();
  if (!annotation) return c.json({ error: "Annotation not found" }, 404);
  const asset = await assetContext(c, annotation.assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const scope = scopeForAsset(c, asset); if (scope instanceof Response) return scope;
  if (annotation.authorId !== c.get("user").id) return c.json({ error: "Forbidden: only the author can edit this annotation." }, 403);
  const data = await jsonInput(c, annotationEditInput); if (data instanceof Response) return data;
  const editedAt = new Date();
  const patch: { noteText?: string | null; strokeR2Key?: string | null; editedAt: Date } = { editedAt };
  const changed: string[] = [];
  if (data.noteText !== undefined) { patch.noteText = data.noteText; changed.push("note"); }
  if (data.strokes !== undefined) {
    changed.push("strokes");
    if (data.strokes.length === 0) { patch.strokeR2Key = null; }
    else {
      let strokeJson: string;
      try { strokeJson = JSON.stringify(data.strokes); } catch { return c.json({ error: "Markup must be JSON-serializable" }, 400); }
      if (byteLength(strokeJson) > 2_000_000) return c.json({ error: "Markup is too large" }, 400);
      // New R2 object per edit (never overwrite/delete the old one — cheap, audit-friendly).
      const dir = annotation.strokeR2Key ? annotation.strokeR2Key.slice(0, annotation.strokeR2Key.lastIndexOf("/")) : `projects/${asset.projectId}/${scope}/${annotation.assetId}/annotations`;
      // Random suffix: Date.now() alone can collide for same-millisecond edits, overwriting the retained prior object.
      const strokeR2Key = `${dir}/strokes-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
      await c.env.MEDIA.put(strokeR2Key, strokeJson, { httpMetadata: { contentType: "application/json" } });
      patch.strokeR2Key = strokeR2Key;
    }
  }
  const updated = await db.update(schema.annotations).set(patch).where(eq(schema.annotations.id, id)).returning().get();
  await audit(c.env, c.get("user"), "annotation.edit", "annotation", id, { assetId: asset.assetId, scope, changed });
  return c.json(updated);
});
