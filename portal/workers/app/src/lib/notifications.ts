import {
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  type NotificationType,
} from "@quincy/db";
import { createDb } from "@quincy/db";
import { projects } from "@quincy/db/schema";
import { eq } from "drizzle-orm";
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
