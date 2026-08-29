# Revamp TB5A — Project Stage and Kanban Ordering Contract

**Status: IMPLEMENTED and DEPLOYED to production — 2026-08-29.** Merge `b4cda86` on `main`
(build: slices 0–8 + fix slices 6b–6e; 2 full Sol diff-review rounds — 15 + 6 blockers closed;
the automatic-writer fence took 3 Sol design rounds + 3 Opus verification passes; Opus final-draft
verdict MERGE). Production: migration `0037` applied to remote D1
(`Executed 16 commands`, preflight + postflight CHECKs passed, 76 unarchived projects normalized to
`board_revision = 1` and positions `0,1024,2048,…`, rollback capture table = 76 rows, FK +
`quick_check` clean); app Worker `4ba551a3-e009-4c56-9051-e9eed47a6aef`, background Worker
`fa876454-666e-4bf7-b6e4-582ab154ed19`; `tb5a_board_contract_enabled` flipped to `1` with the
flag-flip audit recorded; local runtime QA + prod flag-OFF and flag-ON smoke tests all green.
Deployed following `docs/plans/implemented/tb5a/slice-8-deploy-runbook.md`. Recovery point:
`db-recovery/quincy-portal-pre-0037-2026-08-29.sql` (SHA-256 `9b6415c8…d64277df`) + D1 Time Travel
bookmark `00000636-00001bb2-000050d6-d616b6db73e26945e34d144e3c7a99e5`.

Deferred post-TB5A follow-ups (documented in `tb5a/slice-6-writer-closeout.md`): SF5 (a Workflow
`deferred` return completes the Workflow instead of pausing it) and SF6 (maintenance-window queue
/ alarm replay intent). Neither is a rollout hazard — the deploy freeze covered them.

---

**Original review-state note (retained):** APPROVED by Opus plan-tier review — round 3 folds in
the APPROVE conditions; build-ready. The implementation baseline / parent commit was
`8b7b3f96b1195c8dbaef547348962a7bb9bd3079`; the draft commit `7f04955e9456eccf482bb87befccad02eea4fac9`.

TB5A targets the deployed React/React DOM `19.2.8` baseline. It does not change React, routing,
Tailwind, shadcn, or dnd-kit.

## Round 1 revision log

- **Blocking 1 — partial compacting Stage move:** The DB contract now has two mutually exclusive
  winner forms. A non-compacting move uses one guarded target update; a compacting move uses one
  fully snapshot-fenced multi-row `UPDATE … CASE` containing the target transition and all changed
  sibling positions. No target Stage update precedes compaction.

- **Blocking 2 — AutoHDR ABA race:** Workflow-owned entry into Editing now records the exact
  `board_revision` produced by that entry on its handoff or job. Automatic completion requires both
  `stage_key='editing_autohdr'` and that persisted entry revision; the out-and-back
  `rev 5 → rev 6 → rev 7` race is an explicit test.

- **Blocking 3 — command/DB seam:** `@quincy/db` owns prepared winner, activity, and
  marker-gated Deadline-suppression bundles. The app/background caller composes them using exported
  fixed result indexes; an executor-owned post-commit finalizer performs legacy workflow
  notifications and Queue publication only after a winner.

- **Blocking 4 — hidden External neighbours:** Exact placement has one canonical global anchor:
  insert immediately before the caller-visible `after` row; if `after` is null, append globally.
  Hidden rows retain relative order, and the full server-side target-Stage snapshot is fenced.

- **Blocking 5 — independently green slices:** Additive compatibility surfaces remain until all
  consumers move. The Priority route rewrite, its tests, and removal of
  `priorityInsertNeighbors` are one slice; removal of `onSuccess` is co-located with all remaining
  callers.

- **Blocking 6 — old-writer freeze and inert contract:** Rollout uses one reviewed,
  migration-aware app/background source revision and a durable seeded-OFF
  `tb5a_board_contract_enabled` feature flag. Queue, Workflow, Cron, reconciliation, and app Board
  writes are drained or paused before migration, and no old Stage writer may run afterward.

- **Should-fix 1 — executable normalization:** The plan now contains the complete migration
  `WITH ranked … INSERT` and guarded `UPDATE … FROM` statements, including preflight and postflight
  failure gates. The exact SQL must pass local Wrangler and scratch-D1 full-chain and upgrade proofs.

- **Should-fix 2 — bind syntax:** All prepared-statement examples use `?` or numbered `?NNN`
  parameters. No normative SQL uses named parameters.

- **Should-fix 3 — noncanonical Stage keys:** Migration `0037` fails before capture unless every
  unarchived `projects.stage_key` belongs to shared `STAGE_KEYS`.

- **Should-fix 4 — `selectForEditing` disposition:** The resolved foundation contains the exact
  MOVE/STAY call-site table. External Editor gains Stage movement but no RAW selection,
  deselection, review, ZIP, or download-selection capability.

- **Should-fix 5 — writer inventory:** The resolved foundation identifies every current production
  Stage writer by file/function, current primitive, audit action, prerequisite, post-success
  notification, and TB5A target form.

- **Should-fix 6 — legacy body handling:** Both Stage route forms inspect the raw decoded object for
  the exact legacy `{stageKey}` shape before strict schema parsing and return
  `409 stage_contract_reload_required` without mutation.

- **Should-fix 7 — External order correction:** Migration preserves the current internal comparator
  but intentionally replaces External Editor’s manufactured-zero/ID order with the authorized
  projection of canonical persisted order. This is tested as a deliberate one-time presentation
  correction.

The three round-1 review nits are also applied: the review-state SHAs distinguish baseline from
draft, migration prose consistently says “unarchived project,” and the transport helper is named
`stageTransportKeyForRole`, with DTO/label projection kept separate.

## Round 2 revision log

- **Blocking 1 — executable all-or-zero compaction:** The compacting winner is now labelled
  normative executable SQL and uses unqualified `RETURNING` columns. Its fence proves distinct and
  set-equal target snapshots, exact changed-plan membership, one exact target, deterministic
  compacted positions, and live tuple agreement for every changed row before admitting candidates.

- **Blocking 2 — executable workflow token persistence:** Automatic Editing-entry batches now end
  with a marker-gated token `UPDATE` that re-reads `projects.board_revision` inside SQL; no
  `RETURNING` value is rebound between D1 statements. Job-owned paths propagate the exact entry-job
  identity to later completion jobs; the completion job never assumes that its own ID owns the
  token, and missing legacy provenance fails closed.

- **Blocking 3 — authoritative Workspace detail revision:** Internal `ProjectDetail` and the strict
  `ExternalProjectDetailDto` now include role-safe `boardRevision` and `contractEnabled`. Direct
  Workspace deep links can therefore construct expected-state requests without first visiting the
  Dashboard, while External detail remains sentinel-tested against `priority` and raw
  `boardPosition`.

- **Blocking 4 — Slice 4/7 rendering authority:** Authoritative Board-map consumption moves into
  Slice 4 with the server projections and strict adapters. Slice 4 independently proves that an
  External Board renders server-authorized rank rather than manufactured zero/ID order; Slice 7
  adds interactions and views but does not change the ordering authority.

- **Blocking 5 — all-or-zero rollback:** The pre-enable position rollback is now an exact D1 batch:
  a guard table, the rollback `UPDATE`, a following `changes()`-driven CHECK insert, and guard-table
  drop. A count mismatch fails the batch and rolls back every preceding statement, including all
  otherwise matching row restorations.

- **Blocking 6 — complete pre-schema variants:** Each Worker isolate performs one old-schema-safe
  marker check before selecting prepared statements. Pre-marker list/detail reads use old-column
  projections, every Board-affecting writer and the Priority route returns bounded maintenance,
  and no statement referencing a `0037` column is constructed or prepared before the marker exists.

- **Should-fix 1 — exact Drizzle migration file:** Every statement in the displayed `0037` SQL is
  now separated by `--> statement-breakpoint`. The block is the exact checked-in migration file,
  subject only to renumbering if production has claimed `0037`.

- **Should-fix 2 — hidden-top placement fixture:** The canonical-neighbour matrix now includes
  global `H1,H2,B`, visible `B`, and `{before:null, after:B}`. The required result is global
  `H1,H2,target,B` and visible `target,B`.

- **Should-fix 3 — complete named bundle indexes:** `ActivityBundleIndexes` now includes
  `broadLedger`, and automatic variants export a discriminated `WorkflowTailIndexes` naming every
  prerequisite, state, final-claim, job, and entry-token tail even when a caller currently consumes
  only publication IDs.

The round-2 nits are also applied: compacting SQL is explicitly normative and executable, and the
migration suite must prove that a postflight CHECK failure rolls back the preceding
ALTER/capture/update sequence rather than merely reporting failure.

## Round 3 revision log (Opus APPROVE conditions)

- **Migration splitter safety:** Both normalization comparator occurrences now use
  `(priority IS NULL),` instead of a comma-followed `CASE … END,`. The migration suite runs
  Wrangler’s own `splitSqlQuery` over the checked-in file, proves one statement per
  breakpoint-delimited segment, and rejects any remaining compound `END` followed by punctuation
  that can keep Wrangler’s compound frame open.

- **Pinned all-or-zero fences:** Every single-reference fence CTE carrying a snapshot guarantee is
  declared `AS MATERIALIZED`. The compacting and non-compacting exact-placement statements receive
  scratch-D1 query-plan assertions; the compacting plan must contain `MATERIALIZE fence`. The
  rollback batch continues to use its transactional following-CHECK gate and has no fence CTE to
  pin.

- **Same-Stage capability boundary:** A placement-changing request whose target semantic Stage
  equals the project’s current Stage is rejected with
  `403 project_board_reorder_forbidden` unless the principal also holds `prioritizeProjects`.
  Authorized same-Stage reorder is delegated exclusively to `project-board-order.ts`, emits
  `project.board_position_set`, and never becomes a weaker path through `moveProjectStage`.
  Cross-Stage `moveProjectStage` behavior is unchanged.

- **Complete writer ownership:** Slice 0 now closes only after a complete Stage-and-position writer
  inventory assigns every current writer to a slice. The three legacy ordering helpers
  `priorityInsertNeighbors`, `manualInsertNeighbors`, and `renumberedInsertPosition` and their
  shared test imports are removed or rewritten together in Slice 5. No writer may leave Slice 6
  still changing `board_position` without the corresponding `board_revision`.

- **Migration-number coupling:** Renumbering `0037` requires one atomic checklist edit to the
  rollback table name, its unique-index name, every Worker marker literal, migration filename,
  snapshot, journal, tests, and scratch objects.

- **Activity contract simplified:** `project.stage.changed` keeps `emptyPayload`; there is no
  from/to Stage payload and therefore no new semantic-Stage leak surface. Its registry entry moves
  from reserved/cutover to live with the exact producer and source-key shape
  `project-stage:<projectId>:transition:<activityId>`. Its generic safe copy remains appropriate.

- **External stage DTO tightened:** External summary/detail `stageKey` becomes
  `z.enum(STAGE_PRESENTATION_KEYS)`. The existing `editing_autohdr → editing` conversion moves into
  `stageTransportKeyForRole`; no parallel `externalStageKey` helper remains.

- **Executable non-compacting fence:** The plan now specifies the full normative SQL for the
  non-compacting exact-placement winner, including JSON validation, type checks, bidirectional
  target-column set equality, and exact source Stage/revision fencing.

- **Compaction cost made explicit:** A compaction is a full-column renumber to
  `0,1024,2048,…`; every changed row receives a revision bump, invalidating other clients’ tokens
  and potentially producing visible `409` churn. Slice 8 benchmarks bounded representative column
  sizes and stops rollout if production exceeds the reviewed measured envelope.

- **Drizzle snapshot discipline:** Migration-only rollback/scratch tables and the migration-only
  normalization index stay out of `schema.ts` and `0037_snapshot.json`, following the migration
  `0015` backup-table precedent.

- **Pre-marker reads enumerated:** The six current bare project selects that would expand after the
  Drizzle schema change are explicitly assigned pre-`0037` projections:
  `projects.ts:247,492,559,1121` and `tonomo/process.ts:72,80`. Repository audit found no additional
  bare project selects.

- **Review nits closed:** Slice 0 records the legacy `1024,2048,…` versus migration
  `0,1024,…` normalization difference; the trailing-slash Stage route is documented as net-new
  strict-Hono surface; and removal of `/admin/backfill-board-position` includes
  `admin.board_position_backfill`, its route-manifest entry, and its tests.

## Purpose

TB5A establishes one Stage-movement contract and removes the hidden coupling between Priority and
manual Kanban order.

Delivered outcomes:

- Admins, internal Editors, and assigned External Editors can move an unarchived project from the
  Project Workspace rail, native Kanban drag, or a keyboard/non-drag action.
- Every human cross-Stage change uses one command with identical capability, authorization,
  expected-state, confirmation, audit, activity, Deadline, notification, and conflict semantics.
- Same-Stage manual reorder remains Admin-only through `prioritizeProjects` and the dedicated
  Board-order command.
- Manual entry into or exit from Editing and Delivered changes Stage only. It does not send,
  retrieve, cancel, retire, publish, revoke, or delete workflow state.
- `board_position` is the sole persisted manual order. Priority and shoot-date modes are non-writing
  views.
- Current internal visible order is frozen once into canonical persisted order.
- External Editor receives only the authorized projection of that order.
- Automatic workflow completion cannot defeat an intervening human move, including an out-and-back
  ABA sequence.
- TB5A remains complete if TB5B never ships; dnd-kit is not required.

## Authority and dependency boundary

Authority applies in this order:

1. `docs/Decision-Sheet.md`, especially D-17, D-18, and D-19.
2. `docs/Implementation-Plan.md`, especially A9–A11 and A14.
3. `docs/plans/revamp_2026_portal/roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md`.
4. Implemented TB2, TB4B, TB4C, TB4D, and TB4E plans.
5. `docs/PRD.md`, `Personas.md`, and `Sitemap.md`.
6. Current source where older prose has drifted.

Repository constraints remain mandatory:

- implementation occurs only under `portal/`;
- `@quincy/shared` owns capabilities and Stage keys;
- Hono middleware is path-scoped and both exact Stage route forms are registered;
- migration `0037` is additive and uses no generated table rebuild;
- media is never deleted by this feature;
- browser QA goes to Agy under `docs/Subagent-Orchestration.md`;
- deployment order remains background → webhook-ingress when changed → app.

