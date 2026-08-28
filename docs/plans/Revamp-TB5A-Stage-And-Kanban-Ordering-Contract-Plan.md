# Revamp TB5A — Project Stage and Kanban Ordering Contract

**Status:** DRAFT — awaiting fresh-Sol review.

**Review-state note:** This is a plan-only artifact. It authorizes no code, migration, deployment,
or production mutation. It was drafted read-only against local `main`/`HEAD`
`8b7b3f96b1195c8dbaef547348962a7bb9bd3079`, the checked-in migration journal ending at `0036`,
and the production record in `docs/todo.md` stating that migration `0036` was applied on
2026-08-28. The sandbox could not query production D1 directly, so implementation must still run
the mandatory remote `d1_migrations` preflight and observe `0036` as the tail before claiming
`0037`.

Two supplied premises conflict with accepted/current baselines and are resolved here:

- The task text calls React 18.3.1 the baseline, but TB0A is accepted and deployed, and
  `portal/package.json` pins React/React DOM `19.2.8`. TB5A therefore targets the current React
  19.2.8 SPA and makes no React-runtime change.
- TB4E deliberately withholds `priority` and `boardPosition` from External Editors. TB5A does not
  weaken that accepted privacy contract. External Editors receive only their assigned project
  summaries, an opaque per-project `boardRevision`, and the visible assigned-project order needed
  by the board. They do not receive raw Priority or persisted position values and do not receive
  the Priority-sort option.

Reviewer attention is specifically requested on five deliberate decisions:

1. Add `projects.board_revision`, not a global Stage revision. This gives each mutation a scoped
   optimistic-concurrency token without exposing unrelated-board churn to External Editors.
2. Keep the human route-independent `moveProjectStage` command in the app Worker, wrapping an
   extended composable `@quincy/db` guarded Stage-transition writer. Authorization, transition
   classification, confirmation, and role-safe projection belong to the command; atomic Stage,
   position, revision, audit, activity, and recipient fan-out statements belong below it.
3. Represent confirmation as the exact set of applicable typed reasons, bound to the request’s
   expected source and target. A transition may cross more than one sensitive boundary.
4. Normalize the current visible Board order in migration `0037` and retain exact rollback rows in
   a permanent migration-owned table. The migration changes active-project positions once but
   changes no Priority value.
5. Activate `project.stage.changed` only for committed human `moveProjectStage` operations.
   Automatic workflow Stage advances retain their existing workflow/audit ownership in TB5A; they
   use the same guarded Stage/position/revision primitive but do not duplicate a human Stage event.

## Purpose and review state

TB5A gives Quincy one Stage-movement contract and removes the hidden coupling between Priority and
manual Kanban order.

The user-visible outcomes are:

- Admins, internal Editors, and assigned External Editors can move a non-archived project from the
  Project Workspace rail, native Kanban drag, or a keyboard/non-drag action.
- Every human Stage change passes through one command with the same capability, assignment,
  current-Stage, board-revision, active-destination, transition-confirmation, audit, activity,
  notification, and conflict behavior.
- Manual entry into or exit from Editing and Delivered changes Stage only. It never sends,
  retrieves, cancels, retires, publishes, or revokes work.
- Board order is exactly persisted `board_position` order. Priority is metadata and may be selected
  as a non-writing view sort.
- Existing Priority-influenced visible order is frozen once into `board_position` before the
  coupling is removed.
- Automatic AutoHDR completion cannot move a project after a human has already changed its Stage.
- Server queries remain role-authorized. External Editors never receive unrelated projects,
  Priority, raw board positions, or provider-specific Stage identifiers.

The result must be coherent if the roadmap stops before TB5B: TB5A ships a complete native-drag,
rail, keyboard, ordering, authorization, conflict, and notification contract without dnd-kit.

### Required review sequence

1. Fresh Sol reviews this draft against the actual repository and the accepted TB2/TB4B/TB4C/TB4E
   plans.
2. Resolve all blocking contract findings in the plan before implementation.
3. Build from a reviewed branch off current `main`.
4. Run the complete automated gate, local migration proof, repository audits, and Agy-driven local
   browser matrix.
5. Obtain a fresh read-only diff review before production deployment.
6. Apply migration and deploy only after a remote recovery export and remote migration-tail
   confirmation.
7. Move this plan to `docs/plans/implemented/` only after code, migration, Workers, and production
   behavior match it.

## Authority and dependency boundary

Apply authority in this order:

1. `docs/Decision-Sheet.md`, especially:
   - D-17: fixed semantic Stage identities, developer-managed global Stage order, and
     `boardPosition` as the sole persisted manual Kanban order;
   - D-18: Project Workspace rail ownership and the new `moveProjectStage` capability;
   - D-19: assignment-scoped External Editor access and one external-safe projection.
2. `docs/Implementation-Plan.md`, especially A9–A11 and A14:
   - route/resource-aware freshness;
   - durable registry/outbox delivery;
   - fixed Stage semantics and AutoHDR separation;
   - Stage capability ownership;
   - External Editor projection and assignment constraints.
3. `docs/plans/revamp_2026_portal/roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md`.
4. Shipped TB2, TB4B, TB4C, TB4D, and TB4E plans.
5. `docs/PRD.md`, `Personas.md`, and `Sitemap.md`.
6. Current repository source where deployed-plan prose has drifted.

Repository rules in `AGENTS.md`/`CLAUDE.md` remain mandatory:

- implementation occurs only under `portal/`;
- `@quincy/shared` owns capabilities and Stage keys;
- no root-mounted `router.use("*", middleware)`;
- gated exact Hono paths must not be bypassable by trailing slashes;
- migration `0037` must be additive and must not use a generated table rebuild;
- media objects are never removed as a consequence of this feature;
- Chrome QA goes to Agy under the documented authenticated-session rules;
- service deployment ordering remains background → webhook-ingress when changed → app.

The dependency sequence is:

```text
TB2 → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C
```

TB5A establishes the contract consumed by TB5B and TB5C. It does not implement either phase.

## Resolved foundation on current `main`

### Production and migration base

The following was verified locally:

- `main` and `HEAD` both resolve to
  `8b7b3f96b1195c8dbaef547348962a7bb9bd3079`.
- The worktree contains an unrelated untracked `qa-evidence/` directory. Implementation must
  preserve it and all other user-owned changes.
- `portal/packages/db/migrations/meta/_journal.json` ends at:
  `0036_external_editor_assigned_scope`.
- The migration directory ends at:
  `portal/packages/db/migrations/0036_external_editor_assigned_scope.sql`.
- `docs/todo.md` records migration `0036` applied to production on 2026-08-28 with a successful
  foreign-key check and `quick_check`.
- Therefore the planned number is **`0037`**, conditional on the implementation preflight directly
  querying production `d1_migrations` and observing `0036` as its tail.
- `portal/package.json` pins React and React DOM `19.2.8`. TB5A makes no dependency, React, router,
  Tailwind, shadcn, or dnd-kit change.

### Current capability boundary

`portal/packages/shared/src/capabilities.ts` currently contains:

- `selectForEditing` for Admin and internal Editor;
- `prioritizeProjects` for Admin only;
- no `moveProjectStage`;
- an exact nine-capability External Editor allow-list.

`selectForEditing` remains necessary. It currently gates:

- RAW select/deselect routes;
- RAW selection ZIP/download-selection authorization;
- related review UI.

TB5A therefore does not remove or rename `selectForEditing`. It removes only its Stage-movement
responsibility.

The exact capability change is:

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

Add `moveProjectStage` to:

- `ROLE_CAPABILITIES.admin`;
- `ROLE_CAPABILITIES.editor`;
- `EXTERNAL_EDITOR_CAPABILITIES`.

Do not add it to Photographer.

Every Stage UI or API check moves from `selectForEditing` to `moveProjectStage`. Every RAW
selection/download check stays on `selectForEditing`.

External capability possession never supplies project access. Every External call must also pass
current active account, current assignment, unarchived project, and the TB4E server-visible-project
scope.

### Current Stage and position writers

The current reusable DB helper is
`portal/packages/db/src/stage-transition.ts#guardedStageTransition`. It:

- guards `projects.stage_key = from`;
- rejects archived projects;
- appends to the destination using `MAX(board_position)+1024`;
- writes exactly one audit after a winning update;
- returns a boolean;
- does not own capability, transition rules, confirmation, activity, broad outbox, Deadline
  suppression, or positional neighbours.

Only some automatic paths use it. Several production paths still contain direct
`UPDATE projects SET stage_key=...` SQL, including:

- direct RAW ingest;
- Dropbox RAW reconciliation;
- legacy and current AutoHDR claims;
- API-send workflow confirmation;
- AutoHDR final import/replacement;
- legacy AutoHDR fetch;
- reconcile-awaiting-RAW;
- the human `/projects/:id/stage` route.

TB5A must inventory every production `stage_key` writer and route each through the composable guarded
Stage-transition primitive or its statement builder. A final source audit must find no unowned
production Stage UPDATE.

The current human Stage route:

- checks `hasProjectAccess`;
- checks `selectForEditing`;
- separately blocks non-Admin `editing_autohdr`;
- accepts only `{stageKey}`;
- checks target activity;
- performs an unguarded Drizzle Stage/append update;
- writes `stage.set` audit even for problematic same-value behavior;
- performs Delivered Deadline suppression as best-effort follow-up;
- emits the legacy `delivered` notification;
- has no expected Stage/revision, transition classifier, confirmation, activity, or broad outbox.

It is replaced, not patched in place.

### Current Priority and Board coupling

`portal/workers/app/src/lib/kanban-ordering.ts` currently contains:

- `orderedBoardRows`: `boardPosition`, then ID;
- `priorityInsertNeighbors`: converts a Priority change into new manual neighbours;
- `manualInsertNeighbors`;
- collision detection and renumbering.

The Priority route:

1. reads the target and Stage siblings;
2. computes Priority neighbours;
3. writes both `priority` and `board_position`;
4. may renumber the Stage;
5. emits `project.priority.changed`.

The Dashboard’s Board view currently sorts:

