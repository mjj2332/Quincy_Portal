# TB5A Slice 0 — verified current writer inventory

Verified 2026-08-28 on `tb5a-stage-kanban-ordering`, at baseline `2a7a2bc5f3262c3a64c0019e22c518aeba7ce886`. The source references below were re-checked on this branch. Slice 0 made no production signature, route, capability, column, or schema change.

## Explicit corrections

1. **Archive and Restore are one shared handler, not two handlers.** `workers/app/src/routes/projects.ts:974` registers both paths in one loop and branches on the `archived` boolean. The archive branch starts at `:978` and writes at `:992`; the restore branch starts at `:1043` and writes at `:1052`. The plan's two inventory rows describe branches of this single handler. Slice 5 must rewrite this one handler: archive increments the Board revision once, while restore appends to Stage bottom and increments it once.

2. **`GET /projects` has a missed pre-marker full-object read.** `workers/app/src/routes/projects.ts:385` builds `db.select({ project: schema.projects, ... })`, selecting the entire `projects` object. It is a read, not a Stage/position writer, but it must receive the same old-column projection treatment in Slice 4 when `board_revision` exists. The other verified pre-marker full-object reads are `workers/app/src/routes/projects.ts:247`, `:492`, `:559`, `:1121`, and `workers/background/src/tonomo/process.ts:72`, `:80`.

No entirely omitted Stage/position writer was found. The catch-all automatic-writer row below covers the direct AutoHDR/reconciliation writers listed in the exact Stage inventory.

## Ordering characterization boundary

The current code has three related but distinct ordering behaviors, all intentionally left unchanged in Slice 0:

- Internal Board UI `apps/web/src/screens/Dashboard.tsx:48-53`: non-null Priority group first, then `boardPosition`, then `id`; numeric Priority is not a sort key.
- Worker helper `workers/app/src/lib/kanban-ordering.ts:5-7` (`orderedBoardRows`): `boardPosition`, then `id`; it does not apply the UI Priority group.
- API list query `packages/db/src/dashboard-order.ts:4-7` (`dashboardProjectOrder`): shoot date descending with null dates last. `orderDashboardStreetTies` then ties by street and ID. It is not the Board comparator.
- External adapter `apps/web/src/lib/external-api-response.ts:31-38` manufactures `priority: null` and `boardPosition: 0`; the current Board comparator therefore falls through to ID for External rows.

The characterization tests preserve each current behavior so later slices show the intended convergence as an explicit diff.

## Complete current Stage-and-position writer inventory

