import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { externalNotificationListResponseSchema, staffNotificationListResponseSchema } from "@quincy/shared";
import { externalVisibleNotificationCte } from "../lib/external-notification-visibility";
import { notificationProjectContext } from "../lib/notification-project-context";
import { notificationEnrichment } from "../lib/notification-enrichment";
import { coverMaps, effectiveCoverAssetId } from "../lib/project-covers";

const MAX_LIMIT = 50;

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get("/notifications", terminalRoute("/notifications", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 25;
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? new Date(cursorValue) : null;
  if (cursorValue && (!cursor || Number.isNaN(cursor.valueOf()))) return c.json({ error: "Invalid cursor" }, 400);
  const userId = c.get("user").id;
  const db = createDb(c.env.DB);
  if (c.get("user").role === "external_editor") {
    const visibility = externalVisibleNotificationCte(userId);
    const rows = await c.env.DB.prepare(`${visibility.sql} SELECT n.id, n.project_id AS projectId, n.type, n.title, n.body, n.read_at AS readAt, n.created_at AS createdAt, p.street AS projectStreet FROM notifications n INNER JOIN external_visible_notifications visible ON visible.id = n.id INNER JOIN projects p ON p.id = n.project_id WHERE 1 = 1${cursor ? " AND n.created_at < ?" : ""} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
      .bind(...visibility.bindings, ...(cursor ? [cursor.getTime()] : []), limit).all<{ id: string; projectId: string; type: string; title: string; body: string | null; readAt: number | null; createdAt: number; projectStreet: string }>();
    const unread = await c.env.DB.prepare(`${visibility.sql} SELECT COUNT(*) AS count FROM notifications n INNER JOIN external_visible_notifications visible ON visible.id = n.id WHERE n.read_at IS NULL`).bind(...visibility.bindings).first<{ count: number }>();
    // External editors never see photographer-RAW restrictions; their stored-cover join already
    // requires edited assets to be publish_status 'ready' (see project-covers.ts).
    const maps = await coverMaps(db, [...new Set(rows.results.map((row) => row.projectId))], false);
    return c.json(externalNotificationListResponseSchema.parse({
      notifications: rows.results.map((row) => ({
        ...row,
        readAt: row.readAt === null ? null : new Date(row.readAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString(),
        coverAssetId: effectiveCoverAssetId(maps, row.projectId),
      })),
      unreadCount: Number(unread?.count ?? 0),
    }));
  }
  const conditions = [eq(schema.notifications.userId, userId), cursor ? lt(schema.notifications.createdAt, cursor) : undefined];
  const [rows, unread] = await Promise.all([
    db.select().from(schema.notifications).where(and(...conditions)).orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id)).limit(limit).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt))).get(),
  ]);
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
