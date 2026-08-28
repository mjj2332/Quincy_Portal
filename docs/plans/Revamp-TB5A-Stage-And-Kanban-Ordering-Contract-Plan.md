# Revamp TB5A — Project Stage and Kanban Ordering Contract

**Status:** DRAFT — round 1 revision, awaiting fresh-Sol review round 2.

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
  MOVE/STAY call-site table. External Editor gains Stage movement but no RAW selection, deselection,
  review, ZIP, or download-selection capability.

- **Should-fix 5 — writer inventory:** The resolved foundation now identifies every current
  production Stage writer by file/function, current primitive, audit action, prerequisite,
  post-success notification, and TB5A target form.

- **Should-fix 6 — legacy body handling:** Both Stage route forms inspect the raw decoded object for
  the exact legacy `{stageKey}` shape before strict schema parsing and return
  `409 stage_contract_reload_required` without mutation.

- **Should-fix 7 — External order correction:** Migration preserves the current internal comparator
  but intentionally replaces External Editor’s manufactured-zero/ID order with the authorized
  projection of canonical persisted order. This is tested as a deliberate one-time presentation
  correction.

The three review nits are also applied: the review-state SHAs distinguish baseline from draft,
migration prose consistently says “unarchived project,” and the transport helper is named
`stageTransportKeyForRole`, with DTO/label projection kept separate.

## Purpose

TB5A establishes one Stage-movement contract and removes the hidden coupling between Priority and
manual Kanban order.

The delivered outcomes are:

- Admins, internal Editors, and assigned External Editors can move an unarchived project from the
  Project Workspace rail, native Kanban drag, or a keyboard/non-drag action.
- Every human Stage change uses one command with the same capability, authorization, expected-state,
  confirmation, audit, activity, Deadline, notification, and conflict semantics.
- Manual entry into or exit from Editing and Delivered changes Stage only. It does not send,
  retrieve, cancel, retire, publish, revoke, or delete workflow state.
- `board_position` is the sole persisted manual order. Priority and shoot-date modes are non-writing
  views.
- The current internal visible order is frozen once into canonical persisted order.
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
- Hono middleware is path-scoped and exact gated routes cover trailing slashes;
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
- planned migration number is `0037`, conditional on direct remote-tail confirmation;
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

| File / function | Current primitive | Current Stage audit | Current prerequisite | Current post-success notification | TB5A target |
|---|---|---|---|---|---|
| `workers/app/src/lib/ingest.ts#finalizeIngest` (`:214`) | Already calls `guardedStageTransition` | `stage.auto_advance` | Current durable RAW asset exists | `raw_ready` through `onSuccess` | Shared automatic winner bundle; caller finalizer sends `raw_ready` |
| `workers/background/src/dropbox/sync.ts#syncProjectRawFolder` (`:363`) | Already calls `guardedStageTransition` | `stage.auto_advance` | Reconciliation claim plus durable current RAW evidence | `raw_ready` through `onSuccess` | Shared automatic winner bundle; caller finalizer sends `raw_ready` |
| `workers/background/src/reconcile-awaiting-raw.ts#advanceAwaitingRawProject` | Direct D1 guarded update + audit batch | `stage.auto_advance` | Exact shoot date is due on Sydney business date | Cron callback sends `raw_ready` | Typed reconciliation prerequisite in shared winner bundle; caller finalizer sends `raw_ready` |
| `workers/background/src/autohdr/claims.ts#confirmAutoHdrHandoff` | Direct D1 Stage/audit/handoff batch | `stage.auto_advance` | Handoff identity, connection, generation, eligible state | `sent_to_editing` | Winner bundle plus handoff-state tail; persist handoff entry revision; caller finalizer |
| `workers/background/src/autohdr/claims.ts#claimAutoHdrRepeatSend` | Direct Stage update inside retirement/new-claim batch | `stage.auto_advance` | Prior-round retirement, no live fetch/manual ingest, new mapping won | None at this claim site | Winner bundle in claim batch; persist new handoff entry revision; preserve current notification ownership |
| `workers/background/src/autohdr/claims.ts#claimImplicitAutoHdrHandoff` | Direct Stage update inside implicit claim batch | `stage.auto_advance` | New handoff/mapping/path ownership and no collision | `sent_to_editing` | Winner bundle plus typed claim marker; persist handoff entry revision; caller finalizer |
| `workers/background/src/autohdr/claims.ts#claimBackfillAutoHdrHandoff` | Direct Stage update inside backfill batch | `stage.auto_advance` | New handoff/mapping/path claim won | `sent_to_editing` | Winner bundle plus typed claim marker; persist handoff entry revision; caller finalizer |
| `workers/background/src/workflows/autohdr-api-send.ts#complete-autohdr-api-send` | Direct D1 Stage/job/audit batch | `stage.auto_advance` plus workflow-finalized audit | Provider finalize succeeded and claimed job still exists | `sent_to_editing` | Winner bundle; persist job entry revision; post-commit caller finalizer |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` with handoff | Calls `confirmAutoHdrHandoff` | As above | Frozen handoff identity | `sent_to_editing` if transition wins | Same converted handoff command |
| `workers/background/src/workflows/autohdr.ts#mark-send-running` legacy no-handoff branch | Direct Drizzle Stage update | No Stage audit currently | Job/workflow input and exact source Stage | `sent_to_editing` | Shared winner bundle adds canonical `stage.auto_advance`; persist job entry revision |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` same-hash path (`:191`) | Calls `guardedStageTransition` after replay repair | `stage.auto_advance` | Handoff/mapping/fetch/coverage identity | `edited_landed` through `onSuccess` | Winner bundle requires handoff entry revision; caller finalizer |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` first-version path (`:246`) | Direct Stage update inside asset/claim batch | `stage.auto_advance` | New claim-current asset and credible coverage | `edited_landed` after commit | Winner bundle in same batch; exact handoff revision fence; caller finalizer |
| `workers/background/src/autohdr/finals.ts#writeAutoHdrFinal` replacement path (`:296`) | Calls `guardedStageTransition` after replacement batch | `stage.auto_advance` | Replacement claim plus handoff/mapping/fetch/coverage identity | `edited_landed` through `onSuccess` | Winner bundle requires handoff entry revision; caller finalizer |
| `workers/background/src/workflows/autohdr-fetch.ts#advance-stage` legacy branch | Direct Drizzle Stage update | No Stage audit currently | Selected RAW coverage by returned edited assets | `edited_landed` | Shared winner bundle adds canonical audit and requires job entry revision |
| `workers/app/src/routes/projects.ts` Stage handler (`:1113`) | Unguarded Drizzle Stage/append write | `stage.set` even around bad no-op behavior | Route-local access and destination-active check | Legacy `delivered` | Replaced by `moveProjectStage`; no legacy workflow notification |

