import { Hono, type Context } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { parseTonomoOrder, ROLE_CAPABILITIES } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";
import { ensurePipelineStages, listPipelineStages } from "./stages";

const agencyCreate = z.object({ name: z.string().trim().min(1), notes: z.string().trim().nullable().optional() });
const agencyPatch = agencyCreate.partial();
const agentFields = z.object({ agencyId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1), email: z.string().trim().email().nullable().optional(), phone: z.string().trim().nullable().optional() });
const agentPatch = agentFields.partial();
const stagePatch = z.object({ label: z.string().trim().min(1).optional(), active: z.boolean().optional() });
const stageMove = z.object({ direction: z.enum(["up", "down"]) });
const renditionBackfill = z.object({ dryRun: z.boolean().optional(), cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).optional(), confirmProduction: z.literal(true).optional() });
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const eventsQuery = z.object({ source: optionalQuery(z.literal("tonomo")), status: optionalQuery(z.enum(["received", "processed", "poison"])), offset: optionalQuery(z.coerce.number().int().min(0)), limit: optionalQuery(z.coerce.number().int().min(1).max(100)) });
const idCheck = (value: string) => z.string().uuid().safeParse(value).success;

function adminAllowed(c: Context<AppEnv>) {
  return ROLE_CAPABILITIES[c.get("user").role].includes("adminBackend");
}

function summary(payloadJson: string) {
  try {
    const order = parseTonomoOrder(JSON.parse(payloadJson));
    return { street: order.street, orderId: order.orderId };
  } catch { return null; }
}

export const adminRoutes = new Hono<AppEnv>();

// This is intentionally an operator endpoint, not an automatic deployment task. Each call
// advances at most one cursor page; production also requires an explicit body confirmation.
adminRoutes.post("/admin/renditions/backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const input = await jsonInput(c, renditionBackfill); if (input instanceof Response) return input;
  try {
    const result = await c.env.BACKGROUND.backfillRenditions(input);
    await audit(c.env, c.get("user").id, "rendition.backfill.request", "asset_renditions", input.cursor ?? "start", input);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Rendition backfill failed" }, 409);
  }
});

adminRoutes.get("/admin/agencies", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB);
  const agencies = await db.select({ id: schema.agencies.id, name: schema.agencies.name, notes: schema.agencies.notes, createdAt: schema.agencies.createdAt, updatedAt: schema.agencies.updatedAt, agentCount: sql<number>`count(${schema.agents.id})` })
    .from(schema.agencies).leftJoin(schema.agents, eq(schema.agents.agencyId, schema.agencies.id)).groupBy(schema.agencies.id).orderBy(asc(schema.agencies.name)).all();
  return c.json({ agencies });
});

adminRoutes.post("/admin/agencies", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const data = await jsonInput(c, agencyCreate); if (data instanceof Response) return data;
  const id = newId(); const now = new Date(); const db = createDb(c.env.DB);
  await db.insert(schema.agencies).values({ id, ...data, createdAt: now, updatedAt: now });
  await audit(c.env, c.get("user").id, "agency.create", "agency", id, data);
  return c.json(await db.select().from(schema.agencies).where(eq(schema.agencies.id, id)).get(), 201);
});

adminRoutes.patch("/admin/agencies/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid agency id" }, 400);
  const data = await jsonInput(c, agencyPatch); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); if (!await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, id)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.update(schema.agencies).set({ ...data, updatedAt: new Date() }).where(eq(schema.agencies.id, id));
  await audit(c.env, c.get("user").id, "agency.update", "agency", id, data);
  return c.json(await db.select().from(schema.agencies).where(eq(schema.agencies.id, id)).get());
});

adminRoutes.get("/admin/agents", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = z.object({ agencyId: optionalQuery(z.string().uuid()) }).safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const db = createDb(c.env.DB); const rows = db.select({ id: schema.agents.id, agencyId: schema.agents.agencyId, agencyName: schema.agencies.name, name: schema.agents.name, email: schema.agents.email, phone: schema.agents.phone, createdAt: schema.agents.createdAt, updatedAt: schema.agents.updatedAt }).from(schema.agents).leftJoin(schema.agencies, eq(schema.agents.agencyId, schema.agencies.id));
  return c.json({ agents: await (parsed.data.agencyId ? rows.where(eq(schema.agents.agencyId, parsed.data.agencyId)) : rows).orderBy(asc(schema.agents.name)).all() });
});

adminRoutes.post("/admin/agents", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const data = await jsonInput(c, agentFields); if (data instanceof Response) return data;
  const id = newId(); const now = new Date(); const db = createDb(c.env.DB);
  if (data.agencyId && !await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, data.agencyId)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.insert(schema.agents).values({ id, ...data, createdAt: now, updatedAt: now });
  await audit(c.env, c.get("user").id, "agent.create", "agent", id, data);
  return c.json(await db.select().from(schema.agents).where(eq(schema.agents.id, id)).get(), 201);
});

adminRoutes.patch("/admin/agents/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid agent id" }, 400);
  const data = await jsonInput(c, agentPatch); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); if (!await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, id)).get()) return c.json({ error: "Agent not found" }, 404);
  if (data.agencyId && !await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, data.agencyId)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.update(schema.agents).set({ ...data, updatedAt: new Date() }).where(eq(schema.agents.id, id));
  await audit(c.env, c.get("user").id, "agent.update", "agent", id, data);
  return c.json(await db.select().from(schema.agents).where(eq(schema.agents.id, id)).get());
});

adminRoutes.get("/admin/stages", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  return c.json({ stages: await listPipelineStages(createDb(c.env.DB)) });
});

