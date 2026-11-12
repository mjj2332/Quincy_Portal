# Plan: stop the `jobs` full scan in the editor-folder move sweep

Settled 2026-11-12 from blind Opus (deep-reasoner) and Codex plans, synthesized by the session. Base
`origin/main` b53cd794.

## Diagnosis (production D1 analytics, 2026-11-12)

- `quincy-portal` D1 reads 3–4.6B rows/day, up linearly from 0.74B on 1 Oct. That is over the
  Workers Paid 25B/month included allowance. 28 Oct was not a step change.
- About 99.9% of reads come from the `dueForMove` select in
  `portal/workers/background/src/index.ts` (~115–140):
  - it runs on the `* * * * *` cron, ~1,470 times/day;
  - each run reads ~3.1M rows and takes ~575 ms.
- Cause: its correlated `NOT EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = … AND j.kind = 'editor_reconcile' AND (active-and-fresh OR created-in-last-10-min))`
  has no usable index. Production EXPLAIN shows `SCAN j`, once per ready mapping
  (91 mappings × ~36k jobs rows).
- Growth: `jobs` is never pruned, and the hourly reconciliation adds ~450–600 `editor_reconcile`
  rows/day.

## PR 1 — indexes + query split (the fix)

**Code**
- Move the two recovery selects (initial-sync and move) from `scheduled()` into
  `workers/background/src/editor-folders/recovery-queries.ts`, exported as builders taking
  `(db, scheduledTime)`. `scheduled()` and the tests use the same builders.
- In the move select, split `NOT EXISTS(… AND (A OR B))` into two clauses:
  `NOT EXISTS(… AND A) AND NOT EXISTS(… AND B)`. Both columns are NOT NULL, so semantics are
  identical.
  - A = `status IN ('queued','running') AND updated_at > now − JOB_STALE_MS`
  - B = `created_at > now − 10 min`, any status
  - Keep the strict `>` boundaries and the #194 comment.
  - Why: without the split, the plan depends on `sqlite_stat1`. It only uses MULTI-INDEX OR when
    stats exist, and otherwise falls back to reading ~27k rows per run.
- No change to the initial-sync SQL text, other readers, the minute cadence, or the hourly
  rotation.

**Migration `0083_jobs_project_indexes.sql`** (additive; two statements joined by
`--> statement-breakpoint`; no `;` in comments):

```sql
CREATE INDEX jobs_project_kind_created_idx ON jobs (project_id, kind, created_at);
CREATE INDEX jobs_project_status_kind_updated_idx ON jobs (project_id, status, kind, updated_at);
```

Supporting changes:
- Add matching `index(...)` entries to the `jobs` table in `packages/db/src/schema.ts` (~1553).
- Add journal idx 83 with `when` greater than every prior entry.
- Keep `jobs_status_idx`: global scans with no project filter use it.

**Why these indexes**
- **Status before kind** in the second index: the delete guards filter `jobs` by
  `(project_id, status IN …)` with no kind filter. `routes/projects.ts:1368` uses no kind at all;
  `routes/assets.ts:63` uses `kind != 'asset_delete'`. Opus measured:
  - `(project_id, kind, created_at)` alone pushes the delete guard from 42 to 381 rows;
  - with both indexes, every active-job reader reads 0–2 rows.
- **No partial index.** One `WHERE status IN ('queued','running')` was considered and rejected.
  Drizzle's `inArray` binds its values, and SQLite will not use a partial index under a bound
  predicate. Both planners confirmed this.

**Side benefits:** `latestJobForProject` and the project jobs panel (`routes/projects.ts:~1222`)
were also full scans. They become ~1 and ~44 rows.

**Write cost:** two extra index entries per inserted job, plus upkeep of the second index on
status/progress updates. That is ~4k index writes/day, which is negligible.

**Expected:** the move select drops from ~3.1M to under 300 rows per run, and daily rows read from
~4B to under 10M.

**Tests (red first)**
- `workers/background/test/editor-folder-recovery-query-plan.test.ts`:
  - Compile both builders with `.toSQL()` and run `EXPLAIN QUERY PLAN` with their real bound
    params on the migrated D1. Prior art: `workers/app/test/project-activity.test.ts:203`.
  - Require a `SEARCH j` through each named index with its time range bound.
  - Reject `SCAN j` and prefix-only searches.
  - Check plans with and without `ANALYZE` if local D1 allows it.
  - Include the bound-status delete-guard shape.
