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
  const cutoff = now - STALLED_NOTIFICATION_AGE_MS;
  const rows = await env.DB.prepare(
    "SELECT h.id AS handoffId, h.project_id AS projectId " +
    "FROM autohdr_handoffs h " +
    "INNER JOIN autohdr_output_mappings m ON m.handoff_id = h.id " +
    "INNER JOIN projects p ON p.id = h.project_id " +
    "WHERE h.state = 'started' AND m.state = 'pending_discovery' " +
    "AND h.started_at IS NOT NULL AND h.started_at < ? AND p.archived_at IS NULL " +
    "AND h.stalled_notified_at IS NULL",
  ).bind(cutoff).all<{ handoffId: string; projectId: string }>();
  let emitted = 0;
  for (const row of rows.results) {
    emitted += (await processStalledAutoHdrCandidate(env, row, now, cutoff)).emitted;
  }
  return emitted;
}

export type StalledAutoHdrCandidate = { handoffId: string; projectId: string };
export type StalledAutoHdrCandidateResult = { claimed: boolean; emitted: number };

/** Claims one stalled handoff before resolving recipients or emitting its one-shot alert. */
export async function processStalledAutoHdrCandidate(
  env: Env,
  row: StalledAutoHdrCandidate,
  now: number,
  cutoff: number,
): Promise<StalledAutoHdrCandidateResult> {
  const claim = await env.DB.prepare(
    "UPDATE autohdr_handoffs SET stalled_notified_at = ?, updated_at = ? " +
    "WHERE id = ? AND stalled_notified_at IS NULL AND state = 'started' " +
    "AND started_at IS NOT NULL AND started_at < ? " +
    "AND EXISTS (SELECT 1 FROM autohdr_output_mappings m " +
    "WHERE m.handoff_id = autohdr_handoffs.id AND m.state = 'pending_discovery') " +
    "AND EXISTS (SELECT 1 FROM projects p " +
    "WHERE p.id = autohdr_handoffs.project_id AND p.archived_at IS NULL)",
  ).bind(now, now, row.handoffId, cutoff).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    await logStalledAutoHdrClaimSkip(env, row, cutoff);
    return { claimed: false, emitted: 0 };
  }

  try {
    const db = dbFor(env);
    const recipients = await projectNotificationRecipients(db, row.projectId);
    const project = await db.select({ street: projects.street }).from(projects).where(eq(projects.id, row.projectId)).get();
    const copy = notificationCopy("autohdr_stalled", project?.street || "Project");
    const emitted = await emitNotifications(db, {
      projectId: row.projectId,
      type: "autohdr_stalled",
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: row.handoffId,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
    console.log("Claimed stalled AutoHDR notification", { handoffId: row.handoffId, projectId: row.projectId, emitted });
    return { claimed: true, emitted };
  } catch (error) {
    console.error("Stalled AutoHDR notification emission failed", { handoffId: row.handoffId, projectId: row.projectId, error });
    try {
      await env.DB.prepare(
        "UPDATE autohdr_handoffs SET stalled_notified_at = NULL, updated_at = ? " +
        "WHERE id = ? AND stalled_notified_at = ?",
      ).bind(now, row.handoffId, now).run();
    } catch (rollbackError) {
      console.error("Stalled AutoHDR notification claim rollback failed", { handoffId: row.handoffId, projectId: row.projectId, rollbackError });
    }
    return { claimed: true, emitted: 0 };
  }
}

async function logStalledAutoHdrClaimSkip(env: Env, row: StalledAutoHdrCandidate, cutoff: number): Promise<void> {
  try {
    const status = await env.DB.prepare(
      "SELECT h.stalled_notified_at AS stalledNotifiedAt, " +
      "h.state = 'started' AND h.started_at IS NOT NULL AND h.started_at < ? " +
      "AND EXISTS (SELECT 1 FROM autohdr_output_mappings m WHERE m.handoff_id = h.id AND m.state = 'pending_discovery') " +
      "AND EXISTS (SELECT 1 FROM projects p WHERE p.id = h.project_id AND p.archived_at IS NULL) AS eligible " +
      "FROM autohdr_handoffs h WHERE h.id = ?",
    ).bind(cutoff, row.handoffId).first<{ stalledNotifiedAt: number | null; eligible: number }>();
    const reason = status?.stalledNotifiedAt != null
      ? "already_claimed"
      : status?.eligible === 0
        ? "no_longer_eligible"
        : "concurrently_changed";
    console.log("Skipped stalled AutoHDR notification claim", { handoffId: row.handoffId, projectId: row.projectId, reason });
  } catch (error) {
    console.error("Stalled AutoHDR notification claim skip diagnostics failed", { handoffId: row.handoffId, projectId: row.projectId, error });
  }
}

export async function pruneNotifications(env: Env, now = Date.now()): Promise<void> {
  try {
    const deleted = await pruneReadNotifications(env.DB, now);
    if (deleted) console.log("Pruned read notifications", { deleted });
  } catch (error) {
    console.error("Notification retention cleanup failed", { error });
  }
}
