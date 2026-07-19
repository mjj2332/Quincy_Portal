import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, eq } from "drizzle-orm";
import { roleHasCapability } from "@quincy/shared";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";

const annotationInput = z.object({ strokes: z.unknown().optional(), noteText: z.string().trim().max(10_000).optional() })
  .refine((value) => value.strokes !== undefined || Boolean(value.noteText), { message: "A markup or note is required" });
const commentInput = z.object({ body: z.string().trim().min(1).max(10_000), parentId: z.string().uuid().optional() });
const annotationEditInput = z.object({ noteText: z.string().trim().max(10_000).nullable() });
const commentEditInput = z.object({ body: z.string().trim().min(1).max(10_000) });

type AssetContext = { assetId: string; projectId: string; kind: "raw" | "edited" | "video" | "floorplan" | "copy" };

async function assetContext(c: Context<AppEnv>, assetId: string): Promise<AssetContext | undefined> {
  return createDb(c.env.DB).select({ assetId: schema.assets.id, projectId: schema.collections.projectId, kind: schema.collections.kind })
    .from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .where(eq(schema.assets.id, assetId)).get();
}

function scopeForAsset(c: Context<AppEnv>, asset: AssetContext): "raw" | "edited" | Response {
  if (asset.kind !== "raw" && asset.kind !== "edited") return c.json({ error: "Annotations are available for RAW and edited photo assets only" }, 400);
  const capability = asset.kind === "raw" ? "annotateRaw" : "annotateEdited";
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  return asset.kind;
}

async function canViewAsset(c: Context<AppEnv>, asset: AssetContext): Promise<Response | null> {
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
  const [annotationRows, commentRows] = await Promise.all([
    db.select({ annotation: schema.annotations, author: schema.user }).from(schema.annotations)
      .innerJoin(schema.user, eq(schema.annotations.authorId, schema.user.id))
      .where(eq(schema.annotations.assetId, assetId)).orderBy(asc(schema.annotations.createdAt)).all(),
    db.select({ comment: schema.comments, author: schema.user }).from(schema.comments)
      .innerJoin(schema.user, eq(schema.comments.authorId, schema.user.id))
      .where(eq(schema.comments.assetId, assetId)).orderBy(asc(schema.comments.createdAt)).all(),
  ]);
  const comments = commentRows.map(({ comment, author }) => ({
    id: comment.id, parentId: comment.parentId, authorId: comment.authorId, body: comment.body, author: { id: author.id, name: author.name, role: comment.authorRole }, createdAt: comment.createdAt, editedAt: comment.editedAt, replies: [] as unknown[],
  }));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const roots: typeof comments = [];
  for (const comment of comments) {
    const parent = comment.parentId ? byId.get(comment.parentId) : undefined;
    if (parent) (parent.replies as typeof comments).push(comment); else roots.push(comment);
  }
  return c.json({
    annotations: annotationRows.map(({ annotation, author }) => ({
      id: annotation.id, authorId: annotation.authorId, author: { id: author.id, name: author.name, role: annotation.authorRole }, scope: annotation.scope,
      strokeR2Key: annotation.strokeR2Key, noteText: annotation.noteText, createdAt: annotation.createdAt, editedAt: annotation.editedAt,
    })),
    comments: roots,
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
    if (strokeJson === undefined || strokeJson.length > 2_000_000) return c.json({ error: "Markup is too large" }, 400);
  }
  const id = newId();
  const strokeR2Key = strokeJson ? `projects/${asset.projectId}/${scope}/${assetId}/annotations/${id}.json` : null;
  if (strokeR2Key && strokeJson) await c.env.MEDIA.put(strokeR2Key, strokeJson, { httpMetadata: { contentType: "application/json" } });
  await createDb(c.env.DB).insert(schema.annotations).values({
    id, assetId, authorId: c.get("user").id, authorRole: c.get("user").role, scope,
    strokeR2Key, noteText: data.noteText || null, createdAt: new Date(),
  });
  await audit(c.env, c.get("user").id, "asset.annotate", "asset", assetId, { annotationId: id, scope, hasStrokes: Boolean(strokeR2Key) });
  return c.json({ id, strokeR2Key, scope }, 201);
});

annotationsRoutes.post("/assets/:id/comments", async (c) => {
  const assetId = c.req.param("id");
  if (!z.string().uuid().safeParse(assetId).success) return c.json({ error: "Invalid asset id" }, 400);
  const asset = await assetContext(c, assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const scope = scopeForAsset(c, asset); if (scope instanceof Response) return scope;
  const data = await jsonInput(c, commentInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  if (data.parentId) {
    const parent = await db.select({ id: schema.comments.id }).from(schema.comments)
      .where(and(eq(schema.comments.id, data.parentId), eq(schema.comments.assetId, assetId))).get();
    if (!parent) return c.json({ error: "Comment parent was not found on this asset" }, 400);
  }
  const id = newId();
  await db.insert(schema.comments).values({ id, assetId, parentId: data.parentId ?? null, authorId: c.get("user").id, authorRole: c.get("user").role, body: data.body, createdAt: new Date() });
  await audit(c.env, c.get("user").id, "asset.comment", "asset", assetId, { commentId: id, parentId: data.parentId ?? null, scope });
  return c.json({ id }, 201);
});

annotationsRoutes.patch("/comments/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid comment id" }, 400);
  const db = createDb(c.env.DB);
  const comment = await db.select().from(schema.comments).where(eq(schema.comments.id, id)).get();
  if (!comment) return c.json({ error: "Comment not found" }, 404);
  const asset = await assetContext(c, comment.assetId);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const scope = scopeForAsset(c, asset); if (scope instanceof Response) return scope;
  if (comment.authorId !== c.get("user").id) return c.json({ error: "Forbidden: only the author can edit this comment." }, 403);
  const data = await jsonInput(c, commentEditInput); if (data instanceof Response) return data;
  const editedAt = new Date();
  const updated = await db.update(schema.comments).set({ body: data.body, editedAt }).where(eq(schema.comments.id, id)).returning().get();
  await audit(c.env, c.get("user").id, "comment.edit", "comment", id, { assetId: asset.assetId, scope });
  return c.json(updated);
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
  const updated = await db.update(schema.annotations).set({ noteText: data.noteText, editedAt }).where(eq(schema.annotations.id, id)).returning().get();
  await audit(c.env, c.get("user").id, "annotation.edit", "annotation", id, { assetId: asset.assetId, scope });
  return c.json(updated);
});
