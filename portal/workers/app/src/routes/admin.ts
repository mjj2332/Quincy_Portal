import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, dashboardProjectOrder, orderDashboardStreetTies, schema } from "@quincy/db";
import { and, asc, desc, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { enqueueRenditionSafely, parseTonomoOrder, publishNotificationOutbox, renditionsEnabled, roleHasCapability } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";
import { ensurePipelineStages, listPipelineStages } from "./stages";

const agencyCreate = z.object({ name: z.string().trim().min(1), notes: z.string().trim().nullable().optional() });
const agencyPatch = agencyCreate.partial();
const agentFields = z.object({ agencyId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1), email: z.string().trim().email().nullable().optional(), phone: z.string().trim().nullable().optional() });
const agentPatch = agentFields.partial();
const stagePatch = z.object({ label: z.string().trim().min(1).optional(), active: z.boolean().optional() });
const renditionBackfill = z.object({ dryRun: z.boolean().optional(), cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).optional(), confirmProduction: z.literal(true).optional() });
const autohdrBackfillInput = z.object({ dryRun: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() });
const autohdrScaffoldBackfillInput = z.object({ dryRun: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() });
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const eventsQuery = z.object({ source: optionalQuery(z.literal("tonomo")), status: optionalQuery(z.enum(["received", "processed", "poison"])), offset: optionalQuery(z.coerce.number().int().min(0)), limit: optionalQuery(z.coerce.number().int().min(1).max(100)) });
const idCheck = (value: string) => z.string().uuid().safeParse(value).success;

function adminAllowed(c: Context<AppEnv>) {
  return roleHasCapability(c.get("user").role, "adminBackend");
}

function summary(payloadJson: string) {
  try {
    const order = parseTonomoOrder(JSON.parse(payloadJson));
    return { street: order.street, orderId: order.orderId };
  } catch { return null; }
}

export const adminRoutes = new Hono<AppEnv>();

const notificationDeliveryView = z.enum(["pending_stuck", "dlq", "failed", "unknown", "preference_suppressed"]);
const notificationDeliveryQuery = z.object({
  view: notificationDeliveryView,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
const notificationReplayInput = z.object({
  acknowledgeDuplicateEmail: z.literal(true).optional(),
  channels: z.array(z.enum(["in_app", "email"])).min(1).max(2).optional(),
}).strict();

type NotificationDeliveryApiRow = {
  outboxId: string;
  eventType: string;
  projectId: string | null;
  projectStreet: string | null;
  recipientName: string | null;
  channels: string | null;
  status: string;
  attempts: number;
  safeErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  unknownEmailPossible: number;
};

type NotificationDeliveryCursor = { updatedAt: number; id: string };

function encodeNotificationCursor(row: { updatedAt: number; outboxId: string }): string {
  return btoa(JSON.stringify({ updatedAt: row.updatedAt, id: row.outboxId }));
}

function decodeNotificationCursor(value: string | undefined): NotificationDeliveryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Record<string, unknown>;
    return typeof parsed.updatedAt === "number" && Number.isSafeInteger(parsed.updatedAt) && typeof parsed.id === "string" && idCheck(parsed.id)
      ? { updatedAt: parsed.updatedAt, id: parsed.id }
      : null;
  } catch { return null; }
}

function notificationViewSql(view: z.infer<typeof notificationDeliveryView>): string {
  switch (view) {
    case "pending_stuck": return "(o.status = 'pending' OR (o.status = 'queued' AND o.queue_published_at <= ? AND o.queue_published_at IS NOT NULL) OR (o.status = 'processing' AND o.lease_expires_at <= ?))";
    case "dlq": return "o.status = 'dlq'";
    case "failed": return "o.status != 'dlq' AND EXISTS (SELECT 1 FROM notification_delivery_ledger failed WHERE failed.outbox_id = o.id AND failed.status = 'failed')";
    case "unknown": return "EXISTS (SELECT 1 FROM notification_delivery_ledger unknown_email WHERE unknown_email.outbox_id = o.id AND unknown_email.channel = 'email' AND unknown_email.status = 'unknown')";
    case "preference_suppressed": return `o.status = 'completed'
      AND o.event_type = 'project.deadline.reminder'
      AND EXISTS (
        SELECT 1 FROM notification_delivery_ledger preference_suppressed_email
        WHERE preference_suppressed_email.outbox_id = o.id
          AND preference_suppressed_email.channel = 'email'
          AND preference_suppressed_email.status = 'suppressed'
          AND preference_suppressed_email.last_error_code = 'recipient_preference_disabled'
      )`;
  }
}

