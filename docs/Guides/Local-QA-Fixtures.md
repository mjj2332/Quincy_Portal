# Local QA scheduling fixture (#220 follow-on)

A deterministic, local-only dataset for the Production Gantt / checklist-schedule surfaces. Before
this existed, the local tenant had only the handful of hand-made rows an ordinary dev session
accumulates — never enough projects or checklist rows to exercise child-page pagination, the draw
cap, the 199/200 progress boundary, all four stage hues, or a single DST/fold edge case. This
fixture makes those states reachable in a browser pass without touching production, ever.

**Use only the npm commands below. Never run a raw `wrangler` invocation against this fixture** —
the commands below are the guarded path; a hand-typed `wrangler d1 execute` bypasses none of the
guards described here, but it also proves nothing, since the guards are what the commands assert
after running.

## Commands

```sh
npm run db:migrate:local                    # prerequisite — see "known gap" below
npm run db:qa:apply                         # core tier, anchor = this Monday (Sydney)
npm run db:qa:apply -- --tier=core,density  # + the draw-cap tier (opt-in, see below)
npm run db:qa:apply -- --anchor=2026-09-21  # reproduce a specific browser-pass report
npm run db:qa:verify                        # assert the applied DB still matches the RECORDED run exactly
npm run db:qa:teardown                      # remove every fixture row AND every app-written row that
                                             # references one, leave everything else untouched
```

Every `apply` tears down any previously-applied fixture first, so re-running is safe and a changed
`--anchor` or `--tier` cleanly replaces the previous state rather than accumulating rows — **as long
as `verify`/`teardown` succeed**; if a browser pass leaves the DB in a shape teardown's own
post-condition checks or its sweep (below) don't like, both fail loudly rather than
silently leaving orphaned rows for the next `apply` to inherit.

`verify` checks the CURRENTLY APPLIED run — the exact anchor/tier/apply-instant recorded in
`__quincy_local_fixture_runs` when you last ran `apply`, never `Date.now()` and never a value you
pass it (`--anchor`/`--tier` on `verify` are an ASSERTION against that recorded run, not a new value
to recompute against — a mismatch fails immediately, before anything is recomputed). It diffs the
exact id set AND a per-column content fingerprint, including `project_members`, for every table the
generator owns. Comparison is exact and type-aware: NULL is not `''`, and `1` is not `"1"`.
`projects.board_position` is compared against the value apply actually wrote, which apply records in
`__quincy_local_fixture_board_positions`. Memberships are compared against the default-editor set
apply used, which it records in `__quincy_local_fixture_run_records`, never against today's `user`
table. Disabling a default editor after apply therefore changes nothing, and a removed or app-added
membership fails, naming `project_members`. A run applied before these records existed makes
`verify` fail with "Re-apply" rather than fall back to today's editors. **`verify` is expected to fail after a browser pass has mutated a fixture row** (a
stage drag, a schedule edit, a membership change) — that is its job, not a bug; `apply` resets to the
generator's own state.

`teardown` does not merely delete the rows the generator itself inserted. The fixture exists so the
app can be exercised against it (drag-to-reschedule, checklist edits, comments, deadline saves), and
every one of those actions makes the APP write rows this fixture never does directly — `audit_log`,
`notification_outbox`, `notification_delivery_ledger`, `jobs`, comments and their
mentions/read-markers, activity events, assets and renditions, AutoHDR handoffs and
`edited_source_claims`, project members. Twice a hand-maintained teardown table list missed some of
these, so **teardown no longer has a table list. It is derived from the live schema every time it
runs** (`qa-seed/teardown-graph.ts`, driven by `qa-seed/cli.mjs`):

1. **Introspect the foreign-key graph** from the live local DB — every table (from
   `pragma_table_list`, skipping `sqlite_*`, wrangler's `_cf_*`, `d1_migrations`, the reserved
   `__quincy_local_*` tables and `project_board_order_0037_rollback`, which is a migration rollback
   snapshot and excluded *by name*), its columns and every FK (`pragma_table_info`,
   `pragma_foreign_key_list`). Every introspected identifier is checked against `SAFE_IDENTIFIER_RE`
   before it is interpolated.
2. **Capture the whole descendant closure before deleting anything.** Starting from the registered
   fixture rows, rounds of `INSERT OR IGNORE` into `__quincy_local_fixture_closure` (table, rowid, id)
   follow every FK edge plus the no-FK list below, until a round adds nothing — so any depth and any
   self-reference (the `assets` version chain, for instance) is covered and terminates.
3. **Refuse over-capture.** If the closure reaches a `projects` row that is not a registered fixture
   project (a non-fixture project whose `cover_asset_id` points at a fixture asset, say), teardown
   aborts before deleting anything and names the project.
4. **Delete in reverse topological order** of the FK edges, one `DELETE` per table. `audit_log` rows
   go if their `target_id` is *any* captured id, whatever the `target_type`.
