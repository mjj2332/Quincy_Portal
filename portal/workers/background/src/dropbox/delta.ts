import type { DropboxEntry, DropboxFolderPage } from "./client";

export type DropboxProjectPath = { id: string; rawFolderPath: string | null };

export function changedProjectIds(
  entries: DropboxEntry[],
  projectPaths: readonly DropboxProjectPath[],
  normalisePath: (path: string) => string,
): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const changedPath = entry.path_lower.toLowerCase();
    for (const project of projectPaths) {
      if (!project.rawFolderPath) continue;
      const folderPath = normalisePath(project.rawFolderPath).toLowerCase();
      if (changedPath === folderPath || changedPath.startsWith(`${folderPath}/`)) ids.add(project.id);
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
    normalisePath: (path: string) => string;
    syncProject: (projectId: string) => Promise<void>;
    setAlarm: () => Promise<void>;
    clearAlarm: () => Promise<void>;
    persistCursor: (cursor: string) => Promise<void>;
  },
): Promise<void> {
  for (const projectId of changedProjectIds(page.entries, projectPaths, dependencies.normalisePath)) {
    await dependencies.syncProject(projectId);
  }
  if (page.has_more) await dependencies.setAlarm();
  else await dependencies.clearAlarm();
  await dependencies.persistCursor(page.cursor);
}
