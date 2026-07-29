import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./index";
import * as schema from "./schema";

export type NotificationType =
  | "raw_ready"
  | "edited_landed"
  | "sent_to_editing"
  | "autohdr_stalled"
  | "delivered"
  | "comment_added"
  | "assigned_to_project";

export const EMAIL_ENABLED_EVENTS: readonly NotificationType[] = [
  "raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added", "assigned_to_project",
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
  email?: NotificationEmail;
  fromAddress?: string;
};

/** Inserts one row per distinct recipient and best-effort sends enabled email events. */
export async function emitNotifications(
  db: Database,
  input: EmitNotificationInput,
): Promise<number> {
  const copy = input.title && input.body ? { title: input.title, body: input.body } : notificationCopy(input.type);
  const recipients = [...new Map(input.recipients.map((recipient) => [recipient.userId, recipient])).values()];
  let insertedCount = 0;
  for (const recipient of recipients) {
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
    let didInsert: boolean;
    if (input.sourceKey) {
      // drizzle-orm's onConflictDoNothing({ target, where }) places `where` after
      // `DO NOTHING`, but SQLite requires a partial unique index's predicate *before*
      // DO NOTHING (as part of the conflict target itself) — the builder-generated SQL is
      // a syntax error against real D1. Raw SQL sidesteps the builder for just this
      // statement, matching this repo's existing pattern (guardedStageTransition,
      // pruneReadNotifications in this same module) of dropping to the raw driver when
      // drizzle/D1 can't express something correctly.
      const result = await db.run(sql`
        insert into notifications (id, user_id, project_id, type, title, body, source_key, created_at)
        values (${values.id}, ${values.userId}, ${values.projectId}, ${values.type}, ${values.title}, ${values.body}, ${values.sourceKey}, ${values.createdAt.getTime()})
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
      const result = await input.email.send({
        from: input.fromAddress,
        to: recipient.email,
        subject: copy.title,
        text: copy.body,
        html: `<p>${copy.body}</p>`,
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
