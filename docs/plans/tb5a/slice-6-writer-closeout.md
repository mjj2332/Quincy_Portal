# TB5A Slice 6 writer closeout

Status: built; local verification recorded on `tb5a-stage-kanban-ordering`.

## Static audit

The production automatic-writer set is covered by
`portal/packages/db/test/tb5a-slice-6-closeout.test.ts`. It asserts that the listed writers have
no `onSuccess`, no direct `UPDATE projects ... SET stage_key`, and no Drizzle
`db.update(projects).set({ stageKey: ... })`.

The accompanying grep from `portal/`:

```text
$ rg -n "onSuccess" workers packages/db/src --glob '!**/*.test.ts'
(no matches)

$ rg -n -U "UPDATE projects[\\s\\S]{0,300}SET[\\s\\S]{0,180}stage_key\\s*=" workers/background/src workers/app/src/lib/ingest.ts packages/db/src/stage-transition.ts --glob '!**/*.test.ts'
(no matches)

The corresponding repository-wide production grep finds only the two DB winner SQL blocks in
`packages/db/src/stage-board-bundles.ts`; the other `projects.ts` matches are Priority/archive/
restore predicates and do not assign `stage_key`. The rollback helper only restores
`board_position` and intentionally does not touch Stage.

$ rg -n -U "UPDATE projects[\\s\\S]{0,80}SET[\\s\\S]{0,120}stage_key\\s*=" packages/db/src/stage-board-bundles.ts
packages/db/src/stage-board-bundles.ts:269:UPDATE projects AS p ... stage_key = ?4 ... board_revision = p.board_revision + 1
packages/db/src/stage-board-bundles.ts:511:UPDATE projects AS p ... stage_key = CASE ... board_revision = p.board_revision + 1

$ rg -n "boardPosition:|board_position =" workers/app/src/lib/ingest.ts workers/background/src/reconcile-awaiting-raw.ts workers/background/src/dropbox/sync.ts workers/background/src/autohdr workers/background/src/workflows workers/background/src/tonomo/process.ts packages/db/src/stage-transition.ts --glob '!**/*.test.ts'
workers/background/src/tonomo/process.ts:110:    stageKey: "awaiting_raw", boardPosition: appendToStageBottomExpr(...), boardRevision: 0, ...
```

The remaining `board_position` assignments are the DB-owned non-compacting/compacting bundles,
the Slice 5 app project-creation/reorder/archive/restore paths, or the Tonomo INSERT exception.
Every INSERT/UPDATE writer in those paths carries the matching `board_revision` initialization or
mutation. No automatic writer changes position outside a winner bundle.

## Writer conversion

All automatic advances now compose `buildNonCompactingStageWinner` in append mode with
`stage.auto_advance`, the exact source Stage/archive/revision fence, the existing workflow
prerequisite tail, and the revision increment. They do not emit confirmation or
`project.stage.changed` activity.