Dependency sequence:

```text
TB2 → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C
```

## Resolved foundation on the implementation baseline

### Production and migration base

Verified locally:

- draft HEAD is `7f04955`; its implementation parent is `8b7b3f9`;
- the worktree contains user-owned untracked `qa-evidence/`, which must be preserved;
- the migration journal and directory end at `0036_external_editor_assigned_scope`;
- `docs/todo.md` records production migration `0036` as applied;
- planned migration number is `0037`, conditional on remote-tail confirmation;
- React and React DOM are `19.2.8`.

### Exact `selectForEditing` disposition

`selectForEditing` remains an internal RAW-selection capability. TB5A adds
`moveProjectStage`; it does not broaden RAW access.

| Disposition | Current call site | Current purpose | TB5A result |
|---|---|---|---|
| MOVE | `workers/app/src/routes/projects.ts:1117` | Stage API authorization | Use `moveProjectStage` |
| MOVE | `apps/web/src/screens/Dashboard.tsx:131` | Kanban drag gate | Use `moveProjectStage` |
| STAY | `workers/app/src/routes/review.ts:146` | RAW review/select/deselect | Remain `selectForEditing` |
| STAY | `workers/app/src/routes/projects.ts:184` | `selected-raw.zip` authorization | Remain `selectForEditing` |
| STAY | `workers/app/src/routes/projects.ts:827` | download-selection authorization | Remain `selectForEditing` |
| STAY | `apps/web/src/screens/ProjectWorkspace.tsx:395` | RAW review/selection/download UI | Remain `selectForEditing` |

Capability change:

```ts
export const CAPABILITIES = [
  // existing capabilities
  "selectForEditing",
  "moveProjectStage",
  // remaining capabilities
] as const;

export const EXTERNAL_EDITOR_CAPABILITIES = [
  "uploadEdited",
  "viewRaw",
  "annotateRaw",
  "recommendRaw",
  "compareFrames",
  "viewEdited",
  "reviewEdited",
  "annotateEdited",
  "collaborateOnProject",
  "moveProjectStage",
] as const satisfies readonly Capability[];
```

Grant `moveProjectStage` to Admin, internal Editor, and External Editor. Do not grant it to
Photographer. External possession of the capability never substitutes for current assignment,
unarchived-project, active-account, or TB4E visible-scope checks.

`prioritizeProjects` remains Admin-only. TB5A does not grant it to either Editor role.

### Exact current Stage-writer inventory

The current DB helper is `packages/db/src/stage-transition.ts#guardedStageTransition`. It guards
source Stage and archive state, appends to the destination, writes `stage.auto_advance`, and invokes
a best-effort `onSuccess` hook after a winning batch. It does not currently fence Board revision or
continuous workflow-owned Stage occupancy.

| File / function | Current primitive | Current Stage audit | Current prerequisite | Current notification | TB5A target | Slice |
|---|---|---|---|---|---|---|
| `workers/app/src/lib/ingest.ts#finalizeIngest` | `guardedStageTransition` | `stage.auto_advance` | Durable RAW asset | `raw_ready` | Automatic winner bundle; caller finalizer; no separate position write remains | 6 |
| `workers/background/src/dropbox/sync.ts#syncProjectRawFolder` | `guardedStageTransition` | `stage.auto_advance` | Reconciliation claim and RAW evidence | `raw_ready` | Automatic winner bundle; caller finalizer; no separate position write remains | 6 |
| `workers/background/src/reconcile-awaiting-raw.ts#advanceAwaitingRawProject` | Direct guarded Stage/append update and audit batch | `stage.auto_advance` | Shoot date due on Sydney business date | `raw_ready` | Typed reconciliation prerequisite | 6 |
| `workers/background/src/autohdr/claims.ts#confirmAutoHdrHandoff` | Direct Stage/append/audit/handoff batch | `stage.auto_advance` | Handoff identity/connection/generation/state | `sent_to_editing` | Winner plus handoff token tail | 6 |
| `workers/background/src/autohdr/claims.ts#claimAutoHdrRepeatSend` | Stage/append update inside claim batch | `stage.auto_advance` | Retirement/new mapping winner | None here | Winner plus new handoff token | 6 |
| `workers/background/src/autohdr/claims.ts#claimImplicitAutoHdrHandoff` | Direct Stage/append claim batch | `stage.auto_advance` | Mapping/path ownership | `sent_to_editing` | Winner plus handoff token tail | 6 |
| `workers/background/src/autohdr/claims.ts#claimBackfillAutoHdrHandoff` | Direct Stage/append claim batch | `stage.auto_advance` | Mapping/path claim | `sent_to_editing` | Winner plus handoff token tail | 6 |
| `workers/background/src/workflows/autohdr-api-send.ts#complete-autohdr-api-send` | Direct Stage/append/job/audit batch | Stage and workflow audits | Provider finalize and exact job | `sent_to_editing` | Winner plus job token tail | 6 |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` with handoff | `confirmAutoHdrHandoff` | As above | Frozen handoff | `sent_to_editing` | Converted handoff command | 6 |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` legacy no-handoff | Direct Drizzle Stage/append update | None | Legacy workflow input/source Stage | `sent_to_editing` | Propagated entry-job token or fail closed | 6 |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` same-hash | `guardedStageTransition` | `stage.auto_advance` | Handoff/mapping/fetch/coverage | `edited_landed` | Completion with handoff entry token; no separate position write remains | 6 |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` first-version | Direct asset/claim/Stage/append batch | `stage.auto_advance` | Current asset and coverage | `edited_landed` | Completion with handoff entry token | 6 |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` replacement | `guardedStageTransition` | `stage.auto_advance` | Replacement claim and coverage | `edited_landed` | Completion with handoff entry token; no separate position write remains | 6 |
| `workers/background/src/workflows/autohdr-fetch.ts#advance-stage` legacy | Direct Drizzle Stage/append update | None | Returned edited coverage | `edited_landed` | Propagated entry-job token or fail closed | 6 |
| `workers/app/src/routes/projects.ts` Stage handler | Unguarded Stage/append write | `stage.set` | Route-local access | Legacy `delivered` | Replaced by `moveProjectStage` | 5 |

The three existing `guardedStageTransition` owners—`ingest.ts`, `sync.ts`, and both named
`finals.ts` callers—do not retain or add a direct position update outside their converted automatic
winner bundle. The append and revision change are one DB-owned winner.

### Complete current Stage-and-position writer inventory

Slice 0 must verify this table against source before it closes. A newly discovered writer is added
to the table and assigned before implementation continues.

| Writer / source | Current primitive | Current audit | Prerequisite / guard | Current post-success hook | TB5A target form | Slice |
|---|---|---|---|---|---|---|
| `POST /projects/:id/stage`, `projects.ts:1114-1133` | Direct Drizzle Stage plus `appendToStageBottomExpr` | `stage.set` | Route access, active Stage | Deadline follow-up and legacy `delivered` notification | Cross-Stage `moveProjectStage` winner/activity/Deadline bundle; same-Stage placement dispatches only to Board-order command | 5 |
| `POST /projects/:id/board-position`, `projects.ts:456-484` | `guardedBoardUpdate` using `plannedBoardState` | `project.board_position_set` | Access plus `prioritizeProjects` | None | `project-board-order.ts`; exact snapshot/revision; audit only | 5 |
| `guardedBoardUpdate` / `plannedBoardState`, `projects.ts:45-112` | Target update followed by per-row renumber writes | Caller-provided marker | Stage/position snapshots, incomplete revision contract | Caller-specific | Delete after DB-owned non-compacting/compacting bundles replace all callers | 5 |
| Priority route, `projects.ts:417-454`; `priorityInsertNeighbors`, import at `:19`, call at `:427` | Priority-coupled position planning through `guardedBoardUpdate` | `project.priority_set` plus `project.priority.changed` | `prioritizeProjects`, current Stage/position | Queue publication | Metadata-only guarded Priority update; no position/revision mutation | 5 |
| `manualInsertNeighbors`, `kanban-ordering.ts:33-40` | Directional neighbour derivation | None itself | Used only by manual Board route | None | Replaced by exact visible-neighbour request contract; delete with its tests | 5 |
| `renumberedInsertPosition`, `kanban-ordering.ts:42-50` | Legacy full-column `1024,2048,…` renumber plan | None itself | Called through `plannedBoardState` | None | Replaced by DB-owned `0,1024,…` compaction; delete with its tests | 5 |
| Raw app project creation insert, `projects.ts:323-328` | SQL insert with Stage-bottom subquery | Project-creation audit/activity chain | Eligibility and membership predicates | Scaffold trigger | Marker/flag-aware creation bundle appending at bottom with initial revision contract | 5 |
| Tonomo project creation, `workers/background/src/tonomo/process.ts:95-103` | Drizzle insert with `appendToStageBottomExpr` | Tonomo project audit | Exact order/address reconciliation | AutoHDR scaffold enqueue | Marker/flag-aware creation bundle; position and revision written together | 6 |
| Admin backfill route full-column writes, `admin.ts:309-343`, including Stage-bottom repair at `:338` | Per-row normalization plus retrying Stage-bottom correction | `admin.board_position_backfill` | Admin operator route | None | Entire route, route-manifest entry, audit expectation, and tests removed | 5 |
| Archive route, `projects.ts:974-1040` | Archive update removes row from visible Board but does not revise it | `project.archive` | Archive capability and document guards | Activity publication | Board-aware archive winner increments revision exactly once | 5 |
| Restore route, `projects.ts:1041-1071` | Clears archive fields without appending/revision | `project.restore` | Archive capability | Activity publication | Board-aware restore appends to Stage bottom and increments revision exactly once | 5 |
| `ingest.ts#finalizeIngest` | `guardedStageTransition` owns Stage-bottom position | `stage.auto_advance` | Durable RAW asset | `raw_ready` | One automatic winner bundle; no direct position write | 6 |
| `dropbox/sync.ts#syncProjectRawFolder` | `guardedStageTransition` owns Stage-bottom position | `stage.auto_advance` | Claim and RAW evidence | `raw_ready` | One automatic winner bundle; no direct position write | 6 |
| `autohdr/finals.ts` same-hash and replacement | `guardedStageTransition` owns Stage-bottom position | `stage.auto_advance` | Handoff/mapping/fetch/coverage | `edited_landed` | One automatic winner bundle per path; no direct position write | 6 |
| All remaining direct automatic rows in the preceding Stage inventory | Direct Stage-bottom writes | `stage.auto_advance` or currently missing audit on legacy paths | Exact workflow-specific prerequisite | Current owning workflow notification | DB-owned automatic winner plus revision/token tail | 6 |

`workers/app/test/kanban-ordering.test.ts` imports
`priorityInsertNeighbors`, `manualInsertNeighbors`, and `renumberedInsertPosition` together. Slice 5
must remove or rewrite all three imports, their helper definitions, and all affected expectations in
the same independently green slice.

No writer in either inventory may reach the end of Slice 6 while changing `board_position` without
also applying the required `board_revision` transition. The Slice 6 closeout audit is a hard gate,
not a later cleanup.

### Current Priority and External ordering behavior

The Priority route imports `priorityInsertNeighbors` at `projects.ts:19` and calls it at `:427`.
It currently encodes Priority changes into `board_position`.

The current internal Board comparator is:

```text
non-null Priority group first
then boardPosition
then id
```

Numeric `priority ASC` is not part of that comparator and must not be introduced during migration.

The current External adapter withholds raw position and manufactures `boardPosition: 0`, so External
Board order falls back to ID. TB5A intentionally changes that presentation once: External Editor
consumes the authorized projection of canonical persisted order. This is a correction, not a
promise to preserve External ID order.

## Scope

### In scope

- Add `moveProjectStage` while retaining RAW-only `selectForEditing`.
- Add Stage sequence, transport projection, confirmation classifier, strict schemas, conflict
  responses, and activity registry changes in `@quincy/shared`.
- Add `projects.board_revision`.
- Persist workflow-owned Editing-entry revisions.
- Normalize current internal Board order and retain permanent rollback evidence.
- Make Priority metadata-only and add a non-writing Priority view.
- Add one route-independent human Stage command and a capability-distinct same-Stage order command.
- Converge all Stage/position writers on shared prepared bundles.
- Add External-safe Board order, revision, and contract-state projections.
- Add Project Workspace rail, native drag, keyboard movement, confirmations, and refresh ownership.
- Activate human-only, non-coalesced `project.stage.changed`.
- Make Delivered Deadline suppression atomic with its winning Stage move.
- Add migration, API, DB, background-race, web, privacy, rollout, and browser evidence.

### Hard non-goals

- dnd-kit or TB5B;
- Calendar, FullCalendar, Deadline sorting, or Project Deadline redesign;
- configurable semantic Stage identities or transition graphs;
- External Priority or raw position;
- provider start/cancel/retrieve behavior caused by manual Stage movement;
- delivery publish/revoke behavior caused by manual Delivered movement;
- React/dependency migration;
- prototype changes;
- media deletion;
- a second activity/outbox system;
- any expansion of same-Stage reorder authority beyond `prioritizeProjects`.

## Exact Stage domain contract

### Semantic and transport keys

`@quincy/shared` owns:

```ts
export const STAGE_KEYS = [
  "awaiting_raw",
  "raw_review",
  "editing_autohdr",
  "edited_review",
  "delivered",
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_PRESENTATION_KEYS = [
  "awaiting_raw",
  "raw_review",
  "editing",
  "edited_review",
  "delivered",
] as const;

export type StagePresentationKey =
  (typeof STAGE_PRESENTATION_KEYS)[number];

export type StageTransportKey = StageKey | "editing";
```

Helpers remain distinct:

```ts
stageTransportKeyForRole(stage: StageKey, role: Role): StageTransportKey
parseStageTransportKey(value: unknown, role: Role): StageKey | null
projectStageDtoForRole(stage: PipelineStage, role: Role): RoleSafeStageDto
```

`stageTransportKeyForRole` owns the existing `editing_autohdr → editing` role projection now
implemented separately as `external-project-query.ts#externalStageKey`. Delete that parallel helper
and route every External DTO projection through the shared transport helper.

Rules:

- Admin may receive and submit `editing_autohdr`.
- Internal and External Editors receive and submit only `editing`.
- Non-Admin submission of `editing_autohdr` is invalid.
- The server maps `editing` to `editing_autohdr` only after authentication and capability checks.
- Audit/activity storage uses semantic `StageKey`.
- Provider vocabulary never appears in non-Admin API, DOM, modal, toast, console, or notification
  payloads.