adminRoutes.patch("/admin/stages/:key", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const key = c.req.param("key"); const data = await jsonInput(c, stagePatch); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); await ensurePipelineStages(db); const stage = await db.select().from(schema.pipelineStages).where(eq(schema.pipelineStages.key, key)).get();
  if (!stage) return c.json({ error: "Stage not found" }, 404);
  if (data.active === false) {
    if (key === "awaiting_raw") return c.json({ error: "The awaiting_raw stage is required for new projects." }, 409);
    const inUse = (await db.select({ count: sql<number>`count(*)` }).from(schema.projects).where(and(eq(schema.projects.stageKey, key), isNull(schema.projects.archivedAt))).get())?.count ?? 0;
    if (inUse) return c.json({ error: "This stage is used by active projects and cannot be deactivated.", projectCount: inUse }, 409);
  }
  await db.update(schema.pipelineStages).set(data).where(eq(schema.pipelineStages.key, key));
  await audit(c.env, c.get("user").id, "pipeline_stage.update", "pipeline_stage", key, data);
  return c.json(await db.select().from(schema.pipelineStages).where(eq(schema.pipelineStages.key, key)).get());
});

adminRoutes.post("/admin/stages/:key/move", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const key = c.req.param("key"); const data = await jsonInput(c, stageMove); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const stages = await listPipelineStages(db); const index = stages.findIndex((stage) => stage.key === key);
  if (index < 0) return c.json({ error: "Stage not found" }, 404);
  const adjacent = stages[index + (data.direction === "up" ? -1 : 1)];
  if (!adjacent) return c.json({ error: "Stage is already at the edge" }, 409);
  const stage = stages[index]!;
  await db.batch([
    db.update(schema.pipelineStages).set({ displayOrder: adjacent.displayOrder }).where(eq(schema.pipelineStages.key, stage.key)),
    db.update(schema.pipelineStages).set({ displayOrder: stage.displayOrder }).where(eq(schema.pipelineStages.key, adjacent.key)),
  ]);
  await audit(c.env, c.get("user").id, "pipeline_stage.move", "pipeline_stage", key, { direction: data.direction, swappedWith: adjacent.key });
  return c.json({ stages: await listPipelineStages(db) });
});

adminRoutes.get("/admin/webhook-events", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = eventsQuery.safeParse(c.req.query()); if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const query = parsed.data; const filters = [eq(schema.webhookEvents.source, query.source ?? "tonomo")]; if (query.status) filters.push(eq(schema.webhookEvents.status, query.status));
  const db = createDb(c.env.DB); const where = and(...filters);
  const [events, count] = await Promise.all([
    db.select({ id: schema.webhookEvents.id, eventId: schema.webhookEvents.eventId, status: schema.webhookEvents.status, error: schema.webhookEvents.error, receivedAt: schema.webhookEvents.receivedAt, processedAt: schema.webhookEvents.processedAt, payloadJson: schema.webhookEvents.payloadJson }).from(schema.webhookEvents).where(where).orderBy(desc(schema.webhookEvents.receivedAt)).limit(query.limit ?? 30).offset(query.offset ?? 0).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.webhookEvents).where(where).get(),
  ]);
  return c.json({ events: events.map(({ payloadJson, ...event }) => ({ ...event, summary: summary(payloadJson) })), total: count?.count ?? 0 });
});

adminRoutes.get("/admin/webhook-events/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const event = await createDb(c.env.DB).select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  return event ? c.json({ event }) : c.json({ error: "Webhook event not found" }, 404);
});

adminRoutes.post("/admin/webhook-events/:id/retry", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const db = createDb(c.env.DB); const event = await db.select({ id: schema.webhookEvents.id }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  if (!event) return c.json({ error: "Webhook event not found" }, 404);
  const result = await db.update(schema.webhookEvents).set({ status: "received", error: null, processedAt: null }).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"), eq(schema.webhookEvents.status, "poison"))).run();
  if (result.meta.changes === 0) return c.json({ error: "Event is no longer poison" }, 409);
  await audit(c.env, c.get("user").id, "tonomo_event.retry", "webhook_event", id);
  c.executionCtx.waitUntil(c.env.BACKGROUND.processTonomoEvents().catch((error) => {
    console.error("Tonomo webhook handoff failed", error);
  }));
  return c.json({ ok: true });
});

adminRoutes.post("/admin/webhook-events/:id/discard", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const db = createDb(c.env.DB); const event = await db.select({ error: schema.webhookEvents.error }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  if (!event) return c.json({ error: "Webhook event not found" }, 404);
  const result = await db.update(schema.webhookEvents).set({ status: "processed", error: `${event.error ?? "Unknown error"} — discarded by operator`, processedAt: new Date() }).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"), eq(schema.webhookEvents.status, "poison"))).run();
  if (result.meta.changes === 0) return c.json({ error: "Event is no longer poison" }, 409);
  await audit(c.env, c.get("user").id, "tonomo_event.discard", "webhook_event", id, { error: event.error });
  return c.json({ ok: true });
});

adminRoutes.get("/admin/tonomo-health", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB); const [latest, rows] = await Promise.all([
    db.select({ receivedAt: schema.webhookEvents.receivedAt }).from(schema.webhookEvents).where(eq(schema.webhookEvents.source, "tonomo")).orderBy(desc(schema.webhookEvents.receivedAt)).limit(1).get(),
    db.select({ status: schema.webhookEvents.status, count: sql<number>`count(*)` }).from(schema.webhookEvents).where(eq(schema.webhookEvents.source, "tonomo")).groupBy(schema.webhookEvents.status).all(),
  ]);
  const counts = { received: 0, processed: 0, poison: 0 }; for (const row of rows) counts[row.status] = row.count;
  return c.json({ tonomo: { lastEventAt: latest?.receivedAt ?? null, counts, poisonCount: counts.poison } });
});
