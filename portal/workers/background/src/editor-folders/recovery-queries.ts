import { eq, sql } from "drizzle-orm";
import { editorFolderMappings, projects } from "@quincy/db/schema";

import type { dbFor } from "../lib/db";
import { JOB_STALE_MS } from "./move";
import { MOVE_COMMIT_ATTEMPT_LIMIT } from "./move-note";

type Db = ReturnType<typeof dbFor>;

/** Ready mappings whose first Editor sync never completed and has no live sync job (bounded, oldest-first). */
export function editorInitialSyncRecoveryQuery(db: Db, scheduledTime: number) {
  return db.select({ projectId: editorFolderMappings.projectId }).from(editorFolderMappings)
    .innerJoin(projects, eq(projects.id, editorFolderMappings.projectId))
    .where(sql`${editorFolderMappings.state} = 'ready' AND ${editorFolderMappings.initialSyncCompletedAt} IS NULL AND ${projects.archivedAt} IS NULL
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = editor_folder_mappings.project_id AND j.kind = 'editor_sync' AND j.status IN ('queued','running') AND j.updated_at > ${scheduledTime - 20 * 60_000})`)
    .orderBy(editorFolderMappings.updatedAt).limit(50);
}

/**
 * Bounded selection of ready mappings that need a move-related editor_reconcile pass:
 * an expired move lease (takeover), a shoot date that has drifted from the mapping's own
 * placement date (a fresh move, or a stale block worth re-checking), or an orphan-upload
 * watch whose window has lapsed (#195), on any Project: an archived or delivered Project's pass
 * starts no move but still sweeps, so its due watch is found or ends. Throttled
 * the same way as any other reconcile trigger, so a project already mid-pass is not
 * re-enqueued on top of itself.
 *
 * The page is oldest-first and bounded, so every row it can select must be one a pass will
 * act on (#194, and the #154 lesson): a commit-stuck mapping is excluded outright, because
 * `resumeEditorFolderMove` returns before writing anything and it would otherwise hold its
 * slot forever. A NULL expiry is a lease nobody can be holding, so it counts as expired.
 * A queued/running reconcile job only throttles while it is still making progress: one that
 * died mid-run would otherwise hide the project for good.
 *
 * An expired-lease mapping skips the in-flight clause (not the 10-minute recent-creation one).
 * An orphaned job that keeps updated_at fresh would otherwise hide a lapsed lease for up to
 * JOB_STALE_MS plus a sweep interval (a lease expiring 12:11 beside a job last updated 12:01 is
 * excluded at 13:00 and 14:00 and taken over at 15:00, while Attention reports it overdue from
 * 14:11, MOVE_OVERDUE_MS = 2 h). A second pass beside a live one is safe, since every move write
 * is fenced on the lease token.
 *
 * The throttle is two NOT EXISTS clauses, each a single index SEARCH
 * (jobs_project_status_kind_updated_idx for the in-flight clause, jobs_project_kind_created_idx
 * for the recent-creation clause). The in-flight one is OR'd only with a predicate on the mapping
 * row, never with another jobs predicate, so it stays a SEARCH (a single OR over jobs columns
 * only avoids a table scan when sqlite_stat1 exists). Both columns are NOT NULL.
 */
export function editorMoveRecoveryQuery(db: Db, scheduledTime: number) {
  return db.select({ projectId: editorFolderMappings.projectId }).from(editorFolderMappings)
    .innerJoin(projects, eq(projects.id, editorFolderMappings.projectId))
    .where(sql`${editorFolderMappings.state} = 'ready'
      AND NOT (${editorFolderMappings.moveStatus} = 'moving' AND ${editorFolderMappings.moveCommitAttempts} >= ${MOVE_COMMIT_ATTEMPT_LIMIT})
      AND (
        (${editorFolderMappings.moveStatus} = 'moving' AND (${editorFolderMappings.moveExpiresAt} IS NULL OR ${editorFolderMappings.moveExpiresAt} < ${scheduledTime}))
        OR (
          ${projects.archivedAt} IS NULL AND ${projects.stageKey} != 'delivered'
          AND ${projects.shootDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND ${projects.shootDate} != ${editorFolderMappings.shootDate}
          AND (${editorFolderMappings.moveStatus} IS NULL OR (${editorFolderMappings.moveStatus} = 'blocked' AND ${editorFolderMappings.moveTargetShootDate} IS NOT ${projects.shootDate}))
        )
        OR EXISTS (
          SELECT 1 FROM editor_folder_orphan_watches w
          WHERE w.mapping_id = editor_folder_mappings.id AND w.status = 'watching' AND w.watch_until <= ${scheduledTime}
        )
      )
      AND (
        (${editorFolderMappings.moveStatus} = 'moving' AND (${editorFolderMappings.moveExpiresAt} IS NULL OR ${editorFolderMappings.moveExpiresAt} < ${scheduledTime}))
        OR NOT EXISTS (
          SELECT 1 FROM jobs j WHERE j.project_id = editor_folder_mappings.project_id AND j.kind = 'editor_reconcile'
            AND j.status IN ('queued','running') AND j.updated_at > ${scheduledTime - JOB_STALE_MS}
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.project_id = editor_folder_mappings.project_id AND j.kind = 'editor_reconcile'
          AND j.created_at > ${scheduledTime - 10 * 60_000}
      )`)
    .orderBy(editorFolderMappings.updatedAt).limit(50);
}
