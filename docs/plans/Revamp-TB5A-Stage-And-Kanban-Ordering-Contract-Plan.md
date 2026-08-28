# Revamp TB5A — Project Stage and Kanban Ordering Contract

**Status:** DRAFT — round 2 revision, awaiting fresh-Opus plan-tier review.

**Review-state note:** This is a plan-only artifact. It authorizes no code, migration, deployment,
or production mutation. The implementation baseline / parent commit is
`8b7b3f96b1195c8dbaef547348962a7bb9bd3079`; the draft commit is
`7f04955e9456eccf482bb87befccad02eea4fac9`. The checked-in migration journal ends at `0036`,
and `docs/todo.md` records migration `0036` applied to production on 2026-08-28. The read-only
planning sandbox could not query production D1, so implementation must still verify that the remote
`d1_migrations` tail is `0036` before claiming `0037`.

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

## Purpose

TB5A establishes one Stage-movement contract and removes the hidden coupling between Priority and
manual Kanban order.

Delivered outcomes:

- Admins, internal Editors, and assigned External Editors can move an unarchived project from the
  Project Workspace rail, native Kanban drag, or a keyboard/non-drag action.
- Every human Stage change uses one command with identical capability, authorization,
  expected-state, confirmation, audit, activity, Deadline, notification, and conflict semantics.
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

### Exact current Stage-writer inventory

The current DB helper is `packages/db/src/stage-transition.ts#guardedStageTransition`. It guards
source Stage and archive state, appends to the destination, writes `stage.auto_advance`, and invokes
a best-effort `onSuccess` hook after a winning batch. It does not currently fence Board revision or
continuous workflow-owned Stage occupancy.

| File / function | Current primitive | Current Stage audit | Current prerequisite | Current notification | TB5A target |
|---|---|---|---|---|---|
| `workers/app/src/lib/ingest.ts#finalizeIngest` | `guardedStageTransition` | `stage.auto_advance` | Durable RAW asset | `raw_ready` | Automatic winner bundle; caller finalizer |
| `workers/background/src/dropbox/sync.ts#syncProjectRawFolder` | `guardedStageTransition` | `stage.auto_advance` | Reconciliation claim and RAW evidence | `raw_ready` | Automatic winner bundle; caller finalizer |
| `workers/background/src/reconcile-awaiting-raw.ts#advanceAwaitingRawProject` | Direct guarded update/audit batch | `stage.auto_advance` | Shoot date due on Sydney business date | `raw_ready` | Typed reconciliation prerequisite |
| `workers/background/src/autohdr/claims.ts#confirmAutoHdrHandoff` | Direct Stage/audit/handoff batch | `stage.auto_advance` | Handoff identity/connection/generation/state | `sent_to_editing` | Winner plus handoff token tail |
| `workers/background/src/autohdr/claims.ts#claimAutoHdrRepeatSend` | Stage update inside claim batch | `stage.auto_advance` | Retirement/new mapping winner | None here | Winner plus new handoff token |
| `workers/background/src/autohdr/claims.ts#claimImplicitAutoHdrHandoff` | Direct claim batch | `stage.auto_advance` | Mapping/path ownership | `sent_to_editing` | Winner plus handoff token tail |
| `workers/background/src/autohdr/claims.ts#claimBackfillAutoHdrHandoff` | Direct claim batch | `stage.auto_advance` | Mapping/path claim | `sent_to_editing` | Winner plus handoff token tail |
| `workers/background/src/workflows/autohdr-api-send.ts#complete-autohdr-api-send` | Direct Stage/job/audit batch | Stage and workflow audits | Provider finalize and exact job | `sent_to_editing` | Winner plus job token tail |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` with handoff | `confirmAutoHdrHandoff` | As above | Frozen handoff | `sent_to_editing` | Converted handoff command |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` legacy no-handoff | Direct Drizzle Stage update | None | Legacy workflow input/source Stage | `sent_to_editing` | Propagated entry-job token or fail closed |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` same-hash | `guardedStageTransition` | `stage.auto_advance` | Handoff/mapping/fetch/coverage | `edited_landed` | Completion with handoff entry token |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` first-version | Direct asset/claim/Stage batch | `stage.auto_advance` | Current asset and coverage | `edited_landed` | Completion with handoff entry token |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` replacement | `guardedStageTransition` | `stage.auto_advance` | Replacement claim and coverage | `edited_landed` | Completion with handoff entry token |
| `workers/background/src/workflows/autohdr-fetch.ts#advance-stage` legacy | Direct Drizzle Stage update | None | Returned edited coverage | `edited_landed` | Propagated entry-job token or fail closed |
| `workers/app/src/routes/projects.ts` Stage handler | Unguarded Stage/append write | `stage.set` | Route-local access | Legacy `delivered` | Replaced by `moveProjectStage` |

