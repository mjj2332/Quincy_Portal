import type { AppEnv } from "../env";

/**
 * What a Shoot date change on a Project sets in motion: the Editor folder tree is scaffolded under
 * the new date when Editor automation is enabled. The manual Project PATCH and the Shoot date fill
 * (stage move, Deadline save, direct RAW upload) share this so a filled date behaves exactly like
 * one typed by hand. Best effort: a failure is logged and never fails the durable mutation.
 */
export function editorAutomationEnabled(env: Pick<AppEnv["Bindings"], "DROPBOX_EDITOR_AUTOMATION_ENABLED">): boolean {
  return env.DROPBOX_EDITOR_AUTOMATION_ENABLED === "1" || env.DROPBOX_EDITOR_AUTOMATION_ENABLED === true;
}

export async function queueProjectShootDateFollowUps(env: Pick<AppEnv["Bindings"], "DROPBOX_EDITOR_AUTOMATION_ENABLED" | "BACKGROUND">, projectId: string): Promise<void> {
  if (!editorAutomationEnabled(env)) return;
  try {
    await env.BACKGROUND.ensureEditorFolder(projectId);
  } catch (error) {
    console.error("Editor scaffold trigger failed", { projectId, error });
  }
}
