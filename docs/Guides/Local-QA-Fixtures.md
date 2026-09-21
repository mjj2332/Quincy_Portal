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
npm run db:qa:verify                        # assert the applied DB still matches the generator
npm run db:qa:teardown                      # remove every fixture row, leave everything else untouched
```

Every `apply` tears down any previously-applied fixture first, so re-running is always safe and a
changed `--anchor` or `--tier` cleanly replaces the previous state rather than accumulating rows.

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