| Writer | Before | After | Flag-off behavior |
| --- | --- | --- | --- |
| `finalizeIngest` | `guardedStageTransition` plus `onSuccess` | Append winner for `awaiting_raw → raw_review`; explicit `raw_ready` finalizer | Durable RAW ingest may complete; the Stage branch is skipped without a retry loop |
| `syncProjectRawFolder` | `guardedStageTransition` plus `onSuccess` | Append winner with `raw_reconciliation` tail; explicit `raw_ready` finalizer | Sync may retain media truth; automatic Stage is deferred |
| Awaiting-RAW reconciliation | Direct Stage/append/audit | Append winner plus `raw_reconciliation` tail | Cron returns an inert zero-work summary |
| `confirmAutoHdrHandoff` | Direct Stage/append/audit/handoff update | Append winner, handoff-state interlude, handoff token tail | Returns no winner and performs no Stage write |
| `claimAutoHdrRepeatSend` | Stage inside claim batch | Retirement/mapping claim plus separate append winner and new handoff token tail | Typed `ERR_HANDOFF_BLOCKED` before claim writes |
| `claimImplicitAutoHdrHandoff` | Direct Stage/append claim batch | Mapping/path claim followed by append winner and handoff token tail | Returns `null` before creating ownership rows |
| `claimBackfillAutoHdrHandoff` | Direct Stage/append claim batch | Mapping/path claim followed by append winner and handoff token tail | Returns bounded `{ ok: false }` before creating ownership rows |
| `complete-autohdr-api-send` | Direct Stage/append/job/audit batch | Finalization payload/audit prefix plus append winner and job token tail; job is marked done after commit | Workflow exits before provider work; queue claim is also deferred |
| `mark-send-running` with handoff | `confirmAutoHdrHandoff` direct writer | Converted handoff command above | Workflow exits before running the job |
| `mark-send-running` legacy no-handoff | Direct Drizzle Stage/append | Durable self-provenance prefix plus append winner and job token tail | Workflow exits cleanly before transfer |
| `writeAutoHdrFinal` same-hash | `guardedStageTransition` plus hook | Existing replay metadata followed by append winner and handoff final-completion tail | Media truth may persist; Stage remains unchanged |
| `writeAutoHdrFinal` first-version | Direct asset/claim/Stage/append batch | Existing media/version batch followed by append winner and handoff final-completion tail | Media truth may persist; Stage remains unchanged |
| `writeAutoHdrFinal` replacement | `guardedStageTransition` plus hook | Existing replacement metadata followed by append winner and handoff final-completion tail | Media truth may persist; Stage remains unchanged |
| `advance-stage` legacy fetch | Direct Drizzle Stage/append | Explicit source-job token lookup plus append winner and completion tail | Media truth may persist; missing/invalid provenance permanently fails closed |
| Tonomo project creation | Insert with append expression | Insert writes append position and `boardRevision: 0` together | Not flag-gated; still bounded by `pre_0037` maintenance |

## Natural-key final completion fix

The final-completion tail no longer treats the AutoHDR fetch-claim ID as an
`edited_source_claims` ID. Before this fix, its two claim statements were:

```sql
SELECT id FROM edited_source_claims
WHERE id = ? AND handoff_id = ? AND current_asset_id = ?
  AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ?)
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)

SELECT id, current_asset_id FROM edited_source_claims
WHERE id = ? AND handoff_id = ? AND current_asset_id = ?
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
```

They now fence the final claim by its natural key, while retaining the handoff and
mapping premises:

```sql
SELECT id FROM edited_source_claims
WHERE collection_id = ? AND source_path_key = ? AND current_asset_id = ? AND handoff_id = ?
  AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ?)
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)

SELECT id, current_asset_id FROM edited_source_claims
WHERE collection_id = ? AND source_path_key = ? AND current_asset_id = ? AND handoff_id = ?
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
```

`writeAutoHdrFinal` passes the edited collection ID, Dropbox source-path key, and current
asset ID for same-hash replay, first-version creation, and replacement. The first-version
and replacement metadata commits finish before the Stage bundle, so the natural-key tail
can see the durable claim without requiring the caller to retain its generated row ID.

## Automatic-owner audit

Every automatic Stage path was checked for owner rows used by its workflow tail:

| Path | Tail owner and batch visibility |
| --- | --- |
| `finalizeIngest` | No workflow owner; uses the `none` tail. The RAW asset and ingest audit are already durable before the winner bundle. |
| `syncProjectRawFolder` | `raw_reconciliation_claims.id` is the existing running claim; the project shoot date is passed as a nullable natural-value fence. |
| Awaiting-RAW reconciliation | `none` tail; there is no owner row to select. |
| `confirmAutoHdrHandoff` | Existing `autohdr_handoffs` row is updated in the stage/workflow batch interlude, then selected by handoff ID/generation/connection. |
| Repeat-send, implicit, and backfill claims | Each path creates the handoff/mapping rows in its preceding claim batch, then selects the committed handoff by ID/generation/connection. |
| AutoHDR API send finalization | The existing job payload is updated in `prefix`; the `autohdr_api_send` job tail reads that same job in the same batch. |
| Legacy AutoHDR send without a handoff | The existing `autohdr` job provenance is written in `prefix`; the job-entry tail reads that same row in the same batch. |
| AutoHDR fetch completion | The existing `fetch_edited` completion job is selected directly; its source `autohdr` entry job ID/generation are explicitly verified before the bundle. |
| AutoHDR final writer | Same-hash uses the existing natural-key claim; first-version/replacement use the claim committed by their preceding metadata batch, with no fetch-claim ID assumption. |
| Tonomo | No automatic Stage transition; new-project creation is the intentional non-flag-gated exception and writes initial position/revision atomically. |

## Background fixture flag audit