In `packages/shared/src/external-project-dto.ts`:

```ts
stageKey: z.enum(STAGE_PRESENTATION_KEYS)
```

replaces `stageKey: z.string()` in `externalProjectSummarySchema`. The detail schema extends summary
and therefore inherits the same restriction. This change must land before the strict-decoding
internal-Editing sentinel is considered meaningful.

### Sequence and cumulative confirmation

```ts
export const STAGE_SEQUENCE = [
  "awaiting_raw",
  "raw_review",
  "editing_autohdr",
  "edited_review",
  "delivered",
] as const satisfies readonly StageKey[];

export const STAGE_MOVE_CONFIRMATION_REASONS = [
  "backward",
  "skipped_forward",
  "delivered_boundary",
  "editing_boundary",
] as const;
```

`stageMoveConfirmationReasons(from, to)` returns a deduplicated array in that constant order:

- `backward` when `to` precedes `from`;
- `skipped_forward` when `to` is more than one semantic step ahead;
- `delivered_boundary` when exactly one side is Delivered;
- `editing_boundary` when exactly one side is Editing;
- empty for same Stage or an ordinary one-step forward crossing neither special boundary.

Reasons are cumulative. The server recomputes them from authoritative semantic state and requires
exact array equality. Missing, extra, duplicated, or reordered reasons return `409`:

```json
{
  "error": "Confirmation is required for this Stage move.",
  "code": "stage_confirmation_required",
  "requiredConfirmation": {
    "fromStageKey": "role-safe-current",
    "toStageKey": "role-safe-target",
    "reasons": []
  },
  "current": {}
}
```

Cancelling performs no request or optimistic mutation. Confirmation copy explains backward
movement, skipped production steps, Stage-only Delivered behavior, and Stage-only Editing behavior.
One modal may explain multiple reasons.

### Active/inactive and archived behavior

- Only an active configured Stage may be entered.
- An inactive current Stage remains displayed and can be exited.
- An inactive non-current Stage cannot be entered.
- Same-Stage selection with unchanged placement is a no-op.
- A same-Stage placement change is not a Stage move. If the principal lacks
  `prioritizeProjects`, return:

```json
{
  "error": "Forbidden: manual Board reorder requires prioritizeProjects.",
  "code": "project_board_reorder_forbidden",
  "capability": "prioritizeProjects"
}
```

  with HTTP `403` and zero audit/activity/outbox footprint.
- If the principal holds `prioritizeProjects`, dispatch the same-Stage placement change exclusively
  to `project-board-order.ts`; a winner writes `project.board_position_set`. It does not write
  `stage.set`, `project.stage.changed`, or a Stage audit.
- Cross-Stage `moveProjectStage` remains governed only by `moveProjectStage` plus project visibility
  and is unaffected by this same-Stage rule.
- Archived Dashboard remains List-only.
- Admin/internal Editor receives `409 project_archived_read_only`.
- External missing, unassigned, archived, or nonexistent project receives the same generic `404`.
- Photographer receives a constant capability `403`.
- No failed or no-op request writes Stage, position, revision, audit, activity, outbox, Deadline, or
  workflow state.

Tests include an internal Editor and an External Editor each submitting a same-Stage
`between` placement. Both receive `403 project_board_reorder_forbidden`, no existence or hidden-row
leak, and zero mutation footprint.

## Board revision, placement, and transport types

### Per-project revision

Migration `0037` adds:

```ts
boardRevision: integer("board_revision").notNull().default(0)
```

with:

```sql
CHECK (
  typeof(board_revision) = 'integer'
  AND board_revision >= 0
  AND board_revision <= 9007199254740991
)
```

Increment exactly once for every committed Board-state change affecting that row:

- Stage change;
- position change;
- archive removal;
- restore append.

Compaction increments each sibling whose position actually changes. Priority-only, Deadline, view
sort, and shoot date do not increment it.

Existing unarchived projects receive migration baseline revision `1`. Archived projects remain `0`
until restore appends and increments them. New projects start at revision `0`.

### Workflow entry tokens

Migration `0037` also adds nullable safe-integer columns:

```text
autohdr_handoffs.editing_entry_board_revision
jobs.stage_entry_board_revision
```

A workflow-owned transition into Editing records the winning project revision in its owning
handoff or entry job inside the same D1 batch. Manual Editing entry never writes these tokens.

Automatic Editing → Edited Review completion requires:

```text
projects.stage_key = 'editing_autohdr'
AND projects.board_revision = owning_workflow.editing_entry_board_revision
```

plus the exact existing handoff/job/import prerequisite. A null token or absent source-owner
identity fails closed.

### Request types

```ts
export type ExpectedBoardProject = {
  projectId: string;
  boardRevision: number;
};

export type StageMovePlacement =
  | { kind: "append" }
  | {
      kind: "between";
      before: ExpectedBoardProject | null;
      after: ExpectedBoardProject | null;
    };

export type MoveProjectStageRequest = {
  expected: {
    stageKey: StageTransportKey;
    boardRevision: number;
  };
  targetStageKey: StageTransportKey;
  placement: StageMovePlacement;
  confirmation?: {
    reasons: StageMoveConfirmationReason[];
  };
};
```

Objects are strict. IDs are UUIDs; revisions are safe non-negative integers; neighbours are distinct
and cannot equal the target; confirmation reasons cannot repeat.

Both-null `between` normalizes to append. Bottom placement uses append, not a visible neighbour that
might hide later global rows.

### Canonical hidden-neighbour rule

For a `between` request:

1. `before` and `after` must be adjacent in the caller’s authorized target-column projection after
   excluding the moving target.
2. Each supplied neighbour must remain visible, unarchived, in the semantic target Stage, and at the
   supplied revision.
3. The server loads and fences the complete target-Stage snapshot, including rows hidden from the
   caller.
4. If `after` is non-null, the canonical global anchor is immediately before that global row.
5. If `after` is null, placement is a global append after every target-Stage row.
6. Hidden rows keep their relative order.
7. The response returns only the caller-visible order.

Examples:

```text
global:  A,H,B
visible: A,B
request: before=A, after=B
result:  A,H,target,B
```

```text
global:  H1,H2,B
visible: B
request: before=null, after=B
result global:  H1,H2,target,B
result visible: target,B
```

Tests cover zero, one, and multiple hidden rows, hidden rows above the first visible row, midpoint
space, forced compaction, and global append.

### Response and conflict

```ts
export type StageMoveProjectState = {
  projectId: string;
  stageKey: StageTransportKey;
  boardRevision: number;
};

export type StageMoveBoardState = {
  sourceStageKey: StageTransportKey;
  targetStageKey: StageTransportKey;
  orderedVisibleProjectIds: string[];
};

export type MoveProjectStageResponse = {
  changed: boolean;
  project: StageMoveProjectState;
  board: StageMoveBoardState;
};
```

External responses never contain Priority, raw position, hidden IDs, or the internal Editing key.

Changed Stage/revision/neighbour/snapshot/assignment premises return
`409 project_stage_conflict` with authoritative role-safe current state and no automatic retry.
Archived, inactive-destination, confirmation-required, contract-disabled, same-Stage-reorder
forbidden, and pre-schema maintenance results use distinct codes.

## Human Stage command and route

Add:

```text
portal/workers/app/src/lib/project-stage.ts
```

with:

```ts
moveProjectStage({
  env,
  principal,
  projectId,
  request,
  now?,
}): Promise<MoveProjectStageResult>
```

The command owns:

1. schema-variant and durable-feature-flag admission;
2. active principal and `moveProjectStage`;
3. External visible-project authorization before existence disclosure;
4. archive state;
5. role-safe transport normalization;
6. expected Stage and revision;
7. same-Stage placement classification and `prioritizeProjects` enforcement;
8. active destination;
9. confirmation classification and equality;
10. neighbour visibility and revision;
11. complete target-Stage snapshot;
12. canonical placement;
13. prepared winner/activity/Deadline bundle composition;
14. fixed result-index interpretation;
15. authoritative role-safe reread;
16. publication IDs and finalizer intent.

Expected results are exhaustive and non-throwing:

```ts
type MoveProjectStageResult =
  | {
      kind: "moved";
      response: MoveProjectStageResponse;
      finalizer: CommittedStageFinalizerIntent;
    }
  | { kind: "no_change"; response: MoveProjectStageResponse }
  | { kind: "forbidden"; capability: "moveProjectStage" }
  | {
      kind: "reorder_forbidden";
      code: "project_board_reorder_forbidden";
      capability: "prioritizeProjects";
    }
  | { kind: "not_found" }
  | { kind: "archived"; current: StageMoveProjectState }
  | { kind: "inactive_destination"; current: StageMoveProjectState }
  | {
      kind: "confirmation_required";
      current: StageMoveProjectState;
      required: {
        fromStageKey: StageTransportKey;
        toStageKey: StageTransportKey;
        reasons: StageMoveConfirmationReason[];
      };
    }
  | { kind: "conflict"; current: StageMoveProjectState | null }
  | { kind: "disabled" }
  | { kind: "schema_maintenance" };
```

An authorized same-Stage placement change is handed to the dedicated Board-order command rather
than executed as a Stage winner. Unexpected D1/runtime failures throw and remain `500`.

### Route forms and legacy discriminator

Register one shared handler for:

```text
POST /projects/:id/stage
POST /projects/:id/stage/
```

Both use the same session, CSRF, terminal-route, body, command, and finalizer chain.

`POST /projects/:id/stage/` is net-new surface because the app uses default strict Hono routing
(`workers/app/src/index.ts:34`); it is not a regression guard. The route-manifest audit must expect
the new explicit route.

After JSON decoding but before strict TB5A parsing:

```ts
const isExactLegacyStageBody =
  isPlainObject(body) &&
  Object.keys(body).length === 1 &&
  Object.prototype.hasOwnProperty.call(body, "stageKey") &&
  typeof body.stageKey === "string";
```

If true, return `409` without authorization or mutation:

```json
{
  "error": "Reload the application before moving this project.",
  "code": "stage_contract_reload_required"
}
```

Other invalid objects go through the strict parser and normally return `400`. The route performs no
Stage SQL, audit, Deadline suppression, legacy `delivered` notification, or independent retry.

## DB bundle and command layering

### Ownership

`@quincy/db` owns prepared-statement construction for:

1. Stage/position/revision winner and audit marker;
2. existing project activity/outbox/ledger bundle;
3. marker-gated Project Deadline suppression;
4. typed workflow prerequisite, state, final-claim, job, and entry-token tails.

The app/background layer owns authorization, snapshot loading, typed bundle selection, statement
composition, exported-index interpretation, authoritative reread, and post-commit finalization.

`packages/db` does not import `workers/app`. The app Deadline module no longer owns SQL generation;
its public helper delegates to the DB-owned suppression bundle.

No caller supplies arbitrary SQL. Workflow prerequisites are a closed typed union:

```ts
type GuardedTransitionPrerequisite =
  | { kind: "none" }
  | { kind: "raw_reconciliation"; claimId: string; shootDate: string }
  | {
      kind: "autohdr_handoff";
      handoffId: string;
      generation: number;
      connectionId: string;
    }
  | {
      kind: "autohdr_mapping";
      mappingId: string;
      handoffId: string;
      generation: number;
    }
  | {
      kind: "autohdr_final_claim";
      claimId: string;
      handoffId: string;
      mappingId: string;
      currentAssetId: string;
    }
  | {
      kind: "autohdr_job";
      jobId: string;
      generation: number;
      projectId: string;
    };
```

### Complete prepared-bundle indexes

Every builder returns a fixed layout and named indexes:

```ts
type PreparedStatementBundle<TIndexes> = {
  statements: D1PreparedStatement[];
  indexes: TIndexes;
};

type StageWinnerIndexes = {
  winner: number;
  auditMarker: number;
};

type ActivityBundleIndexes = {
  activity: number;
  broadOutbox: number;
  broadLedger: number;
};

type DeadlineSuppressionIndexes = {
  occurrences: number;
  ledgers: number;
  outboxes: number;
};

type WorkflowTailIndexes =
  | { kind: "none" }
  | {
      kind: "raw_reconciliation";
      prerequisiteMarker: number;
    }
  | {
      kind: "autohdr_handoff_entry";
      prerequisiteMarker: number;
      handoffState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_mapping_entry";
      prerequisiteMarker: number;
      handoffState: number;
      mappingState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_final_completion";
      prerequisiteMarker: number;
      handoffState: number;
      mappingState: number;
      finalClaimState: number;
    }
  | {
      kind: "autohdr_job_entry";
      prerequisiteMarker: number;
      jobState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_job_completion";
      prerequisiteMarker: number;
      sourceEntryJob: number;
      completionJobState: number;
    };
```

A composed bundle exports:

```ts
type ComposedStageBundleIndexes = {
  stage: StageWinnerIndexes;
  activity?: ActivityBundleIndexes;
  deadline?: DeadlineSuppressionIndexes;
  workflow: WorkflowTailIndexes;
};
```

The command offsets each nested index exactly once. It never relies on magic offsets, treats the
last result as an implicit winner, or omits a named tail merely because the current caller reads
only publication IDs.

### Post-commit finalizer and `onSuccess`

The final Stage-transition interface does not retain `onSuccess`.

```ts
type CommittedStageFinalizerIntent = {
  publicationIds: string[];
  legacyWorkflowNotification?:
    | "raw_ready"
    | "sent_to_editing"
    | "edited_landed";
};
```

The intent is constructed only when all required winner-result rows agree. It:

- publishes returned outbox IDs;
- invokes the existing legacy workflow notification only for the owning automatic workflow;
- never runs for a loser, no-op, conflict, failed batch, or inconsistent returned-result shape;
- preserves current best-effort error handling after commit.

Migration remains staged:

- `guardedStageTransition(..., onSuccess)` remains through the additive DB slice;
- `ingest.ts`, `sync.ts`, both named `finals.ts` callers, and every direct notification owner move
  to explicit finalizer intents in the automatic-writer slice;
- `onSuccess` and its compatibility executor are removed only after all callers move.

Human `moveProjectStage` produces Queue publication IDs but no legacy workflow notification.

## Two mutually exclusive Stage winner forms

### Non-compacting winner — normative exact-placement SQL

A non-compacting move consists of:

1. one guarded target-project update;
2. one audit marker requiring `changes() = 1`;
3. marker-gated activity, outbox/ledger, workflow, and Deadline tails.

