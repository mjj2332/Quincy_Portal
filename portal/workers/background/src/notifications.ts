import {
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  pruneReadNotifications,
  STALLED_NOTIFICATION_AGE_MS,
  type NotificationType,
} from "@quincy/db";
import { projects } from "@quincy/db/schema";
import { eq } from "drizzle-orm";
import type { Env } from "./env";
import { dbFor } from "./lib/db";

export async function notifyProject(
  env: Env,
  projectId: string,
  type: NotificationType,
  options: { sourceKey?: string } = {},
): Promise<void> {
  try {
    const db = dbFor(env);
    const [project, recipients] = await Promise.all([
      db.select({ street: projects.street }).from(projects).where(eq(projects.id, projectId)).get(),
      projectNotificationRecipients(db, projectId),
    ]);
    const copy = notificationCopy(type, project?.street || "Project");
    await emitNotifications(db, {
      projectId,
      type,
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: options.sourceKey,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
  } catch (error) {
    console.error("Background notification emission failed", { projectId, type, error });
  }
}

export async function scanStalledAutoHdr(env: Env, now = Date.now()): Promise<number> {
  const db = dbFor(env);
  const cutoff = now - STALLED_NOTIFICATION_AGE_MS;
  const rows = await env.DB.prepare(
    "SELECT h.id AS handoffId, h.project_id AS projectId " +
    "FROM autohdr_handoffs h " +
    "INNER JOIN autohdr_output_mappings m ON m.handoff_id = h.id " +
    "INNER JOIN projects p ON p.id = h.project_id " +
    "WHERE h.state = 'started' AND m.state = 'pending_discovery' " +
    "AND h.started_at IS NOT NULL AND h.started_at < ? AND p.archived_at IS NULL",
  ).bind(cutoff).all<{ handoffId: string; projectId: string }>();
  let emitted = 0;
  for (const row of rows.results) {
    const recipients = await projectNotificationRecipients(db, row.projectId);
    const project = await db.select({ street: projects.street }).from(projects).where(eq(projects.id, row.projectId)).get();
    const copy = notificationCopy("autohdr_stalled", project?.street || "Project");
    emitted += await emitNotifications(db, {
      projectId: row.projectId,
      type: "autohdr_stalled",
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: row.handoffId,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
  }
  return emitted;
}

export async function pruneNotifications(env: Env, now = Date.now()): Promise<void> {
  try {
    const deleted = await pruneReadNotifications(env.DB, now);
    if (deleted) console.log("Pruned read notifications", { deleted });
  } catch (error) {
    console.error("Notification retention cleanup failed", { error });
  }
}
