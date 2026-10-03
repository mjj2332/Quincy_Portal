import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { AppEnv } from "../env";
import { auditMeta } from "../lib/audit";
import { jsonInput } from "./helpers";
import { z } from "zod";
import { DEFAULT_EMAIL_DIGEST_CADENCE, EMAIL_DIGEST_CADENCES } from "@quincy/shared";

// Any one preference alone, or several: the Settings screen sends one row at a time. An empty body changes nothing, so it is refused.
const patchSchema = z.object({
  projectDeadlineReminderEmails: z.boolean().optional(),
  subtaskReminderEmails: z.boolean().optional(),
  emailDigestCadence: z.enum(EMAIL_DIGEST_CADENCES).optional(),
}).strict()
  .refine((value) => value.projectDeadlineReminderEmails !== undefined || value.subtaskReminderEmails !== undefined || value.emailDigestCadence !== undefined, { message: "Send at least one preference." });
export const notificationPreferencesRoutes = new Hono<AppEnv>();

async function readPreference(c: Context<AppEnv>) {
  const row = await createDb(c.env.DB).select({ deadline: schema.notificationPreferences.projectDeadlineReminderEmails, subtask: schema.notificationPreferences.subtaskReminderEmails, cadence: schema.notificationPreferences.emailDigestCadence })
    .from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, c.get("user").id)).get();
  // SQLite stores this boolean as an INTEGER, and Drizzle's integer column deliberately
  // exposes that storage value. Keep the HTTP contract JSON-boolean-shaped at the route edge.
  return c.json({
    projectDeadlineReminderEmails: row?.deadline === undefined ? true : Boolean(row.deadline),
    subtaskReminderEmails: row?.subtask === undefined ? true : Boolean(row.subtask),
    emailDigestCadence: row?.cadence ?? DEFAULT_EMAIL_DIGEST_CADENCE,
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
  const cadence = data.emailDigestCadence ?? null;
  const changes = {
    ...(deadline === null ? {} : { projectDeadlineReminderEmails: data.projectDeadlineReminderEmails }),
    ...(subtask === null ? {} : { subtaskReminderEmails: data.subtaskReminderEmails }),
    ...(cadence === null ? {} : { emailDigestCadence: cadence }),
  };
  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, subtask_reminder_emails, email_digest_cadence, updated_at)
      VALUES (?, COALESCE(?, 1), COALESCE(?, 1), COALESCE(?, 'twice_daily'), ?)
      ON CONFLICT(user_id) DO UPDATE SET
        project_deadline_reminder_emails = COALESCE(?, project_deadline_reminder_emails),
        subtask_reminder_emails = COALESCE(?, subtask_reminder_emails),
        email_digest_cadence = COALESCE(?, email_digest_cadence),
        updated_at = excluded.updated_at
    `).bind(user.id, deadline, subtask, cadence, now, deadline, subtask, cadence),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'notification.preference.update', 'notification_preference', ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, user.id, auditMeta(user, changes), now),
  ]);
  return readPreference(c);
}));