Final source audit must also account for creation, archive, restore, and manual position writers.
No production Stage or position mutation may remain outside an owned TB5A command/bundle.

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
Board order falls back to ID. TB5A intentionally changes that currently visible order once:
External Editor will consume the authorized projection of canonical persisted order. This is a
correction, not a promise to preserve the old External ID presentation.

## Scope

### In scope

- Add `moveProjectStage` and keep RAW-only `selectForEditing`.
- Add Stage sequence, transport projection, confirmation classifier, strict schemas, and conflict
  responses in `@quincy/shared`.
- Add `projects.board_revision`.
- Persist workflow-owned Editing-entry revisions.
- Normalize current internal Board order and retain permanent rollback evidence.
- Make Priority metadata-only and add a non-writing Priority view.
- Add one route-independent human Stage command and a same-Stage order command.
- Converge all Stage/position writers on shared prepared bundles.
- Add External-safe Board order and revision projections.
- Add Project Workspace rail, native drag, keyboard movement, confirmations, and refresh ownership.
- Activate human-only, non-coalesced `project.stage.changed`.
- Make Delivered Deadline suppression atomic with its winning Stage move.
- Add migration, API, DB, background-race, web, privacy, rollout, and browser evidence.

### Hard non-goals

- dnd-kit or TB5B;
- Calendar, FullCalendar, Deadline sorting, or project Deadline redesign;
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

`stageTransportKeyForRole` returns a key, not a label. `projectStageDtoForRole` owns the role-safe
key/label DTO.

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
exact array equality. Missing, extra, duplicated, or reordered reasons return:

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

Status is `409`. Cancelling performs no request or optimistic mutation.

Confirmation copy must explain backward movement, skipped production steps, Stage-only Delivered
behavior, and Stage-only Editing behavior. One modal may explain multiple reasons.

### Active/inactive and archived behavior

- Only an active configured Stage may be entered.
- An inactive current Stage remains displayed and can be exited.
- An inactive non-current Stage cannot be entered.
- Same-Stage selection is a no-op.
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
until restore appends and increments them.

### Workflow entry tokens

Migration `0037` also adds nullable safe-integer columns:

```text
autohdr_handoffs.editing_entry_board_revision
jobs.stage_entry_board_revision
```

A workflow-owned transition into Editing records the returned project `board_revision` in its
owning handoff or legacy job inside the same winning batch. Manual Editing entry never writes these
tokens.

Any automatic Editing → Edited Review completion must require:

```text
projects.stage_key = 'editing_autohdr'
AND projects.board_revision = owning_workflow.editing_entry_board_revision
```

plus its existing handoff/job/import prerequisite. A null token fails closed.

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

Both-null `between` normalizes to append. A bottom placement uses append, not a visible neighbour
that might hide later global rows.

### Canonical hidden-neighbour rule

For a `between` request:

1. `before` and `after` must be adjacent in the caller’s authorized target-column projection, after
   excluding the moving target.
2. Each supplied neighbour must still be visible, unarchived, in the semantic target Stage, and at
   the supplied revision.
3. The server loads and fences the complete target-Stage snapshot, including rows hidden from the
   caller.
4. If `after` is non-null, the canonical global anchor is immediately before that global row.
5. If `after` is null, placement is a global append after every target-Stage row.
6. Hidden rows keep their relative order.
7. The response returns only the caller-visible order.

Thus visible `A, B` with hidden `H` globally ordered `A, H, B` inserts the target as
`A, H, target, B`. It never chooses the alternative `A, target, H, B`.

Tests include zero, one, and multiple hidden rows between visible neighbours, with both available
midpoint space and forced compaction.

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

Changed Stage/revision/neighbour/snapshot/assignment premises return `409 project_stage_conflict`
with authoritative role-safe current state and no automatic retry. Archived, inactive-destination,
and confirmation-required results use their distinct codes.

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

1. active principal and capability;
2. External visible-project authorization before existence disclosure;
3. archived state;
4. role-safe transport normalization;
5. expected Stage and revision;
6. active destination;
7. confirmation classification/equality;
8. neighbour visibility and revision;
9. full target-Stage snapshot;
10. canonical placement;
11. prepared winner/activity/Deadline bundle composition;
12. fixed result-index interpretation;
13. authoritative role-safe reread;
14. publication IDs and finalizer intent.

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
  | { kind: "disabled" };
```

Unexpected D1/runtime failures throw and remain `500`.

### Route forms and legacy discriminator

Register one shared handler for:

```text
POST /projects/:id/stage
POST /projects/:id/stage/
```

Both use the same session, CSRF, terminal-route, body, command, and finalizer chain.

After JSON decoding but before the strict TB5A schema parser, perform this discriminator:

```ts
const isExactLegacyStageBody =
  isPlainObject(body) &&
  Object.keys(body).length === 1 &&
  Object.prototype.hasOwnProperty.call(body, "stageKey") &&
  typeof body.stageKey === "string";
