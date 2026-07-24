import type { DropboxEntry, DropboxFolderPage } from "./client";
import { pathEqualsOrIsBelow } from "./paths";

export type DropboxProjectPath = { id: string; rawFolderPath: string | null };

export function changedProjectIds(
  entries: DropboxEntry[],
  projectPaths: readonly DropboxProjectPath[],
  watchedRoot: string,
): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry[".tag"] === "deleted" || !pathEqualsOrIsBelow(entry.path_lower, watchedRoot)) continue;
    for (const project of projectPaths) {
      if (!project.rawFolderPath) continue;
      if (!pathEqualsOrIsBelow(project.rawFolderPath, watchedRoot)) continue;
      if (pathEqualsOrIsBelow(entry.path_lower, project.rawFolderPath)) ids.add(project.id);
    }
  }
  return [...ids];
}

/**
 * Completes one Dropbox delta page. The cursor is the commit point: until every affected
 * project has synced and the next alarm state is durable, a retry must fetch this page again.
 */
export async function completeDropboxDeltaPage(
  page: DropboxFolderPage,
  projectPaths: readonly DropboxProjectPath[],
  dependencies: {
    watchedRoot: string;
    syncProject: (projectId: string) => Promise<void>;
    setAlarm: () => Promise<void>;
    clearAlarm: () => Promise<void>;
    persistCursor: (cursor: string) => Promise<void>;
  },
): Promise<void> {
  for (const projectId of changedProjectIds(page.entries, projectPaths, dependencies.watchedRoot)) {
    await dependencies.syncProject(projectId);
  }
  if (page.has_more) await dependencies.setAlarm();
  else await dependencies.clearAlarm();
  await dependencies.persistCursor(page.cursor);
}