- Rows-read bound: seed ~2,000 old `done` reconcile jobs for one project, run with a prepared
  `.all()` (lesson "Server-Timing / D1 metering"), and assert `meta.rows_read` < 300.
- `editor-folder-move-cron.test.ts`:
  - Keep the existing throttle (:176) and JOB_STALE_MS (:240) cases green.
  - Add equality and ±1 ms boundary cases for 2 h, 10 min, and the initial-sync 20 min.
  - Add a case where a recent done/failed job still throttles (branch B ignores status).
- `packages/db/test/migration-0083.test.ts`, modelled on 0082/0063:
  - journal order and exact index columns;
  - additive only (no DROP/DELETE/UPDATE/TRIGGER);
  - existing indexes kept;
  - `foreign_key_check` empty.
  - `migration-fk-safety.guard.test.ts` stays green.
- Run `npm run verify` from `portal/`.

**Rollout** (`docs/Guides/CI-Deploy.md` § "A PR that adds a D1 migration"; owner's go-ahead)
1. Merge. The deploy turns red at the migration guard.
2. Owner takes a Time Travel bookmark.
3. From `portal/workers/app`, run `npx wrangler d1 migrations apply DB --remote`. The pending list
   must show only 0083.
4. Rerun the failed job.

Compatibility:
- Old code on the new schema is safe and already ~100× cheaper.
- New code without the indexes is correct but still expensive.
- On a Worker rollback, leave the indexes in place.

**Owner decision:** apply 0083 once the PR is approved but before merge, to stop the overage a few
hours sooner? That is only safe if the migration text is frozen from then on.

**Verify in production**
- After the apply, a read-only `EXPLAIN QUERY PLAN` of the `.toSQL()` text shows no `SCAN j`.
- After the deploy, D1 GraphQL `d1QueriesAdaptiveGroups` (grouped by query, `sum.rowsRead / count`)
  should show the new move select under 300 rows per run.
- `d1AnalyticsAdaptiveGroups` daily `rowsRead` should fall to under 10M within 24 h.

## PR 2 — `jobs` retention (optional, owner's call; not needed for the bill)

- Once PR 1 lands, no hot reader's cost grows with the table. Retention is hygiene only.
- If wanted, start conservative (Codex's policy, tighter than Opus's 30 days):
  - delete only `done` `editor_reconcile`/`editor_sync` rows with `updated_at` older than 90 days;
  - keep the newest row per (project, kind), which `latestEditorReconcile`
    (`editor-folders/backfill.ts:157`) reads;
  - skip any row a FK references: `autohdr_handoffs.job_id`, `autohdr_fetch_claims.job_id`,
    `raw_reconciliation_claims.owner_job_id`;
  - keep `failed`/`stuck` rows as retry handles.
- Mechanics: an indexed, bounded delete page in `job-retention.ts`, called once a day from the
  hourly cron, capped per run, with no drain loop.
- Follow these lessons:
  - "A bounded page is only bounded if every row on it can move";
  - "Retention must key on the youngest thing that still needs the chain…".

## Separate owner one-off — stale September rows

- 8 `editor_reconcile` jobs have been `queued`, and 34 `dropbox_sync` jobs `running`, since
  September.
- They no longer affect reads, but they **block** project/asset deletes
  (`routes/projects.ts:1368`, `routes/assets.ts:63`), which have no staleness rule.
- Steps:
  1. Confirm no Queue or Workflow still owns them.
  2. Following `docs/agents/production-data.md`, mark them `stuck` with an explanatory `error`.
- Do this by hand, not in a migration.

## Decisions taken in synthesis

| Question | Opus | Codex | Settled |
|---|---|---|---|
| Second index column order | `(project_id, status, kind, updated_at)` | `(project_id, kind, status, updated_at)` | Opus: the delete guards filter by status without kind (checked at `projects.ts:1368`, `assets.ts:63`) |
| Partial index | rejected (measured) | rejected (measured) | rejected |
| Cadence change | no | no | no |
| Retention | optional PR, 30 d, keep newest | separate PR, 90 d, done only | optional PR 2, Codex's conservative policy |
| Stale rows | owner one-off → `stuck` | diagnose ownership first | diagnose, then owner one-off |