function safeNotificationErrorCode(value: string | null): string | null {
  if (!value) return null;
  const safe = new Set([
    "queue_publish_failed", "delivery_lease_expired", "delivery_retry", "reauthorization_suppressed", "recipient_preference_disabled",
    "queue_retries_exhausted", "email_configuration_missing", "email_acceptance_unknown",
    "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INVALID_FROM",
    "E_INVALID_TO", "E_INVALID_EMAIL", "E_DOMAIN_NOT_VERIFIED", "E_SENDER_NOT_ALLOWED",
    "E_RECIPIENT_SUPPRESSED", "E_MESSAGE_TOO_LARGE", "E_INVALID_HEADERS",
    "project_activity_payload_invalid", "project_activity_missing", "project_activity_invalid",
    "project_activity_project_mismatch", "project_activity_type_reserved",
  ]);
  return safe.has(value) ? value : "delivery_error";
}

function serializeNotificationDeliveryRow(row: NotificationDeliveryApiRow) {
  return {
    outboxId: row.outboxId,
    eventType: row.eventType,
    projectId: row.projectId,
    projectStreet: row.projectStreet,
    recipientName: row.recipientName,
    channels: row.channels ? row.channels.split(",").map((value) => {
      const [channel, status] = value.split(":");
      return { channel, status };
    }) : [],
    status: row.status,
    attempts: row.attempts,
    safeErrorCode: safeNotificationErrorCode(row.safeErrorCode),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAttemptAt: row.lastAttemptAt,
    unknownEmailPossible: row.unknownEmailPossible === 1,
  };
}

async function loadNotificationDeliveryRow(c: Parameters<typeof adminAllowed>[0], outboxId: string): Promise<ReturnType<typeof serializeNotificationDeliveryRow> | null> {
  const row = await c.env.DB.prepare(`
    SELECT o.id AS outboxId, o.event_type AS eventType, o.project_id AS projectId,
      p.street AS projectStreet, recipient.name AS recipientName,
      GROUP_CONCAT(l.channel || ':' || l.status) AS channels,
      o.status AS status, o.delivery_attempts AS attempts,
      COALESCE(o.last_error_code, MAX(l.last_error_code)) AS safeErrorCode,
      o.created_at AS createdAt, o.updated_at AS updatedAt,
      MAX(l.last_attempt_at) AS lastAttemptAt,
      MAX(CASE WHEN l.channel = 'email' AND l.status = 'unknown' THEN 1 ELSE 0 END) AS unknownEmailPossible
    FROM notification_outbox o
    LEFT JOIN notification_delivery_ledger l ON l.outbox_id = o.id
    LEFT JOIN projects p ON p.id = o.project_id
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    WHERE o.id = ? GROUP BY o.id
  `).bind(outboxId).first<NotificationDeliveryApiRow>();
  return row ? serializeNotificationDeliveryRow(row) : null;
}

async function notificationDeliveryCounts(c: Parameters<typeof adminAllowed>[0], now: number) {
  const counts = await Promise.all(([
    "pending_stuck", "dlq", "failed", "unknown", "preference_suppressed",
  ] as const).map(async (view) => {
    const clause = notificationViewSql(view);
    const values = view === "pending_stuck" ? [now - 30 * 60_000, now] : [];
    const result = await c.env.DB.prepare(`SELECT COUNT(DISTINCT o.id) AS count FROM notification_outbox o WHERE ${clause}`).bind(...values).first<{ count: number }>();
    return [view, Number(result?.count ?? 0)] as const;
  }));
  return Object.fromEntries(counts) as Record<typeof notificationDeliveryView['_type'], number>;
}

