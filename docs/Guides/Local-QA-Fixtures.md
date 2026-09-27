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

Every `apply` replaces any previously-applied fixture, so re-running is safe and a changed
`--anchor` or `--tier` cleanly replaces the previous state rather than accumulating rows. It builds
and validates the replacement dataset **first** — every DST cross-check, anchor check and schedule
round-trip — and only then tears down the previous fixture and writes the new one, so a generation
failure leaves the previous fixture exactly as it was rather than leaving none. (A failure part-way
through *writing* is not covered: the statements go out as several `--file` batches, which are not
one transaction.) Replacement works **as long as `verify`/`teardown` succeed**; if a browser pass leaves the DB in a shape teardown's own
post-condition checks or its sweep (below) don't like, both fail loudly rather than
silently leaving orphaned rows for the next `apply` to inherit.

`verify` checks the CURRENTLY APPLIED run — the exact anchor/tier/apply-instant recorded in
`__quincy_local_fixture_runs` when you last ran `apply`, never `Date.now()` and never a value you
pass it (`--anchor`/`--tier` on `verify` are an ASSERTION against that recorded run, not a new value
to recompute against — a mismatch fails immediately, before anything is recomputed). It diffs the
exact id set AND a per-column content fingerprint, including `project_members`, for every table the
generator owns. The compared columns are read off the **live** table (`pragma_table_info`), not a
hand list: every column is compared except `VERIFY_EXCLUDED_COLUMNS` in `qa-seed/cli.mjs` (empty
today; each entry must carry a reason). A live column the generator's fingerprint has no expected
value for fails `verify` naming `table.column`, and
`test/qa-seed-verify-columns.guard.test.ts` fails in CI for the same case — so a migration that adds a
column to a fixture-written table cannot silently go uncompared. Subtasks, collections, deadline
occurrences and memberships are scoped by fixture `project_id`, so a row the app *added* to a fixture
project (a checklist item, a floorplan collection, a reminder, an editor) fails too. Comparison is exact and type-aware: NULL is not `''`, and `1` is not `"1"`. The global
`PRAGMA foreign_key_check` is printed as a **warning**, not a failure: it covers every row in the
local database, and a violation in unrelated local data says nothing about the fixture.
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
   aborts before deleting anything and names the project. More generally, every captured row's
   outgoing FK parents must be in the closure too, unless the parent table is a shared lookup in
   `SHARED_PARENT_TABLES` (`user`, `agencies`, `agents`, `integration_connections`, and
   `pipeline_stages`, each with its reason). A captured row that points outside the fixture — a
   `premium_unlocks` row joining a real project's client link to a fixture asset — aborts the
   teardown before anything is deleted, naming the table, row id, column and parent. Clear the
   reference by hand and re-run.
4. **Delete in reverse topological order** of the FK edges, one `DELETE` per table. `audit_log` rows
   (and `project_activity_events.source_id`) go if their id column holds *any* captured id, whatever
   the `target_type`, **or any id ever registered for the fixture, even if the app has already
   deleted that row**. The app deletes a fixture subtask and writes an audit row targeting its id in
   the same batch, and that audit row goes too.
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
- Over-capture into a non-fixture project, or a captured row whose FK parent is outside the fixture
  and is not a shared lookup (step 3).

And it only covers D1. It does **not** remove anything outside the database: R2 objects uploaded
against a fixture asset, queue messages already in flight, or a fixture id that appears only inside a
JSON/text column (`audit_log.meta_json`, a notification payload). Those are not followed, because
nothing in the schema says they are references.

### What teardown cannot remove: residue about rows the app created *and* deleted

Some rows describe an entity that the app **created and then deleted** during a pass. For example:

- an `audit_log` row for a comment or asset that was created and then deleted;
- a rendition DLQ event (`rendition_dlq_events`) that arrives after its asset was deleted.

Teardown leaves these rows. Nothing left in the database links them to the fixture: the entity was
never registered, and its row is gone, so neither the FK graph nor the registered-id match can reach
it. The only way to reach them would be to harvest ids out of text and payload columns
(`meta_json`, `source_key`, payload JSON). That would reopen the over-capture risk the boundary
check in step 3 closes, so teardown deliberately does not do it. They are FK-less orphans in a
**local** database. They are harmless to a later `apply`, `verify` or teardown sweep, none of which
look at them, and they are exactly what the same delete leaves behind in production.

## Browser passes against the fixture

- Record the **anchor** and **tier** (printed by `apply`, readable again via `verify`) in the pass
  report — see `docs/subagents/Subagent-Orchestration.md` §2a.
- **Fixture passes do not upload media.** Renditions cannot be generated locally anyway, so an upload
  only produces rendition DLQ noise, some of which teardown cannot reach (see above). Exercise the
  scheduling surfaces the fixture exists for; take media flows to a pass that is set up for them.
