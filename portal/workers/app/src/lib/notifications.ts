import {
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  type NotificationType,
} from "@quincy/db";
import { createDb } from "@quincy/db";
import { projects, user } from "@quincy/db/schema";
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
    await emitNotifications(db, {
      projectId,
      type,
      recipients,
      title: copy.title,
      body: copy.body,
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
        email: env.EMAIL,
        fromAddress: env.NOTIFICATIONS_FROM_ADDRESS,
      });
    }
  } catch (error) {
    console.error("Project assignment notification emission failed", { projectId, error });
  }
}