5. **Sweep.** Every captured row must be gone, and no FK column or no-FK column may still hold a
   captured id. Anything left fails loudly, naming the table and column, and the registry is left in
   place for inspection. Only a clean sweep empties the registry.

Every statement — each capture `INSERT` and each `DELETE` — still carries the
`__quincy_local_capability` predicate.

### The one hand-written list: id columns without an FK

Some columns hold an entity id with no FK constraint, so the graph cannot see them. They are listed
in `NO_FK_ID_COLUMNS` in `qa-seed/teardown-graph.ts`, each with the source evidence for what it
points at:

| Column | Points at |
|---|---|
| `audit_log.target_id` | any captured id (polymorphic on `target_type`) |
| `project_activity_events.source_id` | any captured id (polymorphic on `source_kind`) |
| `notification_outbox.project_id` | `projects` |
| `notification_outbox.recipient_membership_cycle_id` | `project_members` |
| `notification_outbox.actor_id`, `.recipient_id` | `user` |
| `notification_delivery_ledger.recipient_id` | `user` |
| `project_activity_events.actor_id` | `user` |
| `rendition_dlq_events.asset_id` | `assets` |
| `projects.cover_asset_id` | `assets` |
| `project_comment_read_markers.last_read_comment_id` | `project_comments` |
| `document_uploads.pdf_asset_id`, `.preview_asset_id`, `.pdf_supersedes_asset_id`, `.preview_supersedes_asset_id` | `assets` |
| `document_uploads.completion_audit_id` | `audit_log` |
| `assets.supersedes_asset_id`, `.replaced_by_asset_id`, `.source_raw_asset_id` | `assets` |
| `assets.autohdr_handoff_id` | `autohdr_handoffs` |
| `external_edited_upload_sessions.asset_id` | `assets` |
| `external_edited_upload_sessions.membership_cycle_id` | `project_members` |
| `notice_board_read_markers.last_read_post_id` | `notice_board_posts` |

`test/qa-seed-no-fk-columns.guard.test.ts` keeps this list honest. It scans
`packages/db/src/schema.ts` for every `*_id` column without `.references()` and fails unless the
column is either in `NO_FK_ID_COLUMNS` or in its own `NOT_ENTITY_REFERENCES` allowlist, which gives a
reason for each entry (an OAuth provider's account id, a Dropbox folder id, an R2 multipart-upload
id, and so on). **A
migration that adds an unreferenced id column turns that test red** until someone decides which list
it belongs in. The planner also refuses at run time if a listed column is missing from the live
schema or has since gained a real FK.

### What teardown still cannot handle

It fails loudly on all of these rather than guessing:

- A composite FK, or an FK that targets a column other than `id`.
- A `WITHOUT ROWID` table, or a table with a column that shadows `rowid`.
- A self-referencing FK declared `ON DELETE RESTRICT`. SQLite checks RESTRICT row by row, so a single
  `DELETE` of a captured chain can fail under it. `NO ACTION`, `CASCADE` and `SET NULL`
  self-references are fine; `test/qa-seed-teardown-graph.test.ts` proves both halves.
- An FK cycle between different tables.
- Over-capture into a non-fixture project (step 3).

And it only covers D1. It does **not** remove anything outside the database: R2 objects uploaded
against a fixture asset, queue messages already in flight, or a fixture id that appears only inside a
JSON/text column (`audit_log.meta_json`, a notification payload). Those are not followed, because
nothing in the schema says they are references.

## What each core-tier project proves

