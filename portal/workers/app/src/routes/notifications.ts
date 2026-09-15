import { Hono } from "hono";
import type { Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { decodeNotificationCursor, encodeNotificationCursor, externalNotificationListResponseSchema, staffNotificationListResponseSchema } from "@quincy/shared";
import { externalVisibleNotificationCte } from "../lib/external-notification-visibility";
import { notificationProjectContext } from "../lib/notification-project-context";
import { notificationEnrichment } from "../lib/notification-enrichment";
import { coverMaps, effectiveCoverAssetId } from "../lib/project-covers";

const MAX_LIMIT = 50;

/** Shared boundary-cursor encoder for both list branches: a cursor is a position, never a
 * permission, but if the boundary row itself somehow fails to encode while a further page
 * exists, returning nextCursor:null would be indistinguishable from genuine end-of-list and
 * silently truncate the feed — fail loudly instead. */
function encodeNextCursor(c: Context<AppEnv>, boundary: { createdAt: number; id: string }, branch: "staff" | "external"): string | Response {
  try {
    return encodeNotificationCursor({ createdAt: boundary.createdAt, id: boundary.id });
  } catch {
    console.error("Notification pagination cursor could not be encoded", { event: "notification_pagination_cursor_rejected", branch, rowId: boundary.id });
    return c.json({ error: "Notification pagination is temporarily unavailable" }, 500);
  }
}

/** Splits a `limit + 1` fetch into the page and the row that proves a further page exists. */
function pageOf<T>(fetched: readonly T[], limit: number): { rows: T[]; boundary: T | null } {
  const rows = fetched.slice(0, limit);
  return { rows, boundary: fetched.length > limit ? rows.at(-1)! : null };
}

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get("/notifications", terminalRoute("/notifications", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 25;
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue !== undefined ? decodeNotificationCursor(cursorValue) : null;
  if (cursorValue !== undefined && !cursor) return c.json({ error: "Invalid cursor" }, 400);
  const userId = c.get("user").id;
  const db = createDb(c.env.DB);
  if (c.get("user").role === "external_editor") {
    const visibility = externalVisibleNotificationCte(userId);
    const bindings: unknown[] = [...visibility.bindings];
    let cursorClause = "";
    if (cursor) {
      cursorClause = " AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))";
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    bindings.push(limit + 1);
    const rows = await c.env.DB.prepare(`${visibility.sql} SELECT n.id, n.project_id AS projectId, n.type, n.title, n.body, n.read_at AS readAt, n.created_at AS createdAt, p.street AS projectStreet FROM notifications n INNER JOIN external_visible_notifications visible ON visible.id = n.id INNER JOIN projects p ON p.id = n.project_id WHERE 1 = 1${cursorClause} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
      .bind(...bindings).all<{ id: string; projectId: string; type: string; title: string; body: string | null; readAt: number | null; createdAt: number; projectStreet: string }>();
    const unread = await c.env.DB.prepare(`${visibility.sql} SELECT COUNT(*) AS count FROM notifications n INNER JOIN external_visible_notifications visible ON visible.id = n.id WHERE n.read_at IS NULL`).bind(...visibility.bindings).first<{ count: number }>();
    const { rows: pageRows, boundary } = pageOf(rows.results ?? [], limit);
    let nextCursor: string | null = null;
    if (boundary) {
      const encoded = encodeNextCursor(c, { createdAt: boundary.createdAt, id: boundary.id }, "external");
      if (encoded instanceof Response) return encoded;
      nextCursor = encoded;
    }
    // External editors never see photographer-RAW restrictions; their stored-cover join already
    // requires edited assets to be publish_status 'ready' (see project-covers.ts).
    const maps = await coverMaps(db, [...new Set(pageRows.map((row) => row.projectId))], false);
    return c.json(externalNotificationListResponseSchema.parse({
      notifications: pageRows.map((row) => ({
        ...row,
        readAt: row.readAt === null ? null : new Date(row.readAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString(),
        coverAssetId: effectiveCoverAssetId(maps, row.projectId),
      })),
      unreadCount: Number(unread?.count ?? 0),
      nextCursor,
    }));
  }
  const cursorCondition = cursor
    ? or(lt(schema.notifications.createdAt, new Date(cursor.createdAt)), and(eq(schema.notifications.createdAt, new Date(cursor.createdAt)), lt(schema.notifications.id, cursor.id)))
    : undefined;
  const conditions = [eq(schema.notifications.userId, userId), cursorCondition];
  const [fetchedRows, unread] = await Promise.all([
    db.select().from(schema.notifications).where(and(...conditions)).orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id)).limit(limit + 1).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt))).get(),
  ]);
  const { rows, boundary } = pageOf(fetchedRows, limit);
  let nextCursor: string | null = null;
  if (boundary) {
    const encoded = encodeNextCursor(c, { createdAt: boundary.createdAt.getTime(), id: boundary.id }, "staff");
    if (encoded instanceof Response) return encoded;
    nextCursor = encoded;
  }
  const context = await notificationProjectContext(db, c.get("user"), rows.map((row) => row.projectId));
  const enrichment = await notificationEnrichment(
    db,
    c.get("user"),
    rows.map((row) => ({ id: row.id, type: row.type, projectId: row.projectId, sourceKey: row.sourceKey })),
    new Set(context.keys()),
  );
  return c.json(staffNotificationListResponseSchema.parse({
    notifications: rows.map((row) => {
      const projectContext = row.projectId ? context.get(row.projectId) : undefined;
      const enriched = enrichment.get(row.id);
      return {
        id: row.id, projectId: row.projectId, type: row.type,
        title: enriched?.title ?? row.title,
        body: enriched?.body ?? row.body,
        readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
        projectStreet: projectContext?.street ?? null, coverAssetId: projectContext?.coverAssetId ?? null,
        actor: enriched?.actor ?? null, subject: enriched?.subject ?? null, assetId: enriched?.assetId ?? null,
      };
    }),
    unreadCount: unread?.count ?? 0,
    nextCursor,
  }));
}));

notificationsRoutes.post("/notifications/:id/read", terminalRoute("/notifications/:id/read", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  if (c.get("user").role === "external_editor") {
    const visibility = externalVisibleNotificationCte(userId);
    const result = await c.env.DB.prepare(`${visibility.sql} UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL AND id IN (SELECT id FROM external_visible_notifications)`).bind(...visibility.bindings, new Date().getTime(), id).run();
    if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
    return c.json({ ok: true });
  }
  const result = await createDb(c.env.DB).update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
    .run();
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
  return c.json({ ok: true });
}));

notificationsRoutes.delete("/notifications/:id", terminalRoute("/notifications/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  if (c.get("user").role === "external_editor") {
    const visibility = externalVisibleNotificationCte(userId);
    const result = await c.env.DB.prepare(`${visibility.sql} DELETE FROM notifications WHERE id = ? AND id IN (SELECT id FROM external_visible_notifications)`).bind(...visibility.bindings, id).run();
    if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
    await audit(c.env, c.get("user"), "notification.delete", "notification", id);
    return c.json({ ok: true });
  }
  const result = await createDb(c.env.DB).delete(schema.notifications)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .run();
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
  await audit(c.env, c.get("user"), "notification.delete", "notification", id);
  return c.json({ ok: true });
}));

notificationsRoutes.post("/notifications/read-all", terminalRoute("/notifications/read-all", async (c) => {
  const userId = c.get("user").id;
  if (c.get("user").role === "external_editor") {
    const visibility = externalVisibleNotificationCte(userId);
    await c.env.DB.prepare(`${visibility.sql} UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (SELECT id FROM external_visible_notifications)`).bind(...visibility.bindings, new Date().getTime()).run();
    return c.json({ ok: true });
  }
  await createDb(c.env.DB).update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return c.json({ ok: true });
}));
