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
 * The referencing tables have no index on their job column, so the FK guards are uncorrelated `NOT IN` lists
 * (each table is read once per run into a lookup, not once per candidate; the columns are NOT NULL, so NOT IN is
 * safe). They are defence in depth: today those FKs point at other kinds.
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
    AND EXISTS (SELECT 1 FROM jobs n WHERE n.project_id = j.project_id AND n.kind = j.kind
      AND (n.created_at > j.created_at OR (n.created_at = j.created_at AND n.id > j.id)))
    AND j.id NOT IN (SELECT job_id FROM autohdr_handoffs)
    AND j.id NOT IN (SELECT job_id FROM autohdr_fetch_claims)
    AND j.id NOT IN (SELECT owner_job_id FROM raw_reconciliation_claims)
  LIMIT ?`;

export const JOB_RETENTION_DELETE_SQL = `DELETE FROM jobs WHERE id IN (${JOB_RETENTION_CANDIDATES_SQL})`;

export async function pruneJobHistory(db: D1Database, now: number): Promise<{ deleted: number }> {
  const result = await db.prepare(JOB_RETENTION_DELETE_SQL).bind(now - JOB_RETENTION_MS, JOB_RETENTION_PAGE).run();
  return { deleted: result.meta.changes ?? 0 };
}
