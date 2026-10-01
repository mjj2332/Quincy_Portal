import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { auditMeta } from "../lib/audit";
import { jsonInput } from "./helpers";
import { z } from "zod";

// Either switch alone, or both: the Settings screen sends one row at a time. An empty body changes nothing, so it is refused.
const patchSchema = z.object({ projectDeadlineReminderEmails: z.boolean().optional(), subtaskReminderEmails: z.boolean().optional() }).strict()
  .refine((value) => value.projectDeadlineReminderEmails !== undefined || value.subtaskReminderEmails !== undefined, { message: "Send at least one preference." });
export const notificationPreferencesRoutes = new Hono<AppEnv>();

async function readPreference(c: Context<AppEnv>) {
  const row = await createDb(c.env.DB).select({ deadline: schema.notificationPreferences.projectDeadlineReminderEmails, subtask: schema.notificationPreferences.subtaskReminderEmails })
    .from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, c.get("user").id)).get();
  // SQLite stores this boolean as an INTEGER, and Drizzle's integer column deliberately
  // exposes that storage value. Keep the HTTP contract JSON-boolean-shaped at the route edge.
  return c.json({
    projectDeadlineReminderEmails: row?.deadline === undefined ? true : Boolean(row.deadline),
    subtaskReminderEmails: row?.subtask === undefined ? true : Boolean(row.subtask),
  });
}

notificationPreferencesRoutes.get("/notification-preferences", terminalRoute("/notification-preferences", readPreference));

notificationPreferencesRoutes.patch("/notification-preferences", terminalRoute("/notification-preferences", async (c) => {
  const data = await jsonInput(c, patchSchema);
  if (data instanceof Response) return data;
  const user = c.get("user");
  const now = Date.now();
  // An absent switch keeps its stored value (a new row takes the column default of on), so one PATCH never resets the other row.
  const deadline = data.projectDeadlineReminderEmails === undefined ? null : data.projectDeadlineReminderEmails ? 1 : 0;
  const subtask = data.subtaskReminderEmails === undefined ? null : data.subtaskReminderEmails ? 1 : 0;
  const changes = { ...(deadline === null ? {} : { projectDeadlineReminderEmails: data.projectDeadlineReminderEmails }), ...(subtask === null ? {} : { subtaskReminderEmails: data.subtaskReminderEmails }) };
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, subtask_reminder_emails, updated_at)
      VALUES (?, COALESCE(?, 1), COALESCE(?, 1), ?)
      ON CONFLICT(user_id) DO UPDATE SET
        project_deadline_reminder_emails = COALESCE(?, project_deadline_reminder_emails),
        subtask_reminder_emails = COALESCE(?, subtask_reminder_emails),
        updated_at = excluded.updated_at
    `).bind(user.id, deadline, subtask, now, deadline, subtask),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'notification.preference.update', 'notification_preference', ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, user.id, auditMeta(user, changes), now),
  ]);
  return readPreference(c);
}));
