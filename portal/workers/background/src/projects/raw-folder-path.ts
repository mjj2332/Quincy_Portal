import type { Database } from "@quincy/db";

import type { Env } from "../env";
import { errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { automationFlag } from "../dropbox/monitor-state";
import type { DropboxSyncMessage, DropboxSyncTrigger } from "../messages";

export type RawFolderPathChange = {
  projectId: string;
  /** The raw_folder_path this caller read; the write is fenced on it. */
  previousPath: string | null;
  previousLink: string | null;
  path: string;
  /** Written only when non-null and different from previousLink. */
  link: string | null;
  dropboxFolderId: string;
  actor: "tonomo" | "editor_scaffold";
  orderId?: string | null;
};

/**
 * Guarded write of a verified RAW folder path with its audit row in one D1 batch: the UPDATE is
 * fenced on the raw_folder_path the caller read and on no ready Editor mapping (a mapping can go
 * ready during the Dropbox lookup; once it is ready, RAW intake belongs to the Editor tree), and
 * the audit INSERT only fires when that UPDATE landed (matched by the unique updated_at it stamps).
 * Zero changes means another writer moved the path first; the caller re-reads and decides again.
 */
export async function commitRawFolderPathChange(env: Env, change: RawFolderPathChange): Promise<boolean> {
  const at = Date.now();
  const link = change.link && change.link !== change.previousLink ? change.link : null;
  const meta = JSON.stringify({
    actor: change.actor,
    ...(change.orderId ? { orderId: change.orderId } : {}),
    previousRawFolderPath: change.previousPath,
    rawFolderPath: change.path,
    dropboxFolderId: change.dropboxFolderId,
    ...(link ? { previousRawFolderLink: change.previousLink, rawFolderLink: link } : {}),
  });
  const mappingGuard = automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
    ? " AND NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = projects.id AND m.state = 'ready')"
    : "";
  const pathGuard = change.previousPath === null ? " AND raw_folder_path IS NULL" : " AND raw_folder_path = ?";
  const update = env.DB.prepare(`UPDATE projects SET raw_folder_path = ?, raw_folder_link = COALESCE(?, raw_folder_link), updated_at = ? WHERE id = ?${pathGuard} AND archived_at IS NULL${mappingGuard}`);
  const [result] = await env.DB.batch([
    change.previousPath === null
      ? update.bind(change.path, link, at, change.projectId)
      : update.bind(change.path, link, at, change.projectId, change.previousPath),
    env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'project.raw_folder_path.changed', 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ? AND updated_at = ?)")
      .bind(crypto.randomUUID(), change.projectId, meta, at, change.projectId, change.path, at),
  ]);
  if ((result?.meta.changes ?? 0) === 0) {
    console.log("RAW folder path change lost the race; another writer moved the path first", { projectId: change.projectId, actor: change.actor });
    return false;
  }
  return true;
}

/** A D1-only path edit produces no Dropbox delta, so the RAW monitor never notices the new location on its own. */
export async function enqueueRawFolderPathSync(env: Env, db: Database, projectId: string, trigger: DropboxSyncTrigger): Promise<{ jobId: string }> {
  const jobId = await createJob(db, { kind: "dropbox_sync", projectId, correlationId: `dropbox_sync:${projectId}` });
  try {
    const message: DropboxSyncMessage = { type: "dropbox_sync", projectId, jobId, trigger };
    await env.INGEST_QUEUE.send(message);
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", errorMessage(error));
    throw error;
  }
}