```text
non-null Priority group first
then boardPosition
then id
```

The numeric Priority value does not appear directly in that comparator. Instead,
`priorityInsertNeighbors` has already encoded numeric grouping into `board_position`. That is the
hidden coupling TB5A removes.

The current optional shoot-date modes are client-side, non-writing sorts. They remain so.

The current temporary `/admin/backfill-board-position` route computes a different historical
shoot-date/street ordering and writes positions. It must not survive as a second normalization
authority after migration `0037`.

### Current project query boundary

Internal `GET /projects` returns server-authorized rows:

- Admin/internal Editor: broad unarchived scope;
- Photographer: assigned projects in Photographer-visible Stages;
- Admin archived mode: explicitly capability-gated.

External `GET /projects` already delegates to `listExternalProjects()`, whose SQL uses the shared
TB4E visible-project predicate. It does not fetch all projects and filter them in React.

The External summary intentionally excludes:

- Priority;
- `boardPosition`;
- internal notes/contact/billing/order data;
- Dropbox/provider data;
- the real `editing_autohdr` key.

The current web adapter fills External Priority with `null` and Board position with `0`, so External
Kanban falls back to ID order. TB5A fixes this without adding the withheld raw fields.

### Current Stage presentation boundary

The canonical DB key is `editing_autohdr`.

Non-Admin server and web projection currently maps that key to:

```text
key: editing
label: Editing
```

Admin may receive the internal configured label. Internal Editors and External Editors must continue
to receive only the neutral key/label in API responses, DOM, confirmation copy, notifications, and
client state.

The current Dashboard maps a neutral drop target back to `editing_autohdr` in the browser. TB5A
removes that leak for non-Admin users: their request vocabulary remains neutral, and the server maps
it to the semantic key after authorization.

### TB4B Deadline behavior

TB4B owns project Deadline schedules and pending occurrences. The current Delivered route calls
`suppressProjectDeadlineWork()` after the Stage write, best effort.

TB5A changes that boundary:

- entering Delivered marker-gates Deadline occurrence/outbox suppression to the winning Stage
  mutation in the same D1 batch;
- exiting Delivered does not automatically resume superseded reminders;
- an explicit TB4B Deadline save/resume remains the only way to resume a schedule;
- Deadline never affects Board order;
- Stage movement never edits the Deadline value itself.

Extract a marker-gated Deadline-suppression statement builder from
`workers/app/src/lib/project-deadline.ts`. Preserve the existing public helper for archive and tests,
but make both archive and Delivered Stage entry use the same SQL owner.

### TB4C/TB4E activity and notification behavior

`project.stage.changed` is already registered but reserved. Its current payload is `{}`, its source
key validation is too broad, and its renderer falls back to generic “Project activity” copy.

`buildProjectActivityStatements()` already provides the accepted durable path:

- one immutable activity row per unique semantic source;
- one broad outbox row per eligible Editor membership cycle;
- one in-app ledger per outbox;
- exact membership-cycle and authorization-epoch admission;
- no broad email;
- external policy enforcement.

The phrase “at most one outbox” in the task is interpreted under the accepted TB4C schema as:

```text
at most one broad outbox and one in-app ledger per eligible recipient membership cycle
```

It cannot mean one global outbox row because TB4C deliberately stores one recipient-scoped outbox
row per eligible Editor cycle.

The TB4E policy already marks `project.stage.changed` as externally allowed and
`project.priority.changed` as externally suppressed. TB5A activates and tests the Stage policy; it
does not expose Priority notifications to External Editors.

## Scope

### In scope

- Add and grant `moveProjectStage`.
- Keep `selectForEditing` for RAW-selection work only.
- Add the shared Stage sequence, role-safe transport key, transition classifier, confirmation
  requirements, and exact request/response schemas.
- Add an opaque per-project `boardRevision`.
- Normalize every unarchived semantic Stage once to its current visible Board order.
- Record exact pre-normalization rollback state.
- Make `board_position` the only persisted manual order.
- Make Priority updates metadata-only.
- Add a Priority view sort: `1` highest through `10`, null last, then Board order, then ID.
- Keep shoot-date sorts view-only.
- Add one route-independent human Stage command.
- Extend the DB Stage-transition seam for append and neighbour placement, revision fencing, audit,
  and optional activity/outbox statements.
- Converge every production Stage/position writer on revision-aware primitives.
- Add rail Stage control, native drag, and keyboard/non-drag Stage movement.
- Add all required confirmation paths.
- Preserve inactive-current Stage escape behavior.
- Preserve Deadline/overdue card data and the no-card-RAW-count requirement.
- Preserve TB2 interaction ownership and authorization-cache purge behavior.
- Extend strict External schemas with only the scoped fields required by TB5A.
- Activate `project.stage.changed` for human command winners.
- Remove broad notification production from pure position reorder.
- Preserve Priority broad notification for eligible internal Editor cycles.
- Make Delivered Deadline suppression winner-gated and atomic with the Stage move.
- Add migration, command, API, registry, background-race, web, and privacy tests.
- Produce migration, query-plan, repository-audit, and local browser evidence.

### Hard non-goals

- dnd-kit or any TB5B interaction replacement;
- Production Calendar, FullCalendar, Calendar endpoints, or Deadline sorting;
- global pipeline order configuration;
- Stage creation/deletion;
- custom transition graphs;
- changing semantic Stage identities;
- project card-detail expansion;
- Priority access or Priority sorting for External Editors;
- External access to archived projects;
- publish/revoke behavior on Delivered entry/exit;
- AutoHDR start/cancel/retire/delete/retrieve behavior on manual Editing entry/exit;
- changes to provider credentials, paid-job retry, or PR #44’s Admin-only direct send;
- React, Tailwind, shadcn, router, or dependency migration;
- prototype changes;
- media deletion or R2-key mutation;
- a second activity/outbox mechanism.

## Exact Stage domain contract

### Canonical semantic and presentation keys

`@quincy/shared` remains the sole owner:

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

Add shared helpers:

```ts
stageKeyForRole(stage: StageKey, role: Role): StageTransportKey
stageLabelKeyForRole(stage: StageKey, role: Role): StageTransportKey
parseStageTransportKey(value: unknown, role: Role): StageKey | null
```

Rules:

- Admin may receive and submit `editing_autohdr`.
- Internal Editor and External Editor receive and submit only `editing`.
- Non-Admin submission of `editing_autohdr` is rejected as an invalid transport key; it is never
  required for legitimate use.
- The server maps neutral `editing` to semantic `editing_autohdr` only after session and capability
  validation.
- Server audit/activity storage always uses real `StageKey`.
- External notification copy remains generic and never interpolates the real internal key.
- Any future External activity projection maps real `editing_autohdr` to `editing` before returning
  payload data.

Replace the current “Admin can set any Stage directly” comment around `STAGE_TRANSITIONS`. All
authorized roles use the same semantic classifier and confirmation rules. Admin has no silent
confirmation bypass.

### Canonical order and transition classification

The semantic progression is fixed:

```ts
export const STAGE_SEQUENCE = [
  "awaiting_raw",
  "raw_review",
  "editing_autohdr",
  "edited_review",
  "delivered",
] as const satisfies readonly StageKey[];
```

Display order from `pipeline_stages` does not classify a transition.

Confirmation reasons are:

```ts
export const STAGE_MOVE_CONFIRMATION_REASONS = [
  "backward",
  "skipped_forward",
  "delivered_boundary",
  "editing_boundary",
] as const;

export type StageMoveConfirmationReason =
  (typeof STAGE_MOVE_CONFIRMATION_REASONS)[number];
```

Add one pure function:

```ts
stageMoveConfirmationReasons(
  from: StageKey,
  to: StageKey,
): readonly StageMoveConfirmationReason[]
```

It returns a canonical, deduplicated array in the constant order above:

- `backward` when `index(to) < index(from)`;
- `skipped_forward` when `index(to) > index(from) + 1`;
- `delivered_boundary` whenever exactly one side is `delivered`;
- `editing_boundary` whenever exactly one side is `editing_autohdr`;
- empty for the same Stage or a normal one-step forward that crosses neither special boundary.

Sensitive reasons are cumulative. Examples:

| From | To | Required reasons |
|---|---|---|
| Awaiting RAW | RAW review | none |
| Awaiting RAW | Edited review | `skipped_forward` |
| RAW review | Editing | `editing_boundary` |
| Editing | Edited review | `editing_boundary` |
| Edited review | RAW review | `backward` |
| Edited review | Delivered | `delivered_boundary` |
| Delivered | Edited review | `backward`, `delivered_boundary` |
| Delivered | Editing | `backward`, `delivered_boundary`, `editing_boundary` |
| Editing | Delivered | `skipped_forward`, `delivered_boundary`, `editing_boundary` |

A single confirmation modal may explain multiple reasons, but the request must acknowledge the exact
canonical array. A boolean `confirm: true` is insufficient because it could be reused after the
intended transition changed.

### Confirmation semantics and copy

The server recomputes requirements from the authoritative real `from` and requested real `to`.
Success requires exact array equality with the request. Missing, extra, duplicated, or incorrectly
ordered reasons return:

```json
{
  "error": "Confirmation is required for this Stage move.",
  "code": "stage_confirmation_required",
  "requiredConfirmation": {
    "fromStageKey": "role-safe current key",
    "toStageKey": "role-safe target key",
    "reasons": ["..."]
  },
  "current": {}
}
```

Use `409`, because the client must review current authoritative state before resubmitting.

Required UI messages:

- `backward`: explain that the project is moving backward in production.
- `skipped_forward`: explain that one or more normal production steps are being skipped.
- `delivered_boundary`: state explicitly that this changes Stage only and does not publish, revoke,
  create, or remove a client delivery.
- `editing_boundary`: state explicitly that this changes Stage only and does not start, send,
  retrieve, cancel, retire, or delete an editing round.

For internal and External Editors, all Editing copy is neutral. “AutoHDR”, provider names, watch
folders, handoff IDs, and diagnostics must not appear in the modal, request, response, DOM, console,
or notification.

Cancelling the modal performs no request and no optimistic mutation.