| Project (street prefix `QA FIXTURE ·`) | Stage | What it proves |
|---|---|---|
| Pagination 260 | Awaiting RAW | 260 not-done children, more than 2× the child page limit → embedded page + two continuation pages |
| Near-complete 199 of 200 | RAW review | `Math.round(99.5)` capped at 99 — progress never shows 100% until every child is done |
| Complete 40 of 40 | Edited review | Progress is exactly 100%, the completed checkmark renders |
| Zero progress | Editing · autoHDR | Progress is emitted as `0`, not omitted |
| Delivered | Delivered | The one project reaching `--signal-positive` — **only visible with the delivered filter on** |
| Schedule edges | RAW review | Every checklist schedule state and endpoint kind (`unscheduled`, `due_only`, `range`, both `date` and `timed`), all three `legacy_unresolved` reasons, and the DST fold canary (see below) |
| No deadline, no shoot date | Awaiting RAW | `missing_deadline` attention, hollow-start bar |
| Hollow start, has deadline | Editing · autoHDR | A hollow-start bar that still carries a deadline marker |
| Deadline before start | Edited review | Zero-length bar + `deadline_before_start` attention |
| Invalid shoot date | RAW review | `shoot_date = '2026-02-30'` (a real Tonomo shape that isn't a valid calendar day) — the bar falls back to sorting by `created_at` |

All five real `pipeline_stages` keys are used, which is **four distinct hues**, not five —
`raw_review`/`edited_review` share `--signal-caution` and `editing_autohdr` alone reaches
`--signal-info` (the fifth, `editing`, is a presentation-only key no seed can ever produce; see
`apps/web/src/lib/stage-colors.ts`). `--signal-positive` needs the delivered filter, and the
199/200 vs. 200/200 boundary needs the completed-children filter. **A browser pass must explicitly
flip `delivered=1` and `completed=1` at some point** — neither one is visible in the default filter
state.

## Density (`--tier=core,density`) — opt-in, and why

30 additional projects × 70 not-done children each (2,100 subtasks) push `matchedRows` — projects
plus visible children, exactly what `production-gantt.ts`'s density accounting counts — over
`PRODUCTION_GANTT_DRAW_CAP` (2,000), tripping `tooManyToDraw`. This is **forced to be opt-in**, not
a judgement call: `ProductionGantt.tsx`'s child-chain walker stops starting new chains outright
once `tooManyToDraw` is true, which would make the pagination case above unverifiable in the same
filter state as the draw-cap case. Apply `density` only for the one browser pass that needs it, then
apply `core` alone again — that removes it (teardown-first makes every `apply` a clean replace).

The documented recovery filter: filter to a single stage. A single density stage is 6 projects ×
70 children + the 6 project rows themselves — comfortably under the cap.

## The guard, and its honest limit

Two independent layers, in the same shape as `packages/db/setup-local.mjs`'s own guard (see
`test/local-setup-wiring.guard.test.ts`):

1. **Transport fence** (`qa-seed/cli.mjs`): the database name and wrangler config path are
   hard-coded, `--local` is unconditional, and `--remote`/`--env`/`--config`/`--database`/
   `--preview`/`--file`/`--command` are all refused — in both `--flag value` and `--flag=value`
   form — before any subprocess is spawned. No argument passes through unrecognised.
2. **Capability fence** (`setup-local.mjs`'s `__quincy_local_capability` table, local-only, never a
   migration, never in `seed/0001_seed.sql`): every generated statement this fixture ever runs —
   every insert, every teardown delete — carries `WHERE EXISTS (SELECT 1 FROM
   __quincy_local_capability WHERE capability = 'scheduling-fixtures')`. A statement copied out of
   this fixture and run anywhere that never ran `npm run db:migrate:local` — production included —
   fails with `no such table: __quincy_local_capability` instead of silently succeeding.

**Read this plainly, not as marketing:** nothing here makes the fixture *structurally impossible*
to apply to production. Fixture ids must be canonical UUIDs (the API enforces that shape
everywhere), so there is no id-format marker available, and a production-rejecting `CHECK`
constraint would itself be a migration that runs on production. What is true, and is the actual
claim: no command or artifact in this repository can reach production, every path throws before a
subprocess is spawned, and a copied statement fails safely if it somehow arrived. A privileged
operator holding real production credentials could still create the capability table there by hand
and bypass all of this deliberately — that is a hostile act this repository cannot prevent, not the
accidental `--remote`/copy-paste/CI case this guard exists for.

## Why `state: "invalid"` is deliberately unseeded

`normalizeChecklistSchedule` — the same pure function the real API calls — can never produce a
storage row that serializes to `invalid`; that state exists only for genuinely corrupt storage
(version ≥ 1 with a zone but no populated endpoint, a resolved instant that no longer re-resolves,
and similar shapes). Seeding it would mean hand-writing a row the application itself could never
have written — exactly what this fixture exists to avoid. It stays covered by the existing
unit tests in `packages/shared/src/checklist-schedule.ts`'s own test file, not by browser QA data.

## Known gap this fixture does not fix

`setup-local.mjs` applies migrations and the post-rollout board flag, but it does not apply
`seed/0001_seed.sql`. A genuinely fresh local D1 therefore lacks the five pipeline stages and the
bootstrap admin the fixture's preflight requires, even though most local setups already have them
from ordinary use. The fixture's preflight fails with a clear, specific message in that case
(`Run the shared seed first`) rather than a confusing downstream error — it does not attempt to
apply the seed itself. If you are building a scratch database from nothing (as the fixture's own
integration test does), apply the seed yourself first:

```sh
npx wrangler d1 execute quincy-portal --local --config ../../workers/app/wrangler.jsonc \
  --persist-to <scratch dir> --file ./seed/0001_seed.sql
```

## No fixture users (v1)

Every fixture subtask is unassigned (`assignee_id NULL`, `assignment_version 0`); `created_by` is
always the existing bootstrap admin, which the fixture never inserts, updates, or deletes. This
means the Editor filter and assignee chips are not exercised by this fixture — that is deferred
scope, not an oversight.
