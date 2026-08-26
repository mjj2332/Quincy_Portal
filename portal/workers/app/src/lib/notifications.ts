import {
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  type NotificationType,
} from "@quincy/db";
import { createDb } from "@quincy/db";
import { projects, user } from "@quincy/db/schema";
import { projectNotificationRoute, staffPathFor, truncateForEmail } from "@quincy/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../env";

export async function notifyProject(
  env: AppEnv["Bindings"],
  projectId: string,
  type: NotificationType,
  options: { editorOnly?: boolean; excludeUserId?: string } = {},
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const [project, recipients] = await Promise.all([
      db.select({ street: projects.street }).from(projects).where(eq(projects.id, projectId)).get(),
      projectNotificationRecipients(db, projectId, options),
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
      link,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
  } catch (error) {
    console.error("App notification emission failed", { projectId, type, error });
  }
}

export async function notifyProjectAssignments(
  env: AppEnv["Bindings"],
  projectId: string,
  assignments: Array<{ userId: string; roleOnProject: "photographer" | "editor" }>,
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const userIds = [...new Set(assignments.map((assignment) => assignment.userId))];
    if (!userIds.length) return;
    const [project, activeUsers] = await Promise.all([
      db.select({ street: projects.street }).from(projects).where(eq(projects.id, projectId)).get(),
      db.select({ userId: user.id, email: user.email, name: user.name }).from(user)
        .where(and(inArray(user.id, userIds), eq(user.active, true))).all(),
    ]);
    const activeRecipients = new Map(activeUsers.map((target) => [target.userId, target]));
    const projectLabel = project?.street || "Project";
    const route = projectNotificationRoute(projectId, "assigned_to_project");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    for (const roleOnProject of ["photographer", "editor"] as const) {
      const recipients = assignments
        .filter((assignment) => assignment.roleOnProject === roleOnProject)
        .map((assignment) => activeRecipients.get(assignment.userId))
        .filter((recipient): recipient is { userId: string; email: string; name: string } => Boolean(recipient));
      if (!recipients.length) continue;
      const copy = notificationCopy("assigned_to_project", projectLabel, roleOnProject);
      await emitNotifications(db, {
        projectId,
        type: "assigned_to_project",
        recipients,
        title: copy.title,
        body: copy.body,
        link,
        email: env.EMAIL,
        fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
      });
    }
  } catch (error) {
    console.error("Project assignment notification emission failed", { projectId, error });
  }
}

type MentionMap = { id: string; mentionedUserId: string };

/**
 * Emits direct Notice Board rich-text mention notifications. Project-comment mentions
 * use the transactional notification outbox and must not re-enter this helper.
 */
export async function notifyNoticeBoardMentions(
  env: AppEnv["Bindings"],
  input: { actorId: string; authorName: string; body: string; mentions: MentionMap[] },
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const mentionIds = [...new Set(input.mentions.map((mention) => mention.mentionedUserId).filter((id) => id !== input.actorId))];
    if (!mentionIds.length) return;
    let recipients: Map<string, { userId: string; email: string; name: string }>;
    // Re-check active status at emission time; the map may have been written
    // before a user was deactivated.
    const activeStaff = await db.select({ userId: user.id, email: user.email, name: user.name })
      .from(user).where(and(inArray(user.id, mentionIds), eq(user.active, true))).all();
    recipients = new Map(activeStaff.map((target) => [target.userId, target]));
    const copy = { title: "You were mentioned", body: "You were mentioned in a notice-board post." };
    const excerpt = truncateForEmail(input.body);
    const mentionEmail = { scope: "notice-board" as const, authorName: input.authorName, excerpt };
    const route = projectNotificationRoute(null, "mentioned");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    for (const mention of input.mentions) {
      if (mention.mentionedUserId === input.actorId) continue;
      const recipient = recipients.get(mention.mentionedUserId);
      if (!recipient) continue;
      await emitNotifications(db, {
        type: "mentioned",
        recipients: [recipient],
        title: copy.title,
        body: copy.body,
        sourceKey: mention.id,
        link,
        mentionEmail,
        email: env.EMAIL,
        fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
      });
    }
  } catch (error) {
    console.error("Notice Board mention notification emission failed", { error });
  }
}

/** Defined in Phase 1 with the shared enum; Phase 3 wires its first caller. */
export async function notifySubtaskAssignee(
  env: AppEnv["Bindings"],
  input: { projectId: string; actorId: string; assigneeId: string | null; subtaskId: string; assignmentVersion: number },
): Promise<void> {
  if (!input.assigneeId || input.assigneeId === input.actorId) return;
  try {
    const db = createDb(env.DB);
    // Project recipients includes active current members and active admins, so
    // this is also the required emission-time eligibility re-check.
    const recipient = (await projectNotificationRecipients(db, input.projectId, { excludeUserId: input.actorId }))
      .find((candidate) => candidate.userId === input.assigneeId);
    if (!recipient) return;
    const route = projectNotificationRoute(input.projectId, "subtask_assigned");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    await emitNotifications(db, {
      projectId: input.projectId,
      type: "subtask_assigned",
      recipients: [recipient],
      title: "Subtask assigned",
      body: "You have been assigned a project subtask.",
      sourceKey: `subtask-assignment:${input.subtaskId}:${input.assignmentVersion}`,
      link,
      email: env.EMAIL,
      fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
    });
  } catch (error) {
    console.error("Subtask assignment notification emission failed", { projectId: input.projectId, error });
  }
}
