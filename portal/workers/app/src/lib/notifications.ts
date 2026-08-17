import {
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  type NotificationType,
} from "@quincy/db";
import { createDb } from "@quincy/db";
import { projects, user } from "@quincy/db/schema";
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
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
 * Emits direct rich-text mention notifications. The mapping id is intentionally
 * the source key: a removed and later re-added mention is a new event, while a
 * retry of the same persisted map cannot duplicate a notice or an email.
 */
export async function notifyMentions(
  env: AppEnv["Bindings"],
  input: (
    { scope: "notice-board"; actorId: string; mentions: MentionMap[] }
    | { scope: "project-comment"; actorId: string; projectId: string; mentions: MentionMap[] }
  ),
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const mentionIds = [...new Set(input.mentions.map((mention) => mention.mentionedUserId).filter((id) => id !== input.actorId))];
    if (!mentionIds.length) return;
    let recipients: Map<string, { userId: string; email: string; name: string }>;
    if (input.scope === "notice-board") {
      // Re-check active status at emission time; the map may have been written
      // before a user was deactivated.
      const activeStaff = await db.select({ userId: user.id, email: user.email, name: user.name })
        .from(user).where(and(inArray(user.id, mentionIds), eq(user.active, true))).all();
      recipients = new Map(activeStaff.map((target) => [target.userId, target]));
    } else {
      const activeRecipients = await projectNotificationRecipients(db, input.projectId, { excludeUserId: input.actorId });
      recipients = new Map(activeRecipients.map((target) => [target.userId, target]));
    }
    const copy = input.scope === "notice-board"
      ? { title: "You were mentioned", body: "You were mentioned in a notice-board post." }
      : { title: "You were mentioned", body: "You were mentioned in a project comment." };
    const route = projectNotificationRoute(input.scope === "project-comment" ? input.projectId : null, "mentioned");
    const link = route?.kind === "project" ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
    for (const mention of input.mentions) {
      if (mention.mentionedUserId === input.actorId) continue;
      const recipient = recipients.get(mention.mentionedUserId);
      if (!recipient) continue;
      await emitNotifications(db, {
        ...(input.scope === "project-comment" ? { projectId: input.projectId } : {}),
        type: "mentioned",
        recipients: [recipient],
        title: copy.title,
        body: copy.body,
        sourceKey: mention.id,
        link,
        email: env.EMAIL,
        fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
      });
    }
  } catch (error) {
    console.error("Mention notification emission failed", { scope: input.scope, error });
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