adminRoutes.get("/admin/notification-deliveries", terminalRoute("/admin/notification-deliveries", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = notificationDeliveryQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const cursor = decodeNotificationCursor(parsed.data.cursor);
  if (parsed.data.cursor && !cursor) return c.json({ error: "Invalid cursor" }, 400);
  const now = Date.now();
  const clause = notificationViewSql(parsed.data.view);
  const values: unknown[] = parsed.data.view === "pending_stuck" ? [now - 30 * 60_000, now] : [];
  let cursorClause = "";
  if (cursor) { cursorClause = " AND (o.updated_at < ? OR (o.updated_at = ? AND o.id < ?))"; values.push(cursor.updatedAt, cursor.updatedAt, cursor.id); }
  const rows = await c.env.DB.prepare(`
    SELECT o.id AS outboxId, o.event_type AS eventType, o.project_id AS projectId,
      p.street AS projectStreet, recipient.name AS recipientName,
      GROUP_CONCAT(l.channel || ':' || l.status) AS channels,
      o.status AS status, o.delivery_attempts AS attempts,
      COALESCE(o.last_error_code, MAX(l.last_error_code)) AS safeErrorCode,
      o.created_at AS createdAt, o.updated_at AS updatedAt,
      MAX(l.last_attempt_at) AS lastAttemptAt,
      MAX(CASE WHEN l.channel = 'email' AND l.status = 'unknown' THEN 1 ELSE 0 END) AS unknownEmailPossible
    FROM notification_outbox o
    LEFT JOIN notification_delivery_ledger l ON l.outbox_id = o.id
    LEFT JOIN projects p ON p.id = o.project_id
    LEFT JOIN user recipient ON recipient.id = o.recipient_id
    WHERE ${clause}${cursorClause}
    GROUP BY o.id ORDER BY o.updated_at DESC, o.id DESC LIMIT ?
  `).bind(...values, parsed.data.limit).all<NotificationDeliveryApiRow>();
  const items = rows.results.map(serializeNotificationDeliveryRow);
  const last = rows.results.at(-1);
  return c.json({
    view: parsed.data.view,
    items,
    nextCursor: last && rows.results.length === parsed.data.limit ? encodeNotificationCursor({ updatedAt: last.updatedAt, outboxId: last.outboxId }) : null,
    counts: await notificationDeliveryCounts(c, now),
  });
}));