The board-contract flag enable was added immediately after migrations in:
`autohdr-api-send.test.ts`, `autohdr-claims.test.ts`, `autohdr-manual-supplement.test.ts`,
`autohdr-send-run.test.ts`, `autohdr-versioning.test.ts`, `dropbox-reconciliation.test.ts`,
and `raw-stage.test.ts`. `tonomo-process.test.ts` intentionally remains flag-off because it
tests Tonomo creation/link processing, not an automatic Stage advance. The pure
`reconcile-awaiting-raw.test.ts` logic suite has no D1 migration setup or automatic-stage
execution; the migration-only and non-stage fixtures likewise remain unchanged.

## Ambiguities resolved

- The existing `automaticBoardWritesEnabled` seam is background-local. App ingest uses the same
  `tb5a_board_contract_enabled` decision through its existing `requireBoardSchemaReady` plus
  `boardContractEnabled` path, so it stays within the requested ingest-only app scope.
- Legacy job payloads may carry the entry generation under either `generation` or the new
  `stageEntryGeneration`; completion accepts the compatibility fallback but requires the explicit
  `sourceJobId`, exact job kind/project, self-provenance marker, and non-null stored token.
- Dropbox reconciliation may have a nullable project shoot date. Its typed prerequisite and SQL
  use SQLite `IS`, with the current project value bound verbatim, preserving the existing claim
  fence without manufacturing an empty date.
- Repeat-send ownership retirement remains its existing idempotent claim batch. Its automatic Stage
  winner, audit marker, state interlude, and token tail are one DB batch; the separation prevents
  the claim workflow from losing its existing recovery behavior while keeping Stage ownership
  DB-controlled.
- `guardedStageTransition` remains only as a compatibility wrapper for legacy tests/callers; it has
  no hook and composes the same append winner. All named production automatic callers use explicit
  finalizers directly.

## Token tail and provenance

`NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL` and `NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL` remain
byte-identical to the approved plan. The DB bundle tests compare each exported constant against the
plan's breakpoint-delimited SQL and execute the valid handoff tail at revision `5`.

The job-owned path carries `stageEntrySourceJobId` and `stageEntryGeneration` in durable workflow/job
input and passes the source ID as an explicit completion-tail prerequisite. Completion resolves that
source job by exact ID, project, kind, generation, valid JSON, self-provenance, and non-null stored
token. The completion job's exact payload and `fetch_edited` kind are fenced in the same completion
tail. Missing ID, generation mismatch, null token, absent source job, current-job substitution,
equal-revision impostors, move-out, and ABA (`5 → 6 → 7`) all produce no completion winner or
notification.

## Verification

The Slice 5 DB suite had 21 files and 91 tests by its test-file count. Slice 6 removed two
hook-characterization tests and added the closeout, stale-premise, and provenance assertions; the
current DB suite has 22 files and 94 passing tests. After the conversion:

- `npm run typecheck` — passed
- `npm run build -w @quincy/web` — passed (382 modules; existing large-chunk warning)
- `npm test -w @quincy/db` — 22 files, 94 tests passed
- `npx vitest run --config packages/shared/vitest.config.ts` — 16 files, 99 tests passed
- `npm test -w @quincy/web` — Node: 17 files/111 tests; DOM: 31 files/310 tests passed (the
  managed sandbox also reports expected localhost:3000 `EPERM` connection warnings)
- `npm test -w @quincy/worker-webhook-ingress` — 1 file, 13 tests passed
- `npm run -w @quincy/db generate` — no schema changes, nothing to migrate
- `npm test -w @quincy/worker-app` — blocked before collection by the managed sandbox: Wrangler
  log write and Miniflare `127.0.0.1` listen both returned `EPERM`
- `npm test -w @quincy/worker-background` — blocked by the managed sandbox: Miniflare could not
  listen on `127.0.0.1` and Wrangler could not write `/Users/tingruilee/.wrangler/logs` (`EPERM`)

The original reported worker-background baseline was 238 passing / 3 failing. The three failures
were the missing manual-supplement flag and two final-version completion cases. The corrected
worker-background suite could not be executed in this managed sandbox: Wrangler/Miniflare are
denied writing the user Wrangler log and listening on `127.0.0.1` (`EPERM`). The post-fix count is
therefore pending the orchestrating environment’s worker run; the gate output above records all
non-worker results available here.