```

If true, return:

```json
{
  "error": "Reload the application before moving this project.",
  "code": "stage_contract_reload_required"
}
```

with `409`. Do not authorize a compatibility write, call the command, or mutate anything. Other
invalid objects go through the strict parser and normally return `400`.

The route performs no Stage SQL, audit, Deadline suppression, legacy `delivered` notification, or
independent retry.

## DB bundle and command layering

### Ownership

`@quincy/db` owns prepared-statement construction for:

1. the Stage/position/revision winner plus audit marker;
2. the existing project activity/outbox/ledger bundle;
3. marker-gated project Deadline suppression;
4. typed workflow-entry-token and workflow-prerequisite tails.

The app/background layer owns:

- authorization and domain classification;
- loading the authorized snapshot;
- selecting a typed DB bundle input;
- composing the returned prepared statements;
- reading exported fixed result indexes;
- post-commit finalization.

`packages/db` does not import `workers/app`. The app Deadline module no longer owns SQL generation.
Its public archive/test helper delegates to the DB-owned suppression bundle.

No caller supplies arbitrary SQL. Workflow prerequisites are a closed typed union such as:

```ts
type GuardedTransitionPrerequisite =
  | { kind: "none" }
  | { kind: "raw_reconciliation"; claimId: string; shootDate: string }
  | { kind: "autohdr_handoff"; handoffId: string; generation: number; connectionId: string }
  | { kind: "autohdr_mapping"; mappingId: string; generation: number }
  | { kind: "autohdr_final_claim"; claimId: string; handoffId: string; currentAssetId: string }
  | { kind: "autohdr_job"; jobId: string };
```

### Prepared bundle indexes

Each DB builder returns a fixed statement layout and named relative indexes:

```ts
type PreparedStatementBundle<TIndexes> = {
  statements: D1PreparedStatement[];
  indexes: TIndexes;
};

type StageWinnerIndexes = {
  winner: 0;
  auditMarker: 1;
  workflowEntryToken?: 2;
};

type ActivityBundleIndexes = {
  activity: number;
  broadOutbox: number;
};

type DeadlineSuppressionIndexes = {
  occurrences: number;
  ledgers: number;
  outboxes: number;
};
```

The command offsets each bundle once when composing the final array. It reads only these exported
indexes; it does not depend on undocumented magic offsets or infer success from the final statement.

### Post-commit finalizer and `onSuccess`

The final Stage-transition interface does not retain `onSuccess`.

A caller/executor-owned finalizer receives only committed intent:

```ts
type CommittedStageFinalizerIntent = {
  publicationIds: string[];
  legacyWorkflowNotification?:
    | "raw_ready"
    | "sent_to_editing"
    | "edited_landed";
};
```

It is constructed only when the winner update and audit marker succeed. It:

- publishes returned outbox IDs;
- invokes the existing legacy workflow notification only for the owning automatic workflow;
- never runs for a loser, no-op, conflict, or failed batch;
- preserves current best-effort error handling after the database commit.

Migration is staged safely:

- the existing `guardedStageTransition(..., onSuccess)` compatibility executor remains through the
  additive DB slice;
- `ingest.ts:214`, `sync.ts:363`, `finals.ts:191`, and `finals.ts:296` move to explicit finalizer
  intents in the automatic-writer convergence slice;
- all other current notification call sites in the inventory move in the same slice;
- only after every caller moves are `onSuccess` and its compatibility executor removed.

Human `moveProjectStage` produces Queue publication IDs but no legacy workflow notification.

## Two mutually exclusive Stage winner forms

### Non-compacting winner

A non-compacting move consists of:

1. one guarded target-project update;
2. one audit marker requiring `changes() = 1`;
3. marker-gated activity, outbox/ledger, workflow-token, and Deadline tails.

The update requires the durable feature flag, exact target ID, source Stage, archive state, expected
revision when applicable, typed prerequisite, and placement snapshot.

Append is computed inside the update:

```sql
SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
```

For exact placement, the update also fences the complete target-Stage snapshot encoded as one JSON
parameter. If any ID, Stage, position, revision, archive state, or row count changed, it updates zero
rows.

### Compacting winner

A compacting move has no preceding target-project Stage update.

The command supplies:

- the exact target project snapshot;
- the complete target-Stage snapshot, including hidden rows;
- a validated changed-row plan containing the target and only siblings whose positions change;
- `expectedChangedRowCount`.

One fully snapshot-fenced multi-row statement:

- proves the full target snapshot has identical row count and identical
  `(id, stage_key, board_position, board_revision, archived_at)` values;
- proves the target’s exact source Stage and revision;
- proves the changed-row JSON contains distinct expected IDs and exactly
  `expectedChangedRowCount` rows;
- applies the target Stage transition and every changed sibling position using `CASE`;
- assigns deterministic `0, 1024, 2048, …` positions;
- increments each changed row’s revision once;
- affects zero rows if any fence fails.

Conceptual normative shape:

```sql
WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_extract(value, '$.stageKey') AS stage_key,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision
  FROM json_each(?1)
),
changed_plan AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_extract(value, '$.oldStageKey') AS old_stage_key,
    CAST(json_extract(value, '$.oldBoardPosition') AS REAL) AS old_board_position,
    CAST(json_extract(value, '$.oldBoardRevision') AS INTEGER) AS old_board_revision,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    CAST(json_extract(value, '$.isTarget') AS INTEGER) AS is_target
  FROM json_each(?2)
),
fence AS (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1 FROM feature_flags
    WHERE key = ?3 AND enabled = 1
  )
  AND (SELECT COUNT(*) FROM changed_plan) = ?4
  AND (SELECT COUNT(DISTINCT project_id) FROM changed_plan) = ?4
  AND (SELECT COUNT(*) FROM expected_target) = ?5
  AND (
    SELECT COUNT(*) FROM projects
    WHERE stage_key = ?6 AND archived_at IS NULL AND id <> ?7
  ) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE p.id IS NULL
       OR p.archived_at IS NOT NULL
       OR p.stage_key <> e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision <> e.board_revision
  )
  AND EXISTS (
    SELECT 1 FROM projects
    WHERE id = ?7
      AND stage_key = ?8
      AND board_revision = ?9
      AND archived_at IS NULL
  )
)
UPDATE projects AS p
SET
  stage_key = CASE WHEN c.is_target = 1 THEN ?6 ELSE p.stage_key END,
  board_position = c.new_board_position,
  board_revision = p.board_revision + 1,
  updated_at = ?10
