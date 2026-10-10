import { and, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_EMAIL_DIGEST_CADENCE, isDigestExemptType, isEmailDigestCadence, type EmailDigestCadence, type NotificationType } from "@quincy/shared";
import type { Database } from "./index";
import * as schema from "./schema";

export type { NotificationType } from "@quincy/shared";

export const EMAIL_ENABLED_EVENTS: readonly NotificationType[] = [
  "raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added", "assigned_to_project", "mentioned", "subtask_assigned", "subtask_due_today",
];
export const STALLED_NOTIFICATION_AGE_MS = 3 * 60 * 60 * 1000;
export const READ_NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type NotificationRecipient = { userId: string; email: string; name: string };
export type NotificationEmail = {
  send(message: { from: string; to: string; subject: string; text: string; html?: string }): Promise<{ messageId: string }>;
};

export type NotificationCopy = { title: string; body: string };

/** Shared copy deliberately hides the implementation vendor from every staff recipient. */
export function notificationCopy(
  type: NotificationType,
  projectLabel = "Project",
  assignmentRole?: "photographer" | "editor",
): NotificationCopy {
  switch (type) {
    case "raw_ready": return { title: "RAW ready for review", body: `${projectLabel} has RAW images ready for review.` };
    case "edited_landed": return { title: "Edited images ready for review", body: `${projectLabel} has edited images ready for review.` };
    case "sent_to_editing": return { title: "Moved to editing", body: `${projectLabel} has moved to editing.` };
    case "autohdr_stalled": return { title: "Editing round taking longer than expected", body: `${projectLabel} has an editing round that may need attention.` };
    case "delivered": return { title: "Project delivered", body: `${projectLabel} has been marked delivered.` };
    case "comment_added": return { title: "New review feedback", body: `${projectLabel} has new review feedback.` };
    case "assigned_to_project": return assignmentRole
      ? { title: "Assigned to project", body: `You have been assigned as the ${assignmentRole} for ${projectLabel}.` }
      : { title: "Assigned to project", body: `You have been assigned to ${projectLabel}.` };
    case "mentioned": return { title: "You were mentioned", body: "You were mentioned." };
    case "subtask_assigned": return { title: "Subtask assigned", body: `You have been assigned a subtask in ${projectLabel}.` };
    case "subtask_due_today": return { title: "Subtask due today", body: `A subtask assigned to you in ${projectLabel} is due today.` };
    case "subtask_reminder": return { title: "Subtask reminder", body: `A subtask assigned to you in ${projectLabel} is due.` };
    case "project_deadline_reminder": return { title: "Project deadline reminder", body: `${projectLabel} has a deadline reminder.` };
    case "project_activity": return { title: "Project activity", body: `${projectLabel} has a project update.` };
    case "project_collaboration_activity": return { title: "Project collaboration activity", body: `${projectLabel} has a collaboration update.` };
    // #741 15a: these four exist only on the outbox path, whose resolver composes the title (naming the Video, Version and actor); this is the neutral form.
    case "video_version_uploaded":
    case "video_note":
    case "video_reply":
    case "video_decision": return { title: "Video review update", body: `${projectLabel} has a video review update.` };
  }
}

export async function projectNotificationRecipients(
  db: Database,
  projectId: string,
  options: { editorOnly?: boolean; excludeUserId?: string } = {},
): Promise<NotificationRecipient[]> {
  const memberRows = await db.selectDistinct({
    userId: schema.user.id,
    email: schema.user.email,
    name: schema.user.name,
  }).from(schema.projectMembers)
    .innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id))
    .where(and(
      eq(schema.projectMembers.projectId, projectId),
      eq(schema.user.active, true),
      sql`${schema.user.role} <> 'external_editor'`,
      options.editorOnly ? eq(schema.projectMembers.roleOnProject, "editor") : undefined,
    )).all();
  const adminRows = await db.select({
    userId: schema.user.id,
    email: schema.user.email,
    name: schema.user.name,
  }).from(schema.user).where(and(eq(schema.user.role, "admin"), eq(schema.user.active, true))).all();
  return [...new Map([...memberRows, ...adminRows].map((row) => [row.userId, row])).values()]
    .filter((row) => row.userId !== options.excludeUserId);
}

export type EmitNotificationInput = {
  projectId?: string;
  type: NotificationType;
  recipients: NotificationRecipient[];
  title?: string;
  body?: string;
  sourceKey?: string;
  link?: string;
  mentionEmail?:
    | {
        scope: "project-comment";
        authorName: string;
        projectLabel: string;
        excerpt: string;
      }
    | {
        scope: "notice-board";
        authorName: string;
        excerpt: string;
      };
  email?: NotificationEmail;
  fromAddress?: string;
  /**
   * When set, each recipient's row is inserted only while `project_subtask_assignees` STILL holds
   * them on this Subtask at their captured assignment version, checked inside the insert itself.
   * A recipient removed after the caller resolved its recipients (e.g. while an earlier
   * recipient's email was in flight) gets neither the row nor the email. Requires `sourceKey`.
   */
  requireSubtaskAssignee?: { subtaskId: string; versions: Readonly<Record<string, number>> };
};

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]!);
}