- `verify` is expected to fail after a pass has edited fixture rows; re-`apply` to reset.

## What each core-tier project proves

On the Production Gantt a project draws a bar only when it has a deadline (`apps/web/src/lib/production-gantt-adapter.ts`, `buildProjectBar`: no deadline means a "Deadline not set" row and no bar), so every core project meant to show a bar, progress or a hue carries one — its shoot date + 7 days at 17:00 unless noted below.

| Project (street prefix `QA FIXTURE ·`) | Stage | What it proves |
|---|---|---|
| Pagination 260 | Awaiting RAW | 260 not-done children, more than 2× the child page limit → embedded page + two continuation pages; the bar shows the `awaiting_raw` hue |
| Near-complete 199 of 200 | RAW review | `Math.round(99.5)` capped at 99 — progress never shows 100% until every child is done |
| Complete 40 of 40 | Edited review | Progress is exactly 100%, the completed checkmark renders |
| Zero progress | Editing · autoHDR | Progress is emitted as `0`, not omitted |
| Delivered | Delivered | The one project reaching `--signal-positive` — **only visible with the delivered filter on** |
| Schedule edges | RAW review | Every checklist schedule state and endpoint kind (`unscheduled`, `due_only`, `range`, both `date` and `timed`), all three `legacy_unresolved` reasons, and the DST fold canary (see below) |
| No deadline, no shoot date | Awaiting RAW | `missing_deadline` attention (flagged hollow-start) and **no bar** — deliberately left without a deadline |
| Hollow start, has deadline | Editing · autoHDR | A hollow-start bar that still carries a deadline marker (deadline anchor + 14 days, 17:00) |
| Deadline before start | Edited review | Zero-length bar + `deadline_before_start` attention (deadline anchor + 2 days 09:00, shoot anchor + 10) |
| Invalid shoot date | RAW review | `shoot_date = '2026-02-30'` (a real Tonomo shape that isn't a valid calendar day) — serialized as no shoot date, so the bar starts at `created_at` (deadline anchor + 7 days, 17:00) |

All five real `pipeline_stages` keys are used, which is **four distinct hues**, not five —
`raw_review`/`edited_review` share `--signal-caution` and `editing_autohdr` alone reaches
`--signal-info` (the fifth, `editing`, is a presentation-only key no seed can ever produce; see
`apps/web/src/lib/stage-colors.ts`). `--signal-positive` needs the delivered filter, and the
199/200 vs. 200/200 boundary needs the completed-children filter. **A browser pass must explicitly
flip `delivered=1` and `completed=1` at some point** — neither one is visible in the default filter
state.

## Density (`--tier=core,density`) — opt-in, and why

The density tier alone trips `PRODUCTION_GANTT_DRAW_CAP` **under the Gantt's default filters**
(delivered off, completed off), with at least 10% to spare. `matchedRows` here means exactly what the
server computes: `production-gantt.ts`'s `density_candidates`, i.e. every project that passes
`authorized_projects_base` plus its *visible* children. That CTE (`production-scope-sql.ts:89`) drops
delivered projects unless the delivered filter is on, and done children are hidden unless completed
is on. The tier cycles its 30 projects through all five stages, so 6 of them are delivered and count
for nothing in the default view.

At today's cap of 2,000 the numbers the server computes are:

| Density tier, filter state | Projects | Rows each (1 project + children) | `matchedRows` |
| --- | --- | --- | --- |
| Default (delivered off, completed off) | 24 | 92 | **2,208** — over the 2,200 margin (cap × 1.1) |
| Delivered on | 30 | 92 | 2,760 |
| One stage (the recovery filter) | 6 | 92 | 552 — back under the cap |

Children per project (91, all not-done) is not hand-picked. `qa-seed/dataset.ts` derives it from
`PRODUCTION_GANTT_DRAW_CAP` and the non-delivered project count: the smallest number that puts the
default view strictly over `cap + ceil(cap / 10)`. Raising the cap raises the tier with it. The 10%
margin is there so ordinary browser-pass activity cannot un-trip the cap by accident. Ticking a
child done hides it from the default view, so each tick lowers the count by one. The density tier
alone stays over the cap until 208 of its children are ticked: at 2,000 the count no longer
*exceeds* the cap, and `tooManyToDraw` is `matchedRows > cap`. With `core` applied as well, the
default view carries core's rows on top. `test/qa-seed-coverage.test.ts` counts the same way the server does and fails if any of these
three states stops holding.

This tier is **forced to be opt-in**, not a judgement call: `ProductionGantt.tsx`'s child-chain
walker stops starting new chains outright once `tooManyToDraw` is true. With density applied,
the pagination case above could not be verified in the same filter state as the draw-cap case.
Apply `density` only for the one browser pass that needs it, then apply `core` alone again. That
removes it: every `apply` tears down the previous fixture before writing, so it is a clean replace.

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
