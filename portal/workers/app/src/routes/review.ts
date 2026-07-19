import { Hono } from "hono";
import type { Context } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess, requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";

const reviewInput = z.object({ stars: z.number().int().min(1).max(5).nullable().optional(), colorLabel: z.enum(["select", "maybe", "cut", "hero"]).nullable().optional(), decision: z.enum(["approved", "flagged"]).nullable().optional(), recommended: z.boolean().optional() });
async function assetContext(c: Context<AppEnv>, assetId: string) { return createDb(c.env.DB).select({ projectId: schema.collections.projectId, kind: schema.collections.kind }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(eq(schema.assets.id, assetId)).get(); }
export const reviewRoutes = new Hono<AppEnv>();
reviewRoutes.post("/assets/:id/review", async (c) => {
  const id = c.req.param("id"); if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid asset id" }, 400); const asset = await assetContext(c, id); if (!asset) return c.json({ error: "Asset not found" }, 404);
  if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); {
    const data = await jsonInput(c, reviewInput); if (data instanceof Response) return data; const user = c.get("user");
    if (user.role === "photographer") { if (data.recommended === undefined || data.stars !== undefined || data.colorLabel !== undefined || data.decision !== undefined) return c.json({ error: "Photographers may only set recommended" }, 403); }
    else if (asset.kind === "raw" && !["admin", "editor"].includes(user.role)) return c.json({ error: "Forbidden" }, 403);
    const db = createDb(c.env.DB); const existing = await db.select({ id: schema.assetReviewState.id }).from(schema.assetReviewState).where(eq(schema.assetReviewState.assetId, id)).get(); const values = { ...data, updatedBy: user.id, updatedAt: new Date() }; if (existing) await db.update(schema.assetReviewState).set(values).where(eq(schema.assetReviewState.id, existing.id)); else await db.insert(schema.assetReviewState).values({ id: newId(), assetId: id, stars: data.stars ?? null, colorLabel: data.colorLabel ?? null, decision: data.decision ?? null, recommended: data.recommended ?? false, updatedBy: user.id, updatedAt: new Date() }); await audit(c.env, user.id, "asset.review", "asset", id, data); return c.json({ ok: true });
  }
});
reviewRoutes.post("/assets/:id/select", requireCapability("selectForEditing"), async (c) => {
  const id = c.req.param("id"); const asset = await assetContext(c, id); if (!asset) return c.json({ error: "Asset not found" }, 404); if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); const db = createDb(c.env.DB); await db.insert(schema.selections).values({ id: newId(), assetId: id, selectedBy: c.get("user").id, state: "selected_for_editing", createdAt: new Date() }).onConflictDoUpdate({ target: schema.selections.assetId, set: { selectedBy: c.get("user").id, state: "selected_for_editing" } }); await audit(c.env, c.get("user").id, "asset.select", "asset", id); return c.json({ ok: true });
});
reviewRoutes.delete("/assets/:id/select", requireCapability("selectForEditing"), async (c) => { const id = c.req.param("id"); const asset = await assetContext(c, id); if (!asset) return c.json({ error: "Asset not found" }, 404); if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); await createDb(c.env.DB).delete(schema.selections).where(eq(schema.selections.assetId, id)); await audit(c.env, c.get("user").id, "asset.unselect", "asset", id); return c.json({ ok: true }); });