function formatMentionEmail(mentionEmail: NonNullable<EmitNotificationInput["mentionEmail"]>, link?: string): { text: string; html: string } {
  const htmlExcerpt = escapeHtml(mentionEmail.excerpt).replace(/\n/g, "<br />");
  if (mentionEmail.scope === "project-comment") {
    const text = `${mentionEmail.authorName} commented on ${mentionEmail.projectLabel}:\n\n“${mentionEmail.excerpt}”`;
    const html = `<p>${escapeHtml(mentionEmail.authorName)} commented on ${escapeHtml(mentionEmail.projectLabel)}:</p><p>“${htmlExcerpt}”</p>`;
    return link
      ? { text: `${text}\n\n${link}`, html: `${html}<p><a href="${escapeHtml(link)}">View project</a></p>` }
      : { text, html };
  }
  const text = `${mentionEmail.authorName} mentioned you in a notice-board post:\n\n“${mentionEmail.excerpt}”`;
  const html = `<p>${escapeHtml(mentionEmail.authorName)} mentioned you in a notice-board post:</p><p>“${htmlExcerpt}”</p>`;
  return { text, html };
}

/** Inserts one row per distinct recipient and best-effort sends enabled email events. */
export async function emitNotifications(
  db: Database,
  input: EmitNotificationInput,
): Promise<number> {
  // Deadline reminders are durable occurrence events owned by the background outbox
  // consumer. Keeping the legacy emitter fail-closed prevents a future generic caller from
  // creating a second producer or bypassing membership-cycle authorization.
  if (input.type === "project_deadline_reminder") return 0;
  // #141: same rule for a staff subtask assignment. Its only producer is
  // `emitStaffSubtaskAssignedNotification` (the outbox carries the assigner as actor); a direct
  // row here would be a second producer, and a second email once the consumer delivers.
  if (input.type === "subtask_assigned") return 0;
  // #424: a Subtask reminder is a durable occurrence event owned by the background scan and the outbox consumer, so the same rule applies.
  if (input.type === "subtask_reminder") return 0;
  const copy = input.title && input.body ? { title: input.title, body: input.body } : notificationCopy(input.type);
  const recipients = [...new Map(input.recipients.map((recipient) => [recipient.userId, recipient])).values()];
  // This is the security choke point for all legacy direct emitters. Do not rely on each of the
  // six current callers to remember the role boundary, and do not send an email before this
  // reload. The same read carries each recipient's digest cadence (#489): there is deliberately no
  // fallback for a missing `select`, so a recipient whose cadence cannot be read is never silently
  // treated as Immediately.
  const currentRoles = await db.select({
    id: schema.user.id,
    role: schema.user.role,
    cadence: sql<string>`coalesce(${schema.notificationPreferences.emailDigestCadence}, ${DEFAULT_EMAIL_DIGEST_CADENCE})`,
  }).from(schema.user)
    .leftJoin(schema.notificationPreferences, eq(schema.notificationPreferences.userId, schema.user.id))
    .where(inArray(schema.user.id, recipients.map((recipient) => recipient.userId))).all();
  const externalIds = new Set(currentRoles.filter((row) => row.role === "external_editor").map((row) => row.id));
  const cadenceByUser = new Map<string, EmailDigestCadence>(currentRoles.map((row) => [row.id, isEmailDigestCadence(row.cadence) ? row.cadence : DEFAULT_EMAIL_DIGEST_CADENCE]));
  let insertedCount = 0;
  for (const recipient of recipients) {
    if (externalIds.has(recipient.userId)) continue;
    const values = {
      id: crypto.randomUUID(),
      userId: recipient.userId,
      projectId: input.projectId ?? null,
      type: input.type,
      title: copy.title,
      body: copy.body,
      sourceKey: input.sourceKey ?? null,
      createdAt: new Date(),
    };
    // #489: a non-exempt email for a recipient who is not on Immediately waits for their Email digest.
    // The notification row and its digest item are written in ONE batch, so a crash can never leave
    // a notification whose email is neither sent nor pending.
    const emailEligible = EMAIL_ENABLED_EVENTS.includes(input.type) && Boolean(input.email) && Boolean(input.fromAddress);
    const deferToDigest = emailEligible && !isDigestExemptType(input.type) && (cadenceByUser.get(recipient.userId) ?? DEFAULT_EMAIL_DIGEST_CADENCE) !== "immediate";
    let didInsert: boolean;
    if (input.sourceKey || deferToDigest) {
      // drizzle-orm's onConflictDoNothing({ target, where }) places `where` after
      // `DO NOTHING`, but SQLite requires a partial unique index's predicate *before*
      // DO NOTHING (as part of the conflict target itself) — the builder-generated SQL is
      // a syntax error against real D1. Raw SQL sidesteps the builder for just this
      // statement, matching this repo's existing raw-driver pattern when
      // drizzle/D1 can't express something correctly.
      const guard = input.requireSubtaskAssignee;
      const guardedVersion = guard ? guard.versions[recipient.userId] : undefined;
      if (guard && guardedVersion === undefined) continue;
      const conflict = input.sourceKey ? "on conflict (type, source_key, user_id) where source_key is not null do nothing" : "";
      const createdAtMs = values.createdAt.getTime();
      const row = [values.id, values.userId, values.projectId, values.type, values.title, values.body, values.sourceKey, createdAtMs];
      if (deferToDigest) {
        // Raw D1 batch (drizzle's D1 batch cannot carry raw SQL): D1 runs the statements in one
        // transaction, and `changes()` in the second statement reads the first one's result.
        const insertNotification = guard
          ? db.$client.prepare(`
              insert into notifications (id, user_id, project_id, type, title, body, source_key, created_at)
              select ?, ?, ?, ?, ?, ?, ?, ?
              where exists (
                select 1 from project_subtask_assignees a
                where a.subtask_id = ? and a.user_id = ? and a.assignment_version = ?
              )
              ${conflict}
            `).bind(...row, guard.subtaskId, values.userId, guardedVersion)
          : db.$client.prepare(`
              insert into notifications (id, user_id, project_id, type, title, body, source_key, created_at)
              values (?, ?, ?, ?, ?, ?, ?, ?)
              ${conflict}
            `).bind(...row);
        const insertItem = db.$client.prepare(`
          insert into notification_digest_items (id, recipient_id, notification_id, project_id, notification_type, state, created_at, updated_at)
          select ?, ?, ?, ?, ?, 'pending', ?, ?
          where changes() = 1
          on conflict (notification_id) do nothing
        `).bind(crypto.randomUUID(), values.userId, values.id, values.projectId, values.type, createdAtMs, createdAtMs);
        const [result] = await db.$client.batch([insertNotification, insertItem]);
        didInsert = (result?.meta?.changes ?? 0) === 1;
        if (didInsert) insertedCount += 1;
        continue;
      }
      const result = guard
        ? await db.run(sql`
          insert into notifications (id, user_id, project_id, type, title, body, source_key, created_at)
          select ${values.id}, ${values.userId}, ${values.projectId}, ${values.type}, ${values.title}, ${values.body}, ${values.sourceKey}, ${createdAtMs}
          where exists (
            select 1 from project_subtask_assignees a
            where a.subtask_id = ${guard.subtaskId} and a.user_id = ${values.userId} and a.assignment_version = ${guardedVersion}
          )
          on conflict (type, source_key, user_id) where source_key is not null do nothing
        `)
        : await db.run(sql`
        insert into notifications (id, user_id, project_id, type, title, body, source_key, created_at)
        values (${values.id}, ${values.userId}, ${values.projectId}, ${values.type}, ${values.title}, ${values.body}, ${values.sourceKey}, ${createdAtMs})
        on conflict (type, source_key, user_id) where source_key is not null do nothing
      `);
      didInsert = (result.meta?.changes ?? 0) === 1;
    } else {
      await db.insert(schema.notifications).values(values);
      didInsert = true;
    }
    if (!didInsert) continue;
    const inserted = { id: values.id };
    insertedCount += 1;
    if (!EMAIL_ENABLED_EVENTS.includes(input.type) || !input.email || !input.fromAddress) continue;
    try {
      const emailContent = input.mentionEmail
        ? formatMentionEmail(input.mentionEmail, input.link)
        : {
            text: input.link ? `${copy.body}\n\n${input.link}` : copy.body,
            html: input.link ? `<p>${copy.body}</p><p><a href="${input.link}">View project</a></p>` : `<p>${copy.body}</p>`,
          };
      const result = await input.email.send({
        from: input.fromAddress,
        to: recipient.email,
        subject: copy.title,
        ...emailContent,
      });
      await db.update(schema.notifications).set({ emailSentAt: new Date(), emailMessageId: result.messageId }).where(eq(schema.notifications.id, inserted.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(schema.notifications).set({ emailError: message.slice(0, 2_000) }).where(eq(schema.notifications.id, inserted.id));
    }
  }
  return insertedCount;
}

export async function pruneReadNotifications(d1: D1Database, now = Date.now()): Promise<number> {
  const result = await d1.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?")
    .bind(now - READ_NOTIFICATION_RETENTION_MS).run();
  return result.meta.changes ?? 0;
}
