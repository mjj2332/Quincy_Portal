import { Hono } from "hono";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";

const MAX_LIMIT = 50;

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.get("/notifications", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 25;
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? new Date(cursorValue) : null;
  if (cursorValue && (!cursor || Number.isNaN(cursor.valueOf()))) return c.json({ error: "Invalid cursor" }, 400);
  const userId = c.get("user").id;
  const db = createDb(c.env.DB);
  const conditions = [eq(schema.notifications.userId, userId), cursor ? lt(schema.notifications.createdAt, cursor) : undefined];
  const [rows, unread] = await Promise.all([
    db.select().from(schema.notifications).where(and(...conditions)).orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id)).limit(limit).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt))).get(),
  ]);
  return c.json({
    notifications: rows.map((row) => ({
      id: row.id, projectId: row.projectId, type: row.type, title: row.title, body: row.body,
      readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    })),
    unreadCount: unread?.count ?? 0,
  });
});

notificationsRoutes.post("/notifications/:id/read", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const result = await createDb(c.env.DB).update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
    .run();
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
  return c.json({ ok: true });
});

notificationsRoutes.delete("/notifications/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const result = await createDb(c.env.DB).delete(schema.notifications)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .run();
  if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Notification not found" }, 404);
  await audit(c.env, userId, "notification.delete", "notification", id);
  return c.json({ ok: true });
});

notificationsRoutes.post("/notifications/read-all", async (c) => {
  const userId = c.get("user").id;
  await createDb(c.env.DB).update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return c.json({ ok: true });
});