Append is computed inside the guarded update:

```sql
SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
```

For exact placement, the following is normative executable SQL. It must pass scratch D1 alongside
the compacting form.

Parameters:

```text
?1  expectedTargetJson
?2  'tb5a_board_contract_enabled'
?3  expectedTargetRowCount excluding target
?4  semantic target Stage
?5  target project ID
?6  target old semantic Stage
?7  target old board revision
?8  computed non-compacting board position
?9  updated_at timestamp
```

Each `expectedTargetJson` row is:

```ts
type ExpectedTargetPlacementRow = {
  projectId: string;
  stageKey: StageKey;
  boardPosition: number;
  boardRevision: number;
};
```

```sql
WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?2
      AND enabled = 1
  )
  AND json_valid(?1)
  AND (SELECT COUNT(*) FROM expected_target) = ?3
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?4
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
  )
  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ) = ?3
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?4
      AND p.archived_at IS NULL
      AND p.id <> ?5
      AND e.project_id IS NULL
  )
)
UPDATE projects AS p
SET
  stage_key = ?4,
  board_position = ?8,
  board_revision = p.board_revision + 1,
  updated_at = ?9
FROM fence
WHERE p.id = ?5
  AND p.stage_key = ?6
  AND p.board_revision = ?7
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
```

The SQL validates `json_valid`, every JSON field type, distinct expected IDs, both directions of
set equality against the complete live unarchived target-Stage snapshot, and the target’s exact
source Stage and revision. Any ID, Stage, position, revision, archive state, or row-count change
updates zero rows.

The append specialization retains the exact source Stage/revision, durable flag, and complete
target-snapshot fence, but computes its final position from the fenced destination inside the
winner. It does not trust a client-supplied numeric position.

Every single-reference fence CTE carrying an all-or-zero premise uses `AS MATERIALIZED`.
Scratch-D1 query-plan tests inspect both non-compacting and compacting statements. The compacting
plan must contain `MATERIALIZE fence`; the non-compacting plan must show the pinned fence rather
than a co-routine/inlined evaluation.

### Compacting winner — normative executable SQL

The following SQL is normative executable SQL. The builder must run it against scratch D1 as
written and may not weaken, silently repair, or replace its fences.

Parameters:

```text
?1  expectedTargetJson
?2  changedPlanJson
?3  'tb5a_board_contract_enabled'
?4  expectedChangedRowCount
?5  expectedTargetRowCount excluding target
?6  semantic target Stage
?7  target project ID
?8  target old semantic Stage
?9  target old board revision
?10 updated_at timestamp
```

`expectedTargetJson` is the complete live target-Stage snapshot excluding the moving target. Every
row contains the live tuple plus its deterministic post-compaction position:

```ts
type ExpectedTargetCompactionRow = {
  projectId: string;
  stageKey: StageKey;
  boardPosition: number;
  boardRevision: number;
  newBoardPosition: number;
};
```

`changedPlanJson` contains the target plus only siblings whose deterministic new position differs
from their old position. `isTarget` is the integer `0` or `1`, not a JSON boolean:

```ts
type ChangedCompactionRow = {
  projectId: string;
  oldStageKey: StageKey;
  oldBoardPosition: number;
  oldBoardRevision: number;
  newBoardPosition: number;
  isTarget: 0 | 1;
};
```

```sql
WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
changed_plan AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.oldStageKey') AS old_stage_key,
    json_type(value, '$.oldStageKey') AS old_stage_key_type,
    CAST(json_extract(value, '$.oldBoardPosition') AS REAL) AS old_board_position,
    json_type(value, '$.oldBoardPosition') AS old_board_position_type,
    CAST(json_extract(value, '$.oldBoardRevision') AS INTEGER) AS old_board_revision,
    json_type(value, '$.oldBoardRevision') AS old_board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type,
    CAST(json_extract(value, '$.isTarget') AS INTEGER) AS is_target,
    json_type(value, '$.isTarget') AS is_target_type
  FROM json_each(
    CASE WHEN json_valid(?2) THEN ?2 ELSE '[]' END
  )
),
required_changed AS (
  SELECT ?7 AS project_id
  UNION ALL
  SELECT project_id
  FROM expected_target
  WHERE new_board_position IS NOT board_position
),
planned_destination AS (
  SELECT project_id, new_board_position
  FROM expected_target
  UNION ALL
  SELECT project_id, new_board_position
  FROM changed_plan
  WHERE is_target = 1
),
ordered_destination AS (
  SELECT
    project_id,
    new_board_position,
    ROW_NUMBER() OVER (
      ORDER BY new_board_position, project_id
    ) - 1 AS desired_rank
  FROM planned_destination
),
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?3
      AND enabled = 1
  )
  AND json_valid(?1)
  AND json_valid(?2)

  AND (SELECT COUNT(*) FROM expected_target) = ?5
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?6
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
  )

  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?6
      AND archived_at IS NULL
      AND id <> ?7
  ) = ?5
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?6
      AND p.archived_at IS NULL
      AND p.id <> ?7
      AND e.project_id IS NULL
  )

  AND (SELECT COUNT(*) FROM changed_plan) = ?4
  AND (SELECT COUNT(DISTINCT project_id) FROM changed_plan) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE project_id_type <> 'text'
       OR old_stage_key_type <> 'text'
       OR old_board_position_type NOT IN ('integer', 'real')
       OR old_board_revision_type <> 'integer'
       OR old_board_revision < 0
       OR old_board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
       OR is_target_type <> 'integer'
       OR is_target NOT IN (0, 1)
  )
  AND (
    SELECT COUNT(*)
    FROM changed_plan
    WHERE is_target = 1
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE is_target = 1
      AND project_id = ?7
      AND old_stage_key = ?8
      AND old_board_revision = ?9
  )

  AND (SELECT COUNT(*) FROM required_changed) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM required_changed r
    LEFT JOIN changed_plan c
      ON c.project_id = r.project_id
    WHERE c.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    LEFT JOIN required_changed r
      ON r.project_id = c.project_id
    WHERE r.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    WHERE c.is_target = 0
      AND NOT EXISTS (
        SELECT 1
        FROM expected_target e
        WHERE e.project_id = c.project_id
          AND e.stage_key = c.old_stage_key
          AND e.board_position IS c.old_board_position
          AND e.board_revision = c.old_board_revision
          AND e.new_board_position IS c.new_board_position
      )
  )

  AND (SELECT COUNT(*) FROM planned_destination) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT project_id)
    FROM planned_destination
  ) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT new_board_position)
    FROM planned_destination
  ) = ?5 + 1
  AND NOT EXISTS (
    SELECT 1
    FROM ordered_destination
    WHERE new_board_position
          IS NOT CAST(desired_rank * 1024 AS REAL)
  )

  AND (
    SELECT COUNT(*)
    FROM changed_plan c
    JOIN projects p
      ON p.id = c.project_id
    WHERE p.stage_key = c.old_stage_key
      AND p.board_position IS c.old_board_position
      AND p.board_revision = c.old_board_revision
      AND p.archived_at IS NULL
  ) = ?4
)
UPDATE projects AS p
SET
  stage_key = CASE
    WHEN c.is_target = 1 THEN ?6
    ELSE p.stage_key
  END,
  board_position = c.new_board_position,
  board_revision = p.board_revision + 1,
  updated_at = ?10
FROM changed_plan c, fence
WHERE p.id = c.project_id
  AND p.stage_key = c.old_stage_key
  AND p.board_position IS c.old_board_position
  AND p.board_revision = c.old_board_revision
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
```

The fence establishes all of the following before any candidate is admitted:

- `expected_target` has distinct IDs and is set-equal to the complete live unarchived destination
  snapshot excluding the target;
- every expected row matches live Stage, position, revision, and archive state;
- no live unarchived destination row is absent from `expected_target`;
- `changed_plan` has distinct IDs and exactly `expectedChangedRowCount` rows;
- exactly one row has `is_target=1`, and it is the requested target;
- `changed_plan` is set-equal to the target plus exactly the siblings whose position changes;
- every sibling plan row agrees with its expected old tuple and deterministic new position;
- the complete destination has unique positions exactly `0,1024,2048,…`;
- exactly `expectedChangedRowCount` changed-plan rows match their full old tuples against live
  projects.

The same-stage reorder specialization must retain these proofs. It may not replace them with
per-row guards that permit a partial renumber.

Every compaction is intentionally a full-column normalization to `0,1024,2048,…`. Every row whose
position changes increments `board_revision`, invalidating every other client’s optimistic token
for that column. On a large column this can cause visible, expected `409 project_stage_conflict`
churn; TB5A does not auto-retry or silently rebase those clients.

The following audit marker remains immediate:

```sql
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  ?1,
  ?2,
  ?3,
  'project',
  ?4,
  ?5,
  ?6
WHERE changes() = ?7
RETURNING id;
```

`?7` is `1` for non-compacting winners and `expectedChangedRowCount` for compacting winners.
All subsequent tails require that exact audit ID.

Required malformed-plan tests run the normative SQL unchanged against scratch D1:

- duplicate ID in `expected_target`;
- duplicate ID in `changed_plan`;
- sibling marked `isTarget=1`;
- target missing or more than one target;
- one stale changed-row old Stage/position/revision tuple;
- changed plan missing a sibling whose deterministic position changes;
- extra unchanged sibling in changed plan;
- missing live target-Stage row from `expected_target`;
- extra expected row;
- non-deterministic, duplicate, or gapped new position.

Every malformed case updates zero rows and produces no audit or tail footprint.

## Automatic workflow safety and ABA fencing

> Superseded during the TB5A build — see docs/plans/tb5a/fence-rework-sol-design.md (+ fence-rework-opus-fixes.md) for the authoritative fenced design. This section is retained as the original intent.

Every automatic writer uses a DB-owned winner bundle while retaining its workflow owner:

- exact source Stage remains mandatory;
- archive remains forbidden;
- destination append remains canonical;
- exact workflow prerequisite remains in the same batch;
- winning Stage audit remains `stage.auto_advance`;
- no human confirmation or `project.stage.changed` event applies;
- legacy workflow notification remains at its current owning workflow.

### Executable Editing-entry token tail

D1 prepares every statement before executing a batch. No statement may attempt to bind a preceding
statement’s `RETURNING board_revision` value into a later statement.

Instead, the automatic Editing-entry bundle:

1. fences the precise handoff or job identity, generation, project, and expected prior token in its
   winner premise;
2. performs the Stage winner and audit marker;
3. appends any marker-gated workflow/activity/Deadline statements;
4. ends with exactly one marker-gated token `UPDATE` that re-reads the current project revision
   inside SQL;
5. interprets a winner only when the Stage winner, audit marker, and token tail each return their
   exact required row.

Handoff-owned tail:

```sql
UPDATE autohdr_handoffs
SET
  editing_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND project_id = ?1
  AND connection_id = ?4
  AND generation = ?5
  AND state = ?6
  AND editing_entry_board_revision IS ?7
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?8
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  generation,
  editing_entry_board_revision;
```

Job-owned tail:

```sql
UPDATE jobs
SET
  stage_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND kind = ?4
  AND project_id = ?1
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.projectId') = ?1
  AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ?5
  AND stage_entry_board_revision IS ?6
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?7
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  stage_entry_board_revision;
```

`IS ?7` / `IS ?6` binds either `NULL` for first entry or an explicit expected prior token for a
reviewed supported re-entry. The winning Stage predicate contains the same owner identity,
generation, project, and prior-token premise, so a Stage winner cannot legitimately produce a
zero-row token tail.

Any inconsistent result shape is an invariant failure: no finalizer or legacy notification runs,
and the implementation alerts with owner IDs but no provider secret. Tests prove the valid winner
shape and every independently stale owner premise.

### Job-token provenance

The selected legacy strategy is explicit source-job propagation.

- Handoff-backed claims, mappings, sends, and finals use
  `autohdr_handoffs.editing_entry_board_revision`.
- A supported job-owned Editing entry writes `jobs.stage_entry_board_revision` on the exact job that
  performed that entry.
- If completion runs in a different `AutoHdrFetch` or completion job, the entry workflow propagates
  `stageEntrySourceJobId` and `stageEntryGeneration` through the durable workflow/job input.
- Completion queries the source entry job by exact ID, project, kind, generation, and non-null token.
  It never assumes the current fetch/completion job owns the token.
- The entry-job ID is also included in the existing exact handoff/mapping/import prerequisite, so a
  caller cannot substitute an unrelated job with a coincidentally equal revision.
- Pre-rollout workflows lacking source-job provenance are drained before migration. After rollout,
  a missing source-job ID, mismatched generation, null token, or absent source job is permanently
  fail-closed: media truth may be retained, but there is no Stage reassert, audit, revision,
  activity, outbox, or legacy notification.

Required ABA test:

1. workflow-owned Editing entry commits revision `5` and atomically records `5`;
2. human moves out of Editing, producing revision `6`;
3. human re-enters Editing, producing revision `7`;
4. old completion resolves the owning handoff/source entry job and stored revision `5`;
5. Stage matches but revision does not;
6. completion changes zero Stage rows and produces no Stage audit/revision/activity/outbox or legacy
   notification;
7. imported immutable media may retain independently committed truth.

Manual moves never retire workflow state. The token is the continuous-occupancy fence.

## Human Stage activity and notifications

Activate only `project.stage.changed`.

The payload remains the existing strict `emptyPayload`:

```ts
{}
```

Do not add `fromStageKey` or `toStageKey`. Current internal and External copy is generic and renders
neither field; keeping the empty payload removes the semantic Editing leak surface entirely.

Exact registry deltas in `packages/shared/src/project-activity.ts`:

- change `project.stage.changed` from reserved / `cutover: "reserved"` to a live registry entry;
- set `producerOwner` to `moveProjectStage`;
- set `producerCallSites` to the sole human producer,
  `workers/app/src/lib/project-stage.ts#moveProjectStage`;
- retain `sourceKind: "project_stage"`;
- change `sourceKeyShape` from `project-stage:<projectId>:<transitionId>` to
  `project-stage:<projectId>:transition:<activityId>`;
- retain `payloadSchema: emptyPayload`;
- retain project deep linking, no coalescing, and in-app-only delivery;
- keep `case "project.stage.changed":` in the generic-copy group at
  `project-activity.ts:433`, because the empty payload requires no type-specific rendering.

Registry contract:

