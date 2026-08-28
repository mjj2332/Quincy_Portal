import {
  emitExternalSafeLegacyNotification,
  emitExternalSubtaskNotification,
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  pruneReadNotifications,
  STALLED_NOTIFICATION_AGE_MS,
  type NotificationType,
} from "@quincy/db";
import { projects } from "@quincy/db/schema";
import { eq } from "drizzle-orm";
import { PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, projectNotificationRoute, publishNotificationOutbox, staffPathFor } from "@quincy/shared";
import type { Env } from "./env";
import { dbFor } from "./lib/db";

export async function notifyProject(
  env: Env,
  projectId: string,
  type: NotificationType,
  options: { sourceKey?: string; sourceId?: string } = {},
): Promise<void> {
  try {
    const db = dbFor(env);
    const sourceKey = options.sourceKey ?? `legacy:${type}:${projectId}`;
    const sourceId = options.sourceId ?? sourceKey;
    const [project, recipients] = await Promise.all([
      db.select({ street: projects.street }).from(projects).where(eq(projects.id, projectId)).get(),
      projectNotificationRecipients(db, projectId),
    ]);
    const copy = notificationCopy(type, project?.street || "Project");
    const route = projectNotificationRoute(projectId, type);
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    await emitNotifications(db, {
      projectId,
      type,
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: options.sourceKey,
      link,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
    const externalIds = await emitExternalSafeLegacyNotification(env.DB, {
      projectId,
      actorId: PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
      type,
      sourceKey,
      sourceId,
    });
    if (externalIds.length) await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, externalIds);
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

function sydneyDateTime(now: number) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

export type DueSubtaskCandidate = { subtaskId: string; projectId: string; assigneeId: string; assignmentVersion: number; dueDate: string };
export type DueSubtaskCandidateResult = { claimed: boolean; emitted: number };

/** Claims one eligible due subtask before resolving its current assignee or emitting its one-shot alert. */
export async function processDueSubtaskCandidate(
  env: Env,
  row: DueSubtaskCandidate,
  now: number,
  todaySydney: string,
): Promise<DueSubtaskCandidateResult> {
  const claim = await env.DB.prepare(
    "UPDATE project_subtasks SET due_reminder_sent_at = ?, updated_at = ? " +
    "WHERE id = ? AND project_id = ? AND due_reminder_sent_at IS NULL AND done = 0 " +
    "AND due_date = ? AND substr(due_date, 1, 10) <= ? AND assignee_id = ? " +
    "AND assignment_version = ? " +
    "AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_subtasks.project_id AND p.archived_at IS NULL)",
  ).bind(now, now, row.subtaskId, row.projectId, row.dueDate, todaySydney, row.assigneeId, row.assignmentVersion).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    await logDueSubtaskClaimSkip(env, row, todaySydney);
    return { claimed: false, emitted: 0 };
  }

  try {
    const db = dbFor(env);
    const recipients = (await projectNotificationRecipients(db, row.projectId)).filter((recipient) => recipient.userId === row.assigneeId);
    const project = await db.select({ street: projects.street }).from(projects).where(eq(projects.id, row.projectId)).get();
    const copy = notificationCopy("subtask_due_today", project?.street || "Project");
    const route = projectNotificationRoute(row.projectId, "subtask_due_today");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    const emitted = await emitNotifications(db, {
      projectId: row.projectId,
      type: "subtask_due_today",
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: `subtask-due:${row.subtaskId}:${row.dueDate}`,
      link,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
    const externalIds = await emitExternalSubtaskNotification(env.DB, {
      projectId: row.projectId,
      actorId: PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
      assigneeId: row.assigneeId,
      subtaskId: row.subtaskId,
      assignmentVersion: row.assignmentVersion,
      sourceKey: `subtask-due:${row.subtaskId}:${row.dueDate}`,
      kind: "due_today",
      dueDate: row.dueDate,
      claimAt: now,
      now,
    });
    if (externalIds.length) await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, externalIds, now);
    console.log("Claimed due subtask notification", { subtaskId: row.subtaskId, projectId: row.projectId, emitted });
    return { claimed: true, emitted };
  } catch (error) {
    console.error("Due subtask notification emission failed", { subtaskId: row.subtaskId, projectId: row.projectId, error });
    try {
      await env.DB.prepare(
        "UPDATE project_subtasks SET due_reminder_sent_at = NULL, updated_at = ? " +
        "WHERE id = ? AND due_reminder_sent_at = ?",
      ).bind(now, row.subtaskId, now).run();
    } catch (rollbackError) {
      console.error("Due subtask notification claim rollback failed", { subtaskId: row.subtaskId, projectId: row.projectId, rollbackError });
    }
    return { claimed: true, emitted: 0 };
  }
}

export async function scanDueSubtasks(env: Env, now = Date.now()): Promise<number> {
  const { date: todaySydney, hour } = sydneyDateTime(now);
  if (hour !== 8) return 0;
  const rows = await env.DB.prepare(
    "SELECT s.id AS subtaskId, s.project_id AS projectId, s.assignee_id AS assigneeId, s.assignment_version AS assignmentVersion, s.due_date AS dueDate " +
    "FROM project_subtasks s INNER JOIN projects p ON p.id = s.project_id " +
    "WHERE s.done = 0 AND s.due_date IS NOT NULL AND substr(s.due_date, 1, 10) <= ? " +
    "AND s.due_reminder_sent_at IS NULL AND s.assignee_id IS NOT NULL AND p.archived_at IS NULL",
  ).bind(todaySydney).all<DueSubtaskCandidate>();
  let emitted = 0;
  for (const row of rows.results) emitted += (await processDueSubtaskCandidate(env, row, now, todaySydney)).emitted;
  return emitted;
}

async function logDueSubtaskClaimSkip(env: Env, row: DueSubtaskCandidate, todaySydney: string): Promise<void> {
  try {
    const status = await env.DB.prepare(
      "SELECT due_reminder_sent_at AS dueReminderSentAt, " +
      "done = 0 AND due_date IS NOT NULL AND substr(due_date, 1, 10) <= ? AND assignee_id IS NOT NULL " +
      "AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_subtasks.project_id AND p.archived_at IS NULL) AS eligible " +
      "FROM project_subtasks WHERE id = ?",
    ).bind(todaySydney, row.subtaskId).first<{ dueReminderSentAt: number | null; eligible: number }>();
    const reason = status?.dueReminderSentAt != null ? "already_claimed" : status?.eligible === 0 ? "no_longer_eligible" : "concurrently_changed";
    console.log("Skipped due subtask notification claim", { subtaskId: row.subtaskId, projectId: row.projectId, reason });
  } catch (error) {
    console.error("Due subtask notification claim skip diagnostics failed", { subtaskId: row.subtaskId, projectId: row.projectId, error });
  }
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
    const route = projectNotificationRoute(row.projectId, "autohdr_stalled");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    const emitted = await emitNotifications(db, {
      projectId: row.projectId,
      type: "autohdr_stalled",
      recipients,
      title: copy.title,
      body: copy.body,
      sourceKey: row.handoffId,
      link,
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