adminRoutes.post("/admin/notification-deliveries/:outboxId/replay", terminalRoute("/admin/notification-deliveries/:outboxId/replay", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const outboxId = c.req.param("outboxId"); if (!idCheck(outboxId)) return c.json({ error: "Invalid outbox id" }, 400);
  const data = await jsonInput(c, notificationReplayInput); if (data instanceof Response) return data;
  const existing = await c.env.DB.prepare("SELECT id, status, lease_expires_at AS leaseExpiresAt, updated_at AS updatedAt FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ id: string; status: string; leaseExpiresAt: number | null; updatedAt: number }>();
  if (!existing) return c.json({ error: "Notification outbox row not found" }, 404);
  const now = Math.max(Date.now(), existing.updatedAt + 1);
  if (existing.status === "processing" && existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) return c.json({ error: "Notification delivery is actively leased", code: "delivery_active" }, 409);
  const email = await c.env.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(outboxId).first<{ status: string }>();
  const unknownEmail = email?.status === "unknown";
  const channels = data.channels ? [...new Set(data.channels)] : ["in_app", "email"] as const;
  const exactUnknownAcknowledgement = data.acknowledgeDuplicateEmail === true
    && data.channels?.length === 1
    && data.channels[0] === "email"
    && Object.keys(data).length === 2;
  if (unknownEmail && !exactUnknownAcknowledgement) {
    return c.json({ error: "Cloudflare may already have accepted this email. Replaying can send a duplicate.", code: "duplicate_email_possible" }, 409);
  }
  const channelList = channels.map((channel) => `'${channel}'`).join(",");
  const acknowledgement = unknownEmail && exactUnknownAcknowledgement;
  // Both statements are fenced on `existing.updatedAt` (read moments ago) so a concurrent
  // discard/replay racing this same row -- which would have changed updated_at -- cannot win
  // alongside this request: exactly one of the two produces changes here.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'pending', available_at = ?, queue_published_at = NULL,
          lease_token = NULL, lease_expires_at = NULL, completed_at = NULL,
          last_error_code = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND updated_at = ? AND status != 'suppressed'
        AND (status != 'processing' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND EXISTS (
          SELECT 1 FROM notification_delivery_ledger
          WHERE outbox_id = ? AND channel IN (${channelList})
            AND (status IN ('failed', 'discarded') OR (channel = 'email' AND status = 'unknown' AND ? = 1))
        )
    `).bind(now, now, outboxId, existing.updatedAt, now, outboxId, acknowledgement ? 1 : 0),
    c.env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'pending',
          email_message_id = CASE WHEN channel = 'email' THEN NULL ELSE email_message_id END,
          last_error_code = NULL, last_error = NULL, updated_at = ?
      WHERE outbox_id = ? AND channel IN (${channelList})
        AND (status IN ('failed', 'discarded') OR (channel = 'email' AND status = 'unknown' AND ? = 1))
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = notification_delivery_ledger.outbox_id AND o.status = 'pending' AND o.updated_at = ?)
    `).bind(now, outboxId, acknowledgement ? 1 : 0, now),
    c.env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'notification.delivery.replay', 'notification_outbox', ?, ?, ?
      WHERE changes() >= 1
    `).bind(newId(), c.get("user").id, outboxId, auditMeta(c.get("user"), { channels, acknowledgeDuplicateEmail: acknowledgement }), now),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) return c.json({ error: "Notification delivery is no longer replayable", code: "delivery_changed" }, 409);
  c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, [outboxId]));
  return c.json({ item: await loadNotificationDeliveryRow(c, outboxId) });
}));

adminRoutes.post("/admin/notification-deliveries/:outboxId/discard", terminalRoute("/admin/notification-deliveries/:outboxId/discard", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const outboxId = c.req.param("outboxId"); if (!idCheck(outboxId)) return c.json({ error: "Invalid outbox id" }, 400);
  const existing = await c.env.DB.prepare("SELECT id, status, lease_expires_at AS leaseExpiresAt, updated_at AS updatedAt FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ id: string; status: string; leaseExpiresAt: number | null; updatedAt: number }>();
  if (!existing) return c.json({ error: "Notification outbox row not found" }, 404);
  const now = Math.max(Date.now(), existing.updatedAt + 1);
  if (existing.status === "processing" && existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) return c.json({ error: "Notification delivery is actively leased", code: "delivery_active" }, 409);
  // Both statements are fenced on `existing.updatedAt` (read moments ago) so a concurrent
  // replay/discard racing this same row -- which would have changed updated_at -- cannot win
  // alongside this request: exactly one of the two produces changes here.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = CASE WHEN channel = 'email' AND status IN ('processing', 'unknown') THEN 'unknown' ELSE 'discarded' END,
          last_error_code = CASE WHEN channel = 'email' AND status IN ('processing', 'unknown') THEN 'email_acceptance_unknown' ELSE 'operator_discarded' END,
          last_error = CASE WHEN channel = 'email' AND status IN ('processing', 'unknown') THEN 'Email outcome requires duplicate acknowledgement.' ELSE 'Discarded by operator.' END,
          updated_at = ?
      WHERE outbox_id = ? AND status NOT IN ('sent', 'suppressed')
        AND EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = notification_delivery_ledger.outbox_id AND o.updated_at = ? AND o.status != 'discarded' AND o.status != 'suppressed' AND (o.status != 'processing' OR o.lease_expires_at IS NULL OR o.lease_expires_at <= ?))
      RETURNING channel, status
    `).bind(now, outboxId, existing.updatedAt, now),
    c.env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'discarded', lease_token = NULL, lease_expires_at = NULL,
          completed_at = ?, last_error_code = 'operator_discarded', last_error = 'Discarded by operator.', updated_at = ?
      WHERE id = ? AND updated_at = ? AND status != 'discarded' AND status != 'suppressed' AND (status != 'processing' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = ? AND status NOT IN ('sent', 'suppressed'))
    `).bind(now, now, outboxId, existing.updatedAt, now, outboxId),
    c.env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'notification.delivery.discard', 'notification_outbox', ?, ?, ?
      WHERE changes() = 1
    `).bind(newId(), c.get("user").id, outboxId, auditMeta(c.get("user"), { outboxId }), now),
  ]);
  const discardedEmailToUnknown = (results[0]?.results as Array<{ channel: string; status: string }> | undefined)?.some((row) => row.channel === "email" && row.status === "unknown");
  if (discardedEmailToUnknown) {
    try {
      await c.env.DB.prepare(`
        UPDATE notifications SET email_error = 'email_acceptance_unknown'
        WHERE id = (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app')
      `).bind(outboxId).run();
    } catch { /* Ledger remains authoritative if the compatibility mirror is gone. */ }
  }
  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) return c.json({ error: "Notification delivery is no longer discardable", code: "delivery_changed" }, 409);
  return c.json({ item: await loadNotificationDeliveryRow(c, outboxId) });
}));