```text
category: stage
cutover: live
producer: moveProjectStage
producer call site: workers/app/src/lib/project-stage.ts#moveProjectStage
source kind: project_stage
source key: project-stage:<projectId>:transition:<activityId>
payload: emptyPayload
actor: user
deep link: project
coalescing: none
channels: in_app only
email default: off
backfill: none
```

Every winning human cross-Stage change emits one immutable activity. Automatic advances, same-Stage
reorder, conflicts, cancellation, inactive target, archive, and failed authorization do not.

Reuse `buildProjectActivityStatements()` and TB4C recipient-cycle semantics:

- at most one broad outbox and one in-app ledger per eligible membership cycle;
- exact membership-cycle and authorization-epoch admission;
- no broad email or coalescing;
- External assigned recipients receive fixed generic safe copy;
- `projectExternalActivityPayload` returns only `{}` for this live type;
- External notification projection never exposes semantic Editing keys.

If and only if a later reviewer reopens the accepted `emptyPayload` decision and requires a
from/to payload, the change requires fresh review plus an explicit test proving an External
recipient never receives `editing_autohdr`. The TB5A default and approved build contract is
`emptyPayload`.

Human Stage movement does not call legacy `notifyProject(..., "delivered")` or
`notifyProject(..., "sent_to_editing")`.

Winning Priority changes retain `project.priority.changed` and internal broad fan-out. Pure Board
reorder produces audit only.

## Migration `0037`

### Numbering discipline

Before creating files:

1. query production `d1_migrations` and require tail `0036`;
2. require local journal and migration-directory tail `0036`;
3. confirm no other branch has claimed `0037`;
4. stop and renumber if any check differs;
5. if renumbering is required, change together:
   - migration filename and journal tag;
   - snapshot filename and snapshot identity;
   - `project_board_order_0037_rollback`;
   - `project_board_order_0037_stage_rank_idx`;
   - every app/background Worker `sqlite_master` marker literal;
   - all `_tb5a_0037_*` scratch/guard table names;
   - migration, rollback, route, variant, and query-plan test fixtures.
   No isolate may check a marker number different from the rollback table and unique-index number.

Planned files:

```text
portal/packages/db/migrations/0037_project_board_order_contract.sql
portal/packages/db/migrations/meta/0037_snapshot.json
portal/packages/db/migrations/meta/_journal.json
portal/packages/db/test/migration-0037.test.ts
```

### Exact additive SQL

The following block is the exact Drizzle migration file. Every statement is separated by
`--> statement-breakpoint`.

```sql
CREATE TABLE _tb5a_0037_stage_preflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
--> statement-breakpoint
INSERT INTO _tb5a_0037_stage_preflight (ok)
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM projects
    WHERE archived_at IS NULL
      AND stage_key NOT IN (
        'awaiting_raw',
        'raw_review',
        'editing_autohdr',
        'edited_review',
        'delivered'
      )
  )
  THEN 1
  ELSE 0
END;
--> statement-breakpoint
DROP TABLE _tb5a_0037_stage_preflight;
--> statement-breakpoint
ALTER TABLE projects
ADD COLUMN board_revision INTEGER NOT NULL DEFAULT 0
CHECK (
  typeof(board_revision) = 'integer'
  AND board_revision >= 0
  AND board_revision <= 9007199254740991
);
--> statement-breakpoint
ALTER TABLE autohdr_handoffs
ADD COLUMN editing_entry_board_revision INTEGER
CHECK (
  editing_entry_board_revision IS NULL
  OR (
    typeof(editing_entry_board_revision) = 'integer'
    AND editing_entry_board_revision >= 0
    AND editing_entry_board_revision <= 9007199254740991
  )
);
--> statement-breakpoint
ALTER TABLE jobs
ADD COLUMN stage_entry_board_revision INTEGER
CHECK (
  stage_entry_board_revision IS NULL
  OR (
    typeof(stage_entry_board_revision) = 'integer'
    AND stage_entry_board_revision >= 0
    AND stage_entry_board_revision <= 9007199254740991
  )
);
--> statement-breakpoint
INSERT INTO feature_flags (
  key,
  enabled,
  updated_by,
  updated_at
)
VALUES (
  'tb5a_board_contract_enabled',
  0,
  NULL,
  unixepoch('now') * 1000
)
ON CONFLICT(key) DO UPDATE SET
  enabled = 0,
  updated_by = NULL,
  updated_at = excluded.updated_at;
--> statement-breakpoint
CREATE TABLE project_board_order_0037_rollback (
  project_id TEXT PRIMARY KEY NOT NULL,
  stage_key TEXT NOT NULL,
  priority INTEGER,
  old_board_position REAL NOT NULL,
  normalized_board_position REAL NOT NULL,
  visible_rank INTEGER NOT NULL,
  captured_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_board_order_0037_stage_rank_idx
ON project_board_order_0037_rollback(stage_key, visible_rank);
--> statement-breakpoint
CREATE INDEX projects_stage_archive_board_order_idx
ON projects(stage_key, archived_at, board_position, id);
--> statement-breakpoint
CREATE TABLE _tb5a_0037_normalization_postflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS project_id,
    stage_key,
    priority,
    board_position AS old_board_position,
    ROW_NUMBER() OVER (
      PARTITION BY stage_key
      ORDER BY
        (priority IS NULL),
        board_position,
        id
    ) AS visible_rank
  FROM projects
  WHERE archived_at IS NULL
)
INSERT INTO project_board_order_0037_rollback (
  project_id,
  stage_key,
  priority,
  old_board_position,
  normalized_board_position,
  visible_rank,
  captured_at
)
SELECT
  project_id,
  stage_key,
  priority,
  old_board_position,
  CAST((visible_rank - 1) * 1024 AS REAL),
  visible_rank,
  unixepoch('now') * 1000
FROM ranked;
--> statement-breakpoint
UPDATE projects AS p
SET
  board_position = r.normalized_board_position,
  board_revision = 1
FROM project_board_order_0037_rollback AS r
WHERE p.id = r.project_id
  AND p.archived_at IS NULL
  AND p.stage_key = r.stage_key
  AND p.priority IS r.priority
  AND p.board_position IS r.old_board_position
  AND p.board_revision = 0;
--> statement-breakpoint
INSERT INTO _tb5a_0037_normalization_postflight (ok)
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM project_board_order_0037_rollback r
    LEFT JOIN projects p
      ON p.id = r.project_id
    WHERE p.id IS NULL
       OR p.archived_at IS NOT NULL
       OR p.stage_key <> r.stage_key
       OR p.priority IS NOT r.priority
       OR p.board_position IS NOT r.normalized_board_position
       OR p.board_revision <> 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    WHERE p.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM project_board_order_0037_rollback r
        WHERE r.project_id = p.id
      )
  )
  THEN 1
  ELSE 0
END;
--> statement-breakpoint
DROP TABLE _tb5a_0037_normalization_postflight;
```

**Postflight is `changes()`-free (build finding, Slice 2).** An earlier draft gated the postflight
on `changes() = (SELECT COUNT(*) FROM project_board_order_0037_rollback)`. `changes()` reflects the
prior statement only on a connection that ran that statement; `wrangler d1 migrations apply` does,
but the worker-app test harness applies each `--> statement-breakpoint` segment as a separate
`D1.exec()` call, so `changes()` there does not see the normalization `UPDATE`. The two `NOT
EXISTS` blocks above are the equivalent (stronger) guarantee with no cross-statement state: block 1
— every captured row maps to a project that is unarchived, same Stage/Priority, at its normalized
position, revision `1`; block 2 — every unarchived project has a captured row (so a missed row is
caught, not only a wrong one). The abort mechanism is unchanged: a `0` fails `CHECK (ok = 1)` and
`wrangler d1 migrations apply` rolls the migration back.

The preflight CHECK aborts on a noncanonical unarchived Stage. The postflight CHECK aborts unless
the guarded update affected every captured row and every captured row matches normalized state.

The comparator remains exactly:

```sql
(priority IS NULL),
board_position,
id
```

This is rank-identical to `CASE WHEN priority IS NULL THEN 1 ELSE 0 END` but is required because
Wrangler’s compound-statement splitter does not close a `CASE` frame at `END,`. Never restore the
comma-followed `CASE` expression and never add numeric `priority ASC`.

The migration suite imports Wrangler’s installed
`wrangler-dist/cli.js` `splitSqlQuery`, runs it over the checked-in migration file, and asserts:

- each nonempty segment separated by `--> statement-breakpoint` maps to exactly one Wrangler SQL
  statement;
- no Wrangler statement merges adjacent migration segments;
- Wrangler’s compound stack is effectively closed at every boundary;
- no migration statement is swallowed together with Wrangler’s `d1_migrations` journal insert;
- a source audit finds no other compound `END` followed by punctuation rather than `;` or
  whitespace.

The migration:

- records every unarchived project, including one occupying an inactive configured Stage;
- changes no Stage or Priority;
- changes no archived row beyond exposing default columns;
- assigns `0,1024,2048,…` per semantic Stage;
- assigns every normalized unarchived project revision `1`;
- creates no audit, activity, outbox, or workflow notification;
- uses no rebuild, `PRAGMA foreign_keys=OFF`, permanent-data drop, or rollback-table foreign key.

### Drizzle snapshot discipline

`packages/db/drizzle.config.ts` has no `tablesFilter`. The migration-only objects:

```text
project_board_order_0037_rollback
project_board_order_0037_stage_rank_idx
projects_stage_archive_board_order_idx
_tb5a_*
```

must remain out of `packages/db/src/schema.ts` and out of
`packages/db/migrations/meta/0037_snapshot.json`. This follows migration `0015`’s `_bk_*` table
precedent.

Only the three durable application columns and their intended Drizzle declarations enter
`schema.ts` and the snapshot. The rollback table, its unique index, the normalization query index,
and all scratch/guard tables are maintained only by the hand-authored migration. This is required
for the second `drizzle-kit generate` to be a no-op.

### Migration transaction rollback proof

The migration test suite must prove actual rollback, not only error reporting.

Create a scratch `0036` fixture with a temporary test trigger that performs `RAISE(IGNORE)` for one
seeded project’s normalization update. Apply the exact migration through the same transactional
migration runner. The guarded normalization updates fewer rows, causing the postflight CHECK insert
to fail.

After failure, open a fresh connection and prove:

- `projects.board_revision` does not exist;
- both workflow token columns do not exist;
- the rollback table and new indexes do not exist;
- the feature-flag seed/update did not persist;
- every original position, Stage, and Priority remains unchanged;
- the migration journal did not advance.

This test accompanies normal full-chain, `0036→0037`, preflight-failure, Wrangler-splitter, and
scratch-D1 proofs.

### External order correction

For internal roles, normalization preserves the current visible comparator exactly.

For External Editor, it intentionally changes the current manufactured-zero/ID presentation to the
authorized projection of canonical persisted order. Migration and web tests prove this one-time
correction and never describe External ID order as preserved.

### All-or-zero pre-enable rollback

A targeted position rollback is permitted only while the feature flag has never been enabled and
every captured row remains unarchived, in its captured Stage, at normalized position, and at
migration baseline revision `1`.

Before the batch, compute and record:

```sql
SELECT COUNT(*)
FROM project_board_order_0037_rollback;
```

Require a positive expected count and bind it to the guard insert. Execute these exact statements in
one `env.DB.batch()` call and in this order:

```sql
CREATE TABLE _tb5a_0037_position_rollback_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
```

```sql
UPDATE projects AS p
SET board_position = r.old_board_position
FROM project_board_order_0037_rollback AS r
WHERE p.id = r.project_id
  AND p.archived_at IS NULL
  AND p.stage_key = r.stage_key
  AND p.board_position IS r.normalized_board_position
  AND p.board_revision = ?1;
```

Bind `?1` to `1`.

```sql
INSERT INTO _tb5a_0037_position_rollback_guard (ok)
VALUES (
  CASE
    WHEN changes() = ?1 THEN 1
    ELSE 0
  END
);
```

For this statement, bind `?1` to the recorded expected rollback-row count.

```sql
DROP TABLE _tb5a_0037_position_rollback_guard;
```

If the update matches fewer or more rows than expected, the CHECK insert fails. D1 rolls back the
entire batch, including the guard-table creation and every otherwise matching position update.
Tests create one drifted row and prove that all other rows retain normalized positions after the
failure.

This rollback form has no single-reference fence CTE; its all-or-zero guarantee is the following
CHECK failure inside one D1 batch. If implementation introduces a fence CTE here, it must be
`AS MATERIALIZED` and receive the same query-plan proof.

After any genuine Stage/reorder/archive/restore write, mass restore and revision reset are forbidden.
Keep the no-FK rollback table permanently and fix forward.

Remove `/admin/backfill-board-position` as one unit:

- remove the handler;
- remove its `/api/admin/backfill-board-position` route-manifest entry;
- remove `admin.board_position_backfill`;
- remove or rewrite its audit-action tests and route tests;
- prove no production or test reference survives.

It must not survive as a second ordering authority.

## Priority and Board commands

### Priority

The Priority route becomes metadata-only:

```sql
UPDATE projects
SET
  priority = ?1,
  updated_at = ?2
WHERE id = ?3
  AND archived_at IS NULL
  AND priority IS NOT ?1
  AND stage_key = ?4
  AND board_position IS ?5
  AND board_revision = ?6
RETURNING
  priority,
  board_revision;
```

It:

- retains `prioritizeProjects`;
- validates `1..10|null`;
- preserves equality no-op behavior;
- writes one audit and one `project.priority.changed` activity on a winner;
- retains TB4C internal fan-out and TB4E External suppression;
- does not derive a position from siblings;
- does not change Stage, position, or Board revision.

The route rewrite, tests, import removal, and deletion of all three
`priorityInsertNeighbors`, `manualInsertNeighbors`, and `renumberedInsertPosition` helpers occur in
one slice. Before the `0037` marker exists, the route returns bounded
`503 board_schema_maintenance`; no statement containing `board_revision` is prepared.

Priority view:

```text
priority 1 … 10
null last
then authoritative Board rank
then ID
```

It is unavailable to projections that withhold Priority.

### Same-Stage manual order

Add `workers/app/src/lib/project-board-order.ts`.

The command:

- requires `prioritizeProjects`;
- is the sole owner of same-Stage position changes;
- requires the post-`0037` schema variant and enabled feature flag;
- validates target Stage/revision and visible neighbours;
- applies the same canonical global-anchor and full-snapshot rules;
- writes position/revision only;
- writes one `project.board_position_set` audit;
- creates no Stage audit, activity, or outbox;
- returns authoritative visible order;
- returns `409` on stale state without retry.