### Active and inactive Stages

Destination rules:

- only active semantic Stages are selectable destinations;
- the current Stage remains visible when its `pipeline_stages.active` value is false;
- selecting the current Stage is a no-op;
- an inactive current Stage can be escaped to any active Stage, subject to confirmation;
- another inactive Stage cannot be entered;
- a project in an inactive Stage remains visible on its authorized Board in a temporary occupied
  inactive column so it can be moved out;
- no global Stage label/order/active mutation is part of TB5A.

The command checks destination activity in D1. Client filtering is not authorization.

### Archived projects

An archived project is read-only:

- External Editors cannot discover it and receive the same generic not-found response as an
  unassigned/nonexistent project.
- Internal authorized users receive:
  `409 code:"project_archived_read_only"`.
- No Stage, position, Priority, audit, activity, outbox, Deadline, or revision write occurs.
- Archived Dashboard remains List-only.

### Priority is metadata

Priority remains:

```ts
type ProjectPriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;
```

Semantics:

- `1` is highest;
- `10` is lowest non-null;
- null sorts last in the Priority view;
- changing Priority writes only `projects.priority` and `updated_at`;
- changing Priority does not write `stage_key`, `board_position`, or `board_revision`;
- Priority mutation retains its equality-guarded no-op behavior;
- a winning Priority change writes one audit, one `project.priority.changed` activity, and
  recipient-cycle broad rows under TB4C;
- TB4E continues suppressing Priority delivery to External Editors;
- Priority changes are allowed only through `prioritizeProjects` as today.

The optional Priority view comparator is:

```text
priority ascending (1 … 10)
null last
then persisted Board order
then project id
```

Priority view is a different view of the same authorized projects. It does not alter the Board-order
view or persisted positions.

### Board order

After normalization, the canonical manual order inside each semantic Stage is:

```text
board_position ascending
then project id ascending
```

The ID tie-break is deterministic corruption/legacy protection. Normal command-owned writes should
leave distinct positions.

Rules:

- Board-order view uses only this order.
- Priority has no role in Board-order comparison.
- Shoot date has no role in Board-order comparison.
- Deadline has no role in any order comparator.
- Returning from Priority or shoot-date view to Board order restores persisted order.
- Manual reorder controls render only in Board-order view.
- Pure manual position reorder writes audit but no project activity and no broad inbox row.
- Native cross-Stage drag can append or supply exact visible neighbours.
- Rail and keyboard/non-positional Stage moves append to the destination’s persisted bottom.
- Same-Stage rail choice is a no-op, not a reorder.
- Same-Stage manual reorder remains a separate position command; it does not pretend to be a Stage
  transition.

## Canonical revision, placement, request, and response types

### Persisted project Board revision

Migration `0037` adds:

```ts
boardRevision: integer("board_revision").notNull().default(0)
```

with the SQL constraint:

```sql
CHECK (
  typeof(board_revision) = 'integer'
  AND board_revision >= 0
  AND board_revision <= 9007199254740991
)
```

`boardRevision` is an opaque optimistic-concurrency token, not a displayed sequence number.

Increment it exactly once on each committed project Board-state change:

- Stage change;
- `board_position` change;
- archive removal from an active Board;
- restore append to an active Board.

When collision compaction updates sibling positions, increment every affected sibling’s revision
once. Priority-only, shoot-date sort, Deadline edit, and view-mode changes do not increment it.

New projects start at revision `0`. Existing active projects receive the normalization baseline
revision described in migration `0037`; archived projects remain at the default until restored.

### Placement types

Add shared strict schemas and types:

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

Validation:

- all IDs are UUIDs;
- revisions are safe non-negative integers;
- before/after IDs are distinct and cannot equal the target ID;
- request objects are `.strict()`;
- duplicate confirmation reasons are invalid;
- non-Admin transport keys use the neutral Editing key;
- `between` neighbours must be visible to the principal, unarchived, in the target semantic Stage,
  and match the supplied revisions;
- both-null `between` is normalized to append;
- a one-sided bottom placement uses append semantics rather than assuming no hidden project follows
  an External-visible neighbour;
- exact-neighbour placement is defined over the caller’s authorized projection. Hidden External
  projects are neither returned nor accepted as neighbour IDs.

### Authoritative state projection

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

Internal responses may include `boardPosition` in an explicitly internal extension for diagnostics
and existing adapters. The strict External response never includes it or Priority.

`orderedVisibleProjectIds` contains only projects authorized to the current principal. It is
authoritative for the affected target column after the mutation. It does not include hidden IDs,
counts, positions, or gaps.

### Conflict response

Every changed premise returns `409` with no automatic retry:

```ts
export type StageMoveConflictResponse = {
  error: string;
  code: "project_stage_conflict";
  current: StageMoveProjectState | null;
};
```

Changed premise includes:

- project Stage differs;
- project Board revision differs;
- project became archived;
- External assignment/access disappeared;
- a supplied neighbour changed Stage or revision;
- a supplied neighbour is no longer visible;
- the command’s guarded compaction snapshot lost;
- destination was deactivated;
- confirmation no longer matches the authoritative transition.

The client replaces optimistic state with `current`, invalidates the narrow project/detail and
Dashboard resources, preserves the user’s view/filter/scroll state, and asks the user to retry
manually. It never silently resubmits.

## One human Stage mutation command

### Route-independent seam

Add:

```text
portal/workers/app/src/lib/project-stage.ts
```

with one exported command:

```ts
moveProjectStage({
  env,
  principal,
  projectId,
  request,
  now?,
}): Promise<MoveProjectStageResult>
```

The command—not the Hono handler—owns:

1. active-principal validation;
2. `moveProjectStage` capability;
3. External assigned-project authorization;
4. non-disclosing External missing/unassigned behavior;
5. project existence and archived state;
6. role-safe transport-key normalization;
7. expected Stage and Board revision;
8. target Stage existence/activity;
9. transition classification;
10. confirmation equality;
11. visible-neighbour authorization and revision checks;
12. append or exact-neighbour placement;
13. guarded Stage/position/revision mutation;
14. one audit;
15. one human Stage activity;
16. recipient-cycle broad outbox/ledger creation;
17. Delivered Deadline suppression;
18. authoritative role-safe reread;
19. direct return of publication IDs to its finalizer.

Rail, native drag, keyboard actions, and later dnd-kit call the same API/command. TB5B may change only
how it derives placement; it must not add a second mutation owner.

### Command result union

Use an exhaustive non-throwing domain result for expected outcomes:

```ts
type MoveProjectStageResult =
  | { kind: "moved"; response: MoveProjectStageResponse; publicationIds: string[] }
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
  | { kind: "conflict"; current: StageMoveProjectState | null };
```

Unexpected D1/runtime failures throw and remain `500`; they must not be mislabeled as user conflicts.

Add one route finalizer that maps each non-throwing result exactly once and publishes returned outbox
IDs only after the winning D1 batch commits.

### Hono route contract

Replace the current handler body with one shared handler registered for both forms:

```text
POST /projects/:id/stage
POST /projects/:id/stage/
```

Both forms use the identical session, CSRF, terminal-route, parser, command, and finalizer chain.
Do not add `router.use("*", ...)`.

The route:

- validates the UUID and strict transport body;
- delegates to `moveProjectStage`;
- performs no independent Stage SQL;
- performs no independent audit;
- calls no legacy `notifyProject(..., "delivered")`;
- calls no best-effort Deadline suppression;
- returns the command’s role-safe response.

Old `{stageKey}` bodies without expected state fail closed with:

```text
409 stage_contract_reload_required
```

They must not perform a compatibility write without a revision premise.

### Authorization order

Command authorization occurs before existence disclosure:

1. require active authenticated principal;
2. require `moveProjectStage`;
3. for External Editor, resolve the target through the shared TB4E visible-project scope;
4. only then classify missing/archived/current state.

Results:

| Principal | Project state | Result |
|---|---|---|
| Admin/internal Editor | active project | eligible |
| Admin/internal Editor | archived project | `409 project_archived_read_only` |
| External Editor | active assigned project | eligible |
| External Editor | unassigned/nonexistent/archived | generic `404` |
| Photographer | any ID | constant capability `403` |
| inactive/revoked session | any ID | existing authentication failure |

Impersonation continues through the shipped principal model. Audit metadata includes
`impersonatedBy` via `auditMeta`; author identity is the impersonated user.

## Guarded DB Stage-transition seam

### Composable writer

Extend `portal/packages/db/src/stage-transition.ts` into two layers:

```ts
buildGuardedStageTransitionStatements(input)
guardedStageTransition(d1, input)
```

The builder supplies statement ownership for complex app/background batches. The executor runs the
builder for standalone transitions.

Canonical low-level input:

```ts
type GuardedStageTransitionInput = {
  projectId: string;
  expectedFrom: StageKey;
  to: StageKey;
  placement:
    | { kind: "append" }
    | {
        kind: "between";
        before: BoardRowSnapshot | null;
        after: BoardRowSnapshot | null;
      };
  expectedProjectBoardRevision?: number;
  actor: { kind: "user"; id: string } | { kind: "system"; id: null };
  action: "project.stage_moved" | "stage.auto_advance";
  auditId: string;
  auditMeta: Record<string, unknown>;
  activity?: ProjectActivityIntent;
  deadlineSuppression?: "project_delivered";
  prerequisite?: GuardedTransitionPrerequisite;
  now: number;
};
```

System automation omits the client revision and relies on its exact `expectedFrom` plus its existing
workflow prerequisite. Human moves require the expected revision.

The builder must not accept arbitrary raw SQL from callers. Complex workflow prerequisites use a
small typed set or caller-owned winner marker ID so SQL remains reviewable.

### Winning write

The authoritative Stage write:

- requires exact project ID;
- requires exact semantic `expectedFrom`;
- requires `archived_at IS NULL`;
- for human moves, requires exact `board_revision`;
- requires the typed workflow prerequisite when present;
- validates supplied neighbour snapshots;
- computes append or insertion position;
- sets `stage_key`, `board_position`, `board_revision = board_revision + 1`, and `updated_at`;
- returns Stage, position, and revision.