// Temporary, idempotent operator route for the priority/reordering migration. The initial
// ordering is deliberately computed with the same dashboard query and Unicode tie-break as the
// live dashboard; only a stage move observed during the write window is repaired afterwards.
adminRoutes.post("/admin/backfill-board-position", terminalRoute("/admin/backfill-board-position", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB);
  const rows = await db.select({ project: schema.projects }).from(schema.projects)
    .where(isNull(schema.projects.archivedAt)).orderBy(...dashboardProjectOrder).all();
  const byStage = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byStage.get(row.project.stageKey) ?? [];
    group.push(row); byStage.set(row.project.stageKey, group);
  }
  const expectedStage = new Map(rows.map((row) => [row.project.id, row.project.stageKey]));
  const writes: D1PreparedStatement[] = [];
  for (const group of byStage.values()) {
    const ordered = orderDashboardStreetTies(group);
    for (const [index, row] of ordered.entries()) {
      writes.push(c.env.DB.prepare("UPDATE projects SET board_position = ? WHERE id = ? AND archived_at IS NULL").bind((index + 1) * 1024, row.project.id));
    }
  }
  if (writes.length) await c.env.DB.batch(writes);

  let corrected = 0;
  let remaining: { id: string; stageKey: string }[] = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const current = await db.select({ id: schema.projects.id, stageKey: schema.projects.stageKey })
      .from(schema.projects).where(isNull(schema.projects.archivedAt)).all();
    const moved = current.filter((row) => expectedStage.get(row.id) !== row.stageKey);
    if (!moved.length) { remaining = []; break; }
    remaining = moved;
    await c.env.DB.batch(moved.map((row) => c.env.DB.prepare(
      "UPDATE projects SET board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?) WHERE id = ? AND stage_key = ? AND archived_at IS NULL",
    ).bind(row.stageKey, row.id, row.id, row.stageKey)));
    for (const row of moved) { expectedStage.set(row.id, row.stageKey); corrected += 1; }
  }
  if (remaining.length) return c.json({ error: "Projects changed stage during backfill; rerun required", corrected, remaining }, 409);
  await audit(c.env, c.get("user"), "admin.board_position_backfill", "system", "board-position", { projectCount: rows.length, corrected });
  return c.json({ ok: true, projectCount: rows.length, corrected, verified: true });
}));

// This is intentionally an operator endpoint, not an automatic deployment task. Each call
// advances at most one cursor page; production also requires an explicit body confirmation.
adminRoutes.post("/admin/renditions/backfill", terminalRoute("/admin/renditions/backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const input = await jsonInput(c, renditionBackfill); if (input instanceof Response) return input;
  try {
    const result = await c.env.BACKGROUND.backfillRenditions(input);
  await audit(c.env, c.get("user"), "rendition.backfill.request", "asset_renditions", input.cursor ?? "start", input);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Rendition backfill failed" }, 409);
  }
}));

adminRoutes.post("/admin/autohdr/backfill", terminalRoute("/admin/autohdr/backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const input = await jsonInput(c, autohdrBackfillInput);
  if (input instanceof Response) return input;
  const result = await c.env.BACKGROUND.backfillAutoHdrV2(input);
  await audit(c.env, c.get("user"), "admin.autohdr_backfill", "system", "backfill", { result });
  return c.json(result);
}));