`moveProjectStage` must reject a placement-changing same-Stage request from a principal lacking
`prioritizeProjects` with `403 project_board_reorder_forbidden`. An authorized same-Stage request
must use this command and audit, not a Stage winner. The cross-Stage path is unaffected.

Archive increments revision while removing a row from the Board. Restore appends to the current
Stage bottom and increments revision.

## Server-authorized projections

### Dashboard list projection

`GET /projects` remains the list/Board owner.

Internal response adds:

```ts
type InternalProjectSummaryDto = ExistingInternalSummary & {
  boardRevision: number;
};

type DashboardBoardProjection = {
  contractEnabled: boolean;
  orderedProjectIdsByStage:
    Partial<Record<StageTransportKey, string[]>>;
};
```

External response adds only:

```ts
type ExternalProjectSummaryDto = ExistingExternalSummary & {
  stageKey: StagePresentationKey;
  boardRevision: number;
};

type ExternalProjectListResponse = {
  projects: ExternalProjectSummaryDto[];
  board: {
    contractEnabled: boolean;
    orderedProjectIdsByStage:
      Partial<Record<StagePresentationKey, string[]>>;
  };
};
```

Rules:

- SQL authorization precedes projection;
- External SQL starts from `visibleProjectWhere`;
- arrays contain only assigned, unarchived IDs;
- no hidden fetch/filter occurs in React;
- no Priority, raw position, hidden count, global revision, or internal Editing key leaks;
- `externalProjectSummarySchema.stageKey` is `z.enum(STAGE_PRESENTATION_KEYS)`;
- strict schemas reject internal-field expansion;
- Board rendering consumes the authorized maps, then ID only as a defensive missing-ID fallback.

### Workspace detail projection

The Workspace does not depend on the Dashboard list query. Its detail seam is independently
authoritative.

Internal `ProjectDetail` adds:

```ts
type ProjectDetail = ExistingProjectDetail & {
  boardRevision: number;
  contractEnabled: boolean;
};
```

The internal project-detail SQL projection, route response, `projectDetailQueryOptions`,
`useProjectDetailQuery`, and Workspace adapter all carry those fields.

Strict External detail adds:

```ts
type ExternalProjectDetailDto = ExistingExternalProjectDetailDto & {
  stageKey: StagePresentationKey;
  boardRevision: number;
  contractEnabled: boolean;
};
```

`externalProjectDetailSchema` remains `.strict()`, inherits the narrowed summary `stageKey`, and
`externalProjectDetailToWorkspace()` explicitly maps all three fields. A direct Workspace deep link
can therefore create:

```ts
{
  expected: {
    stageKey: detail.stageKey,
    boardRevision: detail.boardRevision
  }
}
```

without Dashboard state.

Privacy sentinel tests inject `priority`, `boardPosition`, `editing_autohdr`, hidden IDs, and hidden
counts into External detail. Strict decoding must reject each response. Valid External detail
contains `boardRevision` and `contractEnabled` but never raw global position or Priority.

### Slice-4 rendering authority

Authoritative Board-map consumption ships in Slice 4, not Slice 7.

- The Dashboard groups cards by role-safe Stage and orders them by the corresponding authorized
  server ID array.
- Internal raw `boardPosition` may remain temporarily in compatibility DTOs for untouched callers,
  but `sortKanbanProjects(..., "board")` no longer treats it as rendering authority after the map is
  available.
- The External adapter does not manufacture `boardPosition: 0` as order authority.
- It may expose a private ephemeral authorized rank to the existing card model during the slice,
  derived only from the server’s authorized ID array; that rank is neither a wire field nor global
  position and is removed when the card model accepts order maps directly.
- Priority and shoot-date view comparators remain local non-writing views.

Independent Slice 4 test:

```text
authorized server order: external-visible Z, A
lexical ID order:         A, Z
raw global position:      unavailable
expected Board rendering: Z, A
```

The test must pass before any Slice 5 mutation work. Flag-off controls remain hidden.

## Rail, native drag, keyboard, and freshness

### Project Workspace rail

Add a Stage control under Production. It receives role-safe Stage, `boardRevision`,
`contractEnabled`, Stage list, `can("moveProjectStage")`, archive state, and mutation callback from
the detail query.

It shows inactive current Stage, enables active destinations, performs no same-Stage request, uses
append placement, and uses the Quincy confirmation modal.

### Native drag and keyboard

TB5A keeps native HTML drag:

- cross-column `draggable` uses `moveProjectStage`;
- column background uses append;
- card boundaries submit exact visible neighbours;
- a same-column card drop is admitted only for `prioritizeProjects` and uses
  `project-board-order.ts`;
- internal and External Editors cannot reorder within a Stage;
- confirmation keeps the card in its source column until accepted;
- conflict restores authoritative state;
- no dnd-kit dependency is added.

Every movable card also has a keyboard-operable Move Stage action using the same destinations,
confirmation, append placement, focus return, and live-region announcement. Manual reorder controls
remain available only in Board order to principals with `prioritizeProjects`.

### Refresh ownership

Dashboard replacement is deferred while:

- a card is being dragged;
- a confirmation is open;
- a Stage/reorder mutation is pending.

One queued authoritative refresh runs after commit, cancel, or conflict. Preserve view, filter,
search, scroll, focus, and modal state. TB4E access-loss purge always wins over a late response.

## Pre-schema and post-schema statement variants

A SQL statement must never be prepared with a column that does not yet exist.

Each app/background Worker isolate owns:

```ts
type BoardSchemaVariant = "pre_0037" | "tb5a_0037";
```

On startup or its first database-backed request, it executes only this old-schema-safe query:

```sql
SELECT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'table'
    AND name = 'project_board_order_0037_rollback'
) AS tb5a_0037_exists;
```

The resulting promise/value is cached for the isolate. No later route independently probes or
speculatively prepares both variants.

If the migration renumbers, this marker literal, the rollback table, its unique-index name, all
scratch names, and every test move together.

### Named pre-marker read sites

After `boardRevision` is added to the Drizzle `projects` schema, these current bare selects would
automatically emit the new column unless replaced with explicit old-schema projections:

```text
workers/app/src/routes/projects.ts:247
workers/app/src/routes/projects.ts:492
workers/app/src/routes/projects.ts:559
workers/app/src/routes/projects.ts:1121
workers/background/src/tonomo/process.ts:72
workers/background/src/tonomo/process.ts:80
```

The round-3 repository audit searched both `.from(schema.projects)` and `.from(projects)` bare
select forms and found no additional current Worker sites. Slice 4 must repeat the audit against its
implementation diff. Every listed site receives a pre-marker explicit projection or is removed by
its owning rewrite.

### `pre_0037` variant

- Normal internal list/detail reads use their old-column SQL projections.
- Normal strict External list/detail reads use old-column authorized SQL projections.
- The six named bare project selects use explicit old-column projections.
- Response adapters synthesize `boardRevision: 0` and `contractEnabled: false`; those values are
  inert presentation defaults, not concurrency authority.
- Legacy Board presentation remains active; no authoritative post-normalization map is claimed.
- Stage, reorder, archive, restore, creation, automatic Stage writers, and all service/RPC paths
  capable of invoking them return bounded `503 board_schema_maintenance`.
- The metadata-only Priority route also returns `503 board_schema_maintenance`.
- No builder containing `board_revision`, either workflow token column, or normalized-order indexes
  is constructed, invoked, or prepared.
- Background Queue, Workflow, Cron, reconciliation, Dropbox, Tonomo, and AutoHDR handlers classify
  the bounded maintenance result without retry storms or Stage side effects.

### `tb5a_0037` variant

- List/detail reads select actual `board_revision` and the durable flag.
- Authorized order maps are computed from post-migration canonical order.
- All Board writers use the new bundles but remain disabled while the flag is OFF.
- Priority may use its new metadata-only statement even while the Board flag is OFF.
- Automatic writers remain flag-gated.

Variant-selection tests use a real `0036` schema and fail the test if any trace, construction, or
preparation mentions a `0037` column before the marker check completes. “No statement referencing a
`0037` column is prepared before the marker” is satisfied only when all six named sites and the
writer inventory have explicit pre-schema behavior.

## Implementation slices

Every slice independently passes:

```bash
npm run typecheck
npm run build -w @quincy/web
```

and its affected tests. Compatibility adapters remain until the slice moving their final consumer.

### Slice 0 — characterization only

- Freeze legacy internal ordering, External ID fallback, Stage writers, Priority insertion,
  duplicate/fractional positions, archived rows, and inactive Stage fixtures.
- Complete and verify the Stage-and-position writer inventory above. No writer may remain assigned
  only by prose.
- Record that `renumberedInsertPosition` normalizes to `1024,2048,…`, whereas migration `0037`
  deliberately normalizes to `0,1024,…`. This is harmless only because the old helper is deleted in
  Slice 5.
- Record implementation parent, draft, migration tail, dependency pins, and test counts.
- Make no production signature removal.

Gate: typecheck, web build, existing Kanban/background characterization suites, and checked
writer-inventory evidence.

### Slice 1 — additive shared contract

- Add capability, Stage transport, sequence, confirmation, request/response, revision, placement,
  activity, and External-safe schemas.
- Flip `project.stage.changed` from reserved to live with its exact producer call site, new
  activity-ID source-key shape, and `emptyPayload`.
- Keep its generic-copy switch case.
- Narrow External summary/detail Stage decoding to `STAGE_PRESENTATION_KEYS`.
- Fold External Editing neutralization into `stageTransportKeyForRole`.
- Add internal and strict External detail revision/contract fields.
- Keep current Stage call sites on compatibility types until their owning slice.
- Add shared truth-table, strict-schema, activity-registry, and privacy-sentinel tests.

Gate: typecheck, web build, shared Vitest, affected workspace tests.

### Slice 2 — migration and schema

- Add the exact breakpoint-separated migration `0037`, three additive columns, rollback table,
  indexes, flag seed, journal, snapshot, and migration tests.
- Use `(priority IS NULL),` at both comparator declarations.
- Run Wrangler’s own `splitSqlQuery` over the checked-in migration and prove one statement per
  breakpoint-delimited segment.
- Re-audit the entire SQL file for compound `END` tokens not followed by `;` or whitespace.
- Keep migration-only tables/indexes/scratch objects out of `schema.ts` and
  `0037_snapshot.json`.
- Prove full-chain, `0036→0037`, preflight failure, and postflight transactional rollback.
- Keep production helpers intact.

Gate: typecheck, web build, DB migration tests, local Wrangler splitter/apply, scratch D1,
foreign-key check, and `quick_check`.

### Slice 3 — additive DB bundles

- Add prepared winner, normative non-compacting exact-placement SQL, normative compacting SQL,
  complete activity indexes, workflow-token, workflow-tail, and Deadline-suppression bundles.
- Declare every single-reference fence CTE `AS MATERIALIZED`.
- Assert scratch-D1 `EXPLAIN QUERY PLAN` contains `MATERIALIZE fence` for the compacting winner and
  confirms pinned fence materialization for the non-compacting exact-placement winner.
- Retain `guardedStageTransition` and `onSuccess` compatibility executor.
- Retain the three legacy Kanban-ordering helpers through this slice.
- Add winner, loser, malformed-plan, compaction, token-tail, query-plan, and index-layout tests.

Gate: typecheck, web build, DB and existing app/background tests.

### Slice 4 — authorized projection, authoritative rendering, and flag-off UI seam

- Add internal/External Board projections and summary/detail `boardRevision`.
- Add internal and strict External detail `contractEnabled`.
- Add strict decoders and privacy sentinels, including non-vacuous rejection of
  `editing_autohdr`.
- Replace manufactured-zero/ID ordering with authoritative authorized-map rendering.
- Add durable flag projection and hidden-control behavior.
- Convert or remove all six named bare pre-marker project reads and repeat the repository audit for
  additions.
- Prove no `0037` column statement is constructed or prepared before the marker.
- Do not change the Stage mutation route signature yet.

Gate: typecheck, web build, query/privacy/detail/web-adapter/pre-schema tests, including independent
`Z,A` External authorized-order behavior.

### Slice 5 — human commands, routes, Priority, and current web caller

In one independently green slice:

- add `moveProjectStage` and manual order command;
- enforce `403 project_board_reorder_forbidden` for internal or External Editors attempting a
  same-Stage placement change;
- dispatch authorized same-Stage changes only to `project-board-order.ts`;
- retain `project.board_position_set` as the sole successful reorder audit;
- leave cross-Stage `moveProjectStage` behavior unchanged;
- replace both Stage route forms;
- document and register trailing-slash Stage as net-new strict-Hono surface;
- add the legacy-body discriminator;
- change the Dashboard Stage caller to the new request/response;
- move its cross-Stage capability gate to `moveProjectStage`;
- gate same-Stage drag/reorder on `prioritizeProjects`;
- refactor Priority to metadata-only;
- rewrite every app creation/archive/restore position writer to the revision contract;
- update/remove all tests importing `priorityInsertNeighbors`, `manualInsertNeighbors`, and
  `renumberedInsertPosition`;
- remove all three route imports, calls, and helper definitions;
- remove the temporary Admin backfill route, route-manifest entry,
  `admin.board_position_backfill`, and its tests;
- integrate DB-owned Deadline suppression and post-commit Queue finalizer.

Gate: typecheck, web build, app integration, Dashboard, capability, Deadline, activity, route,
archive/restore/create, same-Stage-403, and backfill-removal tests.

### Slice 6 — automatic writer convergence and compatibility removal

- Convert every automatic and Tonomo inventory row.
- Add SQL-reread workflow Editing-entry token tails.
- Propagate source entry-job identity through every job-owned completion path.
- Permanently fail closed for missing legacy provenance.
- Add move-out, out-and-back ABA, stale-token, and source-job-substitution tests.
- Replace every named `onSuccess` and direct notification owner.
- Confirm `ingest.ts`, `sync.ts`, and both guarded `finals.ts` callers have no separate direct
  position write.
- Remove compatibility executor only after all callers compile.
- Audit that no direct production Stage update remains.
- Audit that no production `board_position` writer remains without its required
  `board_revision` mutation.

Gate: typecheck, web build, app/background/DB automatic-writer and notification suites plus the
complete writer-inventory closeout.

### Slice 7 — complete interaction UI