Final source audit also covers creation, archive, restore, manual position, and Priority-coupled
position writers. No production Stage or position mutation may remain outside an owned TB5A
command/bundle.

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
- Add one route-independent human Stage command and a same-Stage order command.
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
- a second activity/outbox system.

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

Rules:

- Admin may receive and submit `editing_autohdr`.
- Internal and External Editors receive and submit only `editing`.
- Non-Admin submission of `editing_autohdr` is invalid.
- The server maps `editing` to `editing_autohdr` only after authentication and capability checks.
- Audit/activity storage uses semantic `StageKey`.
- Provider vocabulary never appears in non-Admin API, DOM, modal, toast, console, or notification
  payloads.

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
- Archived Dashboard remains List-only.
- Admin/internal Editor receives `409 project_archived_read_only`.
- External missing, unassigned, archived, or nonexistent project receives the same generic `404`.
- Photographer receives a constant capability `403`.
- No failed or no-op request writes Stage, position, revision, audit, activity, outbox, Deadline, or
  workflow state.

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
Archived, inactive-destination, confirmation-required, contract-disabled, and pre-schema
maintenance results use distinct codes.

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
2. active principal and capability;
3. External visible-project authorization before existence disclosure;
4. archive state;
5. role-safe transport normalization;
6. expected Stage and revision;
7. active destination;
8. confirmation classification and equality;
9. neighbour visibility and revision;
10. complete target-Stage snapshot;
11. canonical placement;
12. prepared winner/activity/Deadline bundle composition;
13. fixed result-index interpretation;
14. authoritative role-safe reread;
15. publication IDs and finalizer intent.

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

Unexpected D1/runtime failures throw and remain `500`.

### Route forms and legacy discriminator

Register one shared handler for:

```text
POST /projects/:id/stage
POST /projects/:id/stage/
```

Both use the same session, CSRF, terminal-route, body, command, and finalizer chain.

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

### Non-compacting winner

A non-compacting move consists of:

1. one guarded target-project update;
2. one audit marker requiring `changes() = 1`;
3. marker-gated activity, outbox/ledger, workflow, and Deadline tails.

The update requires the durable feature flag, exact project ID, source Stage, archive state,
expected revision, typed prerequisite, and placement snapshot.

Append is computed inside the update:

```sql
SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
```