FROM changed_plan c, fence
WHERE p.id = c.project_id
  AND p.stage_key = c.old_stage_key
  AND p.board_position IS c.old_board_position
  AND p.board_revision = c.old_board_revision
  AND p.archived_at IS NULL
RETURNING p.id, p.stage_key, p.board_position, p.board_revision;
```

The implementation may specialize the same-stage reorder variant, but it must preserve these
all-or-zero fences.

The immediately following audit marker is:

```sql
INSERT INTO audit_log (
  id, actor_id, action, target_type, target_id, meta_json, created_at
)
SELECT ?1, ?2, ?3, 'project', ?4, ?5, ?6
WHERE changes() = ?7
RETURNING id;
```

`?7` is `1` for the non-compacting form and `expectedChangedRowCount` for the compacting form.
All tails require that exact audit ID. A loser therefore has zero audit, activity, outbox, ledger,
Deadline, and workflow-entry-token footprint.

## Automatic workflow safety and ABA fencing

Every automatic writer uses the same DB-owned winner bundle while retaining its workflow owner:

- exact source Stage remains mandatory;
- archive remains forbidden;
- destination append remains canonical;
- existing handoff/job/import prerequisite remains in the same batch;
- winning Stage audit remains `stage.auto_advance`;
- no human confirmation applies;
- no human `project.stage.changed` event is emitted;
- legacy workflow notification remains at its current owning workflow.

For an AutoHDR completion, the final Stage predicate includes:

```text
project.id = expected project
AND project.stage_key = editing_autohdr
AND project.board_revision = handoff.editing_entry_board_revision
AND project.archived_at IS NULL
AND the exact handoff/mapping/fetch/import winner prerequisite remains valid
```

Legacy no-handoff flows use `jobs.stage_entry_board_revision`.

Required ABA test:

1. workflow-owned Editing entry commits revision `5` and records `5`;
2. human moves out of Editing, producing revision `6`;
3. human re-enters Editing, producing revision `7`;
4. old completion checks Stage and stored entry revision `5`;
5. Stage matches but revision does not;
6. completion changes zero Stage rows and produces no Stage audit/revision/activity/outbox or legacy
   notification;
7. imported immutable media may retain its independently committed truth.

Manual moves never retire workflow state. The revision token, not retirement, is the safety fence.

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

Every winning human Stage change emits one immutable activity. Automatic workflow advances, same
Stage, conflicts, cancellation, inactive target, archive, and failed authorization do not.

Reuse `buildProjectActivityStatements()` and its TB4C recipient-cycle semantics:

- at most one broad outbox and one in-app ledger per eligible membership cycle;
- exact membership-cycle and authorization-epoch admission;
- no broad email;
- no coalescing;
- External assigned recipients receive fixed generic safe copy;
- External notification projection never exposes semantic Editing keys.

The human command does not call legacy `notifyProject(..., "delivered")` or
`notifyProject(..., "sent_to_editing")`.

Winning Priority changes retain `project.priority.changed` and internal broad fan-out. Pure Board
reorder produces audit only.

## Migration `0037`

### Numbering discipline

Before creating files:

1. query production `d1_migrations` and require tail `0036`;
2. require local journal and migration directory tail `0036`;
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

The migration uses modern SQLite window functions and `UPDATE … FROM`. D1’s current SQLite engine
supports `ROW_NUMBER() OVER (...)`; no app-side ranking pass is needed. These exact statements must
be executed successfully by both local Wrangler and a scratch D1 before production approval.

```sql
CREATE TABLE _tb5a_0037_stage_preflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

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

DROP TABLE _tb5a_0037_stage_preflight;

ALTER TABLE projects
ADD COLUMN board_revision INTEGER NOT NULL DEFAULT 0
CHECK (
  typeof(board_revision) = 'integer'
  AND board_revision >= 0
  AND board_revision <= 9007199254740991
);

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

INSERT INTO feature_flags (key, enabled, updated_by, updated_at)
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