Append computes the live destination bottom inside the same statement:

```sql
SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = :target
  AND archived_at IS NULL
  AND id <> :projectId
```

Two serialized appends therefore receive distinct positions.

Exact-neighbour insertion uses real midpoint positions. When the midpoint equals a boundary because
space is exhausted, the command constructs one atomic, fully snapshot-fenced compaction UPDATE for
the affected target Stage:

- serialize the expected Stage rows through one JSON parameter to avoid D1’s 100-bind limit;
- verify exact ID, Stage, position, revision, and archive snapshots;
- assign deterministic `0, 1024, 2048, ...` positions in current `(board_position,id)` order with
  the target inserted at the requested location;
- increment each changed row’s `board_revision` once;
- make the whole statement affect zero rows if any snapshot changed.

No partial sibling renumber may commit.

### Marker-gated tail

A winning human batch is:

```text
1. guarded Stage/position/revision UPDATE
2. exactly one audit marker
3. optional target-Stage compaction statements, owned by that marker
4. exactly one project.stage.changed activity
5. at most one broad outbox per eligible membership cycle
6. one in-app ledger per created outbox
7. Delivered Deadline suppression statements when entering Delivered
```

The audit marker is inserted only when the Stage statement won. Every activity, outbox, ledger,
compaction, and Deadline statement is conditioned on that exact marker.

The activity source key is unique:

```text
project-stage:<projectId>:transition:<activityId>
```

Its validator proves:

- key project ID equals activity project ID;
- source ID equals project ID;
- transition token equals activity ID;
- payload `fromStageKey` and `toStageKey` are valid and differ.

A losing batch has zero audit/activity/outbox/ledger/Deadline footprint.

### System automation

Every automatic writer must use the same Stage/position/revision builder, but TB5A preserves its
workflow semantics:

- exact `expectedFrom` remains mandatory;
- archive remains forbidden;
- append remains destination-bottom;
- existing handoff/import winner prerequisites remain in the same batch;
- existing `stage.auto_advance` audit identity remains;
- existing workflow notification ownership remains;
- no human confirmation applies;
- no `project.stage.changed` human activity is emitted.

For AutoHDR final completion, the exact guard is:

```text
project.id = expected project
AND project.stage_key = editing_autohdr
AND project.archived_at IS NULL
AND the final-import/workflow winner prerequisite still exists
```

If a human has moved the project to Awaiting RAW, RAW review, Edited review, or Delivered, the
automatic update changes zero rows. It does not append, increment revision, audit, notify, or retry
the Stage transition. Edited media may retain its separately committed immutable import truth, but
completion cannot reassert Stage.

Direct send remains Admin-only and send-only. A human manual move into Editing does not create a
handoff; an actual approved direct-send operation may still perform its own guarded workflow advance.

## Human Stage activity and notification contract

### Activate one reserved type

Move only `project.stage.changed` from reserved to live.

Payload:

```ts
{
  fromStageKey: StageKey;
  toStageKey: StageKey;
}
```

Registry entry:

```text
category: stage
producer owner: TB5A moveProjectStage
producer call site: workers/app/src/lib/project-stage.ts#moveProjectStage
source kind: project_stage
source key: project-stage:<projectId>:transition:<activityId>
actor rule: user
deep link: project
coalescing: none
channels: in_app only
email default: off
cutover: live
cutover date: TB5A production date
backfill: none
```

Add a TB5A cutover constant rather than inheriting TB4C’s date.

Every successful human Stage change emits one immutable activity. Same-Stage no-op, cancelled
confirmation, stale conflict, inactive target, archived project, failed authorization, and automatic
workflow advance do not emit this human type.

### Recipient rules

Reuse `buildProjectActivityStatements()` unchanged in shape:

- recipients are exact event-time Editor membership cycles;
- active eligible global roles are resolved inside marker-gated SQL;
- current assignment, role, account status, membership cycle, and authorization epoch are rechecked
  at delivery;
- one recipient-cycle outbox and in-app ledger at most;
- no email ledger/provider call;
- actor inclusion follows the existing TB4C rule;
- no coalescing.

External policy:

- `project.stage.changed`: allowed;
- payload validates internally;
- External rendering uses fixed generic copy and role-safe presentation;
- External notification list never receives the raw semantic Editing key;
- `project.priority.changed`: remains suppressed.

Suggested internal copy:

```text
Title: Project stage updated
Body: <actor> — <project> stage was updated.
```

Suggested External copy remains TB4E’s fixed literal:

```text
Title: Project stage updated
Body: The assigned project stage was updated.
```

Do not interpolate Stage labels for External delivery.

### Remove duplicate legacy production

The manual Stage command must not call:

```ts
notifyProject(env, projectId, "delivered")
notifyProject(env, projectId, "sent_to_editing")
```

Manual Delivered and Editing entry are Stage-only and are represented by the single Stage activity
producer. Existing legacy workflow notifications remain owned by actual delivery/handoff workflows
until their own accepted migration.

### Priority and reorder delivery

- Winning Priority change keeps one `project.priority.changed` activity and TB4C broad fan-out.
- External recipient policy suppresses it.
- Priority no-op emits nothing.
- Pure `board_position` reorder writes its existing audit but no activity/outbox.
- Collision compaction caused by a semantic manual reorder remains part of that one reorder audit and
  creates no broad inbox row.

## Scope B normalization migration `0037`

### Numbering discipline

Before creating migration files:

1. query production `d1_migrations`;
2. require its tail to be exactly `0036`;
3. require local journal and migration directory to end at `0036`;
4. confirm no other branch has claimed `0037`;
5. if any check differs, stop and renumber from the real next value.

Planned files:

```text
portal/packages/db/migrations/0037_project_board_order_contract.sql
portal/packages/db/migrations/meta/0037_snapshot.json
portal/packages/db/migrations/meta/_journal.json
portal/packages/db/test/migration-0037.test.ts
```

### Exact additive schema

Migration `0037` performs:

1. one bare `ALTER TABLE projects ADD COLUMN board_revision ...`;
2. one permanent rollback-record table;
3. one Board query index;
4. one deterministic data capture;
5. one deterministic active-project normalization.

Rollback-record table:

```sql
CREATE TABLE project_board_order_0037_rollback (
  project_id TEXT PRIMARY KEY NOT NULL,
  stage_key TEXT NOT NULL,
  priority INTEGER,
  old_board_position REAL NOT NULL,
  normalized_board_position REAL NOT NULL,
  visible_rank INTEGER NOT NULL,
  captured_at INTEGER NOT NULL
);
```

Do not add a foreign key. The migration record must survive later project deletion and remain useful
for forensic comparison.

Add:

```sql
CREATE UNIQUE INDEX project_board_order_0037_stage_rank_idx
ON project_board_order_0037_rollback(stage_key, visible_rank);

CREATE INDEX projects_stage_archive_board_order_idx
ON projects(stage_key, archived_at, board_position, id);
```

The rollback table records every unarchived project in every semantic Stage, including projects in
an inactive configured Stage. Archived projects are not part of the visible Board and are not
normalized.

### Exact legacy order capture

The migration reproduces the current visible Board comparator exactly:

```sql
PARTITION BY stage_key
ORDER BY
  CASE WHEN priority IS NULL THEN 1 ELSE 0 END,
  board_position,
  id
```

This intentionally does not sort numeric Priority directly. Today numeric Priority has already
affected positions through `priorityInsertNeighbors`; adding `priority ASC` during migration would
create a new order instead of freezing the visible one.

For each active project, record:

- project ID;
- Stage;
- Priority at migration time;
- old position;
- deterministic visible rank;
- normalized position;
- one migration capture timestamp.

Normalized position is:

```text
(visible_rank - 1) × 1024
```

The first project in each Stage is `0`, matching the existing append helper’s empty-Stage behavior.

After capture, update active projects from the rollback table:

```text
board_position = normalized_board_position
board_revision = 1
```

Set every normalized active project to baseline revision `1`, even when its numeric position happened
to be unchanged. This creates one unambiguous post-normalization token. Archived projects remain
revision `0`; restore appends them and increments to `1`.

The migration:

- changes no Priority;
- changes no Stage;
- changes no archived row;
- creates no audit/activity/outbox;
- performs no table rebuild;
- uses no `PRAGMA foreign_keys=OFF`;
- drops or renames nothing.

### Migration rollback boundary

Before any TB5A write-enabled app reaches production, the rollback table and remote recovery export
provide exact pre-normalization state.

An immediate pre-write rollback may restore:

```text
projects.board_position = rollback.old_board_position
```

for rows whose current revision still equals the migration baseline and whose Stage still equals the
recorded Stage.

Once a post-migration Stage/reorder/archive/restore write occurs, do not mass-restore old positions.
That would erase legitimate user changes. After write enablement, prefer fix-forward and use the
recovery export only under explicit incident authority.

The additive column and rollback table are not dropped during ordinary rollback.

### Retire the temporary operator backfill

Remove or permanently disable:

```text
POST /admin/backfill-board-position
```

after migration `0037`.

It uses shoot-date/street ordering and would become a second, incorrect ordering authority. Its
removal belongs in the route-security manifest and integration tests.

## Priority and Board commands

### Priority-only command

Refactor the Priority route so its authoritative update is:

```sql
UPDATE projects
SET priority = ?, updated_at = ?
WHERE id = ?
  AND archived_at IS NULL
  AND priority IS NOT ?
  AND <complete expected project snapshot>
RETURNING priority, board_revision;
```

It must not select Stage siblings merely to choose a new position. Remove production use of
`priorityInsertNeighbors`.

Preserve:

- `prioritizeProjects`;
- project access;
- range validation `1..10|null`;
- equality no-op;
- one audit;
- one `project.priority.changed` activity;
- TB4C internal fan-out;
- TB4E external suppression.

Response:

```ts
{ priority: ProjectPriority; boardRevision: number }
```

The revision is unchanged.

### Manual position command

Move same-Stage manual reorder persistence into a route-independent command, for example:

```text
workers/app/src/lib/project-board-order.ts
```