// One-off operator tool for projects whose raw_folder_path predates the implicit-scaffolding
// rollout: ensureAutoHdrScaffold() only fires on a WRITE to raw_folder_path (project create,
// Tonomo, PATCH, Dropbox reconciliation), so a project that already had a path set before that
// code shipped never got scaffolded automatically. Kept as a real route (not a throwaway script)
// since a future data path could plausibly hit the same gap. Bounded and re-runnable: a project
// already actively scaffolded is naturally skipped by ensureAutoHdrScaffold()'s own idempotent
// convergence, so calling this again is always safe.
adminRoutes.post("/admin/autohdr/scaffold-backfill", terminalRoute("/admin/autohdr/scaffold-backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const input = await jsonInput(c, autohdrScaffoldBackfillInput);
  if (input instanceof Response) return input;
  const db = createDb(c.env.DB);
  const limit = input.limit ?? 50;
  const candidates = await db.select({ id: schema.projects.id, street: schema.projects.street })
    .from(schema.projects)
    .where(and(
      isNotNull(schema.projects.rawFolderPath),
      sql`${schema.projects.rawFolderPath} != ''`,
      isNull(schema.projects.archivedAt),
      notExists(db.select({ id: schema.autohdrScaffoldClaims.id }).from(schema.autohdrScaffoldClaims)
        .where(and(eq(schema.autohdrScaffoldClaims.projectId, schema.projects.id), eq(schema.autohdrScaffoldClaims.state, "active")))),
    ))
    .limit(limit).all();
  if (input.dryRun) {
    await audit(c.env, c.get("user"), "admin.autohdr_scaffold_backfill.dry_run", "system", "scaffold-backfill", { candidateCount: candidates.length });
    return c.json({ dryRun: true, candidateCount: candidates.length, candidates });
  }
  const items: { projectId: string; street: string; jobId?: string; error?: string }[] = [];
  for (const [index, project] of candidates.entries()) {
    if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    try {
      const { jobId } = await c.env.BACKGROUND.ensureAutoHdrScaffold(project.id);
      items.push({ projectId: project.id, street: project.street, jobId });
    } catch (error) {
      items.push({ projectId: project.id, street: project.street, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await audit(c.env, c.get("user"), "admin.autohdr_scaffold_backfill", "system", "scaffold-backfill", { triggeredCount: items.length, items });
  return c.json({ dryRun: false, triggeredCount: items.length, items });
}));

// Messages the quincy-renditions consumer's DLQ actually received (see background queue()'s
// RENDITION_DLQ_QUEUE_NAME branch). Each row is append-only: a replay that fails 3x again lands
// as a fresh "open" row rather than mutating this one.
adminRoutes.get("/admin/renditions-dlq", terminalRoute("/admin/renditions-dlq", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = z.object({ status: optionalQuery(z.enum(["open", "replayed", "discarded"])), limit: optionalQuery(z.coerce.number().int().min(1).max(200)) }).safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const db = createDb(c.env.DB); const status = parsed.data.status ?? "open";
  const [events, openCount] = await Promise.all([
    db.select({ id: schema.renditionDlqEvents.id, assetId: schema.renditionDlqEvents.assetId, status: schema.renditionDlqEvents.status, receivedAt: schema.renditionDlqEvents.receivedAt, resolvedAt: schema.renditionDlqEvents.resolvedAt, projectId: schema.projects.id, street: schema.projects.street })
      .from(schema.renditionDlqEvents)
      .leftJoin(schema.assets, eq(schema.assets.id, schema.renditionDlqEvents.assetId))
      .leftJoin(schema.collections, eq(schema.collections.id, schema.assets.collectionId))
      .leftJoin(schema.projects, eq(schema.projects.id, schema.collections.projectId))
      .where(eq(schema.renditionDlqEvents.status, status))
      .orderBy(desc(schema.renditionDlqEvents.receivedAt)).limit(parsed.data.limit ?? 50).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.renditionDlqEvents).where(eq(schema.renditionDlqEvents.status, "open")).get(),
  ]);
  return c.json({ events, openCount: openCount?.count ?? 0 });
}));

adminRoutes.post("/admin/renditions-dlq/:id/replay", terminalRoute("/admin/renditions-dlq/:id/replay", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid rendition DLQ event id" }, 400);
  const db = createDb(c.env.DB);
  const event = await db.select({ id: schema.renditionDlqEvents.id, assetId: schema.renditionDlqEvents.assetId }).from(schema.renditionDlqEvents)
    .where(and(eq(schema.renditionDlqEvents.id, id), eq(schema.renditionDlqEvents.status, "open"))).get();
  if (!event) return c.json({ error: "Rendition DLQ event is not open" }, 409);
  // A malformed DLQ body (see background queue()'s fallback assetId) has nothing real to
  // re-enqueue; only "discard" is meaningful for it.
  if (!idCheck(event.assetId)) return c.json({ error: "This event has no valid asset to replay — discard it instead" }, 409);
  if (!await db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.id, event.assetId)).get()) {
    return c.json({ error: "This event refers to an asset that has already been deleted — discard it instead" }, 409);
  }
  // enqueueRenditionSafely already checks the queue binding; a replay is a single
  // operator-identified asset, the same blast radius as the ungated webhook-event retry below,
  // so it does not need the bulk backfill's extra production flag. The gate is checked here too
  // (redundantly with enqueueRenditionSafely) so it can be checked BEFORE the row is claimed —
  // claiming first, then finding out the send failed, would leave the row misleadingly
  // "replayed" with nothing actually queued.
  if (!renditionsEnabled(c.env)) return c.json({ error: "Renditions are disabled" }, 409);
  // Claim the row atomically before the side effect: a concurrent discard (or a second
  // concurrent replay) racing this same row must lose here, not after it's already caused a
  // stray rendition re-generation for an asset the operator just decided to discard.
  // Do not reorder this claim after enqueueRenditionSafely() — that would reopen exactly the
  // discard-vs-replay race this comment is guarding against.
  const claimed = await db.update(schema.renditionDlqEvents).set({ status: "replayed", resolvedAt: new Date() })
    .where(and(eq(schema.renditionDlqEvents.id, id), eq(schema.renditionDlqEvents.status, "open"))).run();
  if (claimed.meta.changes === 0) return c.json({ error: "Rendition DLQ event is not open" }, 409);
  if (!await enqueueRenditionSafely(c.env, event.assetId, "operator-dlq-replay")) {
    // The gate is pre-checked above, so this only fires if the queue send itself failed after
    // the row was already claimed. Revert the claim rather than leaving a "replayed" row that
    // nothing actually queued — the default admin view only lists status='open', so an
    // unreverted row here would silently vanish from the backlog while the rendition stays
    // stuck, reproducing the exact invisible-failure mode this feature exists to prevent.
    await db.update(schema.renditionDlqEvents).set({ status: "open", resolvedAt: null })
      .where(and(eq(schema.renditionDlqEvents.id, id), eq(schema.renditionDlqEvents.status, "replayed")));
    return c.json({ error: "Renditions are enabled but the rendition queue rejected the message" }, 502);
  }
  await audit(c.env, c.get("user"), "rendition.dlq.replay", "rendition_dlq_event", id, { assetId: event.assetId });
  return c.json({ ok: true });
}));

