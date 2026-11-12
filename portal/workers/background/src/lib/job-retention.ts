/**
 * Hygiene retention for the `jobs` table (docs/plans/d1-rows-read-jobs-scan.md, PR 2).
 *
 * Deletes only `done` `editor_reconcile` / `editor_sync` rows whose `updated_at` is older than 90 days, and
 * never the newest row per (project_id, kind) (`latestEditorReconcile` reads it), a row with no project, or a
 * row any FK still points at. `failed` / `stuck` rows are retry handles and are never touched.
 *
 * The candidate select walks `projects` and, per project, ranges `jobs_project_status_kind_updated_idx`
 * (project_id, status, kind, updated_at < cutoff), so it reads only rows already past the cutoff rather than every
 * `done` row. `projects` is the outer table because it is tiny; joining it also drops NULL project_id rows.
 *
 * Newest means strictly the greatest `created_at`: `latestEditorReconcile` orders by `created_at` alone, so every row tied
 * at the maximum is kept and an id tie-break could never delete the row the reader returns.
 *
 * The three referencing tables are probed by correlated `NOT EXISTS` through the job indexes added in migration 0084
 * (`autohdr_handoffs_job_idx`, `autohdr_fetch_claims_job_idx`, `raw_reconciliation_claims_owner_job_idx`); the same
 * indexes make the foreign key check on each deleted row a seek instead of a scan. They are defence in depth: today those
 * FKs point at other kinds.
 *
 * The only protected editor rows are the newest per (project, kind), bounded by the project count, so no cursor is needed
 * and the hourly page of 250 outpaces the ~600 rows/day of growth.
 *
 * One atomic bounded statement per run, no drain loop. Every predicate lives in the candidate subquery, so a
 * protected row never takes a slot on the page ("A bounded page is only bounded if every row on it can move").
 */

export const JOB_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const JOB_RETENTION_PAGE = 250;
export const JOB_RETENTION_KINDS = ["editor_reconcile", "editor_sync"] as const;

/** Candidate selection, shared by the DELETE and by tests that measure its plan and rows read. Binds: cutoff, limit. */
export const JOB_RETENTION_CANDIDATES_SQL = `SELECT j.id FROM projects p CROSS JOIN jobs j
  WHERE j.project_id = p.id
    AND j.status = 'done'
    AND j.kind IN ('editor_reconcile', 'editor_sync')
    AND j.updated_at < ?
    AND EXISTS (SELECT 1 FROM jobs n WHERE n.project_id = j.project_id AND n.kind = j.kind AND n.created_at > j.created_at)
    AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs r WHERE r.job_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM autohdr_fetch_claims r WHERE r.job_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM raw_reconciliation_claims r WHERE r.owner_job_id = j.id)
  LIMIT ?`;

export const JOB_RETENTION_DELETE_SQL = `DELETE FROM jobs WHERE id IN (${JOB_RETENTION_CANDIDATES_SQL})`;

export async function pruneJobHistory(db: D1Database, now: number): Promise<{ deleted: number }> {
  const result = await db.prepare(JOB_RETENTION_DELETE_SQL).bind(now - JOB_RETENTION_MS, JOB_RETENTION_PAGE).run();
  return { deleted: result.meta.changes ?? 0 };
}