- Add rail Stage control.
- Add native exact-neighbour drag and keyboard Move action.
- Route same-column interaction only through the Admin-only Board-order command.
- Add Priority view for authorized internal roles.
- Add interaction ownership, narrow invalidation, neutral-label, focus, and accessibility tests.
- Do not introduce a second Board-order authority; consume the Slice 4 maps.

Gate: typecheck, web build, complete web logic and DOM suites.

### Slice 8 — full proof and deployment preparation

- Run complete verification and repository audits.
- Run local migration/query-plan/performance proof.
- Assert every compacting plan fully renumbers its destination column to `0,1024,2048,…` and bumps
  each changed row’s revision.
- Benchmark fixed bounded destination sizes—for example 25, 100, 250, and 500 projects—recording
  SQL/JSON size, D1 execution time, returned-row count, and revisions invalidated.
- Record the actual production unarchived count per Stage during preflight. Require the largest
  column to be no larger than the greatest successfully reviewed benchmark size. If it exceeds the
  measured envelope, stop rollout for fresh performance review rather than extrapolating.
- Include one representative measurement at or above the actual largest production column size.
- Record expected visible `409` churn under concurrent stale clients; do not auto-retry.
- Run Agy browser matrix.
- Obtain fresh read-only implementation diff review.
- Prepare one reviewed schema-aware production revision and recovery export.
- Do not update implemented-plan status until production verification completes.

## Automated test plan

### Shared

Prove capability membership, including that `prioritizeProjects` remains Admin-only; RAW capability
retention; Stage sequence; role-safe Editing; non-Admin internal-key rejection; all 25 confirmation
pairs; cumulative reason order; strict request/response schemas; activity identity and exact live
registry metadata; `emptyPayload`; external policy; provider-safe copy; narrowed
`STAGE_PRESENTATION_KEYS`; and summary/detail revision contracts.

### Migration

Seed all semantic Stages, an inactive configured Stage, archived projects, Priority values
`1,5,10,null`, duplicate/fractional positions, deterministic ID ties, and a noncanonical Stage.

Prove:

- noncanonical unarchived Stage fails before capture;
- archived noncanonical rows do not enter normalization;
- exact breakpoint-separated SQL applies through local Wrangler and scratch D1;
- Wrangler’s own `splitSqlQuery` returns one statement for each breakpoint-delimited segment;
- no compound frame remains open and no journal/CHECK statement is merged;
- the complete `0037` SQL contains no unsafe `END` followed by punctuation;
- comparator is `(priority IS NULL), board_position, id`;
- internal legacy order is preserved;
- External ID order intentionally changes to canonical authorized order;
- normalized positions are `0,1024,…`;
- every captured revision is `1`;
- archived revisions remain `0`;
- rollback rows exactly match unarchived rows;
- Stage/Priority values are unchanged;
- feature flag is seeded OFF;
- workflow entry columns are nullable and constrained;
- migration-only rollback/scratch tables and indexes are absent from `schema.ts` and snapshot;
- runtime indexes exist;
- no rebuild/PRAGMA/drop/rename occurs;
- foreign-key check is empty and `quick_check` is `ok`;
- an injected postflight mismatch rolls back all preceding ALTER/capture/update/flag/index work;
- a drifted pre-enable rollback row causes the CHECK gate to roll back all otherwise matching
  position restorations.

### Human Stage/API

Cover all principals and results, both route forms, exact legacy-body `409`, strict-invalid `400`,
same Stage, active/inactive destinations, archived state, cumulative confirmation, assignment loss,
stale project/neighbour revisions, append, empty destination, simultaneous append, midpoint,
compaction, and full-snapshot loss.

Explicit same-Stage cases:

- internal Editor, same semantic Stage, `between` placement →
  `403 project_board_reorder_forbidden`;
- External Editor, same semantic Stage, `between` placement →
  `403 project_board_reorder_forbidden`;
- Admin with `prioritizeProjects`, same semantic Stage, `between` placement → Board-order command,
  `project.board_position_set`, no Stage activity;
- each rejected request has zero audit/activity/outbox/revision footprint;
- cross-Stage Editor and assigned External Editor movement remains authorized by
  `moveProjectStage`.

For every cross-Stage winner assert exact revision increments, one Stage audit, one human activity
with `{}`, recipient-cycle fan-out, no email, correct Deadline suppression, and authoritative
role-safe order. Every loser or no-op has zero footprint.

Compaction tests include:

- stale full target snapshot;
- duplicate expected ID;
- duplicate changed-plan ID;
- sibling marked target;
- missing or duplicate target marker;
- one stale old tuple;
- missing row that actually changes;
- extra unchanged row;
- missing/extra target-snapshot row;
- invalid deterministic position sequence;
- `EXPLAIN QUERY PLAN` contains `MATERIALIZE fence`;
- all changed siblings receive revision bumps.

Every failure leaves all Stage/position/revision rows unchanged.

Non-compacting tests run the normative SQL unchanged and cover malformed JSON, wrong JSON field
types, duplicate IDs, missing/extra live target rows, stale Stage/position/revision/archive tuples,
wrong target source Stage/revision, and pinned fence materialization.

### Hidden-neighbour fixtures

For visible `A,B`, cover:

- no hidden rows;
- global `A,H,B`;
- global `A,H1,H2,B`;
- midpoint available;
- midpoint exhausted and compaction required;
- `after=null` global append.

Also cover:

```text
global: H1,H2,B
visible: B
request: before=null, after=B
expected global: H1,H2,target,B
expected visible: target,B
```

Assert immediate-before-`after`, hidden relative-order preservation, complete global snapshot
validation, and visible-only response.

### Automatic and ABA

For every writer inventory row prove exact source Stage, archive guard, flag gate, append, revision
increment, workflow prerequisite, audit behavior, token owner, and notification ownership.

Race/provenance tests include:

- human move-out before completion;
- revision `5 → 6 → 7` ABA;
- null workflow token;
- stale handoff identity/generation/project;
- source entry job differs from completion job and succeeds through explicit propagation;
- completion incorrectly using its own job ID loses;
- missing legacy `stageEntrySourceJobId` fails closed;
- unrelated source job with equal revision loses;
- new workflow-owned re-entry records and uses its own new token;
- loser produces no audit/revision/activity/outbox/legacy notification.

### Priority, Deadline, activity, privacy, and web

Prove metadata-only Priority, no Board revision change, Priority-view sorting, pure reorder
audit-only behavior, Delivered atomic suppression, no reminder auto-resume, human-only Stage
activity with empty payload, exact live registry source key, External-safe copy, assigned-only
order, no forbidden detail/list fields, strict rejection of `editing_autohdr`, authoritative map
rendering, native drag, keyboard action, refresh ownership, access-loss purge, and
Deadline/overdue preservation.

### Pre-schema variants

Against an exact `0036` fixture:

- first marker check selects `pre_0037`;
- old-column internal and External list/detail reads succeed;
- all six named bare project-read sites use old-column projections or have been removed;
- returned detail/list values are inert `boardRevision:0`, `contractEnabled:false`;
- Stage/reorder/archive/restore/create/automatic/Priority paths return bounded maintenance;
- no SQL construction, preparation, or execution references a nonexistent `0037` column;
- background handlers do not retry indefinitely or emit workflow notifications.

Against `0037` with flag OFF:

- first marker check selects `tb5a_0037`;
- actual revision and contract fields read successfully;
- Priority metadata-only route is available;
- all Board writers remain disabled by SQL and command gates.

## Repository audits

Run and classify:

```bash
rg -n 'selectForEditing|moveProjectStage|prioritizeProjects' \
  portal/packages/shared portal/apps/web portal/workers

rg -n \
  'SET stage_key|stageKey:|stage_key =|update\(.*projects.*stage' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'

rg -n 'board_position|boardPosition|board_revision|boardRevision' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'

rg -n \
  'priorityInsertNeighbors|manualInsertNeighbors|renumberedInsertPosition|priority.*board_position|priority.*boardPosition' \
  portal -g '*.ts'

rg -n \
  'project\.stage\.changed|notifyProject\(.*delivered|notifyProject\(.*sent_to_editing|project\.priority\.changed' \
  portal -g '*.ts'

rg -n -U \
  '\.select\(\)\s*\.from\((schema\.)?projects\)' \
  portal/workers -g '*.ts'

rg -n \
  'admin\.board_position_backfill|backfill-board-position' \
  portal -g '*.ts'

rg -n \
  'project_board_order_0037|_tb5a_0037|projects_stage_archive_board_order_idx' \
  portal/packages/db/src/schema.ts \
  portal/packages/db/migrations/meta/0037_snapshot.json
```

Expected:

- Stage UI/API uses only `moveProjectStage`;
- RAW selection/download retains `selectForEditing`;
- same-Stage reorder requires `prioritizeProjects` and uses only `project-board-order.ts`;
- no unowned production Stage or position writer remains;
- every Board-state writer increments revision;
- no Priority-to-position production path remains;
- all three legacy Kanban-order helpers are gone after Slice 5;
- one human Stage activity producer exists with `emptyPayload`;
- workflow legacy notifications remain only on workflow winners;
- no manual Delivered/Editing legacy notification exists;
- no External adapter manufactures raw ordering authority;
- no parallel `externalStageKey` helper remains;
- every summary/detail projection has the intended role-safe revision and Stage contract;
- no named pre-marker bare read can expand to a `0037` column;
- no migration-only object appears in Drizzle schema or snapshot;
- the Admin backfill route, audit action, manifest entry, and tests are gone.

Also verify both Stage route forms, no wildcard middleware leak, TB4E route manifest, External strict
projection, and complete bundle-index exports.

## Verification

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Run all focused shared, DB, app, background, and web suites.

Then:

```bash
npx drizzle-kit generate
git status --short
git diff --exit-code -- \
  packages/db/migrations \
  packages/db/migrations/meta \
  packages/db/src/schema.ts
```

The second generation must be a no-op and must not produce a rebuild. The migration-only rollback
table, its indexes, and `_tb5a_*` objects must not appear in schema or snapshot output.

Scratch proof covers the full migration chain, `0036→0037`, Wrangler’s own splitter, exact
normalization SQL, preflight failure, transactional postflight rollback, all-or-zero position
rollback, normative non-compacting and compacting SQL, malformed plans, `MATERIALIZE fence`,
foreign-key check, quick check, bounded compaction measurements, and representative Board
serialization measurements.

## Manual local QA

Use Agy Option A against `http://localhost:8787` with a human-authenticated dedicated Chrome. Agy
never signs in or handles secrets. Use Admin impersonation for internal role checks and approved
disposable External fixtures.

Cover:

- Admin/internal/External/Photographer capability matrix;
- internal and External Editor same-Stage reorder rejection;
- Admin same-Stage Board reorder through `project.board_position_set`;
- canonical Board order and Priority view;
- intentional External ID-order correction;
- direct Workspace deep-link movement without prior Dashboard visit;
- rail, native drag, keyboard movement, cumulative confirmations;
- neutral Editing vocabulary;
- inactive-current escape;
- archive read-only behavior;
- stale project and neighbour conflicts across two tabs;
- refresh during drag/modal/pending mutation;
- hidden-neighbour fixtures, including hidden-top insertion;
- ABA completion and propagated source-job ownership;
- Delivered Deadline suppression and non-resume;
- desktop, tablet, phone, zoom/reflow, keyboard, focus, console, and network behavior.

## Deployment preflight and rollout

### Durable inert mechanism

Use one permanent flag:

```text
tb5a_board_contract_enabled
```

Migration `0037` seeds it OFF. All Stage, position, archive, restore, creation, and automatic Stage
winner SQL requires `enabled=1`. List/detail projections read the same row after the schema marker
exists and hide mutation controls while OFF.

There is one reviewed schema-aware app/background revision:

- before the marker exists, it selects only pre-`0037` statements;
- after the marker exists with flag OFF, migration-aware reads and metadata-only Priority work while
  all Board commands remain disabled;
- enabling requires no build or deployment.

### Freeze and proof before migration

1. Record reviewed source commit and Worker artifact hashes.
2. Re-run the numbering-discipline checklist, including coupled rollback-table/index/marker names.
3. Create and verify the remote D1 recovery export.
4. Drain notification/project queues to recorded zero or pause consumers with backlog recorded.
5. Stop new Stage-capable Workflow instances and wait until every old Stage-capable instance is
   terminal.
6. Disable Cron and hourly reconciliation triggers.
7. Disable app service/RPC paths that can start Dropbox sync, AutoHDR send/fetch, Tonomo creation,
   or reconciliation.
8. Deploy the reviewed background Worker while triggers remain paused; its pre-schema variant must
   perform no Stage or position write.
9. Deploy webhook-ingress only if its reviewed artifact changed.
10. Deploy the same reviewed app Worker in pre-schema maintenance mode.
11. Prove list/detail reads use old projections and all Stage/reorder/archive/restore/create,
    automatic, and Priority mutation paths return bounded maintenance.
12. Prove all six named pre-marker reads are explicit old projections or removed.
13. Prove no statement referencing a `0037` column was constructed or prepared.
14. Record unarchived project count per Stage and require the largest column to fit inside the
    reviewed Slice 8 performance envelope.
15. Query audits, jobs, workflows, queues, and Stage/position aggregates twice across a quiet
    interval. Any unexplained change stops rollout.
16. Only then apply migration `0037`.

The freeze covers app RAW ingest, Dropbox reconciliation, Queue consumers, Workflow instances,
Cron, Tonomo creation, AutoHDR claims/finals, creation, Stage, Priority-coupled legacy order,
archive, restore, and manual reorder. No old Stage writer may execute after normalization.

### Post-migration flag-OFF verification

With the same reviewed versions deployed:

1. require remote migration tail `0037`;
2. verify columns, rollback table, indexes, and flag row;
3. verify rollback-row count equals unarchived-project count;
4. verify zero internal-order mismatches;
5. verify intentional External authorized-order correction;
6. verify normalized positions/revisions and unchanged Stage/Priority;
7. verify foreign-key check and quick check;
8. verify normal internal and strict External list/detail reads;
9. verify authoritative authorized maps;
10. verify metadata-only Priority changes no Board revision;
11. verify every Board-affecting command remains `503 board_contract_disabled`;
12. verify background remains inert while triggers are paused.

### Enable and resume

An authorized operator enables the flag through a reviewed prepared batch using `?` bindings and
writes a feature-flag audit. The update requires current OFF and returns exactly one row.