adminRoutes.post("/admin/renditions-dlq/:id/discard", terminalRoute("/admin/renditions-dlq/:id/discard", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid rendition DLQ event id" }, 400);
  const db = createDb(c.env.DB);
  const result = await db.update(schema.renditionDlqEvents).set({ status: "discarded", resolvedAt: new Date() })
    .where(and(eq(schema.renditionDlqEvents.id, id), eq(schema.renditionDlqEvents.status, "open"))).run();
  if (result.meta.changes === 0) return c.json({ error: "Rendition DLQ event is not open" }, 409);
  await audit(c.env, c.get("user"), "rendition.dlq.discard", "rendition_dlq_event", id);
  return c.json({ ok: true });
}));

adminRoutes.get("/admin/agencies", terminalRoute("/admin/agencies", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB);
  const agencies = await db.select({ id: schema.agencies.id, name: schema.agencies.name, notes: schema.agencies.notes, createdAt: schema.agencies.createdAt, updatedAt: schema.agencies.updatedAt, agentCount: sql<number>`count(${schema.agents.id})` })
    .from(schema.agencies).leftJoin(schema.agents, eq(schema.agents.agencyId, schema.agencies.id)).groupBy(schema.agencies.id).orderBy(asc(schema.agencies.name)).all();
  return c.json({ agencies });
}));

adminRoutes.post("/admin/agencies", terminalRoute("/admin/agencies", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const data = await jsonInput(c, agencyCreate); if (data instanceof Response) return data;
  const id = newId(); const now = new Date(); const db = createDb(c.env.DB);
  await db.insert(schema.agencies).values({ id, ...data, createdAt: now, updatedAt: now });
  await audit(c.env, c.get("user"), "agency.create", "agency", id, data);
  return c.json(await db.select().from(schema.agencies).where(eq(schema.agencies.id, id)).get(), 201);
}));

adminRoutes.patch("/admin/agencies/:id", terminalRoute("/admin/agencies/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid agency id" }, 400);
  const data = await jsonInput(c, agencyPatch); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); if (!await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, id)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.update(schema.agencies).set({ ...data, updatedAt: new Date() }).where(eq(schema.agencies.id, id));
  await audit(c.env, c.get("user"), "agency.update", "agency", id, data);
  return c.json(await db.select().from(schema.agencies).where(eq(schema.agencies.id, id)).get());
}));

adminRoutes.get("/admin/agents", terminalRoute("/admin/agents", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = z.object({ agencyId: optionalQuery(z.string().uuid()) }).safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const db = createDb(c.env.DB); const rows = db.select({ id: schema.agents.id, agencyId: schema.agents.agencyId, agencyName: schema.agencies.name, name: schema.agents.name, email: schema.agents.email, phone: schema.agents.phone, createdAt: schema.agents.createdAt, updatedAt: schema.agents.updatedAt }).from(schema.agents).leftJoin(schema.agencies, eq(schema.agents.agencyId, schema.agencies.id));
  return c.json({ agents: await (parsed.data.agencyId ? rows.where(eq(schema.agents.agencyId, parsed.data.agencyId)) : rows).orderBy(asc(schema.agents.name)).all() });
}));

adminRoutes.post("/admin/agents", terminalRoute("/admin/agents", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const data = await jsonInput(c, agentFields); if (data instanceof Response) return data;
  const id = newId(); const now = new Date(); const db = createDb(c.env.DB);
  if (data.agencyId && !await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, data.agencyId)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.insert(schema.agents).values({ id, ...data, createdAt: now, updatedAt: now });
  await audit(c.env, c.get("user"), "agent.create", "agent", id, data);
  return c.json(await db.select().from(schema.agents).where(eq(schema.agents.id, id)).get(), 201);
}));

adminRoutes.patch("/admin/agents/:id", terminalRoute("/admin/agents/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid agent id" }, 400);
  const data = await jsonInput(c, agentPatch); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); if (!await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, id)).get()) return c.json({ error: "Agent not found" }, 404);
  if (data.agencyId && !await db.select({ id: schema.agencies.id }).from(schema.agencies).where(eq(schema.agencies.id, data.agencyId)).get()) return c.json({ error: "Agency not found" }, 404);
  await db.update(schema.agents).set({ ...data, updatedAt: new Date() }).where(eq(schema.agents.id, id));
  await audit(c.env, c.get("user"), "agent.update", "agent", id, data);
  return c.json(await db.select().from(schema.agents).where(eq(schema.agents.id, id)).get());
}));