The current up/down UI may remain, but it derives exact neighbours from authoritative Board order
and submits:

```ts
{
  expected: { stageKey, boardRevision },
  placement: { kind: "between", before, after }
}
```

The command:

- requires `prioritizeProjects` under current policy;
- rejects archived projects;
- validates exact Stage/revision/neighbours;
- writes only Board positions/revisions;
- writes one `project.board_position_set` audit on a semantic win;
- creates no activity/outbox;
- returns authoritative visible order;
- returns `409` on stale state and never auto-retries.

Remove `priorityInsertNeighbors`. Retain/refactor reusable pure helpers for Board comparison,
placement, midpoint, and compaction.

### Every Board-state writer

The implementation source audit must account for:

- app project creation;
- Tonomo/background project creation;
- human Stage move;
- automatic RAW advance;
- AutoHDR send/repeat-send/backfill advance;
- AutoHDR completion/legacy fetch advance;
- reconcile-awaiting-RAW;
- manual same-Stage reorder;
- archive;
- restore.

Rules:

- create appends with revision `0`;
- archive increments the project revision while removing it from the active Board;
- restore appends to the current Stage bottom and increments revision;
- every Stage/position UPDATE increments revision;
- Priority never does;
- no unguarded production `board_position` normalization route remains.

## Server-authorized Dashboard projection

### Internal response

Keep `GET /projects` as the project-list owner. Do not add browser N+1 Stage-column requests.

Extend the active response with:

```ts
type DashboardBoardProjection = {
  orderedProjectIdsByStage: Partial<
    Record<StageTransportKey, string[]>
  >;
};

type InternalProjectListResponse = {
  projects: InternalProjectSummary[];
  board: DashboardBoardProjection;
};
```

`projects` may retain its existing shoot-date/street list order for List view.

`board.orderedProjectIdsByStage` is computed in SQL from authorized rows using:

```text
stage_key
board_position
id
```

and role-safe Stage presentation. Board view uses this map, not array order and not Priority grouping.

### External response

Extend the strict TB4E schema only with:

```ts
type ExternalProjectSummaryDto = ExistingExternalSummary & {
  boardRevision: number;
};

type ExternalProjectListResponse = {
  projects: ExternalProjectSummaryDto[];
  board: {
    orderedProjectIdsByStage:
      Partial<Record<StagePresentationKey, string[]>>;
  };
};
```

External rules:

- SQL starts from `visibleProjectWhere`;
- order arrays contain only assigned, unarchived project IDs;
- no hidden all-project fetch;
- no raw Priority;
- no raw `boardPosition`;
- no unrelated count or global Stage revision;
- no `editing_autohdr`;
- strict schema rejects internal-field expansion.

The External web adapter must stop manufacturing `boardPosition: 0` as an ordering authority.
Instead, Dashboard Board view consumes the server order map.

### View sorts

Board view:

```text
rank from orderedProjectIdsByStage
then ID only as defensive fallback
```

Priority view, internal only:

```text
priority 1..10
null last
then Board rank
then ID
```

Shoot-date views retain their current comparator and remain client-only over the authorized payload.

Changing sort mode performs:

```text
zero API calls
zero project writes
zero audits
zero activities
zero outboxes
```

The Priority sort option renders only when the authorized projection contains Priority metadata.
It does not render for External Editor or Photographer projections that withhold it.

### Deadline and card fields

Preserve:

- Deadline label;
- overdue state;
- Agency/address/cover fields already authorized;
- Priority display only where authorized.

Remove the List card’s project-level RAW count as required by the accepted TB4B/TB5A contract.
Do not add Deadline sorting.

## Rail, native drag, keyboard, and freshness UI

### Rail Stage control

Add a dedicated Stage control to `ProjectOverviewRail` under Production.

It receives:

- role-safe current Stage;
- current `boardRevision`;
- role-safe Stage list including active state;
- `can("moveProjectStage")`;
- archived/read-only state;
- a mutation callback owned by the Project Workspace.

Behavior:

- current Stage is visibly selected;
- active destinations are enabled;
- inactive non-current destinations are disabled/omitted;
- inactive current Stage remains shown;
- same-Stage selection performs no request;
- append placement is used;
- sensitive transitions open the existing Quincy confirmation modal;
- successful response updates the exact project detail and Dashboard cache;
- `409` replaces stale state and preserves the open workspace;
- External/internal Editor sees only Editing.

### Native Kanban drag

TB5A keeps native HTML drag.

Rules:

- card `draggable` uses `moveProjectStage`, not `selectForEditing`;
- archived, pending, unauthorized, and Photographer cards are not draggable;
- dropping on a column background uses append;
- dropping at a rendered card boundary may send exact visible before/after neighbours;
- confirmation-required drops leave the card in its source column until accepted;
- cancel returns focus to the dragged card;
- success reconciles from the authoritative response/order;
- conflict restores authoritative state and announces it;
- no dnd-kit package or abstraction enters the diff.

### Keyboard/non-drag action

Every movable card has a keyboard-operable Move Stage action:

- button/menu reachable without drag;
- same destination list and active/inactive rules;
- same confirmation modal;
- append placement;
- focus returns to the card or equivalent destination card after completion;
- live region announces success/conflict;
- no pointer-only dependency.

### Interaction ownership and query refresh

Extend the Dashboard query owner so background/cross-tab refresh cannot replace the active board
while:

- a card is being dragged;
- a confirmation modal is open;
- a Stage/position mutation is pending.

During ownership:

- defer exact Dashboard replacement;
- keep the latest invalidation queued;
- preserve view mode, sort, search, scroll, focused card, and modal;
- after commit/cancel/conflict, release ownership and perform one narrow authoritative refresh.

Mutation success invalidates:

- the principal-scoped active Dashboard query;
- project detail;
- role-safe Stage/config data only if a Stage activation conflict indicates it changed.

Publish a narrow same-browser project/Dashboard invalidation through the existing TB2
`BroadcastChannel` mechanism. Other sessions converge through the existing bounded Dashboard
polling.

Membership loss or role transition still uses TB4E’s authorization snapshot and purge behavior.
A delayed Stage mutation response must not repopulate a purged project.

## Implementation slices

### Slice 0 — freeze fixtures and writer inventory

- Add legacy ordering fixtures before changing helpers.
- Capture mixed Priority/null, duplicated positions, fractional positions, inactive Stage, and
  archived rows.
- Record the exact current Board comparator and Priority insertion results.
- Inventory every Stage, position, Priority, archive, restore, project-create, activity, and legacy
  notification writer.
- Record local `main`/HEAD, migration tail, dependency pins, and current test counts.
- Confirm no implementation file outside `portal/` is needed.

### Slice 1 — shared Stage/capability/activity contract

- Add `moveProjectStage`.
- Grant Admin, internal Editor, and External Editor.
- Keep all `selectForEditing` RAW call sites.
- Add role-safe Stage transport types and schemas.
- Add semantic sequence and pure confirmation classifier.
- Add request/response/conflict schemas.
- Add Board revision/placement types.
- Activate `project.stage.changed` with exact payload/source identity/cutover metadata.
- Add internal and External-safe render/projection rules.
- Export through `@quincy/shared`.

### Slice 2 — additive migration and schema

- Add migration `0037`.
- Add `projects.board_revision`.
- Add rollback table and indexes.
- Capture and normalize legacy visible order.
- Update Drizzle schema, journal, and snapshot.
- Add migration upgrade/full-chain/rollback-record tests.
- Remove the temporary Admin backfill endpoint from the accepted route surface.

### Slice 3 — DB Stage and Board primitives

- Extend `stage-transition.ts` with composable guarded statements.
- Add append and exact-neighbour placement.
- Add revision fencing/increments.
- Add atomic JSON-snapshot compaction.
- Preserve system audit behavior.
- Add marker-gated optional activity and Deadline tails.
- Refactor Board helpers around persisted order only.
- Remove `priorityInsertNeighbors`.
- Add DB unit/integration tests.

### Slice 4 — app commands and routes

- Add `moveProjectStage`.
- Add/refactor manual Board-order command.
- Refactor Priority to metadata-only.
- Extract marker-gated Deadline suppression statements.
- Register bare/trailing-slash Stage paths.
- Remove route-local Stage SQL/audit/legacy Delivered notification.
- Return authoritative state/publication IDs.
- Add authorization, conflict, confirmation, no-op, Deadline, activity, and external-scope tests.

### Slice 5 — automatic writer convergence

- Convert all app/background Stage writers to the shared primitive/builder.
- Preserve each workflow’s existing prerequisite and atomic batch.
- Add Board revision changes.
- Prove AutoHDR completion loses after human Stage change.
- Preserve direct-send Admin-only semantics and provider boundaries.
- Preserve existing workflow notification ownership.
- Audit that no direct production Stage UPDATE remains.

### Slice 6 — authorized Dashboard projections

- Add Board-order projection to internal list response.
- Add scoped Board-order projection and `boardRevision` to strict External response.
- Keep Priority/position withheld externally.
- Ensure SQL authorization precedes projection.
- Update strict web decoders/adapters.
- Add privacy and SQL-scope tests.

### Slice 7 — web rail, Board, confirmation, and freshness

- Add rail control.
- Move Dashboard capability check.
- Add Priority sort mode for authorized internal projections.
- Make Board view consume authoritative order map.
- Preserve shoot-date sorts.
- Add native append/exact-neighbour drag.
- Add keyboard Move action.
- Add interaction ownership and narrow invalidation.
- Add DOM/accessibility/neutral-label/conflict tests.
- Keep existing Quincy styles and React 19.2.8.

### Slice 8 — proof, rollout, and closeout

- Run focused and complete gates.
- Run repository audits.
- Apply migration to scratch D1 from full chain and `0036`.
- Run Agy local browser matrix.
- Obtain fresh diff review.
- Create recovery export.
- Confirm remote tail `0036`.
- Apply migration, deploy background, deploy inert app, then enabled app.
- Perform passive production verification.
- Update docs only after production acceptance.

## Automated test plan

### Shared capability and Stage tests

Prove:

- capability union contains `moveProjectStage`;
- Admin/internal Editor/External Editor have it;
- Photographer does not;
- External allow-list is exactly ten items after TB5A;
- `selectForEditing` remains with Admin/internal Editor only;
- every RAW selection/download test still uses `selectForEditing`;
- Stage sequence is exact and immutable;
- role-safe Editing mapping;
- non-Admin real internal-key rejection;
- transition confirmation truth table for all 25 from/to pairs;
- cumulative reason ordering;
- strict request schemas reject unknown keys, unsafe revisions, duplicate reasons, bad IDs, and
  inconsistent transport keys;
- Stage activity payload/source/deep-link identity;
- reserved→live transition for `project.stage.changed`;
- external Stage policy allowed and Priority policy suppressed;
- internal and External copy contains no provider vocabulary.

### Migration tests

Apply through `0036`, seed:

- multiple semantic Stages;
- active and inactive configured Stages;
- archived projects;
- Priority `1`, `5`, `10`, null;
- positions that reflect legacy Priority insertion;
- duplicate positions;
- fractional positions;
- IDs that exercise deterministic ties.

Then apply `0037` and prove:

- one bare `ALTER TABLE ADD COLUMN`;
- no table rebuild, PRAGMA, drop, rename, or destructive delete;
- Priority and Stage unchanged;
- archived rows unchanged except new default revision;
- active legacy visible order preserved exactly;
- normalized positions are `0,1024,...` per Stage;
- all normalized active revisions equal `1`;
- rollback table contains one exact row per active project;
- old and normalized positions are correct;
- Stage/rank uniqueness;
- index presence;
- invalid revision writes fail;
- foreign-key check empty;
- `quick_check` is `ok`;
- journal/snapshot tail is `0037`;
- full-chain apply and `0036→0037` upgrade both pass.

### Stage command/API tests

Cover every principal:

- Admin;
- internal Editor;
- assigned External Editor;
- unassigned External Editor;
- Photographer;
- inactive/deactivated user;
- impersonated Admin principal.

Cover every result:

- immediate one-step forward;
- backward confirmation;
- skipped-forward confirmation;
- Delivered entry/exit;
- Editing entry/exit;
- combined sensitive reasons;
- missing/wrong/extra confirmation;
- same-Stage no-op;
- active destination;
- inactive destination;
- inactive current Stage escape;
- archived project;
- missing/unassigned External generic 404;
- stale Stage;
- stale target revision;
- stale neighbour revision;
- neighbour moved Stage;
- assignment removed during request;
- exact append;
- exact visible neighbours;
- empty destination;
- simultaneous appends;
- midpoint insertion;
- collision compaction;
- compaction snapshot loss;
- bare and trailing-slash route parity;
- old body reload-required response.

For each winner assert:

- one Stage write;
- one revision increment for target;
- expected sibling increments only when compacted;
- one audit;
- one activity;
- at most one outbox/ledger per eligible membership cycle;
- no broad email;
- authoritative response/order;
- exact audit impersonation metadata.

For each loser/no-op assert zero mutation footprint.

### Priority and manual-order tests

Prove:

- Priority `1..10|null` validation;
- same Priority no-op;
- Priority changes no position;
- Priority changes no Board revision;
- Priority changes emit one audit/activity and internal broad fan-out;
- Priority remains externally suppressed;
- Board order unchanged after Priority set/clear;
- Priority view sorts `1..10,null`, then Board rank, then ID;
- switching views writes nothing;
- shoot-date sort writes nothing;
- pure reorder changes position/revision and audit only;
- pure reorder creates no activity/outbox;
- reorder controls render only in Board-order view;
- return to Board order restores persisted order.

### Automatic Stage writer and AutoHDR tests

For every converted writer prove:

- exact from-Stage guard;
- archive guard;
- append behavior;
- revision increment;
- exactly one existing audit on a winner;
- no audit/revision on a loser;
- existing workflow prerequisites remain atomic.

Race tests:

1. project begins in Editing;
2. final-import work reads/claims its normal input;
3. human command moves project backward or to Delivered;
4. completion Stage update runs;
5. final Stage remains the human-selected Stage;
6. automatic Stage update reports no change;
7. no automatic Stage audit/revision/activity/outbox occurs.

Also prove:

- direct AutoHDR send remains Admin-only;
- manual Editing entry creates no handoff/job/provider call;
- manual Editing exit cancels/retires nothing;
- manual Delivered entry publishes nothing;
- manual Delivered exit revokes nothing.

### Deadline tests

Entering Delivered:

- winning Stage batch supersedes pending occurrences;
- suppresses eligible pending/queued Deadline outbox/ledger work;
- uses terminal reason `project_delivered`;
- leaves fired/sent history;
- does not edit Deadline civil/instant/version fields;
- no follow-up gap exists between Stage and suppression.

Loser/no-op/cancel:

- suppresses nothing.

Exiting Delivered:

- does not resume occurrences;
- does not invent reminders;
- leaves explicit TB4B resume available.

Deadline/overdue values never enter Board comparators.

### Activity/delivery/background tests

Prove:

- `project.stage.changed` parser accepts only live exact payload/source identity;
- old broad source keys fail;
- internal generic renderer works;
- External projector neutralizes Editing;
- occurrence fan-out includes only exact eligible Editor membership cycles;
- authorization epoch stamped;
- role/membership loss suppresses at delivery;
- assigned External receives safe Stage notification;
- unassigned/removed External receives none;
- Priority remains suppressed externally;
- broad Stage rows have one in-app ledger and zero email ledgers;
- Queue recovery remains generic;
- no second consumer branch or event type exists;
- legacy workflow notification tests remain green.

### Query/privacy tests

Prove:

- internal broad project scope;
- Photographer scope unchanged;
- External SQL starts from current assignment and archive constraints;
- unassigned rows never enter result sets;
- External Board order contains assigned IDs only;
- no hidden count or placeholder;
- no Priority/`boardPosition`/internal Editing key in strict External JSON;
- `boardRevision` belongs only to returned assigned projects;
- External neighbour IDs must also be visible;
- exact response schemas reject internal-field expansion;
- List and Board share the same authorized project universe.

### Web tests

Cover:

- Board-order comparator no longer groups Priority;
- Priority view comparator;
- shoot-date comparators;
- external authoritative order map;
- rail current/inactive/active options;
- same-Stage no request;
- confirmation copy and cancellation;
- cumulative confirmation reasons;
- neutral Editing in badge, rail, Board, modal, request, response adapter, and toast;
- Admin internal label allowed;
- native append drag;
- native exact-neighbour drag;
- keyboard Move action;
- focus return/live-region announcements;
- conflict reconciliation;
- active drag/modal/pending mutation defers refresh;
- queued refresh runs after release;
- access-loss purge wins over late response;
- Deadline/overdue card remains;
- card-level RAW count absent;
- manual controls hidden outside Board order;
- External Priority sort absent;
- no console/network error in DOM integration tests.

## Repository audits

Record each command and result in evidence.

### Capability audit

```bash
rg -n 'selectForEditing|moveProjectStage' \
  portal/packages/shared portal/apps/web portal/workers
```

Expected:

- Stage movement uses only `moveProjectStage`;
- RAW selection/download retains `selectForEditing`;
- no Stage route/UI checks `selectForEditing`.

### Stage-writer audit

```bash
rg -n \
  'SET stage_key|stageKey:|stage_key =|update\\(.*projects.*stage' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'
```

Classify every production result. No unowned Stage mutation remains outside the shared builder or
migration/test fixtures.

### Position/revision audit

```bash
rg -n 'board_position|boardPosition|board_revision|boardRevision' \
  portal/apps portal/workers portal/packages \
  -g '*.ts'
```

Expected:

- every production Stage/position writer increments revision;
- Priority writer does not write position/revision;
- Board view reads the authoritative order projection;
- External JSON contains revision but not raw position.

### Priority-coupling audit

```bash
rg -n 'priorityInsertNeighbors|priority.*board_position|priority.*boardPosition' \
  portal -g '*.ts'
```

Expected:

- no production Priority-to-position helper or SQL;
- legacy behavior remains only in fixtures explaining migration order.

### Activity/notification audit

```bash
rg -n \
  'project\\.stage\\.changed|notifyProject\\(.*delivered|notifyProject\\(.*sent_to_editing|project\\.priority\\.changed' \
  portal -g '*.ts'
```

Expected:

- one human Stage activity producer;
- no manual legacy Delivered/Editing notification;
- existing workflow-owned notifications remain;
- Priority producer remains single.

### External privacy audit

```bash
rg -n \
  'priority|boardPosition|board_position|editing_autohdr|orderedProjectIdsByStage|boardRevision' \
  portal/packages/shared/src/external-* \
  portal/workers/app/src/lib/external-* \
  portal/apps/web/src/lib/external-*
```

Review every match. Strict External responses must not expose Priority, raw position, hidden IDs, or
internal Editing key.

### Route audit

- Confirm both Stage path forms.
- Confirm both delegate to one handler.
- Confirm no root-mounted wildcard middleware was introduced.
- Update the TB4E registered-route security manifest.
- Confirm removed Admin board backfill is no longer callable.
- Confirm External withheld routes remain withheld.

### Scope audit

```bash
git diff --name-only <implementation-base>...HEAD
```

No changes should enter:

- `prototype/`;
- Calendar/FullCalendar modules;
- client-delivery publish/revoke logic;
- provider credential handling except minimal Stage-writer convergence;
- R2 deletion paths;
- React/dependency manifests unless a demonstrated build requirement receives fresh review;
- webhook-ingress unless a shared-build dependency genuinely changes its artifact.

## Local migration and query-plan proof

Create disposable scratch databases outside user data.

Run:

1. full migration chain `0000→0037`;
2. upgrade path `0036→0037`;
3. representative legacy-order fixture;
4. rollback-table comparison;
5. command/API integration suites against migrated schema.

Record:

- pre/post row counts by Stage and archive state;
- Priority distribution;
- duplicate/fractional position counts;
- old-order vs normalized-order mismatch count, expected `0`;
- rollback-record count vs active-project count, expected equal;
- normalized rank/position mismatch count, expected `0`;
- active revision-1 count;
- archived revision-0 count;
- foreign-key check;
- quick check.