CREATE TABLE project_board_order_0037_rollback (
  project_id TEXT PRIMARY KEY NOT NULL,
  stage_key TEXT NOT NULL,
  priority INTEGER,
  old_board_position REAL NOT NULL,
  normalized_board_position REAL NOT NULL,
  visible_rank INTEGER NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX project_board_order_0037_stage_rank_idx
ON project_board_order_0037_rollback(stage_key, visible_rank);

CREATE INDEX projects_stage_archive_board_order_idx
ON projects(stage_key, archived_at, board_position, id);

CREATE TABLE _tb5a_0037_normalization_postflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

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

INSERT INTO _tb5a_0037_normalization_postflight (ok)
SELECT CASE
  WHEN changes() = (
    SELECT COUNT(*)
    FROM project_board_order_0037_rollback
  )
  AND NOT EXISTS (
    SELECT 1
    FROM project_board_order_0037_rollback r
    LEFT JOIN projects p ON p.id = r.project_id
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

DROP TABLE _tb5a_0037_normalization_postflight;
```

The preflight table’s CHECK deliberately aborts the migration on a noncanonical unarchived Stage
key. The postflight CHECK aborts if the guarded update did not affect exactly every captured row or
if any captured row does not match its normalized state.

The comparator must remain exactly:

```sql
CASE WHEN priority IS NULL THEN 1 ELSE 0 END,
board_position,
id
```

Never add numeric `priority ASC`.

The migration:

- records every unarchived project, including one occupying an inactive configured Stage;
- changes no Stage or Priority;
- changes no archived row except exposing the new default columns;
- assigns `0, 1024, 2048, …` per semantic Stage;
- assigns every normalized unarchived project revision `1`;
- creates no audit, activity, outbox, or workflow notification;
- uses no table rebuild, `PRAGMA foreign_keys=OFF`, drop of permanent data, or foreign key on the
  rollback table.

### External order correction

For internal roles, normalization preserves the current visible comparator exactly.

For External Editor, it intentionally changes the current manufactured-zero/ID presentation to the
authorized projection of canonical persisted order. Migration and web tests must prove this
one-time correction explicitly and must not describe External ID order as preserved.

### Rollback boundary

Before any TB5A Board write is enabled, an authorized targeted rollback may use prepared SQL shaped
as:

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

Bind `?1` to the migration baseline `1`. Verify affected-row count against the rollback table before
committing any revision rebaseline.

After any genuine Stage/reorder/archive/restore write, do not mass-restore positions or reset
revisions. Keep the no-FK rollback table permanently and fix forward.

Remove `/admin/backfill-board-position`; it must not survive as a second ordering authority.

## Priority and Board commands

### Priority

The Priority route becomes metadata-only:

```sql
UPDATE projects
SET priority = ?1, updated_at = ?2
WHERE id = ?3
  AND archived_at IS NULL
  AND priority IS NOT ?1
  AND stage_key = ?4
  AND board_position IS ?5
  AND board_revision = ?6
RETURNING priority, board_revision;
```

It:

- retains `prioritizeProjects`;
- validates `1..10|null`;
- preserves equality no-op behavior;
- writes one audit and one `project.priority.changed` activity on a winner;
- retains TB4C internal fan-out and TB4E External suppression;
- does not read siblings to derive a position;
- does not change Stage, position, or Board revision.

The route rewrite, test updates, import removal, and deletion of `priorityInsertNeighbors` occur in
one slice.

Priority view:

```text
priority 1 … 10
null last
then authoritative Board rank
then ID
```

It is not available to External Editor or Photographer projections that withhold Priority.

### Same-Stage manual order

Add `workers/app/src/lib/project-board-order.ts`.

The command:

- requires `prioritizeProjects` under current policy;
- requires the feature flag;
- validates target Stage/revision and visible neighbours;
- applies the same canonical global-anchor and full-snapshot rules;
- writes position/revision only;
- writes one `project.board_position_set` audit;
- creates no activity or outbox;
- returns authoritative visible order;
- returns `409` on stale state without retry.

Archive increments revision while removing a row from the Board. Restore appends to the current
Stage bottom and increments revision. New projects start at revision `0`.

## Server-authorized projections

`GET /projects` remains the list/Board owner.

Internal response adds:

```ts
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
- order arrays contain only assigned, unarchived IDs;
- no hidden fetch/filter in React;
- no Priority, raw position, hidden count, global revision, or internal Editing key;
- the External adapter stops using manufactured `boardPosition: 0` as order authority;
- strict schemas reject internal-field expansion.

Board view uses server rank then ID as defensive fallback. Priority and shoot-date view changes
perform zero writes, audits, activities, or outboxes.

`contractEnabled` is the durable feature-flag projection. When false, Stage/reorder/archive/restore
Board controls are hidden, and direct Stage/reorder commands return:

```text
503 board_contract_disabled
```

The winning SQL also checks the flag, so a pre-read/toggle race cannot admit a write after disable.

## Rail, native drag, keyboard, and freshness

### Project Workspace rail

Add a Stage control under Production. It receives role-safe current Stage, revision, Stage list,
`can("moveProjectStage")`, archive state, feature-flag state, and a mutation callback.

It shows the inactive current Stage, enables active destinations, performs no same-Stage request,
uses append placement, and uses the Quincy confirmation modal.

### Native drag and keyboard

TB5A keeps native HTML drag:

- `draggable` uses `moveProjectStage`;
- append is used for column background;
- exact visible neighbours may be submitted at card boundaries;
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

## Implementation slices

Every slice must independently pass:

```bash
npm run typecheck
npm run build -w @quincy/web
```

and its affected tests before the slice is accepted. Compatibility adapters remain until the slice
that moves their final consumer.

### Slice 0 — characterization only

- Freeze legacy internal ordering, External ID fallback, Stage writers, Priority insertion,
  duplicate/fractional positions, archived rows, and inactive Stage fixtures.
- Record implementation parent, draft, migration tail, dependency pins, and test counts.
- Make no production signature removal.

Gate: typecheck, web build, existing Kanban/background characterization suites.

### Slice 1 — additive shared contract

- Add capability, Stage transport, sequence, confirmation, request/response, revision, placement,
  activity, and External-safe schemas.
- Keep current Stage call sites on compatibility types until their owning slice.
- Add all shared truth-table and schema tests.

Gate: typecheck, web build, shared Vitest, affected workspace tests.

### Slice 2 — migration and schema

- Add exact migration `0037`, three additive columns, rollback table, indexes, flag seed, journal,
  snapshot, and migration tests.
- Prove full-chain and `0036→0037`.
- Keep production helpers intact.

Gate: typecheck, web build, DB migration tests, local Wrangler, scratch D1, foreign-key check,
`quick_check`.

### Slice 3 — additive DB bundles

- Add prepared winner, compaction, activity composition, workflow-token, and Deadline-suppression
  bundles with fixed indexes.
- Retain `guardedStageTransition` and `onSuccess` compatibility executor.
- Retain `priorityInsertNeighbors`.
- Add winner/loser/compaction/index tests.

Gate: typecheck, web build, DB and existing app/background tests.

### Slice 4 — authorized projection and flag-off UI seam

- Add internal/External Board projections and `boardRevision`.
- Add strict decoders and remove External manufactured-zero ordering authority.
- Add the durable `contractEnabled` read projection and hidden-control behavior.
- Do not change the current mutation route signature yet.

Gate: typecheck, web build, query/privacy/web adapter tests.

### Slice 5 — human commands, routes, Priority, and current web caller

In one independently green slice:

- add `moveProjectStage` and manual order command;
- replace both Stage route forms;
- add the legacy-body discriminator;
- change `Dashboard.tsx` current Stage caller to the new request/response;
- move its capability gate to `moveProjectStage`;
- refactor Priority to metadata-only;
- update/remove all tests importing `priorityInsertNeighbors`;
- remove the import at `projects.ts:19`, call at `:427`, and helper definition;
- remove the temporary Admin backfill route;
- integrate DB-owned Deadline suppression and post-commit Queue finalizer.

Gate: typecheck, web build, app integration, web Dashboard, capability, Deadline, activity, and route
tests.

### Slice 6 — automatic writer convergence and compatibility removal

- Convert every exact inventory row.
- Add and persist workflow Editing-entry revisions.
- Add move-out and out-and-back ABA tests.
- Replace `onSuccess` at `ingest.ts:214`, `sync.ts:363`, `finals.ts:191`, and `finals.ts:296`, plus
  every direct notification owner in the inventory.
- Remove `onSuccess` and the compatibility executor only after all callers compile.
- Audit that no direct production Stage update remains.

Gate: typecheck, web build, app/background/DB automatic-writer and notification suites.

### Slice 7 — complete UI

- Add rail Stage control.
- Add native exact-neighbour drag and keyboard Move action.
- Add Priority view for authorized internal roles.
- Make Board view consume authoritative order maps.
- Add interaction ownership, narrow invalidation, neutral-label, focus, and accessibility tests.

Gate: typecheck, web build, complete web logic and DOM suites.

### Slice 8 — full proof and deployment preparation

- Run complete verification and repository audits.
- Run local migration/query-plan/performance proof.
- Run Agy browser matrix.
- Obtain fresh read-only diff review.
- Prepare one reviewed flag-aware production revision and recovery export.
- Do not update implemented-plan status until production verification completes.

## Automated test plan

### Shared

Prove capability membership, RAW capability retention, exact Stage sequence, role-safe Editing,
non-Admin internal-key rejection, all 25 confirmation pairs, cumulative reason order, strict
schemas, activity identity, external policy, and provider-safe copy.

### Migration

Seed all semantic Stages, an inactive configured Stage, archived projects, Priority values
`1,5,10,null`, duplicate/fractional positions, deterministic ID ties, and a noncanonical Stage
fixture.

Prove:

- noncanonical unarchived Stage causes migration failure before capture;
- archived noncanonical fixture does not enter Board normalization;
- exact SQL applies through local Wrangler and scratch D1;
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
- no rebuild/PRAGMA/drop/rename;
- foreign-key check is empty and `quick_check` is `ok`.

### Human Stage/API

Cover all principals and results, both route forms, exact legacy body `409`, strict-invalid `400`,
same Stage, active/inactive destinations, archived state, cumulative confirmation, assignment loss,
stale project/neighbour revisions, append, empty destination, simultaneous append, midpoint,
compaction, and full-snapshot loss.

For every winner assert exact revision increments, one audit, one human activity, recipient-cycle
fan-out, no email, correct Deadline suppression, and authoritative role-safe order. For every loser
or no-op assert zero footprint.

Compaction tests must prove the target Stage does not change when the full snapshot is stale.

### Hidden-neighbour fixtures

For visible `A, B`, test:

- zero hidden rows;
- one hidden row `A, H, B`;
- multiple hidden rows `A, H1, H2, B`;
- midpoint available;
- midpoint exhausted and compaction required;
- `after=null` global append.

Assert canonical placement immediately before `after`, hidden relative-order preservation, full
global snapshot validation, and visible-only response.

### Automatic and ABA

For every inventory row prove exact source Stage, archive guard, flag gate, append, revision
increment, workflow prerequisite, audit behavior, and legacy notification ownership.

Race tests include:

- human move-out before completion;
- Editing revision `5` → human move-out revision `6` → human re-entry revision `7` → old completion
  with stored revision `5`;
- null legacy workflow token fails closed;
- new workflow-owned re-entry records and uses its own new token;
- no loser Stage audit/revision/activity/outbox/legacy notification.

### Priority/order, Deadline, activity, privacy, and web

Prove metadata-only Priority, no revision change, view sorting, pure reorder audit-only behavior,
Delivered atomic suppression, no reminder auto-resume, human-only Stage activity, External safe
copy, assigned-only order, no forbidden fields, native drag, keyboard action, refresh ownership,
access-loss purge, Deadline/overdue preservation, and removal of card-level RAW count.

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
- no unowned production Stage or position writer;
- every Board-state writer increments revision;
- no Priority-to-position production path;
- one human Stage activity producer;
- workflow-owned legacy notifications remain only on workflow winners;
- no manual legacy Delivered/Editing notification.

Also verify both Stage route forms, no wildcard middleware leak, removed backfill route, TB4E route
manifest, and External strict projection.

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

Scratch proof must cover full migration chain, `0036→0037`, exact normalization SQL, preflight
failure, rollback comparison, foreign-key check, quick check, query plans, and representative Board
serialization measurements.

## Manual local QA

Use Agy Option A against `http://localhost:8787` with a human-authenticated dedicated Chrome.
Agy never signs in or handles secrets. Use Admin impersonation for internal role checks and approved
disposable External fixtures.

Cover:

- Admin/internal/External/Photographer capability matrix;
- canonical Board order and Priority view;
- intentional External ID-order correction;
- rail, native drag, keyboard movement, cumulative confirmations;
- neutral Editing vocabulary;
- inactive-current escape;
- archive read-only behavior;
- stale project and neighbour conflicts across two tabs;
- refresh during drag/modal/pending mutation;
- hidden-neighbour fixtures;
- ABA completion;
- Delivered Deadline suppression and non-resume;
- desktop, tablet, phone, zoom/reflow, keyboard, focus, console, and network behavior.

## Deployment preflight and rollout

### Durable inert mechanism

Use one permanent flag:

```text
tb5a_board_contract_enabled
```

Migration `0037` seeds it OFF. All Stage, position, archive, restore, and automatic Stage winner SQL
requires the flag to be `enabled=1`. The list/UI projection reads the same row and hides Board
mutation controls while OFF.

The reviewed app/background revision is schema-aware:

- before the `0037` rollback-table marker exists, Board-affecting mutations return bounded
  maintenance `503` without referencing new columns;
- after the marker exists but the flag remains OFF, migration-aware reads work while Board commands
  remain disabled;
- enabling the flag requires no new build or deployment.

There is no separate inert and enabled application bundle.

### Freeze and proof before migration

1. Record reviewed source commit and built Worker artifact hashes.
2. Create and verify the remote D1 recovery export.
3. Drain the notification/project queues to recorded zero or pause their consumers with the exact
   remaining backlog recorded.
4. Stop creation of new Stage-capable Workflow instances and wait until every old Stage-capable
   instance is terminal.
5. Disable Cron and hourly reconciliation triggers.
6. Disable app service/RPC paths that can start Dropbox sync, AutoHDR send/fetch, or reconciliation.
7. Deploy the reviewed background Worker while triggers remain paused. Its pre-schema/flag-off path
   must perform no Stage or position write.
8. Deploy optional webhook-ingress only if its reviewed artifact changed.
9. Deploy the same reviewed app Worker in pre-schema maintenance mode.
10. Prove all public and internal Board-affecting mutation paths return bounded disabled responses
    and no previous app/background Worker receives traffic.
11. Query audit, jobs, workflows, queue state, and project Stage/position aggregates twice across a
    quiet observation interval. Any unexplained change stops rollout.
12. Only then apply migration `0037`.

This freeze covers app RAW ingest, Dropbox reconciliation, Queue consumers, Workflow instances,
Cron reconciliation, AutoHDR claims/finals, creation, Stage, Priority-coupled legacy order,
archive, restore, and manual reorder. No old Stage writer may execute after normalization.

### Post-migration flag-OFF verification

With the same reviewed versions already deployed:

1. require remote migration tail `0037`;
2. verify columns, rollback table, indexes, and flag row;
3. verify rollback-row count equals unarchived-project count;
4. verify zero internal-order mismatches;
5. verify the intentional External authorized-order correction;
6. verify normalized positions/revisions and unchanged Stage/Priority;
7. verify foreign-key check and quick check;
8. verify normal internal and strict External reads;
9. verify every Stage/reorder command remains `503 board_contract_disabled`;
10. verify the new background Worker remains inert while triggers are paused.

### Enable and resume

An authorized deployment operator enables the flag through a reviewed prepared batch using `?`
bindings and writes a feature-flag audit. The update must require current value OFF and return one
row; otherwise stop.

After enablement:

1. verify the same app/background Worker versions and source commit remain active;
2. run a disposable/local-authorized command smoke test where permitted;
3. resume Queue consumers;
4. resume new Workflow creation;
5. resume Cron/reconciliation;
6. prove only the reviewed background version handles new work;
7. monitor Stage conflicts, outbox failures, and workflow losers.

If distinct bundles become unavoidable, rollout requires a new plan review, pinned source commits,
artifact hashes, and proof that the inert artifact cannot enable writes.

## Rollback and fix-forward

### App/UI/command fault

1. Set `tb5a_board_contract_enabled` OFF using the audited operator path.
2. Pause Stage-capable Queue, Workflow, Cron, reconciliation, and service triggers.
3. Keep the same migration-aware app/background version serving reads and bounded disabled writes.
4. Do not deploy a pre-TB5A app.
5. Preserve audit/activity/outbox/ledger history and fix forward.

### Background fault

Keep the flag OFF if continued production increases risk. Deploy a fixed TB5A-aware background
consumer, then resume only after it recognizes the live Stage event and revision contract. Never
restore a background version that treats `project.stage.changed` as reserved or writes Stage without
revision.

### Migration fault before enablement

Keep the flag OFF. Compare against the permanent rollback table. Restore old positions only if every
affected row still has migration baseline revision `1`, under explicit incident authority. Do not
delete the rollback table or edit `d1_migrations`.

### Fault after enablement

Do not bulk-restore positions, reset revisions, or deploy pre-TB5A writers. Fix forward. Use the
recovery export only for catastrophic recovery under explicit authority.

### Privacy fault

Immediately disable the flag, preserve restricted evidence, purge affected External projections
through TB4E’s mechanism, and repair the server SQL/strict DTO boundary. Do not repair by fetching a
broad internal DTO and redacting it in React.

## Acceptance checklist

### Domain and authorization

- [ ] `moveProjectStage` belongs only to Admin, internal Editor, and External Editor.
- [ ] External movement additionally requires current assignment.
- [ ] Exact MOVE/STAY `selectForEditing` disposition is preserved.
- [ ] Semantic Stage sequence and cumulative confirmation reasons are shared.
- [ ] Non-Admin transport exposes only neutral Editing.
- [ ] Inactive current Stage remains escapable; archived projects are read-only.
- [ ] Legacy `{stageKey}` returns `409 stage_contract_reload_required` on both route forms.

### Ordering and migration

- [ ] Remote tail is confirmed `0036` before applying `0037`.
- [ ] Noncanonical unarchived Stage keys abort migration.
- [ ] Exact executable normalization SQL passes local Wrangler and scratch D1.
- [ ] Comparator is exactly null-group, `board_position`, ID, never numeric Priority.
- [ ] Permanent rollback table has no foreign key.
- [ ] Internal order is preserved.
- [ ] External manufactured-ID order intentionally changes to authorized canonical order.
- [ ] Unarchived positions normalize to `0,1024,…` and revisions to `1`.
- [ ] Priority and Stage values remain unchanged.
- [ ] Flag is seeded OFF.
- [ ] Temporary Admin backfill route is removed.

### Command and DB seam

- [ ] `@quincy/db` owns prepared winner, activity, and Deadline bundles.
- [ ] Callers compose them through exported fixed result indexes.
- [ ] No caller supplies arbitrary SQL.
- [ ] Post-commit finalizer never runs for a loser.
- [ ] `onSuccess` is removed only with all named production callers.
- [ ] Non-compacting move uses one guarded target update.
- [ ] Compacting move uses one all-or-zero multi-row update with no preceding target update.
- [ ] Compaction audit requires exact expected changed-row count.
- [ ] Hidden-neighbour placement uses immediate-before-`after` or global append.
- [ ] Hidden rows retain relative order and never leak in responses.

### Workflow safety

- [ ] Workflow-owned Editing entry records its exact revision atomically.
- [ ] Automatic completion requires exact Stage and recorded entry revision.
- [ ] Move-out and out-and-back ABA tests pass.
- [ ] Null/legacy token fails closed.
- [ ] Every automatic writer retains its prerequisite and notification owner.
- [ ] Automatic loser produces no Stage audit/revision/activity/outbox/legacy notification.
- [ ] Manual Editing and Delivered moves cause no provider or delivery action.

### Activity, privacy, and UI

- [ ] `project.stage.changed` is human-only, non-coalesced, in-app-only.
- [ ] Recipient fan-out is at most once per eligible membership cycle.
- [ ] Pure reorder emits no activity/outbox.
- [ ] Priority is metadata-only and remains externally suppressed.
- [ ] External projection contains assigned IDs and per-project revision only.
- [ ] No Priority, raw position, hidden ID/count, or internal Editing key leaks.
- [ ] Rail, native drag, and keyboard use the same command.
- [ ] Interaction ownership preserves active drag/modal/pending state.
- [ ] Access-loss purge wins over late responses.

### Slices, proof, and rollout

- [ ] Every slice independently typechecks, builds, and passes its focused tests.
- [ ] Priority helper removal and route rewrite are one slice.
- [ ] Automatic caller conversion and `onSuccess` removal are one slice.
- [ ] Full workspace tests and explicit shared Vitest pass.
- [ ] Second Drizzle generation is a no-op.
- [ ] Writer, capability, ordering, privacy, route, and activity audits are recorded.
- [ ] Agy local browser matrix passes.
- [ ] Fresh read-only diff review approves implementation.
- [ ] Recovery export path, size, and SHA-256 are recorded.
- [ ] Queue, Workflow, Cron, reconciliation, service calls, and app Board writes are frozen before
      migration.
- [ ] No old Stage writer runs after normalization.
- [ ] One reviewed migration-aware app/background revision is verified flag-OFF and enabled without
      redeploy.
- [ ] Production verification completes before this plan moves to `implemented/`.

## Expected implementation footprint

Expected files include:

- shared capabilities, stages, activity registry, External DTO/policy, and tests;
- migration `0037`, journal, snapshot, Drizzle schema, and migration tests;
- DB Stage winner/compaction, Board position, activity, Deadline suppression, and bundle tests;
- new app `project-stage.ts` and `project-board-order.ts`;
- app project, Stage, Admin, Deadline, External-query, and Kanban modules/tests;
- every exact background writer named in the inventory;
- internal/External project adapters and strict decoders;
- Dashboard, Project Workspace, Project Overview rail, query ownership, styles, and DOM tests;
- closeout documentation only after production verification.

Changes to `prototype/`, Calendar, provider credentials, delivery publish/revoke behavior, media
deletion, React/dependency versions, global Stage configuration, or External Priority policy require
fresh review.

## Open decisions for review

No unresolved product decision is required before implementation. Fresh-Sol review round 2 should
explicitly affirm or revise:

1. `projects.board_revision` remains the per-project conflict and continuous-occupancy token; no
   global Stage revision is exposed.
2. `autohdr_handoffs.editing_entry_board_revision` and `jobs.stage_entry_board_revision` are the
   persisted owners for workflow-specific Editing entry.
3. The two winner forms are sufficient: guarded single-row non-compaction and one fully
   snapshot-fenced multi-row compacting update.
4. `@quincy/db` owns all prepared SQL bundles; app/background callers own authorization,
   composition, fixed-index interpretation, and post-commit finalization.
5. `onSuccess` is retained only as a temporary compatibility executor hook and removed with every
   named production caller in one green slice.
6. External exact placement uses immediate-before-visible-`after`, with global append when
   `after=null`, while hidden rows retain relative order.
7. The permanent migration rollback table remains no-FK and is not dropped after rollout.
8. External Editor’s old ID fallback is intentionally corrected to authorized canonical order.
9. Confirmation remains the exact cumulative typed-reason array.
10. `project.stage.changed` remains human-command-owned, non-coalesced, and absent from automatic
    workflow advances.
11. One durable seeded-OFF feature flag and one reviewed source revision provide the inert/enabled
    rollout boundary; no second write-enabled bundle is required.