adminRoutes.get("/admin/stages", terminalRoute("/admin/stages", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  return c.json({ stages: await listPipelineStages(createDb(c.env.DB)) });
}));

adminRoutes.patch("/admin/stages/:key", terminalRoute("/admin/stages/:key", async (c) => {
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
  await audit(c.env, c.get("user"), "pipeline_stage.update", "pipeline_stage", key, data);
  return c.json(await db.select().from(schema.pipelineStages).where(eq(schema.pipelineStages.key, key)).get());
}));

adminRoutes.get("/admin/webhook-events", terminalRoute("/admin/webhook-events", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const parsed = eventsQuery.safeParse(c.req.query()); if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const query = parsed.data; const filters = [eq(schema.webhookEvents.source, query.source ?? "tonomo")]; if (query.status) filters.push(eq(schema.webhookEvents.status, query.status));
  const db = createDb(c.env.DB); const where = and(...filters);
  const [events, count] = await Promise.all([
    db.select({ id: schema.webhookEvents.id, eventId: schema.webhookEvents.eventId, status: schema.webhookEvents.status, error: schema.webhookEvents.error, receivedAt: schema.webhookEvents.receivedAt, processedAt: schema.webhookEvents.processedAt, payloadJson: schema.webhookEvents.payloadJson }).from(schema.webhookEvents).where(where).orderBy(desc(schema.webhookEvents.receivedAt)).limit(query.limit ?? 30).offset(query.offset ?? 0).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.webhookEvents).where(where).get(),
  ]);
  return c.json({ events: events.map(({ payloadJson, ...event }) => ({ ...event, summary: summary(payloadJson) })), total: count?.count ?? 0 });
}));

adminRoutes.get("/admin/webhook-events/:id", terminalRoute("/admin/webhook-events/:id", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const event = await createDb(c.env.DB).select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  return event ? c.json({ event }) : c.json({ error: "Webhook event not found" }, 404);
}));

adminRoutes.post("/admin/webhook-events/:id/retry", terminalRoute("/admin/webhook-events/:id/retry", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const db = createDb(c.env.DB); const event = await db.select({ id: schema.webhookEvents.id }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  if (!event) return c.json({ error: "Webhook event not found" }, 404);
  const result = await db.update(schema.webhookEvents).set({ status: "received", error: null, processedAt: null }).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"), eq(schema.webhookEvents.status, "poison"))).run();
  if (result.meta.changes === 0) return c.json({ error: "Event is no longer poison" }, 409);
  await audit(c.env, c.get("user"), "tonomo_event.retry", "webhook_event", id);
  c.executionCtx.waitUntil(c.env.BACKGROUND.processTonomoEvents().catch((error) => {
    console.error("Tonomo webhook handoff failed", error);
  }));
  return c.json({ ok: true });
}));

adminRoutes.post("/admin/webhook-events/:id/discard", terminalRoute("/admin/webhook-events/:id/discard", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid webhook event id" }, 400);
  const db = createDb(c.env.DB); const event = await db.select({ error: schema.webhookEvents.error }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"))).get();
  if (!event) return c.json({ error: "Webhook event not found" }, 404);
  const result = await db.update(schema.webhookEvents).set({ status: "processed", error: `${event.error ?? "Unknown error"} — discarded by operator`, processedAt: new Date() }).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.source, "tonomo"), eq(schema.webhookEvents.status, "poison"))).run();
  if (result.meta.changes === 0) return c.json({ error: "Event is no longer poison" }, 409);
  await audit(c.env, c.get("user"), "tonomo_event.discard", "webhook_event", id, { error: event.error });
  return c.json({ ok: true });
}));

adminRoutes.get("/admin/tonomo-health", terminalRoute("/admin/tonomo-health", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const db = createDb(c.env.DB); const [latest, rows] = await Promise.all([
    db.select({ receivedAt: schema.webhookEvents.receivedAt }).from(schema.webhookEvents).where(eq(schema.webhookEvents.source, "tonomo")).orderBy(desc(schema.webhookEvents.receivedAt)).limit(1).get(),
    db.select({ status: schema.webhookEvents.status, count: sql<number>`count(*)` }).from(schema.webhookEvents).where(eq(schema.webhookEvents.source, "tonomo")).groupBy(schema.webhookEvents.status).all(),
  ]);
  const counts = { received: 0, processed: 0, poison: 0 }; for (const row of rows) counts[row.status] = row.count;
  return c.json({ tonomo: { lastEventAt: latest?.receivedAt ?? null, counts, poisonCount: counts.poison } });
}));
