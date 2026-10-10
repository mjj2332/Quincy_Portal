Answers: everything a new D1 table or column must touch, in order, from picking the migration number to applying it in production.

## 1. Migration file
- Directory `portal/packages/db/migrations/`, bound to D1 `DB` via `"migrations_dir"` portal/workers/app/wrangler.jsonc:20; drizzle-kit `out` portal/packages/db/drizzle.config.ts:7.
- Name `NNNN_snake_case.sql`; separate statements with `--> statement-breakpoint` portal/packages/db/migrations/0061_project_whiteboard_versions.sql:26.
- Never put `;` or a trigger inside a comment: worker tests split the file on semicolons (`No trigger and no semicolon` portal/packages/db/migrations/0061_project_whiteboard_versions.sql:10).

## 2. Next free number — check open remote branches too
From the repo root (at this rev the highest number on any branch was 0068, so 0069 was free):

    git fetch -q origin && git for-each-ref --format='%(refname)' refs/remotes/origin | while read b; do git ls-tree --name-only "$b" portal/packages/db/migrations/; done | grep -o '[0-9]\{4\}_[a-z0-9_]*\.sql' | sort -u | tail -3

Replace `tail -3` with `cut -c1-4 | uniq -d` to list numbers claimed by two different files (empty = no clash).

## 3. Journal and migration test (hand-maintained)
- Append `{idx, version, when, tag, breakpoints}` to `portal/packages/db/migrations/meta/_journal.json` (last: `0069_video_review_guest` portal/packages/db/migrations/meta/_journal.json:489). Snapshots stop at `0041_snapshot.json`, so `db:generate` output is not usable as-is.
- Add `portal/packages/db/test/migration-<NNNN>.test.ts`, copying `migration-0068` (additive) or `migration-0069` (column swap and `DROP COLUMN` under `foreign_keys=ON`): it bans `CREATE TRIGGER|DROP TABLE|__new_|PRAGMA` portal/packages/db/test/migration-0062.test.ts:38 and requires `when` above every earlier entry portal/packages/db/test/migration-0062.test.ts:49.

## 4. `portal/packages/db/src/schema.ts`
- Times are epoch **ms**: `createdAt` portal/packages/db/src/schema.ts:10 → `timestamp_ms` portal/packages/db/src/schema.ts:11; `updatedAt` portal/packages/db/src/schema.ts:12. The SQL side adds `typeof(created_at) = 'integer'` portal/packages/db/migrations/0061_project_whiteboard_versions.sql:18.
- Mirror the SQL in a `sqliteTable`, e.g. `projectWhiteboardVersions` portal/packages/db/src/schema.ts:467.

## 5. FK safety
- `PRAGMA foreign_keys=OFF` does not reliably persist in remote D1 migrations, and drizzle's `__new_` table rebuild needs it. `portal/packages/db/test/migration-fk-safety.guard.test.ts` bans both; for a new `CHECK`, use ADD COLUMN → copy → DROP COLUMN → RENAME COLUMN.
- `no migration re-asserts an operator-owned feature flag` portal/packages/db/test/migration-feature-flag-ownership.guard.test.ts:87.

## 6. QA seed, teardown graph, audit types
One table in `docs/Guides/Local-QA-Fixtures.md` § "What a new table or column must touch" (`teardown-graph.ts`, `NO_FK_ID_COLUMNS`, `appRows`, audit `target_type` lists, `VERIFY_EXCLUDED_COLUMNS`), with the command that names each fix. Additions not in that guide:
- `audit` portal/workers/app/src/lib/audit.ts:14 takes `action: string` portal/workers/app/src/lib/audit.ts:17 and `targetType: string` portal/workers/app/src/lib/audit.ts:18 — plain strings, no union to extend; the lists in `PROJECT_DESCENDANT_AUDIT_TYPES` portal/packages/db/test/qa-seed-app-rows.ts:90 / `GLOBAL_AUDIT_TYPES` portal/packages/db/test/qa-seed-app-rows.ts:99 are the only register.
- Project hard delete `"/projects/:id"` portal/workers/app/src/routes/projects.ts:1286 removes FK-less tables by hand (`No FK to projects/assets` portal/workers/app/src/routes/projects.ts:1348) before `DELETE FROM projects` portal/workers/app/src/routes/projects.ts:1360. A project-owned table without an FK must be added there.
- Shared seed `portal/packages/db/seed/0001_seed.sql` is applied by `setupLocal` portal/packages/db/setup-local.mjs:241 after `"migrations", "apply"` portal/packages/db/setup-local.mjs:230. Locally: `npm run db:migrate:local` (from `portal/`).

## 7. Production
`docs/Guides/CI-Deploy.md` § "A PR that adds a D1 migration": CI never applies migrations, so the deploy job goes red at the migration guard until the owner (Time Travel bookmark first) runs `migrations apply DB --remote`. The code ships after the schema. Rollback: same doc § "Rolling back".

## 8. Constraints the QA teardown graph imposes on a new table
- A foreign key must be single-column and point at an `id` column: `buildTeardownGraph` throws on a composite FK (0069's `guest_unsubscribe_tokens` uses two single-column FKs for that reason) and on one targeting any other column. A table with no `id` column (a composite-PK link table such as `guest_link_members`) can be a leaf but never an FK parent.
- A table with no FK into the fixture graph and no `*_id` column (`guest_rate_limits`) needs no registration at all.

Last verified against 763523cc