After enablement:

1. verify the same app/background versions and source commit remain active;
2. run an authorized disposable command smoke test;
3. resume Queue consumers;
4. resume new Workflow creation;
5. resume Cron/reconciliation;
6. prove only the reviewed background version handles new work;
7. monitor Stage conflicts, same-Stage forbidden responses, compaction-driven `409` churn, token
   losers, outbox failures, and workflow provenance failures.

If distinct bundles become unavoidable, rollout requires a new plan review, pinned commits,
artifact hashes, and proof that the inert artifact cannot enable writes.

## Rollback and fix-forward

### App/UI/command fault

1. Set the flag OFF through the audited operator path.
2. Pause Stage-capable Queue, Workflow, Cron, reconciliation, and service triggers.
3. Keep the migration-aware version serving reads and bounded disabled writes.
4. Do not deploy a pre-TB5A app.
5. Preserve audit/activity/outbox/ledger history and fix forward.

### Background fault

Keep the flag OFF if continued production increases risk. Deploy a fixed TB5A-aware background
consumer, then resume only after it recognizes the Stage revision and source-owner contract. Never
restore a writer that mutates Stage or position without revision/token fencing.

### Migration fault before enablement

Keep the flag OFF. Use the all-or-zero rollback batch only if every captured row remains at baseline
revision `1` and explicit incident authority approves it. A count mismatch aborts the complete
rollback batch. Do not delete the permanent rollback table or edit `d1_migrations`.

### Fault after enablement

Do not bulk-restore positions, reset revisions, or deploy pre-TB5A writers. Fix forward. Use the
recovery export only for catastrophic recovery under explicit authority.

### Privacy fault

Immediately disable the flag, preserve restricted evidence, purge affected External projections
through TB4E’s mechanism, and repair the server SQL/strict DTO boundary. Do not fetch a broad
internal DTO and redact it in React.

## Acceptance checklist

### Domain and authorization

- [ ] `moveProjectStage` belongs only to Admin, internal Editor, and External Editor.
- [ ] External movement additionally requires current assignment.
- [ ] `prioritizeProjects` remains Admin-only.
- [ ] Same-Stage placement change without `prioritizeProjects` returns
      `403 project_board_reorder_forbidden`.
- [ ] Internal Editor and External Editor same-Stage `between` tests pass.
- [ ] Authorized same-Stage reorder uses only `project-board-order.ts` and
      `project.board_position_set`.
- [ ] Cross-Stage `moveProjectStage` behavior is unaffected.
- [ ] Exact MOVE/STAY `selectForEditing` disposition is preserved.
- [ ] Semantic Stage sequence and cumulative confirmations are shared.
- [ ] Non-Admin transport exposes only neutral Editing.
- [ ] Inactive current Stage remains escapable; archived projects are read-only.
- [ ] Legacy `{stageKey}` returns `409 stage_contract_reload_required` on both route forms.
- [ ] Trailing-slash Stage route is recorded as net-new strict-Hono surface.

### Ordering and migration

- [ ] Remote tail is confirmed `0036` before applying `0037`.
- [ ] Renumbering updates rollback table, unique index, marker literals, scratch names, journal,
      snapshot, filenames, and tests together.
- [ ] Noncanonical unarchived Stage keys abort migration.
- [ ] Exact breakpoint-separated migration passes Wrangler and scratch D1.
- [ ] Wrangler’s own splitter returns one statement per breakpoint-delimited segment.
- [ ] No unsafe comma-followed `CASE … END,` or other unclosed compound frame remains.
- [ ] Failed postflight CHECK rolls back ALTER/capture/update/flag/index work.
- [ ] Comparator is exactly `(priority IS NULL), board_position, ID`.
- [ ] Permanent rollback table has no foreign key.
- [ ] Migration-only rollback/scratch objects and indexes stay out of Drizzle schema/snapshot.
- [ ] Internal order is preserved.
- [ ] External ID fallback changes to authorized canonical order.
- [ ] Positions normalize to `0,1024,…` and unarchived revisions to `1`.
- [ ] Priority and Stage values remain unchanged.
- [ ] Flag is seeded OFF.
- [ ] Pre-enable rollback is all-or-zero through a following CHECK-failure gate.
- [ ] Temporary Admin backfill route, route manifest, `admin.board_position_backfill`, and tests are
      removed.

### Command and DB seam

- [ ] `@quincy/db` owns winner, activity, Deadline, workflow, and token SQL.
- [ ] Complete named indexes include `broadLedger` and every workflow tail.
- [ ] Callers compose bundles only through exported indexes.
- [ ] No caller supplies arbitrary SQL.
- [ ] Post-commit finalizer never runs for a loser.
- [ ] `onSuccess` is removed only with all named production callers.
- [ ] Non-compaction uses the normative guarded target update.
- [ ] Non-compacting exact placement validates JSON types and bidirectional live-snapshot set
      equality.
- [ ] Compaction uses the normative executable all-or-zero SQL.
- [ ] Every single-reference fence CTE carrying the guarantee is `AS MATERIALIZED`.
- [ ] Scratch-D1 plan contains `MATERIALIZE fence` for the compacting winner.
- [ ] `RETURNING` uses unqualified columns and parses on scratch D1.
- [ ] Expected target is distinct and set-equal to the live fenced snapshot.
- [ ] Changed plan is the exact set of changed rows.
- [ ] Exactly one exact target exists; no sibling can be target.
- [ ] Every changed old tuple is pre-proved live before candidates are admitted.
- [ ] Malformed-plan tests leave every row unchanged.
- [ ] Hidden placement uses immediate-before-`after` or global append.
- [ ] Full writer inventory is verified before Slice 0 closes.
- [ ] No writer reaches Slice 6 end changing `board_position` without `board_revision`.
- [ ] All three legacy Kanban-ordering helpers and shared tests move together in Slice 5.

### Workflow safety

- [ ] Entry-token tail re-reads project revision inside SQL.
- [ ] No D1 batch statement rebinds an earlier `RETURNING` value.
- [ ] Token tail is guarded by exact owner, generation, project, prior token, and audit marker.
- [ ] Workflow-owned Editing entry records its exact revision atomically.
- [ ] Completion requires exact Stage and recorded entry revision.
- [ ] Completion jobs use propagated source entry-job identity, not their own ID.
- [ ] Missing legacy provenance permanently fails closed.
- [ ] Move-out and out-and-back ABA tests pass.
- [ ] Every automatic writer retains its prerequisite and notification owner.
- [ ] `ingest.ts`, `sync.ts`, and guarded `finals.ts` callers have no separate position writes.
- [ ] Automatic loser produces no Stage audit/revision/activity/outbox/legacy notification.
- [ ] Manual Editing and Delivered moves cause no provider or delivery action.

### Activity, privacy, and UI

- [ ] `project.stage.changed` flips from reserved to live with its exact producer call site.
- [ ] Its source key is `project-stage:<projectId>:transition:<activityId>`.
- [ ] Its payload remains strict `emptyPayload`.
- [ ] Its generic-copy switch case remains appropriate.
- [ ] `project.stage.changed` is human-only, non-coalesced, and in-app-only.
- [ ] Recipient fan-out is at most once per eligible membership cycle.
- [ ] Pure reorder emits no activity/outbox.
- [ ] Priority is metadata-only and externally suppressed.
- [ ] External summary/detail Stage key is `z.enum(STAGE_PRESENTATION_KEYS)`.
- [ ] `stageTransportKeyForRole` owns `editing_autohdr → editing`; no parallel helper remains.
- [ ] Internal and strict External detail include `boardRevision` and `contractEnabled`.
- [ ] External detail rejects Priority, raw position, hidden IDs/counts, and internal Editing.
- [ ] Slice 4 makes authorized maps the Board rendering authority.
- [ ] External manufactured-zero/ID order is removed.
- [ ] Rail, native cross-Stage drag, and keyboard use the same Stage command.
- [ ] Same-column reorder uses only the authorized Board-order command.
- [ ] Interaction ownership preserves drag/modal/pending state.
- [ ] Access-loss purge wins over late responses.

### Pre-schema, slices, proof, and rollout

- [ ] One old-schema-safe marker check selects each isolate’s statement variant.
- [ ] Pre-marker reads use old projections.
- [ ] All six named bare project-read sites are handled and the source audit finds no additions.
- [ ] No nonexistent-column statement is constructed or prepared pre-marker.
- [ ] Pre-marker Priority and every Board-affecting writer return bounded maintenance.
- [ ] Every slice independently typechecks, builds, and passes focused tests.
- [ ] Priority helper removal, all three helper tests, and route rewrite are one slice.
- [ ] Automatic caller conversion and `onSuccess` removal are one slice.
- [ ] Full workspace tests and explicit shared Vitest pass.
- [ ] Second Drizzle generation is a no-op.
- [ ] Compaction benchmarks cover bounded representative column sizes.
- [ ] Actual production column size fits within the reviewed performance envelope.
- [ ] Representative measurement at or above production size is recorded.
- [ ] Writer, capability, ordering, privacy, route, activity, splitter, and marker audits are
      recorded.
- [ ] Agy local browser matrix passes.
- [ ] Fresh read-only implementation diff review approves.
- [ ] Recovery export path, size, and SHA-256 are recorded.
- [ ] Queue, Workflow, Cron, reconciliation, service calls, and Board writes are frozen before
      migration.
- [ ] No old Stage writer runs after normalization.
- [ ] One reviewed migration-aware revision is verified flag-OFF and enabled without redeploy.
- [ ] Production verification completes before this plan moves to `implemented/`.

## Expected implementation footprint

Expected files include:

- shared capabilities, stages, live activity registry, External DTO/policy, and tests;
- migration `0037`, journal, snapshot, Drizzle declarations for only the three durable columns, and
  migration/splitter tests;
- migration-only rollback table, rollback unique index, normalization index, and `_tb5a_*` scratch
  objects in SQL only—not `schema.ts` or `0037_snapshot.json`;
- DB winner/compaction, Board position, activity, Deadline, workflow-tail, token, query-plan, and
  bundle tests;
- new app `project-stage.ts` and `project-board-order.ts`;
- app project, Stage, Admin, Deadline, External-query, and Kanban modules/tests;
- every app/background Stage-and-position writer named in the inventories;
- internal/External summary and detail adapters and strict decoders;
- Dashboard, Project Workspace, Project Overview rail, query ownership, styles, and DOM tests;
- closeout documentation only after production verification.

Changes to `prototype/`, Calendar, provider credentials, delivery publish/revoke behavior, media
deletion, React/dependency versions, global Stage configuration, External Priority policy, or the
accepted capability boundary require fresh review.

## Notes for the builder

No unresolved product or architectural decision remains. The builder must hold these conditions:

1. Never restore `CASE WHEN priority IS NULL THEN 1 ELSE 0 END,` in migration `0037`. Use
   `(priority IS NULL),`, run Wrangler’s own splitter, and re-audit every compound `END`.
2. Every single-reference snapshot fence CTE is `AS MATERIALIZED`; the compacting scratch-D1 plan
   must say `MATERIALIZE fence`.
3. `moveProjectStage` does not grant same-Stage reorder. Reject internal/External Editors with
   `403 project_board_reorder_forbidden`; successful same-Stage reorder belongs only to
   `project-board-order.ts`, requires `prioritizeProjects`, and audits
   `project.board_position_set`. Cross-Stage movement is unchanged.
4. The full Stage-and-position writer inventory closes in Slice 0. All three legacy helper
   definitions/imports/tests move together in Slice 5, and no position writer survives Slice 6
   without revision fencing.
5. If migration `0037` renumbers, its rollback table, unique index, marker literal in every Worker
   isolate, scratch names, journal, snapshot, filenames, and tests renumber together.
6. `project.stage.changed` remains `emptyPayload`; make its registry entry live with the exact
   producer call site and source key
   `project-stage:<projectId>:transition:<activityId>`. Keep its generic safe copy.
7. External summary/detail `stageKey` is `z.enum(STAGE_PRESENTATION_KEYS)`.
   `stageTransportKeyForRole` absorbs the existing External Editing mapping.
8. Both non-compacting exact placement and compacting SQL are normative executable contracts and
   must pass scratch-D1 proofs unchanged in substance.
9. A compaction is a full-column renumber and can invalidate many optimistic tokens. Record bounded
   measurements and stop rollout if production exceeds the measured envelope.
10. Migration-only rollback/scratch tables and indexes stay out of Drizzle schema and snapshot so
    the second generation remains a no-op.
11. The six named bare project reads are the verified pre-marker list. Repeat the audit after edits;
    no statement referencing a `0037` column may be constructed or prepared before the marker.
12. Legacy `renumberedInsertPosition` starts at `1024`; migration and the new compactor start at
    `0`. Do not preserve the old offset accidentally.
13. The trailing-slash Stage route is intentional net-new strict-Hono surface and must appear in the
    route manifest.
14. Removing `/admin/backfill-board-position` includes its manifest entry,
    `admin.board_position_backfill`, and all associated tests.
15. `projects.board_revision` remains the per-project conflict and continuous-occupancy token; no
    global Stage revision is exposed.
16. `autohdr_handoffs.editing_entry_board_revision` and source
    `jobs.stage_entry_board_revision` remain the workflow-specific entry-token owners.
17. Job-owned completion uses explicit source-entry-job propagation; missing legacy provenance
    fails closed.
18. `expected_target.newBoardPosition` remains the deterministic full-destination plan used to
    prove the exact changed-row set.
19. `@quincy/db` owns all prepared SQL bundles; callers own authorization, composition,
    named-index interpretation, and post-commit finalization.
20. `onSuccess` remains only as a temporary compatibility hook and is removed with every named
    caller in one green slice.
21. External exact placement remains immediate-before-visible-`after`, with global append when
    `after=null`, while hidden rows retain relative order.
22. The permanent rollback table remains no-FK, and pre-enable rollback uses the all-or-zero CHECK
    batch.
23. External Editor’s old ID fallback is intentionally corrected to authorized canonical order.
24. Internal and strict External detail DTOs expose only role-safe `stageKey`, `boardRevision`, and
    `contractEnabled` as required by direct Workspace entry.
25. Authoritative Board-map rendering ships in Slice 4; Slice 7 adds interactions without changing
    order authority.
26. Confirmation remains the exact cumulative typed-reason array.
27. One seeded-OFF durable flag, one old-schema-safe marker check, and one reviewed source revision
    provide the inert/enabled rollout boundary.