Exact placement also fences the complete target-Stage snapshot encoded as one JSON parameter. If any
ID, Stage, position, revision, archive state, or row count changed, it updates zero rows.

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
fence AS (
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

Payload:

```ts
{
  fromStageKey: StageKey;
  toStageKey: StageKey;
}
```

Registry contract:

```text
category: stage
producer: moveProjectStage
source kind: project_stage
source key: project-stage:<projectId>:transition:<activityId>
actor: user
deep link: project
coalescing: none
channels: in_app only
email default: off
backfill: none
```

Every winning human Stage change emits one immutable activity. Automatic advances, same Stage,
conflicts, cancellation, inactive target, archive, and failed authorization do not.

Reuse `buildProjectActivityStatements()` and TB4C recipient-cycle semantics:

- at most one broad outbox and one in-app ledger per eligible membership cycle;
- exact membership-cycle and authorization-epoch admission;
- no broad email or coalescing;
- External assigned recipients receive fixed generic safe copy;
- External notification projection never exposes semantic Editing keys.

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
4. stop and renumber if any check differs.

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
        CASE WHEN priority IS NULL THEN 1 ELSE 0 END,
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
  WHEN changes() = (
    SELECT COUNT(*)
    FROM project_board_order_0037_rollback
  )
  AND NOT EXISTS (
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
  THEN 1
  ELSE 0
END;
--> statement-breakpoint
DROP TABLE _tb5a_0037_normalization_postflight;
```

The preflight CHECK aborts on a noncanonical unarchived Stage. The postflight CHECK aborts unless
the guarded update affected every captured row and every captured row matches normalized state.

The comparator remains exactly:

```sql
CASE WHEN priority IS NULL THEN 1 ELSE 0 END,
board_position,
id
```

Never add numeric `priority ASC`.

The migration:

- records every unarchived project, including one occupying an inactive configured Stage;
- changes no Stage or Priority;
- changes no archived row beyond exposing default columns;
- assigns `0,1024,2048,…` per semantic Stage;
- assigns every normalized unarchived project revision `1`;
- creates no audit, activity, outbox, or workflow notification;
- uses no rebuild, `PRAGMA foreign_keys=OFF`, permanent-data drop, or rollback-table foreign key.

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

This test accompanies normal full-chain, `0036→0037`, preflight-failure, Wrangler, and scratch-D1
proofs.

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

After any genuine Stage/reorder/archive/restore write, mass restore and revision reset are forbidden.
Keep the no-FK rollback table permanently and fix forward.

Remove `/admin/backfill-board-position`; it must not survive as a second ordering authority.

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

The route rewrite, tests, import removal, and deletion of `priorityInsertNeighbors` occur in one
slice. Before the `0037` marker exists, the route returns bounded
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
- requires the post-`0037` schema variant and enabled feature flag;
- validates target Stage/revision and visible neighbours;
- applies the same canonical global-anchor and full-snapshot rules;
- writes position/revision only;
- writes one `project.board_position_set` audit;
- creates no activity or outbox;
- returns authoritative visible order;
- returns `409` on stale state without retry.

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
  boardRevision: number;
  contractEnabled: boolean;
};
```

`externalProjectDetailSchema` remains `.strict()`, and
`externalProjectDetailToWorkspace()` explicitly maps both fields. A direct Workspace deep link can
therefore create:

```ts
{
  expected: {
    stageKey: detail.stageKey,
    boardRevision: detail.boardRevision
  }
}
```

without Dashboard state.

Privacy sentinel tests inject `priority`, `boardPosition`, an internal Editing key, hidden IDs, and
hidden counts into External detail. Strict decoding must reject each response. Valid External detail
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

- `draggable` uses `moveProjectStage`;
- column background uses append;
- card boundaries submit exact visible neighbours;
- confirmation keeps the card in its source column until accepted;
- conflict restores authoritative state;
- no dnd-kit dependency is added.

Every movable card also has a keyboard-operable Move Stage action using the same destinations,
confirmation, append placement, focus return, and live-region announcement.

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

### `pre_0037` variant

- Normal internal list/detail reads use their old-column SQL projections.
- Normal strict External list/detail reads use old-column authorized SQL projections.
- Response adapters synthesize `boardRevision: 0` and `contractEnabled: false`; those values are
  inert presentation defaults, not concurrency authority.
- Legacy Board presentation remains active; no authoritative post-normalization map is claimed.
- Stage, reorder, archive, restore, creation, automatic Stage writers, and all service/RPC paths
  capable of invoking them return bounded `503 board_schema_maintenance`.
- The metadata-only Priority route also returns `503 board_schema_maintenance`.
- No builder containing `board_revision`, either workflow token column, or normalized-order indexes
  is invoked or prepared.
- Background Queue, Workflow, Cron, reconciliation, Dropbox, and AutoHDR handlers classify the
  bounded maintenance result without retry storms or Stage side effects.

### `tb5a_0037` variant

- List/detail reads select actual `board_revision` and the durable flag.
- Authorized order maps are computed from post-migration canonical order.
- All Board writers use the new bundles but remain disabled while the flag is OFF.
- Priority may use its new metadata-only statement even while the Board flag is OFF.
- Automatic writers remain flag-gated.

Variant-selection tests use a real `0036` schema and fail the test if any trace or preparation
mentions a `0037` column before the marker check completes.

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
- Record implementation parent, draft, migration tail, dependency pins, and test counts.
- Make no production signature removal.

Gate: typecheck, web build, existing Kanban/background characterization suites.

### Slice 1 — additive shared contract

- Add capability, Stage transport, sequence, confirmation, request/response, revision, placement,
  activity, and External-safe schemas.
- Add internal and strict External detail revision/contract fields.
- Keep current Stage call sites on compatibility types until their owning slice.
- Add shared truth-table, strict-schema, and privacy-sentinel tests.

Gate: typecheck, web build, shared Vitest, affected workspace tests.

### Slice 2 — migration and schema

- Add the exact breakpoint-separated migration `0037`, three additive columns, rollback table,
  indexes, flag seed, journal, snapshot, and migration tests.
- Prove full-chain, `0036→0037`, preflight failure, and postflight transactional rollback.
- Keep production helpers intact.

Gate: typecheck, web build, DB migration tests, local Wrangler, scratch D1, foreign-key check, and
`quick_check`.

### Slice 3 — additive DB bundles

- Add prepared winner, normative compaction, complete activity indexes, workflow-token,
  workflow-tail, and Deadline-suppression bundles.
- Retain `guardedStageTransition` and `onSuccess` compatibility executor.
- Retain `priorityInsertNeighbors`.
- Add winner, loser, malformed-plan, compaction, token-tail, and index-layout tests.

Gate: typecheck, web build, DB and existing app/background tests.

### Slice 4 — authorized projection, authoritative rendering, and flag-off UI seam

- Add internal/External Board projections and summary/detail `boardRevision`.
- Add internal and strict External detail `contractEnabled`.
- Add strict decoders and privacy sentinels.
- Replace manufactured-zero/ID ordering with authoritative authorized-map rendering.
- Add durable flag projection and hidden-control behavior.
- Do not change the Stage mutation route signature yet.

Gate: typecheck, web build, query/privacy/detail/web-adapter tests, including independent `Z,A`
External authorized-order behavior.

### Slice 5 — human commands, routes, Priority, and current web caller

In one independently green slice:

- add `moveProjectStage` and manual order command;
- replace both Stage route forms;
- add the legacy-body discriminator;
- change the Dashboard Stage caller to the new request/response;
- move its capability gate to `moveProjectStage`;
- refactor Priority to metadata-only;
- update/remove all tests importing `priorityInsertNeighbors`;
- remove its route import, call, and helper definition;
- remove the temporary Admin backfill route;
- integrate DB-owned Deadline suppression and post-commit Queue finalizer.

Gate: typecheck, web build, app integration, Dashboard, capability, Deadline, activity, and route
tests.

### Slice 6 — automatic writer convergence and compatibility removal

- Convert every inventory row.
- Add SQL-reread workflow Editing-entry token tails.
- Propagate source entry-job identity through every job-owned completion path.
- Permanently fail closed for missing legacy provenance.
- Add move-out, out-and-back ABA, stale-token, and source-job-substitution tests.
- Replace every named `onSuccess` and direct notification owner.
- Remove compatibility executor only after all callers compile.
- Audit that no direct production Stage update remains.

Gate: typecheck, web build, app/background/DB automatic-writer and notification suites.

### Slice 7 — complete interaction UI

- Add rail Stage control.
- Add native exact-neighbour drag and keyboard Move action.
- Add Priority view for authorized internal roles.
- Add interaction ownership, narrow invalidation, neutral-label, focus, and accessibility tests.
- Do not introduce a second Board-order authority; consume the Slice 4 maps.

Gate: typecheck, web build, complete web logic and DOM suites.

### Slice 8 — full proof and deployment preparation

- Run complete verification and repository audits.
- Run local migration/query-plan/performance proof.
- Run Agy browser matrix.
- Obtain fresh read-only implementation diff review.
- Prepare one reviewed schema-aware production revision and recovery export.
- Do not update implemented-plan status until production verification completes.

## Automated test plan

### Shared

Prove capability membership, RAW capability retention, Stage sequence, role-safe Editing,
non-Admin internal-key rejection, all 25 confirmation pairs, cumulative reason order, strict
request/response schemas, activity identity, external policy, provider-safe copy, and summary/detail
revision contracts.

### Migration

Seed all semantic Stages, an inactive configured Stage, archived projects, Priority values
`1,5,10,null`, duplicate/fractional positions, deterministic ID ties, and a noncanonical Stage.

Prove:

- noncanonical unarchived Stage fails before capture;
- archived noncanonical rows do not enter normalization;
- exact breakpoint-separated SQL applies through local Wrangler and scratch D1;
- internal legacy order is preserved;
- External ID order intentionally changes to canonical authorized order;
- normalized positions are `0,1024,…`;
- every captured revision is `1`;
- archived revisions remain `0`;
- rollback rows exactly match unarchived rows;
- Stage/Priority values are unchanged;
- feature flag is seeded OFF;
- workflow entry columns are nullable and constrained;
- indexes exist;
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

For every winner assert exact revision increments, one audit, one human activity, recipient-cycle
fan-out, no email, correct Deadline suppression, and authoritative role-safe order. Every loser or
no-op has zero footprint.

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
- invalid deterministic position sequence.

Every failure leaves all Stage/position/revision rows unchanged.

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
activity, External-safe copy, assigned-only order, no forbidden detail/list fields, authoritative
map rendering, native drag, keyboard action, refresh ownership, access-loss purge, and
Deadline/overdue preservation.

### Pre-schema variants

Against an exact `0036` fixture:

- first marker check selects `pre_0037`;
- old-column internal and External list/detail reads succeed;
- returned detail/list values are inert `boardRevision:0`, `contractEnabled:false`;
- Stage/reorder/archive/restore/create/automatic/Priority paths return bounded maintenance;
- no SQL preparation or execution references a nonexistent `0037` column;
- background handlers do not retry indefinitely or emit workflow notifications.

Against `0037` with flag OFF:

- first marker check selects `tb5a_0037`;
- actual revision and contract fields read successfully;
- Priority metadata-only route is available;
- all Board writers remain disabled by SQL and command gates.

## Repository audits

Run and classify:

```bash
rg -n 'selectForEditing|moveProjectStage' \
  portal/packages/shared portal/apps/web portal/workers

rg -n \
  'SET stage_key|stageKey:|stage_key =|update\(.*projects.*stage' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'

rg -n 'board_position|boardPosition|board_revision|boardRevision' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'

rg -n 'priorityInsertNeighbors|priority.*board_position|priority.*boardPosition' \
  portal -g '*.ts'

rg -n \
  'project\.stage\.changed|notifyProject\(.*delivered|notifyProject\(.*sent_to_editing|project\.priority\.changed' \
  portal -g '*.ts'
```

Expected:

- Stage UI/API uses only `moveProjectStage`;
- RAW selection/download retains `selectForEditing`;
- no unowned production Stage or position writer remains;
- every Board-state writer increments revision;
- no Priority-to-position production path remains;
- one human Stage activity producer exists;
- workflow legacy notifications remain only on workflow winners;
- no manual Delivered/Editing legacy notification exists;
- no External adapter manufactures raw ordering authority;
- every summary/detail projection has the intended role-safe revision contract.

Also verify both Stage route forms, no wildcard middleware leak, removed backfill route, TB4E route
manifest, External strict projection, and complete bundle-index exports.

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

The second generation must be a no-op and must not produce a rebuild.

Scratch proof covers the full migration chain, `0036→0037`, exact normalization SQL, preflight
failure, transactional postflight rollback, all-or-zero position rollback, normative compacting
SQL and malformed plans, foreign-key check, quick check, query plans, and representative Board
serialization measurements.

## Manual local QA

Use Agy Option A against `http://localhost:8787` with a human-authenticated dedicated Chrome. Agy
never signs in or handles secrets. Use Admin impersonation for internal role checks and approved
disposable External fixtures.

Cover:

- Admin/internal/External/Photographer capability matrix;
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
2. Create and verify the remote D1 recovery export.
3. Drain notification/project queues to recorded zero or pause consumers with backlog recorded.
4. Stop new Stage-capable Workflow instances and wait until every old Stage-capable instance is
   terminal.
5. Disable Cron and hourly reconciliation triggers.
6. Disable app service/RPC paths that can start Dropbox sync, AutoHDR send/fetch, or reconciliation.
7. Deploy the reviewed background Worker while triggers remain paused; its pre-schema variant must
   perform no Stage or position write.
8. Deploy webhook-ingress only if its reviewed artifact changed.
9. Deploy the same reviewed app Worker in pre-schema maintenance mode.
10. Prove list/detail reads use old projections and all Stage/reorder/archive/restore/create,
    automatic, and Priority mutation paths return bounded maintenance.
11. Prove no statement referencing a `0037` column was prepared.
12. Query audits, jobs, workflows, queues, and Stage/position aggregates twice across a quiet
    interval. Any unexplained change stops rollout.
13. Only then apply migration `0037`.

The freeze covers app RAW ingest, Dropbox reconciliation, Queue consumers, Workflow instances,
Cron, AutoHDR claims/finals, creation, Stage, Priority-coupled legacy order, archive, restore, and
manual reorder. No old Stage writer may execute after normalization.

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
7. monitor Stage conflicts, token losers, outbox failures, and workflow provenance failures.

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
restore a writer that mutates Stage without revision/token fencing.

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
- [ ] Exact MOVE/STAY `selectForEditing` disposition is preserved.
- [ ] Semantic Stage sequence and cumulative confirmations are shared.
- [ ] Non-Admin transport exposes only neutral Editing.
- [ ] Inactive current Stage remains escapable; archived projects are read-only.
- [ ] Legacy `{stageKey}` returns `409 stage_contract_reload_required` on both route forms.

### Ordering and migration

- [ ] Remote tail is confirmed `0036` before applying `0037`.
- [ ] Noncanonical unarchived Stage keys abort migration.
- [ ] Exact breakpoint-separated migration passes Wrangler and scratch D1.
- [ ] Failed postflight CHECK rolls back ALTER/capture/update/flag/index work.
- [ ] Comparator is exactly null-group, `board_position`, ID.
- [ ] Permanent rollback table has no foreign key.
- [ ] Internal order is preserved.
- [ ] External ID fallback changes to authorized canonical order.
- [ ] Positions normalize to `0,1024,…` and unarchived revisions to `1`.
- [ ] Priority and Stage values remain unchanged.
- [ ] Flag is seeded OFF.
- [ ] Pre-enable rollback is all-or-zero through a following CHECK-failure gate.
- [ ] Temporary Admin backfill route is removed.

### Command and DB seam

- [ ] `@quincy/db` owns winner, activity, Deadline, workflow, and token SQL.
- [ ] Complete named indexes include `broadLedger` and every workflow tail.
- [ ] Callers compose bundles only through exported indexes.
- [ ] No caller supplies arbitrary SQL.
- [ ] Post-commit finalizer never runs for a loser.
- [ ] `onSuccess` is removed only with all named production callers.
- [ ] Non-compaction uses one guarded target update.
- [ ] Compaction uses the normative executable all-or-zero SQL.
- [ ] `RETURNING` uses unqualified columns and parses on scratch D1.
- [ ] Expected target is distinct and set-equal to the live fenced snapshot.
- [ ] Changed plan is the exact set of changed rows.
- [ ] Exactly one exact target exists; no sibling can be target.
- [ ] Every changed old tuple is pre-proved live before candidates are admitted.
- [ ] Malformed-plan tests leave every row unchanged.
- [ ] Hidden placement uses immediate-before-`after` or global append.

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
- [ ] Automatic loser produces no Stage audit/revision/activity/outbox/legacy notification.
- [ ] Manual Editing and Delivered moves cause no provider or delivery action.

### Activity, privacy, and UI

- [ ] `project.stage.changed` is human-only, non-coalesced, and in-app-only.
- [ ] Recipient fan-out is at most once per eligible membership cycle.
- [ ] Pure reorder emits no activity/outbox.
- [ ] Priority is metadata-only and externally suppressed.
- [ ] Internal and strict External detail include `boardRevision` and `contractEnabled`.
- [ ] External detail rejects Priority, raw position, hidden IDs/counts, and internal Editing.
- [ ] Slice 4 makes authorized maps the Board rendering authority.
- [ ] External manufactured-zero/ID order is removed.
- [ ] Rail, native drag, and keyboard use the same command.
- [ ] Interaction ownership preserves drag/modal/pending state.
- [ ] Access-loss purge wins over late responses.

### Pre-schema, slices, proof, and rollout

- [ ] One old-schema-safe marker check selects each isolate’s statement variant.
- [ ] Pre-marker reads use old projections.
- [ ] No nonexistent-column statement is constructed or prepared pre-marker.
- [ ] Pre-marker Priority and every Board-affecting writer return bounded maintenance.
- [ ] Every slice independently typechecks, builds, and passes focused tests.
- [ ] Priority helper removal and route rewrite are one slice.
- [ ] Automatic caller conversion and `onSuccess` removal are one slice.
- [ ] Full workspace tests and explicit shared Vitest pass.
- [ ] Second Drizzle generation is a no-op.
- [ ] Writer, capability, ordering, privacy, route, and activity audits are recorded.
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

- shared capabilities, stages, activity registry, External DTO/policy, and tests;
- migration `0037`, journal, snapshot, Drizzle schema, and migration tests;
- DB winner/compaction, Board position, activity, Deadline, workflow-tail, token, and bundle tests;
- new app `project-stage.ts` and `project-board-order.ts`;
- app project, Stage, Admin, Deadline, External-query, and Kanban modules/tests;
- every background writer named in the inventory;
- internal/External summary and detail adapters and strict decoders;
- Dashboard, Project Workspace, Project Overview rail, query ownership, styles, and DOM tests;
- closeout documentation only after production verification.

Changes to `prototype/`, Calendar, provider credentials, delivery publish/revoke behavior, media
deletion, React/dependency versions, global Stage configuration, or External Priority policy require
fresh review.

## Open decisions for review

No unresolved product decision is required before implementation. Fresh Opus plan-tier review should
explicitly affirm or revise:

1. `projects.board_revision` remains the per-project conflict and continuous-occupancy token; no
   global Stage revision is exposed.
2. `autohdr_handoffs.editing_entry_board_revision` and source
   `jobs.stage_entry_board_revision` remain the workflow-specific entry-token owners.
3. Job-owned completion uses explicit source-entry-job propagation; missing legacy provenance fails
   closed.
4. The two winner forms remain guarded single-row non-compaction and the normative executable,
   fully fenced multi-row compaction.
5. `expected_target.newBoardPosition` is the deterministic full-destination plan used to prove the
   exact changed-row set.
6. `@quincy/db` owns all prepared SQL bundles; callers own authorization, composition, named-index
   interpretation, and post-commit finalization.
7. `onSuccess` remains only as a temporary compatibility hook and is removed with every named caller
   in one green slice.
8. External exact placement remains immediate-before-visible-`after`, with global append when
   `after=null`, while hidden rows retain relative order.
9. The permanent rollback table remains no-FK, and pre-enable rollback uses the all-or-zero CHECK
   batch.
10. External Editor’s old ID fallback is intentionally corrected to authorized canonical order.
11. Internal and strict External detail DTOs expose only role-safe `boardRevision` and
    `contractEnabled` as required by direct Workspace entry.
12. Authoritative Board-map rendering ships in Slice 4; Slice 7 adds interactions without changing
    order authority.
13. Confirmation remains the exact cumulative typed-reason array.
14. `project.stage.changed` remains human-command-owned, non-coalesced, and absent from automatic
    advances.
15. One seeded-OFF durable flag, one old-schema-safe marker check, and one reviewed source revision
    provide the inert/enabled rollout boundary.