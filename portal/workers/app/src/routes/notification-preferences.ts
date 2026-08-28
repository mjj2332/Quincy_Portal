import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { auditMeta } from "../lib/audit";
import { jsonInput } from "./helpers";
import { z } from "zod";

const patchSchema = z.object({ projectDeadlineReminderEmails: z.boolean() }).strict();
export const notificationPreferencesRoutes = new Hono<AppEnv>();

async function readPreference(c: Context<AppEnv>) {
  const row = await createDb(c.env.DB).select({ enabled: schema.notificationPreferences.projectDeadlineReminderEmails })
    .from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, c.get("user").id)).get();
  // SQLite stores this boolean as an INTEGER, and Drizzle's integer column deliberately
  // exposes that storage value. Keep the HTTP contract JSON-boolean-shaped at the route edge.
  return c.json({ projectDeadlineReminderEmails: row?.enabled === undefined ? true : Boolean(row.enabled) });
}

notificationPreferencesRoutes.get("/notification-preferences", terminalRoute("/notification-preferences", readPreference));

notificationPreferencesRoutes.patch("/notification-preferences", terminalRoute("/notification-preferences", async (c) => {
  const data = await jsonInput(c, patchSchema);
  if (data instanceof Response) return data;
  const user = c.get("user");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET project_deadline_reminder_emails = excluded.project_deadline_reminder_emails, updated_at = excluded.updated_at
    `).bind(user.id, data.projectDeadlineReminderEmails ? 1 : 0, now),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'notification.preference.update', 'notification_preference', ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, user.id, auditMeta(user, { projectDeadlineReminderEmails: data.projectDeadlineReminderEmails }), now),
  ]);
  return readPreference(c);
}));