| Writer / exact current source reference | Current primitive and audit | Current guard / prerequisite | Current hook or notification | TB5A target | Slice |
|---|---|---|---|---|---|
| `POST /projects/:id/stage`, route `workers/app/src/routes/projects.ts:1113`; write `:1125`; audit `:1126` | Direct Drizzle Stage plus `appendToStageBottomExpr`; `stage.set` | Route access, active target Stage | Deadline follow-up and legacy `delivered` notification at `:1127-1130` | Cross-Stage `moveProjectStage`; same-Stage placement dispatches to Board-order command | 5 |
| `POST /projects/:id/board-position`, route `workers/app/src/routes/projects.ts:457`; helper call `:469`; audit `:477` | `guardedBoardUpdate` with `plannedBoardState` | Access plus `prioritizeProjects` | None | `project-board-order.ts`, exact snapshot/revision, audit only | 5 |
| `guardedBoardUpdate`, `workers/app/src/routes/projects.ts:45`; `plannedBoardState`, `:92` | Target update followed by per-row renumber writes at `:72-81` | Stage/position snapshots; caller marker | Caller-specific | Delete after DB-owned non-compacting/compacting bundles replace all callers | 5 |
| Priority route `workers/app/src/routes/projects.ts:415`; import `:19`; `priorityInsertNeighbors` call `:427` | Priority-coupled position planning; final write through `guardedBoardUpdate` at `:442`; `project.priority_set` plus activity | `prioritizeProjects`, current Stage/position | Notification-outbox publication at `:453` | Metadata-only guarded Priority update; no position/revision mutation | 5 |
| `priorityInsertNeighbors`, `workers/app/src/lib/kanban-ordering.ts:13` | Neighbor derivation used by Priority route | Current column rows | None itself | Remove with legacy Priority-placement coupling | 5 |
| `manualInsertNeighbors`, `workers/app/src/lib/kanban-ordering.ts:33` | Directional neighbor derivation | Used by manual Board route | None itself | Replace with exact visible-neighbor request contract | 5 |
| `renumberedInsertPosition`, `workers/app/src/lib/kanban-ordering.ts:43` | Legacy full-column `1024, 2048, ...` renumber plan | Called through `plannedBoardState` | None itself | Replace with DB-owned `0, 1024, ...` compaction | 5 |
| Raw app project creation, `workers/app/src/routes/projects.ts:320-328`; append expression `:328` | SQL insert with Stage-bottom subquery | Eligibility and membership predicates | Project-creation activity/scaffold chain | Marker/flag-aware creation bundle with initial revision | 5 |
| Tonomo project creation, `workers/background/src/tonomo/process.ts:91-101`; append expression `:101` | Drizzle insert with `appendToStageBottomExpr` | Exact order/address reconciliation | AutoHDR scaffold enqueue | Marker/flag-aware creation bundle | 6 |
| Admin backfill route `workers/app/src/routes/admin.ts:309`; per-row normalization `:324`; Stage-bottom repair `:338`; audit `:343` | Per-row normalization and retrying Stage-bottom correction; `admin.board_position_backfill` | Admin operator route | None | Remove route, manifest entry, audit expectation, and tests | 5 |
| Shared archive/restore handler `workers/app/src/routes/projects.ts:974`; archive update `:992`; restore update `:1052` | Archive removes visibility without revising; restore clears archive fields without appending; `project.archive` / `project.restore` | Archive capability and document guards | Activity publication | Board-aware archive/restore winner; restore appends to Stage bottom | 5 |
| Direct upload `workers/app/src/lib/ingest.ts:214`; `guardedStageTransition` hook `:224` | `guardedStageTransition` owns Stage-bottom position; `stage.auto_advance` | Durable RAW asset | `raw_ready` | One automatic winner bundle; no direct position write | 6 |
| Dropbox sync `workers/background/src/dropbox/sync.ts:363`; hook `:374` | `guardedStageTransition` owns Stage-bottom position; `stage.auto_advance` | Reconciliation claim and RAW evidence | `raw_ready` | One automatic winner bundle | 6 |
| Awaiting-RAW reconciliation `workers/background/src/reconcile-awaiting-raw.ts:53`; audit `:65`; caller `:90` | Direct guarded Stage/append/audit batch; `stage.auto_advance` | Shoot date due on Sydney business date | `onSuccess` at `:104` | Typed reconciliation prerequisite | 6 |
| AutoHDR handoff confirmation `workers/background/src/autohdr/claims.ts:121`; audit `:123` | Direct Stage/append/audit/handoff batch; `stage.auto_advance` | Handoff identity, connection, generation, and state | `sent_to_editing` at `:137` | Winner plus handoff token tail | 6 |
| AutoHDR repeat send `workers/background/src/autohdr/claims.ts:290`; Stage write `:373`; audit `:375` | Stage/append update inside claim batch; `stage.auto_advance` | Retirement/new mapping winner | None in this function | Winner plus new handoff token | 6 |
| Implicit AutoHDR handoff `workers/background/src/autohdr/claims.ts:429`; Stage write `:606`; audit `:612` | Direct Stage/append claim batch; `stage.auto_advance` | Mapping/path ownership | `sent_to_editing` at `:621` | Winner plus handoff token tail | 6 |
| Backfill AutoHDR handoff `workers/background/src/autohdr/claims.ts:636`; Stage write `:789`; audit `:794` | Direct Stage/append claim batch; `stage.auto_advance` | Mapping/path claim | `sent_to_editing` at `:870` | Winner plus handoff token tail | 6 |
| AutoHDR API send `workers/background/src/workflows/autohdr-api-send.ts:135`; audit `:137` | Direct Stage/append/job/audit batch; Stage and workflow audits | Provider finalize and exact job | `sent_to_editing` at `:148-150` | Winner plus job token tail | 6 |
| AutoHDR Workflow handoff path `workers/background/src/workflows/autohdr.ts:264-276` | Delegates to `confirmAutoHdrHandoff` | Frozen handoff | Delegated `sent_to_editing` | Converted handoff command | 6 |
| AutoHDR Workflow legacy no-handoff path `workers/background/src/workflows/autohdr.ts:279-287` | Direct Drizzle Stage/append update; no separate Stage audit | Legacy workflow input/source Stage | `sent_to_editing` at `:281-282` | Propagated entry-job token or fail closed | 6 |
| AutoHDR final same-hash `workers/background/src/autohdr/finals.ts:191`; hook `:203` | `guardedStageTransition`; `stage.auto_advance` | Handoff/mapping/fetch/coverage | `edited_landed` | Completion with handoff entry token | 6 |
| AutoHDR final first-version `workers/background/src/autohdr/finals.ts:246`; audit `:248` | Direct asset/claim/Stage/append batch; `stage.auto_advance` | Current asset and coverage | `edited_landed` at `:262-264` | Completion with handoff entry token | 6 |
| AutoHDR final replacement `workers/background/src/autohdr/finals.ts:296`; hook `:308` | `guardedStageTransition`; `stage.auto_advance` | Replacement claim and coverage | `edited_landed` | Completion with handoff entry token | 6 |
| AutoHDR fetch legacy `workers/background/src/workflows/autohdr-fetch.ts:182` | Direct Drizzle Stage/append update; no separate Stage audit | Returned edited coverage | `edited_landed` at `:183-184` | Propagated entry-job token or fail closed | 6 |

The shared compatibility writer itself is `packages/db/src/stage-transition.ts:19-49`: its current update appends at destination Stage bottom, writes one `stage.auto_advance` audit in the same batch, and calls `onSuccess` only when the update changes one row. Slice 0 adds characterization for the append position, exact audit, loser behavior, and hook winner semantics; it does not alter the helper.