Run `EXPLAIN QUERY PLAN` for:

- authorized internal active project list;
- External assigned project list;
- Board order per Stage;
- append-to-bottom;
- exact neighbour lookup;
- Priority view payload;
- Stage command current reread.

Expected Board queries use `projects_stage_archive_board_order_idx` or an equally selective proven
index. External queries must retain their membership/visible-project index path and must not scan an
unrestricted all-project result for JavaScript filtering.

Measure representative authorized Board serialization for current production-scale and a larger
fixture. Record median and p95; investigate regressions rather than accepting an arbitrary full-table
projection.

## Required verification commands

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

`npm run test --workspaces` must run all workspace-owned test scripts. The explicit shared Vitest
command remains mandatory because the workspace aggregate silently misses `packages/shared`.

Also run focused suites for:

- shared capabilities/Stages/activity/external policy;
- DB migration/Stage transition/Board position/activity;
- app Kanban/Stage/Deadline/external authorization;
- background AutoHDR/RAW Stage and notification delivery;
- web Dashboard/rail/query/DOM behavior.

Then run:

```bash
npx drizzle-kit generate
git status --short
git diff --exit-code -- \
  packages/db/migrations \
  packages/db/migrations/meta \
  packages/db/src/schema.ts
```

The second generate must be a no-op. Do not accept a generated table rebuild.

Record final test counts, skips, warnings, bundle output, migration proof, and repository audits.

## Manual local QA matrix

Use Agy Option A against `http://localhost:8787` with the human-authenticated dedicated Chrome
profile. Agy never signs in, reads secrets, forges sessions, or works around missing authentication.
After one Admin sign-in, use shipped Admin impersonation for internal Editor/Photographer checks.
Use only a disposable External Editor fixture/account under approved local test data.

### Setup

- Apply migrations through `0037` locally.
- Seed projects in every semantic Stage.
- Seed mixed Priority and Board positions.
- Seed one inactive Stage containing a project.
- Seed an archived project.
- Seed assigned/unassigned External project cases.
- Seed pending Deadline occurrences.
- Seed eligible Editor membership cycles.
- Prepare an AutoHDR completion race fixture without calling the real provider.

### Admin matrix

- Board order matches persisted normalized order.
- Priority changes do not move cards.
- Priority sort shows `1..10,null`.
- Shoot-date sorts are view-only.
- Reorder controls appear only in Board order.
- Rail normal forward works immediately.
- Backward and skip require confirmation.
- Editing entry/exit uses dedicated copy.
- Delivered entry/exit uses Stage-only copy.
- Combined confirmation case shows all consequences.
- Same-Stage rail choice performs no request.
- Native drag append works.
- Native neighbour placement works.
- Keyboard Move works.
- Inactive current Stage remains visible and escapable.
- Archived project is read-only.
- Deadline/overdue remains; RAW card count is absent.

### Internal Editor matrix

- Can move Stage from rail, native drag, and keyboard.
- Cannot use Admin-only Priority controls.
- Sees neutral Editing everywhere.
- Request/response contains neutral Editing key.
- Confirmation copy contains no provider detail.
- Stage move creates expected activity/broad delivery.
- Cannot bypass confirmation with a crafted request.

### External Editor matrix

Assigned project:

- appears in list/Board;
- has correct visible assigned-project Board order;
- can move Stage;
- sees neutral Editing;
- sees Deadline/overdue;
- never sees Priority or raw Board position;
- receives safe Stage notification;
- can use only assigned visible neighbour IDs.

Unassigned/removed project:

- absent from list/search/order map;
- direct Stage request returns generic 404;
- stale cached project is purged after assignment removal;
- no Stage notification arrives after cycle loss.

Inspect network payloads for forbidden fields and hidden IDs.

### Photographer matrix

- Stage controls and drag are absent;
- crafted Stage request receives capability denial;
- RAW selection still works under `selectForEditing`;
- assigned-project Stage visibility remains unchanged.

### Conflict and refresh matrix

- Open the same Board in two tabs.
- Move a card in tab A.
- Submit stale move/reorder from tab B.
- Tab B receives 409, does not auto-retry, and reconciles authoritative state.
- Repeat with stale neighbour revision.
- Trigger a refresh while dragging; the card/scroll/filter remains stable.
- Trigger a refresh while confirmation is open; modal and focus remain stable.
- Release interaction; one queued refresh applies.

### AutoHDR/Deadline matrix

- Start completion fixture from Editing.
- Human moves the project backward.
- Complete the fixture.
- Confirm Stage remains human-selected and no automatic Stage audit/revision occurs.
- Enter Delivered on a project with pending Deadline work.
- Confirm pending occurrences become superseded.
- Exit Delivered.
- Confirm Deadline does not resume automatically.
- Confirm no publish/revoke or provider request occurred.

### Viewports and accessibility

Run at:

- 1440×900;
- 1024×768;
- 390×844;
- browser zoom/reflow.

Check:

- keyboard-only movement;
- confirmation focus trap and return;
- live-region announcements;
- visible focus;
- card controls do not overlap;
- inactive Stage escape;
- neutral Editing label;
- no console errors;
- no unexpected network retries;
- no project data reappears after access loss.

## Deployment preflight and rollout

### Preflight

1. Record implementation base and reviewed commit SHAs.
2. Confirm local journal/migration directory tail `0036`.
3. Query production `d1_migrations`; require tail `0036`.
4. Confirm `board_revision`, migration rollback table, and candidate index are absent.
5. Create a timestamped remote D1 recovery export under the parent `db-recovery/` directory:
   `quincy-portal-before-tb5a-<UTC timestamp>.sql`.
6. Record export path, size, SHA-256, foreign-key check, and quick check.
7. Record privacy-safe counts:
   - active/archived projects;
   - projects per Stage;
   - Priority null/non-null distribution;
   - duplicate/fractional positions;
   - activity/outbox/ledger counts;
   - pending Deadline occurrence/outbox counts.
8. Capture the exact legacy order mapping needed to compare migration output without exposing client
   names or addresses.
9. Confirm no active deployment or competing migration.
10. Schedule a short maintenance window covering migration through inert-app deployment, because the
    pre-TB5A app can still write Priority-coupled positions.
11. Build and test:
    - `tb5a-inert-rollback`: migration-aware reads; new strict schemas; Priority metadata-only;
      Stage and position writes disabled with bounded `503`; Stage/reorder controls hidden;
    - `tb5a-write-enabled`: accepted command and UI.
12. Confirm the background bundle recognizes live `project.stage.changed` before the app can produce
    it.
13. Confirm webhook-ingress has no behavior/schema dependency requiring a deploy. If its artifact
    changes, include it between background and app.

### Rollout order

1. Begin the recorded maintenance window.
2. Apply migration `0037`.
3. Postflight:
   - remote migration tail `0037`;
   - exact column/table/index presence;
   - active row/rollback row count equality;
   - zero legacy-order mismatches;
   - normalized positions/revisions;
   - unchanged Priority/Stage values;
   - archived rows unchanged;
   - foreign-key check clean;
   - quick check `ok`.
4. Deploy background first.
5. If webhook-ingress artifact changed, deploy it second; otherwise record “unchanged/not deployed.”
6. Verify background Worker version and generic notification consumer health.
7. Deploy `tb5a-inert-rollback` app.
8. Record that Worker version as the only valid post-`0037` app rollback target.
9. Verify:
   - project list/Board reads;
   - strict External decoders;
   - Priority metadata-only behavior;
   - Stage/reorder bounded disabled response;
   - no unknown/reserved Stage activity failures.
10. End the maintenance write freeze only after the inert target is healthy.
11. Deploy `tb5a-write-enabled` app.
12. Verify the exact app Worker version, served web bundle, route schemas, and health.
13. Keep the inert Worker version available for rollback.
14. Record migration, Worker versions, commits, UTC/local timestamps, recovery export, and QA
    evidence.

### Passive production verification

Production verification is passive by default.

Verify:

- authenticated Dashboard and Project Workspace load;
- Board order matches persisted/order projection;
- List remains correctly ordered;
- Deadline/overdue renders;
- RAW card count is absent;
- no console/network/schema errors;
- External-safe schemas remain strict;
- Queue recovery has no reserved/unknown Stage event failures;
- no unexpected broad email ledger;
- no migration/order mismatch;
- no sudden increase in conflicts or failed outboxes.

If a natural safe Stage change occurs, verify one audit/activity and correct recipient-cycle rows.
Do not mutate a real client project solely for proof unless separately authorized under the
documented disposable QA procedure.

### Documentation closeout

Only after verified production deployment:

- update `docs/todo.md`;
- update the mirrored migration/deploy facts in `AGENTS.md` and `CLAUDE.md`;
- update this status line with commit, migration, Worker versions, recovery export, and QA;
- mark acceptance items with evidence;
- record `0038` as the next available migration;
- `git mv` this plan into `docs/plans/implemented/`.

## Rollback and fix-forward

Migration `0037` is additive but contains a deliberate one-time data normalization.

### App/UI/command fault

1. Roll app to the recorded `tb5a-inert-rollback` Worker version.
2. Verify Stage and manual-order writes return the bounded disabled response.
3. Keep Priority metadata-only; never roll to a pre-TB5A app that rewrites Board order on Priority.
4. Keep the TB5A-aware background consumer live to drain committed Stage outboxes.
5. Preserve audit/activity/outbox/ledger history.
6. Fix forward and rerun the complete gate.

### Background/notification fault

1. Roll app to inert if continued Stage-event production increases risk.
2. Deploy a fixed TB5A-aware background registry/consumer.
3. Let outbox recovery republish the same committed IDs.
4. Do not roll background to a bundle that treats `project.stage.changed` as reserved while such
   rows are pending.
5. Never synthesize replacement activity/source keys or email ledgers.

### Migration/order fault before write enablement

If postflight fails before the write-enabled app and every project remains at migration baseline:

1. keep app inert;
2. compare projects against `project_board_order_0037_rollback`;
3. restore old positions only under explicit human authorization;
4. increment/rebaseline revisions consistently;
5. use the recovery export only if targeted repair is unsafe;
6. fix migration logic under the next valid migration number if `0037` is already recorded applied.

Do not delete the rollback table or edit `d1_migrations`.

### Fault after write enablement

After any genuine Stage/reorder/archive/restore write:

- do not bulk-restore old positions;
- do not reset Board revisions;
- do not redeploy the pre-TB5A app;
- fix forward with command/query corrections;
- use the recovery export only for catastrophic recovery under explicit authority.

### Privacy fault

If External responses expose Priority, position, hidden IDs, internal Editing key, or unrelated-board
signals:

1. roll app immediately to inert;
2. preserve evidence using restricted aggregate queries;
3. purge affected External browser/cache projections through the shipped TB4E mechanism;
4. fix strict schemas and SQL projection;
5. do not redact a broad internal DTO in React as the repair;
6. do not delete activity or audit history.

## Acceptance checklist

### Capability and Stage domain

- [ ] `moveProjectStage` is granted only to Admin, internal Editor, and External Editor.
- [ ] External use additionally requires current assigned-project access.
- [ ] `selectForEditing` remains on RAW selection/download work and gates no Stage movement.
- [ ] Fixed semantic Stage sequence is shared and display order does not redefine it.
- [ ] All 25 transition pairs produce the exact confirmation-reason set.
- [ ] Normal one-step public forward is immediate unless it crosses Editing or Delivered.
- [ ] Backward, skipped-forward, Delivered, and Editing boundaries are acknowledged exactly.
- [ ] Manual Editing/Delivered changes are Stage-only.
- [ ] Non-Admin transport and UI expose only neutral Editing.
- [ ] Active destinations only; inactive current Stage remains visible and escapable.
- [ ] Archived projects are read-only/non-discoverable according to role.
- [ ] Same-Stage rail selection is a true no-op.

### Ordering and migration

- [ ] Migration number is `0037` after direct production-tail confirmation.
- [ ] Migration is additive and contains no table rebuild/PRAGMA/drop/rename.
- [ ] Exact current visible order is captured before normalization.
- [ ] Priority, Stage, and archived rows remain semantically unchanged.
- [ ] Active positions normalize to deterministic `0,1024,...`.
- [ ] Rollback table contains exact old/new position and rank for every active project.
- [ ] `board_position,id` becomes the sole persisted Board order.
- [ ] `boardRevision` fences every Board-state mutation.
- [ ] Priority changes perform no position/revision write.
- [ ] Priority view is `1..10,null`, then Board order, then ID.
- [ ] Shoot-date views remain non-writing.
- [ ] Manual controls exist only in Board-order view.
- [ ] Visible Board order equals the authoritative order projection and mutation-neighbour order.
- [ ] Temporary Admin backfill route is removed/disabled.

### Command and atomicity

- [ ] One route-independent `moveProjectStage` command owns all human Stage entry points.
- [ ] Route authorization cannot be bypassed by direct command invocation.
- [ ] Bare and trailing-slash routes are equivalent.
- [ ] Every request carries expected Stage and project Board revision.
- [ ] Positional moves carry exact visible neighbour revisions.
- [ ] Changed premise returns 409 with authoritative current state and no auto-retry.
- [ ] Append is computed atomically at destination bottom.
- [ ] Collision compaction is all-or-nothing and snapshot-fenced.
- [ ] A winner writes one audit and one human Stage activity.
- [ ] A loser/no-op writes no audit/activity/outbox/Deadline state.
- [ ] Recipient fan-out is at most once per eligible membership cycle.
- [ ] Response returns authoritative role-safe project and Board state.
- [ ] Delivered Deadline suppression is marker-gated in the winning batch.
- [ ] Exiting Delivered does not auto-resume reminders.

### Automatic workflow safety

- [ ] Every production Stage writer uses the shared guarded primitive/builder.
- [ ] Every Stage/position writer increments Board revision.
- [ ] Automatic writers retain exact from-Stage/archive/workflow prerequisites.
- [ ] Human movement out of Editing makes later AutoHDR completion a Stage no-op.
- [ ] Automatic loss produces no Stage audit/revision/activity/outbox.
- [ ] Direct AutoHDR send remains Admin-only, send-only, and provider-safe.
- [ ] Manual Editing movement creates/cancels/retires/deletes no workflow state.
- [ ] Manual Delivered movement publishes/revokes nothing.

### Activity, notification, and privacy

- [ ] `project.stage.changed` alone moves reserved→live for TB5A.
- [ ] Exact payload/source/deep-link/cutover/no-backfill rules pass.
- [ ] Internal Stage notifications use the generic TB4C broad path.
- [ ] External assigned Editor receives only fixed safe copy.
- [ ] External payload/response never exposes `editing_autohdr`.
- [ ] Priority notification remains suppressed externally.
- [ ] Pure position reorder produces no activity/outbox.
- [ ] Broad Stage delivery creates no email ledger/provider call.
- [ ] No legacy manual Delivered/Editing notification duplicates the event.
- [ ] No hidden project, Priority, raw position, count, or neighbour leaks externally.

### Query, freshness, and UI

- [ ] Board/list project universes are server-authorized.
- [ ] External payload contains assigned projects only.
- [ ] Internal Board order uses authoritative server order projection.
- [ ] External Board order works without manufactured zero positions.
- [ ] Rail, native drag, and keyboard paths use the same command.
- [ ] Active drag, open confirmation, and pending mutation preserve interaction state.
- [ ] Cross-tab/background refresh applies after ownership release.
- [ ] Access-loss purge wins over delayed mutation responses.
- [ ] Deadline/overdue remains on cards.
- [ ] Card-level RAW count is absent.
- [ ] Desktop, compact, phone, zoom/reflow, keyboard, focus, console, and network QA pass.
- [ ] No dnd-kit, Calendar, React migration, prototype, or visual-framework expansion enters scope.

### Proof and rollout

- [ ] Shared/DB/app/background/web focused suites pass.
- [ ] Typecheck, web build, workspace tests, and explicit shared Vitest pass.
- [ ] Second `drizzle-kit generate` is a no-op.
- [ ] Capability, writer, ordering, activity, privacy, route, and scope audits are recorded.
- [ ] Full-chain and `0036→0037` migration proofs pass.
- [ ] Query plans and serialization measurements are recorded.
- [ ] Agy local browser matrix passes.
- [ ] Fresh diff review approves the implementation.
- [ ] Recovery export exists with path, size, and SHA-256.
- [ ] Remote tail was directly confirmed `0036` before apply.
- [ ] Migration postflight is clean.
- [ ] Background → optional webhook-ingress → inert app → enabled app rollout completes.
- [ ] Inert post-`0037` rollback Worker version is recorded.
- [ ] Production verification is complete.
- [ ] Documentation reflects production before this file moves to `implemented/`.

## Expected implementation footprint

Exact test filenames may follow workspace conventions. Expected production footprint:

- `portal/packages/shared/src/capabilities.ts`
- `portal/packages/shared/src/stages.ts`
- `portal/packages/shared/src/project-activity.ts`
- `portal/packages/shared/src/external-project-policy.ts`
- `portal/packages/shared/src/external-project-dto.ts`
- optional shared TB5A cutover/config module
- `portal/packages/shared/src/index.ts`
- shared capability/Stage/activity/external-policy tests
- `portal/packages/db/migrations/0037_project_board_order_contract.sql`
- `portal/packages/db/migrations/meta/_journal.json`
- `portal/packages/db/migrations/meta/0037_snapshot.json`
- `portal/packages/db/src/schema.ts`
- `portal/packages/db/src/stage-transition.ts`
- `portal/packages/db/src/board-position.ts`
- `portal/packages/db/src/project-activity.ts` only if bundle/result indexing needs extension
- DB migration/Stage/Board/activity tests
- `portal/workers/app/src/lib/project-stage.ts` (new)
- `portal/workers/app/src/lib/project-board-order.ts` (new or refactored owner)
- `portal/workers/app/src/lib/project-deadline.ts`
- `portal/workers/app/src/lib/external-project-query.ts`
- `portal/workers/app/src/lib/kanban-ordering.ts`
- `portal/workers/app/src/routes/projects.ts`
- `portal/workers/app/src/routes/stages.ts`
- `portal/workers/app/src/routes/admin.ts`
- app Stage/Kanban/Deadline/external-authorization integration tests
- existing app/background ingest, reconciliation, AutoHDR claims/finals/workflow modules that contain
  direct Stage writes
- background RAW/AutoHDR/notification tests
- `portal/apps/web/src/lib/stages.tsx`
- `portal/apps/web/src/lib/dashboard-projects.ts`
- `portal/apps/web/src/lib/external-api-response.ts`
- `portal/apps/web/src/lib/project-data.ts` / query-sync only for narrow Dashboard ownership support
- `portal/apps/web/src/screens/dashboard-helpers.ts`
- `portal/apps/web/src/screens/Dashboard.tsx`
- `portal/apps/web/src/components/ProjectOverviewRail.tsx`
- `portal/apps/web/src/screens/ProjectWorkspace.tsx`
- focused web DOM/query/sort/accessibility tests
- `portal/apps/web/src/styles/app.css`
- deployment closeout docs only after production acceptance

Any need to change `prototype/`, Calendar/FullCalendar code, publish/revoke behavior, provider
credentials, media deletion, React/dependency versions, global Stage configuration, or External
Priority policy requires fresh plan review.

## Open decisions for review

No unresolved product choice is required before implementation. Fresh-Sol review should explicitly
affirm or revise these architecture choices before build:

1. `projects.board_revision` is the scoped conflict token; no global Stage revision is exposed.
2. The migration-owned rollback table remains permanent and has no foreign key.
3. External Board order is returned as authorized ID order plus per-project revision, while Priority
   and raw position remain withheld.
4. Confirmation acknowledges the exact cumulative reason array rather than one precedence-selected
   reason or a boolean.
5. `project.stage.changed` is human-command-owned in TB5A; automatic workflow outcomes retain their
   existing owners and do not create a duplicate Stage activity.