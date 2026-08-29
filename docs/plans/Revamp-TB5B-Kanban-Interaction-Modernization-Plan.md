# Revamp TB5B — Kanban Interaction Modernization

Status: BUILT (slices 0–7, branch tb5b-kanban-interaction-modernization) — §5 gates green through Slice 6. Not yet diff-reviewed / deployed. Sort-key ruled Option A by Opus plan-tier review.

Four Opus residual non-blocking notes are carried into the Luna slice specs, not the plan body: (1) the §5 grep invariant "zero `setQueryData` on `dashboardProjectsKey`" must read "…from any Stage/position **movement** path" so it does not trip on Priority's deliberately-retained `updateProjects` path; (2) the settle bullet that sets `movementSettlePending` is cross-Stage only — same-Stage success clears both gates immediately; (3) the post-block settle refetch and any `queuedRefreshRef` refetch are one single network call, not two; (4) gate discipline — the orchestrating session runs all four §5 commands itself, agent-reported green is not evidence.

Baseline: `47e96757e554d41108ff4034b3454761e6cf042d` on `main`.

TB5A is live in production as of 2026-08-29 (merge `b4cda86`, migration `0037`, app
`4ba551a3`, background `fa876454`, `tb5a_board_contract_enabled` ON). TB5B replaces only the
browser interaction layer over that accepted contract.

## Purpose and delivered outcomes

TB5B delivers the scope brief's primary outcome: the accepted project board is accessible,
automatically refreshed, and conflict-safe for pointer, touch, keyboard-drag, and non-drag use.

Each outcome maps directly to the brief's Acceptance clause:

1. **All movement paths implement TB5A.** Pointer, touch, keyboard drag, the explicit **Move
   to…** action, Board-order arrows, and the Workspace rail all create the same strict
   `MoveProjectStageRequest`. Cross-Stage requests use `POST /projects/:id/stage`; authorized
   same-Stage placement uses `POST /projects/:id/board-position`. Both carry exact authorized
   neighbours and `expected.boardRevision`, use `submitStageMoveWithConfirmation` with an explicit
   endpoint confirmation policy, and reconcile from `MoveProjectStageResponse` plus an
   authoritative Dashboard refetch where the response omits source order.
2. **No pointer-only operation or drag/link ambiguity.** Native HTML5 drag is removed. A dedicated
   button is the sole drag activator; the project anchor remains an ordinary direct/new-tab link.
   Keyboard drag and a non-drag position-aware **Move to…** action are complete alternatives.
3. **Conflicts never overwrite newer state.** Drag motion is a proposal, the accepted snapshot is
   preserved for rollback, a `409 project_stage_conflict` restores/refetches authoritative state,
   and the client never automatically retries a stale command.
4. **Authorization remains server-safe.** The Board uses only the server-authorized
   `orderedProjectIdsByStage` projection. External Editor receives assigned projects only and no
   hidden corpus, Priority, raw position, hidden IDs/counts, or internal Editing key.
5. **TB5C receives a stable interaction policy, not a drag implementation.** The policy is named
   and documented below; FullCalendar remains free to own Calendar geometry in TB5C.

## Authority and dependency boundary

Apply authority in this order:

1. `docs/plans/revamp_2026_portal/roadmap/TB5B-Kanban-Interaction-Modernization.md` — Scope,
   Non-goals, Acceptance, and Calendar handoff bound this plan.
2. `docs/plans/implemented/Revamp-TB5A-Stage-And-Kanban-Ordering-Contract-Plan.md` — the shipped
   Stage/order semantics, capability split, transport types, exact-neighbour rule, confirmation,
   conflict response, projections, flag states, rail, and refresh ownership are immutable inputs.
3. Implemented foundations:
   - TB2 owns principal/role/access-scoped query identity, 15-second staleness, visible 30-second
     polling, focus/reconnect freshness, narrow invalidation/broadcast, and access-loss purge;
   - TB4B owns Deadline/overdue Kanban metadata and removal of only the card-level RAW count;
   - TB4E owns the assigned-only External Editor SQL/strict-DTO boundary, authorization epoch,
     neutral Stage presentation, and terminal cache purge.
4. Current source at the baseline, especially `Dashboard.tsx`, `dashboard-projects.ts`,
   `stage-move.ts`, `ProjectOverviewRail.tsx`, `ProjectWorkspace.tsx`, the established dnd-kit
   implementations in `CollectionPanel.tsx` and `SubtaskChecklist.tsx`, and their tests.

The current source confirms that TB5A already shipped every server projection and command TB5B
consumes:

- Dashboard list: `orderedProjectIdsByStage`, per-project `boardRevision`, and
  `contractEnabled` for internal and strict External responses;
- Workspace detail: role-safe `stageKey`, `boardRevision`, and `contractEnabled` without a
  Dashboard dependency;
- mutations: strict `/stage` and `/board-position` routes, exact `between | append` placement,
  `MoveProjectStageResponse.board.orderedVisibleProjectIds`, typed confirmation and conflict
  responses, `403 project_board_reorder_forbidden`, `503 board_contract_disabled`, and
  `503 board_schema_maintenance`;
- web confirmation: `submitStageMoveWithConfirmation` and canonical reason copy.

This is a **UI-only tracer bullet**. There is no Worker route, command, DB bundle, schema,
capability, Stage/order semantic, notification, or `@quincy/shared` change. There is **no D1
migration; next migration number stays `0038` for a later phase.** Discovering a required server or
shared-contract change is a red flag: stop that slice and return it to plan-tier review rather than
quietly expanding TB5B.

The installed dependency boundary is also closed. `portal/package.json` pins
`@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, and `@dnd-kit/utilities@3.2.2`; both existing
sortable surfaces use them. `@dnd-kit/accessibility` is transitive through core, while
`@dnd-kit/modifiers` is not a direct dependency. TB5B uses core's public `accessibility`,
`DragOverlay`, sensor, collision, measurement, and auto-scroll APIs and adds **no dependency**.
Do not run `npm install` and do not import a transitive package directly.

## Scope

### In scope

- Replace the Dashboard Board's native HTML5 drag engine with one dnd-kit `DndContext`.
- Dedicated drag handle; Pointer, Touch, and Keyboard sensors; multi-container sortable behavior;
  empty-column drops; `DragOverlay`; horizontal/nested auto-scroll.
- A position-aware **Move to…** non-drag action that can express every visible insertion gap the
  drag UI can express; retain Board-order ↑/↓ controls.
- One pure Board model for exact placement, transient proposals, confirmation hold/rollback,
  authoritative response reconciliation, and Quincy announcement copy.
- Optimistic Board updates with exact TB5A request/response handling and no stale auto-retry.
- Query/broadcast freshness hardening without weakening TB4E terminal purge.
- Rewrite native-drag DOM tests around the repository's `DndContext` handler-mock pattern; add
  Node-config pure logic tests and real-browser-only Agy evidence.
- Preserve direct/new-tab links, Priority and shoot-date views, TB4B Deadline/overdue metadata,
  no card RAW count, and List-only archived Dashboard.
- Record the reusable Calendar interaction policy for TB5C.

Expected implementation files:

- `portal/apps/web/src/screens/Dashboard.tsx` — query/accepted-snapshot ownership, mutation
  orchestration, priority handling, and composition of the new Board component;
- new `portal/apps/web/src/components/ProjectKanbanBoard.tsx` — `DndContext`, sensors, columns,
  sortable cards, overlay, handle, and Move-to UI;
- new `portal/apps/web/src/lib/kanban-interaction.ts` — pure order/placement/proposal/reconcile,
  confirmation-timing policy, focus descriptors, and announcement builders;
- `portal/apps/web/src/lib/dashboard-projects.ts` — query/broadcast integration and, if useful,
  relocation of `ProjectSummary` so a lib module no longer imports a screen;
- `portal/apps/web/src/lib/project-query-sync.ts` and its tests — one strict Board invalidation
  message on the existing channel, not a second channel/runtime;
- `portal/apps/web/src/lib/stage-move.ts` — additive lifecycle hooks and the web-only
  `confirmationPolicy` option needed to keep every endpoint path on the same safe
  confirmation/optimistic seam;
- `portal/apps/web/src/screens/ProjectWorkspace.tsx` and
  `portal/apps/web/src/components/ProjectOverviewRail.tsx` only for Board freshness publication,
  announcement, pending/focus parity; the rail's product shape remains a Stage select;
- `portal/apps/web/src/styles/app.css` — handle, overlay, drop indicator, touch target,
  responsive/autoscroll, focus, and reduced-motion styles;
- the three named Board test files, plus focused new lib/component/runtime tests;
- `docs/lessons.md` and `docs/todo.md` only in closeout after the implementation and evidence are
  true.

### Hard non-goals

- No Stage/order semantic, capability, notification, activity, audit, confirmation-reason, or
  endpoint change.
- No D1/schema/migration, Worker route, background Worker, webhook-ingress, or shared-package
  change.
- No generic task-card schema, duplicate comments, card detail surface, Calendar/FullCalendar,
  realtime presence, or prototype edit.
- No second production Kanban drag engine and no native HTML5 fallback. Every Board `draggable`,
  `DragEvent`, `dataTransfer`, and native anchor/wrapper drag/drop listener path is removed;
  dnd-kit's `DndContext` lifecycle callbacks are the intended replacement.
- No Priority or shoot-date persistence. They remain view-only comparators over the same fetched
  authorized snapshot.
- No External client-side fetch-and-filter and no manufactured hidden neighbours.
- No new feature flag or dependency.

## Current behavior that must survive

At baseline, `Dashboard.tsx` already has the correct TB5A ordering authority and refresh safety but
mixes them with native drag:

- `sortKanbanProjects` uses `authorizedBoardOrder`/authorized rank and never raw
  `boardPosition`; Priority sorts `1..10`, null last, then Board rank; shoot-date sorts are local.
- `cardDropPlacement` and `adjacentBoardPlacement` build exact neighbours from the authorized map
  and current neighbour revisions.
- `acceptedProjects` is the rendered server snapshot; query results wait behind
  `interactionBlocked`; `queuedRefreshRef` performs one post-interaction refetch; focus/scroll are
  captured and restored.
- `interactionBlocked` includes native `dragging`, active confirmation, pending Stage moves, and
  pending ordering.
- runtime removal/principal-terminal effects synchronously purge accepted data and win over a late
  response.
- `useDashboardProjects` keys by principal, role, authorization epoch, and archived scope, with
  15-second `staleTime`, visible 30-second poll, and focus/reconnect refetch. Its External branch
  strict-decodes the assigned-only DTO and maps the authorized order without raw position.
- the rail independently builds `{expected: {stageKey, boardRevision}, targetStageKey,
  placement:{kind:"append"}}` from detail and uses the same confirmation helper.

TB5B extracts and tightens these invariants. It must not replace the accepted-snapshot barrier with
dnd-kit's transient arrays or treat transformed DOM order as server authority.

## Interaction model

### One Board context and one rendering authority

`ProjectKanbanBoard` owns exactly one `DndContext` around all active Stage columns. Dashboard
passes the accepted/optimistic Board model, active role-safe Stages, capability booleans, sort mode,
pending state, and command callbacks.

For each Stage:

- render a `SortableContext` with `verticalListSortingStrategy`;
- derive its `items` from `sortKanbanProjects` over the current display model;
- in Board order, the current display model is the authorized map plus a transient proposal;
- in Priority/shoot-date views, the view comparator remains the display authority, while any
  command placement is still derived from the canonical authorized map;
- register the column body itself with `useDroppable`, so an empty column and the space below its
  last card are valid `append` targets.

`authorizedBoardOrder` remains the sole canonical order. dnd-kit transforms and transient arrays
are presentation state only. They never become wire state or survive a settled response/refetch.

### Sortable card and project link

Each card wrapper calls `useSortable`. `setNodeRef`, `transform`, and `transition` attach to
`.kcard-wrap`; only the dedicated handle receives `setActivatorNodeRef`, `attributes`, and
`listeners`.

Normative DOM rules:

- the existing `InternalLink.kcard` remains a normal anchor with its current route and browser
  open-in-new-tab behavior;
- a sibling button has accessible name `Move {street}` and a visible grip affordance;
- there is no `draggable` attribute on the anchor or wrapper and no navigation-suppression timer;
- the current `suppressNavigation` ref is removed. It is unnecessary because the activator is a
  sibling button, not the link; a real-browser test must prove this assumption before closeout;
- the handle is at least 44×44 CSS pixels on touch layouts and, because it is a native `<button>`,
  uses the real `disabled` attribute while the Board is unavailable or a movement is pending so
  it leaves the tab order; `aria-disabled` alone is insufficient;
- Priority, arrows, Move-to trigger, and cover retry remain buttons/selects outside the link.

### Sensors and activation constraints

Use the established house pattern with explicit constraints:

- `PointerSensor`: `activationConstraint: {distance: 8}`. A click or small pointer correction on
  the handle does not start a drag.
- `TouchSensor`: `activationConstraint: {delay: 250, tolerance: 8}`. Touch scroll/fling on the
  card/link/Board remains scrolling; a deliberate handle press-and-hold starts drag. Apply
  `touch-action` only to the handle, not the card or `.kanban` scroller.
- `KeyboardSensor`: `coordinateGetter: sortableKeyboardCoordinates`. Space picks up/drops, arrows
  traverse positions/columns, Escape cancels. If the pinned version fails the browser matrix across
  every rendered column (with at least five active), implement a Board-local coordinate getter over
  role-safe droppable rectangles; do not change shared semantics or add a drag package.
- `DndContext.accessibility.restoreFocus: false` is a required, asserted configuration. Quincy,
  not dnd-kit, owns focus restoration for every result and every input modality.

Disable all Board movement activators when the TB5A contract is off/under maintenance, when the
card lacks `moveProjectStage`, or while one Board movement/confirmation is pending. Same-Stage
destinations are accepted only when `prioritizeProjects` is present and Board-order view is active.
Cross-Stage movement remains available to Admin, internal Editor, and assigned External Editor in
all three view sorts.

### Collision and multi-container proposal

Use a Board-local collision function, not bare `closestCenter` over every rectangle:

1. prefer `pointerWithin` card/column hits for pointer/touch precision;
2. choose a card hit within the hit Stage before the enclosing column;
3. for keyboard/no pointer coordinates, fall back to `closestCorners`, restricted to eligible
   card/column droppables;
4. encode droppable data as `{kind:"card", stageKey, projectId}` or
   `{kind:"column", stageKey}`; never infer Stage from DOM ancestry;
5. reject the moving card itself and capability-invalid same-Stage targets;
6. resolve equal/near-equal candidates deterministically by Stage first and then the visual
   successor gap. Tune only through public dnd-kit/UI code and real-browser evidence.

`onDragStart` captures one immutable drag-start accepted snapshot: moving project state, canonical
authorized maps, visible card/revision lookup, source Stage/index, sort mode, focus origin, and
scroll position. `onDragOver` computes a **transient proposal** from that snapshot and renders the
insertion placeholder/transform across containers. It does not mutate TanStack Query, submit, or
change the accepted snapshot.

For a card target, record only the semantic gap `{targetStageKey, successor}`, where `successor` is
the visible project ID after the proposed insertion or `"end"`. In Priority and shoot-date views,
that successor is the successor of the selected **visual** gap—not the target-card edge interpreted
through canonical Board order. For a column body/empty column, use successor `"end"`. The proposal
contains no neighbour revision and is not a wire `StageMovePlacement`. A same-Stage proposal is
invalid unless Admin is in Board order.

`onDragEnd` freezes this revision-free semantic intent, clears dnd transform state, and hands it to
the Dashboard orchestrator. `onDragCancel` discards only the transient proposal. No request occurs.

### DragOverlay and auto-scroll

Render one `DragOverlay` as a sibling of `.kanban`, not inside its grid/overflow container, containing
an extracted presentational `KanbanCardPreview`. The preview is directly DOM-testable and has no
anchor, form controls, duplicate IDs, or accessibility focus; the source card remains in the DOM at
reduced opacity. Disable decorative drop animation under `prefers-reduced-motion`. Because the
overlay itself renders only during a real active drag, “overlay renders during drag” is browser
evidence, not a happy-dom claim. Slice 5 verifies the sibling mount remains outside transformed,
filtered, or `will-change` ancestors that could turn its fixed wrapper into a clipped containing
block.

Keep dnd-kit auto-scroll enabled and configure the public core API for both axes using pointer
activation, layout-shift compensation, and edge thresholds. The implementation must:

- treat `.kanban` (`overflow-x:auto`) as the horizontal scroll ancestor;
- retain page/nested vertical scrolling where an ancestor can actually scroll;
- avoid making the overlay itself a scroll container;
- remeasure droppables while dragging/after a scroll so card boundaries remain current;
- preserve manual wheel/trackpad scrolling and touch scrolling outside the handle;
- prove left/right edge auto-scroll in a real browser, including a tall column nested in the page.

Do not add `@dnd-kit/modifiers`. If the default/public `autoScroll` options cannot pass the real
browser matrix, keep the failure as an implementation blocker for plan-tier review; do not ship a
private/transitive import.

### Position-aware **Move to…** alternative

Replace the card's current `Move Stage…` select with a two-step button/dialog or disclosure
labelled `Move {street} to…`. It is a complete non-drag alternative, not merely an append shortcut:

- choose any active role-safe target Stage;
- after choosing the Stage, choose a position from a listbox with `End of {Stage}` first, followed
  by `Before {street} — position N` for each visible successor. “Before first” expresses top;
  “before a successor” expresses every middle gap; End expresses append. Exclude the mover.
- derive options only from the authorized map and visible project lookup. External Editor never
  receives or renders a hidden project option.
- when target equals source, expose position choices only to Admin in Board order; otherwise omit
  that target rather than relying on a server 403.
- pass only `{targetStageKey, successor}` to the orchestrator. At activation, it resolves exact
  neighbour revisions from the latest accepted authorized map; if the candidate has disappeared,
  abort locally, announce staleness, refetch, and return focus to the Move-to trigger.
- use the same command orchestrator, confirmation, optimistic/rollback, focus, and announcement
  policy as drag.

The existing ↑/↓ arrows remain in Board order for Admin and call the same orchestrator with the
revision-free successor gap computed by the pure adjacent-intent helper. They are retained as the
fastest keyboard-only same-Stage alternative.

### Quincy accessibility copy

Configure `DndContext.accessibility`; do not leave dnd-kit defaults.

Screen-reader instructions, exact copy:

> To pick up a project, focus its Move project handle and press Space. Use the arrow keys to move
> within or between Stages. Press Space again to drop, or Escape to cancel. You can also use Move
> to… without dragging.

The pure announcement builder supplies these exact templates (Stage labels, positions, and counts
come from the current role-safe proposal):

| Event | Exact template |
|---|---|
| Start | `Picked up {street}. Current Stage: {stageLabel}. Position {position} of {count}.` |
| Over card | `{street} is over {stageLabel}, position {position} of {count}.` |
| Over empty/end | `{street} is over the end of {stageLabel}, position {position} of {count}.` |
| Valid drop | `Dropped {street} in {stageLabel}, position {position} of {count}. Saving.` |
| dnd cancel | `Cancelled moving {street}. It remains in {sourceStageLabel}.` |
| Drop outside Board | `Cancelled moving {street}. It remains in {sourceStageLabel}.` |
| Drop on unchanged gap | `Cancelled moving {street}. It remains in {sourceStageLabel}.` |
| Invalid same-Stage keyboard destination | `Cancelled moving {street}. It remains in {sourceStageLabel}.` |
| Locally stale Move-to option | `That position changed. Reloading the latest Board; no move was made.` |
| Confirmation required | `Move needs confirmation. {street} remains in {sourceStageLabel}.` |
| Modal cancel | `Stage move cancelled. {street} remains in {sourceStageLabel}.` |
| Cross-Stage success | `Moved {street} to {stageLabel}, position {position} of {count}.` |
| Same-Stage success | `Reordered {street} in {stageLabel}, position {position} of {count}.` |
| Authoritative no change (`changed:false`) | `{street} is already in {stageLabel}, position {position} of {count}.` |
| Post-success refetch failure | `The move was saved, but the latest Board could not be loaded. Refresh to continue.` |
| Conflict | `Could not move {street} because the Board changed elsewhere. Reloading the latest Board; no retry was made.` |
| Contract off | `Board interactions are temporarily unavailable while the Board contract is disabled.` |
| Maintenance | `Board interactions are temporarily unavailable while the Board is being updated.` |

dnd-kit's internal live region owns start/over/drop/cancel; the existing Dashboard polite, atomic region owns confirmation, authoritative success, conflict, 503, and Move-to/arrow results. **Every string in both regions is produced by the one pure announcement builder in `kanban-interaction.ts`, which takes the runtime terminal/purge state as an input and returns `undefined` when the principal or project is terminal.** `@dnd-kit/core`'s announcer discards `undefined` (`@dnd-kit/accessibility` `useAnnouncement`), so this is the only mechanism that prevents dnd-kit announcing a private street/Stage after a TB4E purge — the Dashboard's late-response terminal guard does not reach dnd-kit's synchronous `onDragCancel` announcement path.

**Politeness note:** dnd-kit's region is `aria-live="assertive"` by default and offers no politeness option; the Dashboard region is `polite`. The real VoiceOver/NVDA pass must specifically check that the assertive `…Saving.` does not pre-empt or truncate the polite settled/conflict result. **Approved fallback if cadence fails:** return `undefined` from dnd-kit's `onDragEnd` announcement and let the Dashboard's polite region own both drop and settle. This is a configuration change only; it introduces no new region and no dependency.

Do not announce every pointer pixel: `onDragOver` announces only when the semantic Stage/gap
changes. A drop outside every Board droppable, a drop on the unchanged gap, or an invalid same-Stage
keyboard destination behaves exactly as cancellation: zero request, cancellation copy, and no
`Saving` announcement. For all settled templates, `{position} of {count}` means the moving card's
position in the currently displayed, sorted column after settle—not its position in the canonical
map. Announcement tests cover Board, Priority, and shoot-date views, including `changed:false` in a
Priority view whose requested visual gap is already the canonical slot.

### Deterministic focus

Capture a stable focus descriptor before any proposal: `{path, projectId, control, sourceStageKey,
sourceIndex}` where control is `handle | move-to | arrow-up | arrow-down | rail-stage`.

- dnd cancel and modal cancel: return to the initiating control on the source card.
- outside/unchanged/invalid drag drop: return to the initiating handle on the source card; this is
  cancellation with zero request.
- a locally stale Move-to activation: refetch and return focus to its Move-to trigger.
- successful drag/Move-to/arrow: focus the same control on the moved card in its settled Stage;
  fallback to that Stage heading, then the Board region if filtering removed the card.
- conflict/network/503: after authoritative rollback/refetch, focus the initiating control on the
  current card; fallback to source Stage heading, then Board.
- confirmation open: `DndContext.accessibility.restoreFocus` is set to **`false`** and Quincy owns focus for every outcome and every input modality. `@dnd-kit/core@6.3.1` restores focus only for keyboard-initiated drags, inside a `requestAnimationFrame` that runs *after* React commit (`core.esm.js:2689–2745`) — leaving it enabled would pull focus out of the Quincy confirmation modal one frame after it opens, and would retain a DOM node ref across an authoritative replacement. The Quincy modal takes focus under its existing trap; accept/cancel then follows the rules above.
- rail: return to the rail Stage select on success, cancel, conflict, or 503; if access loss
  unmounts it, focus nothing private and let the terminal route own navigation/focus.
- refetch failure after a successful mutation: retain the success-settled focus target if still
  present, otherwise use the settled Stage heading/Board fallback; keep movement disabled and
  expose the visible refresh/error state until an authoritative refetch succeeds.

Use `data-focus-key` for stable restoration and preserve the existing scroll capture. Never retain
a DOM node ref across an authoritative replacement.

The previously underspecified outcomes are normative in both focus and announcement behavior:

| Outcome | Focus after handling | Announcement / request rule |
|---|---|---|
| Drop outside every Board droppable | initiating source handle | cancellation copy; zero request; never `Saving` |
| Drop on the unchanged semantic gap | initiating source handle | cancellation copy; zero request; never `Saving` |
| Locally stale Move-to option at activation | Move-to trigger after refetch | stale-position copy; zero request |
| Invalid same-Stage keyboard destination for Editor/External | initiating source handle | cancellation copy; zero request; never `Saving` |
| Authoritative refetch fails after a successful mutation | settled control if present, then settled Stage heading/Board fallback | saved-but-refresh-failed copy; keep movement disabled until recovery refetch |

## Command wiring

### One web orchestrator

Move the successors of `cardDropPlacement`, `adjacentBoardPlacement`, and insertion-index logic
into `kanban-interaction.ts`. Its pure command boundary exposes semantic-gap-to-request resolution
against a supplied authorized Stage map plus project/revision lookup. Add one Dashboard command
orchestrator that accepts only revision-free intent:

```text
{
  projectId,
  gap: { targetStageKey, successor: visibleProjectId | "end" },
  origin,
  proposedBoard,
  focusDescriptor
}
```

At activation, it resolves that semantic gap against the **latest accepted authorized map** and
re-reads the moving project and exact neighbouring project revisions. Only then does it build and
freeze the complete request:

```text
{
  expected: { stageKey: project.stageKey, boardRevision: project.boardRevision },
  targetStageKey: gap.targetStageKey,
  placement: exactPlacementResolvedFromGap,
}
```

If the mover, successor, or a required neighbour/revision is absent, the resolver returns a local
stale/invalid result, sends no request, and refetches. This makes request construction atomic with
the accepted snapshot rather than accepting a `between` placement whose revisions were captured
earlier. Priority/shoot-date drag and Move-to both name the selected **visual successor**, so they
produce identical commands for the same visible gap.

All Board movement requests, including same-Stage arrows, pass through
`submitStageMoveWithConfirmation`. Add the web-only option
`confirmationPolicy?: "stage-move" | "forbidden"`, defaulting to `"stage-move"` to preserve every
existing caller. Every `/board-position` path—same-Stage drag and arrows—passes `"forbidden"`; an
unexpected `stage_confirmation_required` response is rethrown with no modal and no retry. Every
`/stage` path passes `"stage-move"`. On a valid confirmation, the retry re-sends the frozen request
byte-for-byte except for adding `confirmation.reasons`; no current state or neighbour revisions are
re-read between attempts. Tests pin an invalid same-Stage confirmation to one POST, no modal, and
no retry. The `/board-position` 403 response has no `code`; match the exact “Manual Board reorder
requires Priority access” copy when `capability === "prioritizeProjects"` as well as on the shipped
`project_board_reorder_forbidden` code from `/stage`. This option stays in `apps/web`; there is no
`@quincy/shared` change.

The Workspace rail continues to use detail's independent `stageKey`/`boardRevision`, append
placement, `/stage`, and `confirmationPolicy: "stage-move"`. It publishes Board freshness after a
winner in Slice 6.

### Confirmation and optimistic timing

The server remains the sole confirmation authority. The web-only display classifier decides only
whether optimism is safe to show before the first response:

- same-Stage reorder may apply the proposed optimistic overlay immediately before submit;
- for cross-Stage movement, pre-response optimism is permitted **only** when both role-safe
  transport keys normalize successfully to canonical keys and the exported canonical
  `stageMoveConfirmationReasons(from, to)` classifier returns `[]`;
- any normalization/mapping uncertainty, or any non-empty classifier result, keeps the accepted
  source position while the first request obtains the server's exact reasons;
- on `stage_confirmation_required`, any premature overlay is synchronously rolled back before the
  modal opens and the confirmation-required announcement fires;
- after the user accepts, apply the optimistic proposal immediately before the confirmed request;
- cancel sends no second request and performs no optimistic mutation;
- the UI never sends classifier-produced reasons. Only server-returned reasons enter the confirmed
  retry. This classifier controls display timing, not authorization; uncertainty defers optimism
  and cannot weaken the TB5A command.

`submitStageMoveWithConfirmation` may gain lifecycle callbacks such as
`onConfirmationRequired` and `beforeConfirmedSubmit`; it must preserve existing callers and exact
reason validation. Do not duplicate the server reason list or alter `@quincy/shared`.

### Path matrix

| Path | Revision-free gap source | Request resolution | Endpoint/policy | Optimistic apply | Rollback trigger |
|---|---|---|---|---|---|
| Pointer drag | droppable Stage + selected visual successor/`end` | latest authorized map + revision lookup builds expected/exact neighbours | cross `/stage` + `stage-move`; same `/board-position` + `forbidden` | on drop if confirmation-safe; otherwise after confirmation accept | confirmation-required before modal; 409; 403; 503; network/error; terminal purge |
| Touch drag | same semantic gap as pointer | same resolver | same authoritative route/policy | same | same |
| Keyboard drag | keyboard-selected Stage + visual successor/`end`; never geometry-derived Stage strings | same resolver | same authoritative route/policy | same | same |
| **Move to…** | selected role-safe Stage + listbox successor/`end` | same resolver at activation, never dialog-open revisions | same authoritative route/policy | on action if confirmation-safe; otherwise after accept | stale local option; confirmation-required; 409/403/503/error/purge |
| ↑/↓ arrows | pure adjacent helper returns current Stage + successor/`end` | same resolver | `/board-position` + `forbidden` | immediately before submit | unexpected confirmation; 409/403/503/error/purge |
| Workspace rail | selected active role-safe Stage + `end` | detail expected state + append | `/stage` + `stage-move` | optimistic detail Stage only when confirmation-safe; otherwise after accept | confirmation-required; 409/503/error/access-loss purge |

Priority changes remain on `/priority`; they are not Stage/order movement and do not enter this
matrix. A pure Board-position winner continues to emit no broad notification because TB5A's server
command owns that rule; TB5B adds no UI fan-out or notification call.

### Optimistic model and authoritative settle

**Single-writer rule.** The rendered Board model is `acceptedProjects`, and it has exactly two writers: `acceptDashboardProjects` (server data only) and the Board orchestrator's optimistic overlay / rollback / authoritative-response reconcile. **No Board movement path may write `queryClient.setQueryData` on `dashboardProjectsKey`.** The baseline's `updateProjects` helper (`Dashboard.tsx:296`) is retired for all Stage/position movement, because a `setQueryData` write bumps `dataUpdatedAt` and can be accepted by the accept effect (`Dashboard.tsx:327–335`) as if it were a server snapshot — laundering unconfirmed optimistic state into the accepted snapshot with no rollback baseline. Slice 3 adds a test asserting that a pending movement produces zero `setQueryData` calls on the Dashboard key and that the TanStack cache still holds the pre-move server snapshot while the optimistic overlay is rendered.

The `kanban-interaction.ts` / Dashboard orchestrator contract makes that ownership executable: the
optimistic Board overlay lives only in component state layered over `acceptedProjects`, never in
the query cache. Priority deliberately keeps its existing `updateProjects`/`setQueryData` path:
Priority is not Board movement, has its own pending set, and always calls `queueDashboardRefresh`,
so it cannot share the Board movement rollback ledger or be accepted as one of its overlays.

Allow only one Stage/position movement command per Dashboard at a time. Disable every movement
activator while it or its confirmation is pending. This bounds the rollback snapshot and prevents
two local proposals from manufacturing stale neighbour premises. Priority may retain its existing
separate pending path, but any pending Priority change keeps `interactionBlocked` true.

The optimistic model is an overlay over the accepted snapshot, not a write to raw
`boardPosition`:

1. remove the moving ID from its source authorized array;
2. insert it into the target authorized array at the proposed visible gap;
3. change only that card's role-safe `stageKey`; keep the request's old revision until success;
4. attach the updated authorized map consistently to every rendered summary;
5. retain the complete accepted baseline for rollback.

On success, reconcile from `MoveProjectStageResponse`:

- set the moving project's returned `stageKey` and `boardRevision`;
- branch on `changed`: `changed:false` applies the authoritative response without claiming a move or
  reorder and uses the exact no-change announcement template;
- replace the response **target** Stage's visible array with authoritative
  `board.orderedVisibleProjectIds` (same-Stage response replaces that one array);
- for a cross-Stage response, baseline-minus-mover may render the source array only as a
  **provisional** projection. The mover's expected-state fence does not prove that source siblings
  or their revisions stayed unchanged, and the response intentionally returns no authoritative
  source array;
- never infer order from transforms, `boardPosition`, Priority, or IDs;
- respect the server's priority-first canonical comparison (`priority === null`, then
  `boardPosition`, then ID). In a mixed-priority column, a visual-gap optimistic overlay may snap
  to a different settled displayed position when the authoritative response arrives; the response
  wins and the final announcement uses that displayed settled position/count;
- set `movementSettlePending`, invalidate/refetch Dashboard and detail narrowly,
  and enable no further command until a successful Dashboard refetch supplies the full source
  projection plus fresh sibling revisions;
- if that post-success refetch fails, show the visible refresh/error state, keep every movement
  control disabled, and do not build another command from provisional source premises. A later
  successful authoritative refetch is explicitly detected and accepted, clears
  `movementSettlePending`, and settles focus/announcement state.

On `409 project_stage_conflict`, synchronously restore the accepted baseline, apply no `current`
patch as if it were a complete Board response, announce no-retry conflict, and perform one
authoritative Board refetch. `current` may update a rail/detail presentation while refetching, but
it cannot authoritatively reconstruct source/target order. No conflict path resubmits.

On `503 board_contract_disabled` or `board_schema_maintenance`, restore baseline, retain the
existing exact unavailable copy, set the persistent-in-view mutation-disabled reason, and refetch.
The TB5A flag-off/pre-0037 states render ordinary cards/list data but no drag handle, arrows, or
Move-to mutation controls. An unexpected 403/error also restores and refetches; server
authorization remains final. The shipped 409 codes `project_archived_read_only`,
`inactive_destination`, and `stage_contract_reload_required` use the generic error branch: full
baseline rollback and exactly one refetch, with no retry. Tests pin all three, including a genuinely
reachable `inactive_destination` case.

The regression for this boundary must allow source siblings to reorder concurrently without
changing the mover's revision, then let the mover's `/stage` request win. The returned target array
settles authoritatively, the source stays explicitly provisional, and no second movement command is
enabled until the full Dashboard refetch settles successfully. This is a UI-only reconciliation;
it does not justify a server or shared response change.

## Freshness and conflict safety

### Ruled: Board query sort-key — Option A (Opus plan-tier ruling, 2026-08-29)

The scope owner delegated this to Opus plan-tier review, which **ruled Option A**. This section is now normative, not open.

**How the brief's "keyed by authorization scope/sort" clause is satisfied.** The clause is met by a **two-layer identity**, both layers mandatory:

- **Network identity (authorization scope only):** `["dashboard-projects", principalId, role, authorizationEpoch, {archived}]`, unchanged from the baseline. `GET /api/projects` reads no sort input (`workers/app/src/routes/projects.ts:341–372`), so sort cannot change a single byte of the response or of `orderedProjectIdsByStage`.
- **Derived interaction identity (authorization scope AND sort):** `{dashboardQueryKey, effectiveKanbanSort}`. This is the Board's rendering/interaction key. It gates and rebuilds, on every change: memoized per-Stage display arrays, `SortableContext` `items`, droppable data, the drag-start snapshot, Move-to position options, and the announcement position/count basis. Sort selection stays disabled while `interactionBlocked` is true.

The brief's sort clause is therefore **satisfied at the derived layer**, which is the only layer where sort has semantic content. Putting sort in the network key would be a defect, not a stricter reading: it fragments the authorized snapshot across caches whose non-current entries retain pre-move state and are served instantly on a sort switch, directly violating the brief's Acceptance clause "conflicts never overwrite newer state"; it blanks the Board on every sort switch because both `acceptedProjects.key` and the query key miss simultaneously (`Dashboard.tsx:286`); and it silently voids the existing `exact: true` Dashboard invalidations in `Dashboard-stage-interactions.dom.test.tsx:146,163`, turning a real freshness regression test into a no-op.

**Ruling boundary.** This ruling is scoped to the fact that sort is a pure client view. If a future phase makes sort a server request input, sort necessarily enters the network key and this ruling is superseded without further review.

**Slice 6 obligation.** Add an explicit assertion that `dashboardProjectsKey` remains a five-element tuple and that changing `effectiveKanbanSort` triggers zero network fetches while fully rebuilding the derived interaction identity.

### Cross-tab Board freshness

Extend the existing `quincy:project-data:v1` `BroadcastChannel` runtime with one strict message,
exactly:

```text
{version:1, type:"dashboard-board-invalidated", sourceTabId, committedAt}
```

Rules:

- publish only after a successful Stage/reorder winner from Dashboard or Workspace rail;
- the Board message is deliberately ID-free: do not put project ID, Stage, order arrays, revisions,
  role, or any project/metadata identifier in it. A detail query that legitimately needs a project
  ID cross-tab uses the existing project-resource message separately; do not fold that ID into the
  Board message;
- receiver validates exact keys, ignores its own `sourceTabId`, never rebroadcasts, and invalidates
  active `dashboard-projects` queries already scoped to that tab's own principal/role/epoch;
- same-tab caller also invalidates its own exact Dashboard/detail resources because
  `BroadcastChannel` deliberately ignores self;
- unsupported/failed `BroadcastChannel` falls back to existing focus/reconnect/30-second poll;
- no localStorage bus and no second BroadcastChannel runtime.

`project-query-sync.test.ts` must prove strict parsing, malformed/extra-key rejection, self-ignore,
no rebroadcast, active Dashboard invalidation, and that the receiving key remains the receiver's
authorization scope. Add a mixed Admin/External (including impersonated runtime) test that asserts
the serialized Board message contains no project or metadata identifier and each receiver
invalidates only its own active `dashboard-projects` scope.

### Active-interaction reconciliation

Extend `interactionBlocked` to include:

- a dnd-kit active ID or transient proposal;
- open Move-to UI only once a concrete proposal/confirmation is being held (an idle disclosure
  alone need not block polling);
- the global active Quincy confirmation modal;
- pending Stage/reorder mutation;
- pending Priority mutation.

**Two orthogonal gates. They must never be merged.**

- **`interactionBlocked` — the *accept* gate.** Defers replacing `acceptedProjects` with incoming query data. Members: active dnd id/transient proposal, held Move-to proposal/confirmation, active confirmation modal, pending Stage/reorder mutation, pending Priority mutation. It clears as soon as the last of those clears, including immediately after a cross-Stage success.
- **`movementSettlePending` — the *command* gate.** Disables every movement activator (handle, keyboard drag, Move-to, arrows, rail) and is set on cross-Stage success until an authoritative Dashboard refetch is **accepted**. It is **not** a member of `interactionBlocked`, and it must never gate `queuedRefreshRef`, the queued-refetch effect, or `acceptDashboardProjects`. The settle refetch is precisely the thing that clears it, so blocking acceptance on it is a self-deadlock.

Sequence after a cross-Stage winner: apply the response target array to the accepted snapshot → clear `interactionBlocked` → run exactly one settle refetch → **accept** it (unblocked) → clear `movementSettlePending`. A failed settle refetch keeps `movementSettlePending` set and surfaces the recovery copy; a later successful refetch clears it.

While blocked, `acceptedProjects` remains rendered and every query replacement—including
focus/reconnect/poll/broadcast—sets `queuedRefreshRef` without replacing the Board. On drag cancel,
modal cancel, success, conflict, or error, perform exactly one queued refetch after the last block
clears, then accept only if the runtime is still non-terminal. After cross-Stage success,
`interactionBlocked` clears immediately but `movementSettlePending` remains set through the required
authoritative Dashboard refetch because its source projection is provisional. A failed settle
refetch preserves `movementSettlePending` and the visible refresh/error state.

TB4E purge has absolute precedence:

- `principalTerminal`, project removal, 401, or 403 clears inaccessible accepted data immediately,
  even during drag/modal/pending mutation;
- clear transient proposal, overlay, focus descriptor, and queued refresh when terminal;
- late mutation/query results check the terminal generation/runtime before applying, focusing,
  announcing private names, or restoring snapshots;
- never restore a pre-purge rollback baseline.

Required exact regression scenarios:

1. **Defers background replacement during dnd drag.** Start drag on “Source Street”; resolve a
   focus/poll query containing “Fresh Street”; accepted DOM remains Source.
2. **Refetches once after interaction.** Cancel/drop; exactly one post-block fetch runs; Fresh is
   accepted; source handle/fallback focus and scroll are restored.
3. **Modal and pending mutation also defer.** Repeat with confirmation open and with unresolved
   POST; no replacement occurs until each last block clears.
4. **Broadcast uses the `interactionBlocked` accept gate.** A second runtime/tab publishes Board invalidation during
   drag; no accepted replacement occurs until release; receiver never rebroadcasts.
5. **Terminal purge wins.** Mark principal/project terminal while a query and Stage POST are late;
   Board empties immediately and neither response restores cards or announces private data, and
   assert the dnd-kit live region emits no project street or Stage label after the purge.
6. **409 rollback/no retry.** Apply an optimistic proposal, reject with conflict, prove baseline
   restoration then authoritative refetch, one POST total, and exact conflict announcement.
7. **503 disables mutation.** Both TB5A codes restore baseline, show their exact unavailable copy,
   and remove/disable every movement activator while Priority metadata behavior remains as shipped.
8. **Cross-Stage source race stays blocked.** Reorder source siblings concurrently without
   changing the mover revision, let `/stage` win, accept the response target array, mark
   baseline-minus-mover source provisional, and enable no second command until the full Dashboard
   refetch supplies source order and fresh sibling revisions. A failed refetch keeps movement
   disabled with visible recovery copy.
9. **ID-free mixed-scope Board broadcast.** Send a Board invalidation between Admin and
   impersonated/External runtimes; the wire message contains no project/metadata identifier, never
   rebroadcasts, and each receiver invalidates only its own active authorization-scoped Dashboard
   query.
10. **Provisional-source barrier releases.** After the scenario-8 cross-Stage winner, the settle refetch succeeds; assert `acceptedProjects` is replaced with the full server projection, every movement activator is re-enabled, and no further fetch is queued. Then repeat with the settle refetch failing once and the retry succeeding; assert the Board is never left with movement permanently disabled.

## Accessibility acceptance checklist

The build is not accepted until automated coverage plus the real-browser matrix prove:

- [ ] The project link and dedicated drag handle are separate focusable elements; anchor click,
      Cmd/Ctrl-click, middle-click, and context-menu/new-tab behavior do not start drag.
- [ ] Every enabled handle has accessible name `Move {street}`, visible focus, and at least a 44×44
      touch target on phone.
- [ ] Every unavailable native-button handle has the real `disabled` attribute, leaves the tab
      order, and cannot activate; `aria-disabled` alone is not accepted.
- [ ] Pointer, touch, and keyboard drag share one proposal/command path; no native drag attribute,
      listener, `DragEvent`, or `dataTransfer` remains.
- [ ] Keyboard-only Space/arrow/Space moves across Stages; Space/arrow/Space reorders within a
      Stage for Admin Board order; Escape cancels with no request.
- [ ] Internal and External Editors can keyboard-drag across Stages but cannot produce a same-Stage
      reorder request.
- [ ] **Move to…** expresses top/middle/end visible gaps without drag and exposes no hidden External
      project.
- [ ] ↑/↓ remain available only for Admin Board order and use the same exact command.
- [ ] Workspace rail remains keyboard operable and command-identical.
- [ ] Focus returns according to the deterministic table for success, dnd cancel, modal cancel,
      conflict, 503, and rail; access loss does not refocus private DOM.
- [ ] The exact start/over/drop/cancel/confirmation/success/conflict/503 strings above are emitted;
      over announcements deduplicate unchanged semantic gaps; both announcement paths suppress all
      street/Stage copy when terminal/purge state is active.
- [ ] `accessibility.restoreFocus` is asserted `false`; keyboard drag into required confirmation
      leaves focus inside the modal for at least two animation frames.
- [ ] `changed:false` uses the no-change template, and `{position} of {count}` reflects the settled
      displayed/sorted column in every view mode.
- [ ] DragOverlay is non-interactive and absent from the accessibility tree as a duplicate card.
- [ ] Horizontal and nested auto-scroll work without blocking ordinary trackpad/wheel/touch scroll.
- [ ] `prefers-reduced-motion` removes meaningful drag/drop animation while preserving state/focus.
- [ ] At 200% zoom and narrow phone layout, handle, link, Move-to, and card controls remain reachable
      with no pointer-only operation.

## Calendar interaction convention handoff

Name the reusable policy **Quincy Guarded Direct Manipulation Policy**. Document it in
`portal/apps/web/src/lib/kanban-interaction.ts` and this plan as eight engine-neutral rules:

1. explicit source capability and authorized projection;
2. immutable interaction-start snapshot plus optimistic proposal;
3. guarded authoritative domain mutation using the source's concurrency token;
4. stale rollback to authoritative state with no automatic retry;
5. defer/reconcile incoming refresh while manipulation/confirmation/mutation is active, with
   access-loss purge taking precedence;
6. keyboard manipulation and a complete non-drag action;
7. deterministic focus restoration and start/proposal/drop/cancel/conflict announcements;
8. **confirmation-gated optimism** — never render an optimistic proposal before a required
   confirmation resolves; if the server demands confirmation, roll the proposal back synchronously
   before the modal opens; never send client-classified reasons.

The code module exports pure Board-specific helpers and a documented policy type/vocabulary only;
it does not export dnd-kit sensors, collision geometry, React components, or a generic drag engine.
TB5C adopts the policy in its FullCalendar event/resize and Move/Reschedule flows, while
FullCalendar owns Calendar geometry. If a future implementation wants a reusable engine, that is a
new reviewed scope.

## Slice plan

Every slice is independently green. From `portal/`, run the complete §5 gate after each slice—the
root workspace script silently skips `packages/shared`, while `apps/web`'s own `test` script already
chains Node-config `*.test.ts` and happy-dom `*.dom.test.tsx` suites.

### Slice 0 — freeze characterization and inventory

Files:

- the existing three Board tests only: `Dashboard-stage-interactions.dom.test.tsx`,
  `Dashboard-kanban-sort.dom.test.tsx`, and `Dashboard-board-order.characterization.test.ts`;
- optionally a no-production-code test fixture/helper local to those tests.

Work and tests:

- characterize authorized Board/Priority/shoot sorting, exact card/arrow neighbours, append,
  External authorized order, Deadline/no-RAW markup, direct/new-tab anchor, flag-off controls,
  current confirmation cancel/no-second-request, focus/scroll restoration, and the exact
  drag/modal/pending/terminal freshness test;
- inventory and assert every native Board drag surface to remove:
  `DragEvent`, `draggable`, `onDragStart`, `onDragEnd`, `onDragOver`, `onDragLeave`, `onDrop`, and
  `dataTransfer` in `Dashboard.tsx`/card markup;
- any native-drag inventory assertion added here must live only in those three Board test files,
  all of which Slice 2's fence explicitly permits editing;
- record that existing native synthetic drag tests are characterization only and will be rewritten,
  not preserved as proof of dnd sensors.

What stays working: production code is unchanged.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: characterization is green at the baseline and fails if authorized order, capability
split, Deadline/no-RAW, confirmation cancellation, or refresh/purge behavior drifts.

### Slice 1 — pure Board interaction model

Files:

- new `apps/web/src/lib/kanban-interaction.ts`;
- new `apps/web/src/lib/kanban-interaction.test.ts` (Node config);
- `Dashboard.tsx`/`dashboard-projects.ts` only to relocate types/helpers without behavior change;
- update characterization imports.

Work and tests:

- extract sort, exact neighbour, adjacent, insertion-index, eligible-target, proposal apply,
  accepted-baseline rollback, authoritative response reconcile, focus descriptor/fallback, and
  announcement builders;
- model card/column droppable data and empty-column append without importing React/dnd-kit;
- prove first/middle/last, same/cross Stage, hidden-safe authorized projection, missing/stale
  neighbour, semantic visual-successor gaps in every view sort, activation-time gap-to-request
  resolution, authoritative response target replacement/baseline-minus-mover provisional source
  projection, 409 rollback, all `changed:false` announcement branches, exact copy, and announcement
  deduplication;
- pin canonical priority-first order (`priority === null`, then `boardPosition`, then ID) and
  an optimistic-vs-authoritative settled-position divergence in a mixed-priority column, including
  the visible snap to the server response;
- document the Quincy Guarded Direct Manipulation Policy in the module.

What stays working: Dashboard still uses native drag and current markup; helpers are behavior-
preserving successors.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: Node tests can prove all command placement/reconcile/announcement behavior without DOM
geometry or dnd events, and characterization remains byte-equivalent where intended.

### Slice 2 — dnd-kit Board, handle, overlay, cross-Stage path

This slice is independently green but **not a deploy boundary**: it temporarily withdraws Admin
same-Stage drag reorder until Slice 3, while the existing arrow alternative remains available.

Files:

- new `apps/web/src/components/ProjectKanbanBoard.tsx`;
- `Dashboard.tsx`, `app.css`;
- `Dashboard-stage-interactions.dom.test.tsx`, `Dashboard-kanban-sort.dom.test.tsx`, and
  `Dashboard-board-order.characterization.test.ts`, plus a focused Board component DOM test.
  `Dashboard-kanban-sort.dom.test.tsx` line 88's `draggable === "false"` flag-off assertion is a
  native-drag characterization and must be rewritten in this slice to assert the flag-off state
  through the disabled handle button—the `draggable` attribute no longer exists.

Work and tests:

- introduce one Board `DndContext`, PointerSensor distance 8, per-column `SortableContext`, custom
  collision data/strategy, empty-column droppable, `useSortable`, dedicated handle, and
  `DragOverlay` mounted as a sibling of `.kanban`; extract and directly DOM-test the non-interactive
  `KanbanCardPreview`, while leaving active-drag overlay rendering to browser evidence;
- use transient cross-container proposal in `onDragOver`; commit cross-Stage only in `onDragEnd`;
- remove **all** native Board drag attributes/listeners/types/dataTransfer and the navigation-
  suppression timer in this slice—there is never a two-engine intermediate production path;
- keep same-Stage dnd rejected for now; arrows remain the existing route;
- use a hoisted `@dnd-kit/core` `DndContext` mock patterned after
  `CollectionPanel.dom.test.tsx` to capture/invoke start/over/end/cancel handlers and verify command
  wiring; assert the `DndContext` receives `accessibility.restoreFocus === false`. Do not claim this
  tests sensors.
- before accepting this slice, run an Agy focused real-Chrome check for pointer-handle versus
  ordinary anchor click, Cmd/Ctrl-click, middle-click, and context-menu/new-tab behavior. Removing
  the navigation-suppression timer is not accepted on happy-dom evidence alone.

What stays working: List/archived views, card anchors, Priority/shoot sorts, arrows, current Move
Stage control, Deadline/no-RAW, flag-off, and the `interactionBlocked` query-accept gate.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: synthetic DndContext end events create exact cross-Stage `between`/`append` requests;
empty columns work; the focused Agy pointer-vs-link proof is recorded; repository search finds zero
native Board drag path; `Dashboard-kanban-sort.dom.test.tsx` contains no `draggable` assertion.

### Slice 3 — Admin same-Stage reorder and authoritative optimism

Files:

- `ProjectKanbanBoard.tsx`, `Dashboard.tsx`, `kanban-interaction.ts`, `stage-move.ts` if the unified
  wrapper belongs there;
- Board Node/DOM tests and `Dashboard-board-order.characterization.test.ts`.

Work and tests:

- enable same-Stage dnd only for `prioritizeProjects` in Board order;
- route it exclusively to `/board-position`, still through the common submit seam;
- preserve ↑/↓ and move them to the same orchestrator;
- add one bounded optimistic overlay/baseline ledger and authoritative
  `orderedVisibleProjectIds` target reconciliation plus provisional cross-Stage source handling;
- assert a pending movement produces zero `setQueryData` calls on `dashboardProjectsKey`, the
  TanStack cache retains its pre-move server snapshot, and the component-state overlay alone renders
  the optimistic result;
- add `confirmationPolicy`; prove every `/board-position` path passes `forbidden`, and an invalid
  confirmation response causes one POST, no modal, and no retry;
- restore baseline/refetch on 409/403/503/error; never retry; pin generic rollback + one-refetch
  handling for `project_archived_read_only`, a reachable `inactive_destination`, and
  `stage_contract_reload_required`; pin `/board-position` 403 copy selection on
  `capability === "prioritizeProjects"`; keep pure reorder notification-free;
- add an explicit failed settle-refetch branch that sets recovery copy and retains
  `movementSettlePending`; today's silent `!result.data` return is not sufficient;
- disable all movement controls while the one Board movement command is pending.

What stays working: Editors/External can still cross Stage but cannot same-Stage reorder; Priority
and view sorts remain non-writing; arrows remain visible only in Board order.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: Admin drag and arrows send byte-equivalent exact requests to `/board-position`; Editor
and External produce zero same-Stage request; optimistic DOM precedes unresolved POST, then server
order wins or baseline rolls back with one refetch/no retry. Cross-Stage success clears
`interactionBlocked` but keeps `movementSettlePending` through the authoritative refetch; success
accepts the full snapshot and releases the command gate, while failure leaves visible recovery
state and movement disabled.

### Slice 4 — keyboard drag, complete Move-to, announcements, confirmation, focus

Files:

- `ProjectKanbanBoard.tsx`, `Dashboard.tsx`, `kanban-interaction.ts`, `stage-move.ts`,
  `ProjectWorkspace.tsx`, `ProjectOverviewRail.tsx`, `app.css`;
- Board DOM/Node tests and focused Workspace rail tests.

Work and tests:

- add KeyboardSensor with `sortableKeyboardCoordinates` and exact Quincy instructions/
  announcements;
- replace the append-only card select with position-aware **Move to…**;
- implement confirmation-safe optimistic timing and helper lifecycle hooks;
- add stable origin-specific focus descriptors/fallbacks and scroll preservation;
- bring rail announcement/focus/optimistic timing onto the same policy without changing its
  append-only Stage product behavior; add `data-focus-key` to the Stage select at
  `ProjectOverviewRail.tsx:35`; rail Board broadcast is intentionally deferred to Slice 6;
- strictly test exact copy, deduped over announcements, modal accept/cancel, no request on dnd
  cancel/outside/unchanged/invalid destination, no second request on modal cancel, real disabled
  handle tab-order behavior, stale Move-to refetch/focus, post-success refetch failure, and focus for
  every origin/result; DOM tests assert the `DndContext` receives
  `accessibility.restoreFocus === false`;
- before accepting this slice, run Agy focused real-Chrome keyboard proof across every rendered
  column with at least five active, including off-screen columns, same-Stage capability rejection,
  focus, and announcements. Include keyboard drag → confirmation-required → focus remains inside
  the modal for at least two animation frames. If `sortableKeyboardCoordinates` fails, use the
  approved Board-local coordinate getter and rerun the same proof.

What stays working: all earlier pointer behavior, arrows, direct links, role-safe Stage vocabulary,
and TB5A cumulative server confirmation reasons.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: DndContext-mock keyboard-equivalent events and non-drag actions reach identical
requests; confirmation-required cards remain at source until accept; exact focus and announcement
checks pass for success/cancel/conflict/503/rail; `restoreFocus:false` is asserted; recorded real
keyboard sensor evidence proves multi-container and off-screen traversal plus modal focus retention
for at least two animation frames.

### Slice 5 — touch, horizontal/nested scroll, responsive and motion

**Browser/AT evidence prerequisites:** before Slice 5 begins, the orchestrator records the concrete
acceptance path: a physical touch-capable Chrome device or remote-debuggable Android target for
touch drag, and a real VoiceOver or NVDA pass (human-run or controllable AT environment) for live-
announcement cadence. Desktop emulation and Chrome accessibility-tree inspection remain useful
diagnosis only; neither is acceptance. This is an orchestrator action item, not an Opus question.

Files:

- `ProjectKanbanBoard.tsx`, `app.css`;
- Node/DOM configuration assertions; browser evidence is mandatory for behavior.

Work and tests:

- add TouchSensor delay/tolerance, handle-scoped touch action, 44×44 target, public auto-scroll
  configuration, drag remeasurement, overlay reduced-motion behavior, and phone/zoom layout;
- verify in real Chrome that `DragOverlay` renders during an active drag as a sibling of `.kanban`,
  escapes horizontal clipping, and remains non-interactive; the extracted `KanbanCardPreview` DOM
  test covers structure only;
- DOM tests assert configuration/markup/classes only; they must explicitly disclaim sensor,
  scrolling, and timing proof;
- run the focused Agy browser checks listed below, the nominated real-touch path, and the real AT
  cadence pass before declaring this slice accepted;
- repeat the refresh regressions under real interaction timing, including drag/modal/pending
  deferral, cross-Stage provisional-source barrier, refetch failure hold, and terminal purge.

What stays working: ordinary Board horizontal swipe/trackpad/wheel outside a drag, link activation,
page vertical scroll, and all command semantics.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: real Chrome proves horizontal and nested auto-scroll and reduced motion; the nominated
physical/remote Android Chrome proves touch drag; real VoiceOver/NVDA proves announcement cadence;
freshness regressions pass under real interaction timing. Pointer/link and keyboard sensor evidence
from Slices 2 and 4 remains green. Emulation/tree inspection alone is not acceptance.

### Slice 6 — cross-tab freshness and interaction barrier hardening

Files:

- `dashboard-projects.ts`, `project-query-sync.ts`, `Dashboard.tsx`, `ProjectWorkspace.tsx`,
  `ProjectOverviewRail.tsx`;
- `project-query-sync.test.ts`, `Dashboard-stage-interactions.dom.test.tsx`, and focused query tests.

Work and tests:

- add the strict Board-invalidated message to the existing channel and publish after Dashboard/
  rail winners only;
- add rail Board-broadcast publication here (not Slice 4), while retaining Slice 4's already-proved
  announcement/focus/optimistic timing;
- invalidate locally and in receiving tabs without ID/metadata leakage or rebroadcast; when detail
  freshness also needs the project ID, emit the existing project-resource message separately;
- key the derived interaction model by effective sort; the network fetch key stays the unchanged five-element `dashboardProjectsKey` per the Option A ruling. Assert zero fetches on sort change and full rebuild of memoized display arrays, dnd items, drag-start snapshot, and Move-to options;
- record that the unchanged key preserves the `exact: true` consumers at
  `Dashboard-stage-interactions.dom.test.tsx:146,163` and the prefix match in
  `removeProjectFromDashboardQueries` (`dashboard-projects.ts:60`); future widening must audit both;
- extend `interactionBlocked` to dnd proposal, confirmation, Stage/reorder/priority pending, and
  explicitly **not** the cross-Stage settle gate;
- implement `movementSettlePending` as the separate movement-activator gate and prove it releases
  after the first successful settle refetch and after one failed settle refetch followed by success;
- prove focus/poll/reconnect/broadcast replacements defer, exactly one post-block refetch settles,
  and terminal purge defeats late query and mutation responses.

What stays working: TB2 exact project-resource messages and tests, unsupported-channel fallback,
query retry/stale/poll settings, External branch, and all non-Board query consumers.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: all ten exact freshness/conflict scenarios above pass, including mixed-scope
runtimes/tabs, ID-free Board payload, provisional-source barrier, one post-release refetch where
authoritative settle succeeds, release after a failed-then-successful settle refetch, no rebroadcast,
and terminal purge precedence.

### Slice 7 — full test rewrite, characterization diff, lessons and tracker

Files:

- `Dashboard-stage-interactions.dom.test.tsx`;
- `Dashboard-kanban-sort.dom.test.tsx`;
- `Dashboard-board-order.characterization.test.ts`;
- new `kanban-interaction.test.ts` and any Board DOM test;
- `docs/lessons.md`, `docs/todo.md`, and this plan's status only to the truthful pre-deploy state.

Work and tests:

- revisit and consolidate the three Board tests after their permitted Slice 2 rewrites; Slice 7
  does not defer ownership of native-drag assertion removal that Slice 2 needed to remain green;
- remove every synthetic native `DragEvent` helper/assertion;
- consolidate pure placement/proposal/reconcile/announcement tests under the Node config;
- use the DndContext mock only for React integration, capability, endpoint, focus, modal, and
  refresh wiring;
- preserve characterization for direct links, Deadline/no-RAW, sorts/arrows, External scope,
  flag-off/maintenance, and archived List-only;
- run repository audits and fill the lessons stub from actual evidence.

What stays working: every delivered behavior in Slices 0–6; this slice changes no product contract.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: the full web suite contains no false claim that happy-dom proves sensors/scroll/touch;
the baseline behavior diff is fully classified; lessons/todo state matches evidence.

### Slice 8 — full proof and deploy preparation

Files:

- evidence/closeout edits only; no new feature work.

Work and tests:

- run the complete gate and audits below;
- execute the full Agy local-dev matrix, recording browser-only items and any real-touch blocker;
- obtain fresh read-only Sol diff review and later Opus final-draft review per the pipeline;
- inspect bundle/dependency/CSS delta and confirm no package/lock/shared/Worker/migration change;
- prepare the app-Worker-only deploy/rollback record and passive production verification checklist;
- keep the plan in `docs/plans/` until build, verification, commit, and production deploy are all
  complete; then update status with commit/version and `git mv` it to `implemented/`.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: full gate and audits are green, browser matrix is recorded, reviews approve, deploy
diff is app/web-only, and rollback target is known.

## Automated test and repository audit plan

### Node-config tests (`apps/web/vitest.config.ts`)

- authorized sorting, revision-free visual gap intent, and activation-time exact request resolution
  independent of DOM;
- multi-container proposal for card/column/empty target;
- capability/sort eligibility;
- optimistic overlay, accepted-baseline rollback, authoritative target/provisional source response
  reconcile and held `movementSettlePending` command gate;
- priority-first canonical ordering and a mixed-priority optimistic-position versus settled-position
  divergence/snap;
- confirmation-timing policy using canonical normalized keys/classifier (defer when uncertain;
  never supplies server reasons), plus `forbidden` same-Stage confirmation fail-closed behavior;
- generic full-baseline rollback, exactly one refetch, and no retry for
  `project_archived_read_only`, reachable `inactive_destination`, and
  `stage_contract_reload_required`;
- focus descriptors/fallback selection;
- exact/deduplicated announcement strings, displayed-column position/count, `changed:false`, and
  terminal/purge suppression returning `undefined`;
- strict ID-free Board broadcast parsing and mixed-scope receiver isolation if the runtime test
  remains `.test.ts`.

### happy-dom tests (`apps/web/vitest.dom.config.ts`)

- one `DndContext` and per-column `SortableContext` composition, including asserted
  `accessibility.restoreFocus === false`;
- handle/link separation, labels, controls, directly rendered `KanbanCardPreview` structure, and
  flag-off disabled/hidden state;
- captured DndContext handler → exact request/endpoint/optimistic DOM/rollback wiring;
- role matrix and sort-mode behavior;
- Move-to dialog, arrows, rail, confirmation modal, focus, terminal-suppressed live regions;
- accepted-snapshot deferral, provisional-source `movementSettlePending` hold, refetch-failure hold,
  ID-free broadcast, and terminal purge.

happy-dom does **not** prove PointerSensor activation, TouchSensor timing, KeyboardSensor key
capture, real collision rectangles, auto-scroll, link-click suppression, screen-reader delivery, or
browser focus timing. It also does not prove that `DragOverlay` renders during an active drag; only
the extracted preview's static structure is a DOM test. Those are browser acceptance items.

### Repository audits

Run and classify from the repository root:

```bash
rg -n "DragEvent|draggable=|dataTransfer|addEventListener\\(['\"](?:drag|drop)" \
  portal/apps/web/src/screens/Dashboard.tsx \
  portal/apps/web/src/components/ProjectKanbanBoard.tsx

rg -n 'onDragStart|onDragOver|onDragEnd|onDragCancel|onDrop|onDragLeave' \
  portal/apps/web/src/screens/Dashboard.tsx \
  portal/apps/web/src/components/ProjectKanbanBoard.tsx

rg -n '@dnd-kit/(core|sortable|utilities|modifiers|accessibility)' \
  portal/apps/web/src portal/package.json portal/package-lock.json

rg -n 'cardDropPlacement|adjacentBoardPlacement|orderedVisibleProjectIds|authorizedBoardOrder|boardPosition' \
  portal/apps/web/src/screens/Dashboard.tsx \
  portal/apps/web/src/components/ProjectKanbanBoard.tsx \
  portal/apps/web/src/lib/kanban-interaction.ts

rg -n 'submitStageMoveWithConfirmation|/stage|/board-position|project_board_reorder_forbidden' \
  portal/apps/web/src

rg -n 'dashboard-board-invalidated|BroadcastChannel|dashboard-projects' \
  portal/apps/web/src/lib portal/apps/web/src/screens

git diff -- portal/packages/shared portal/packages/db portal/workers
git diff -- portal/package.json portal/package-lock.json
```

Expected:

- the first audit has zero native Board drag paths; upload/drop surfaces outside the Board are
  unrelated and remain. The second audit is inspect-and-classify: legitimate `DndContext`
  callbacks in `ProjectKanbanBoard.tsx` are expected, while native anchor/wrapper drag listeners
  are forbidden;
- one dnd-kit Board engine using only pinned direct packages; no install/lock delta;
- all placement reads authorized order and revisions, never raw `boardPosition`;
- every movement caller reaches the common helper and correct endpoint;
- one existing BroadcastChannel runtime, one strict ID-free new message, no project/metadata
  payload;
- no shared/DB/Worker/migration change.

### Final diff review checklist

Gate discipline: the orchestrator runs all four gate commands itself from `portal/`; an
agent-reported green is not evidence. Before approval, require the following UI-only boundary
checks to be empty/unchanged:

```bash
git diff -- portal/packages/shared portal/packages/db portal/workers
git diff -- portal/package.json portal/package-lock.json
ls portal/packages/db/migrations/
```

The migration listing must still end at `0037_project_board_order_contract.sql`.

Grep-verifiable invariants:

- zero `draggable=`, `dataTransfer`, or `DragEvent` in `Dashboard.tsx` and
  `ProjectKanbanBoard.tsx`, and zero `suppressNavigation`;
- zero imports of `@dnd-kit/modifiers` or `@dnd-kit/accessibility` (transitive only);
- `restoreFocus: false` is present on the Board `DndContext`;
- zero `setQueryData` on `dashboardProjectsKey` outside `useDashboardProjects`'s `queryFn`;
- every `/board-position` call site passes `confirmationPolicy: "forbidden"`, every `/stage` call
  site passes `"stage-move"`, and no movement path calls `apiPost` directly around
  `submitStageMoveWithConfirmation`;
- `dashboardProjectsKey` still returns exactly five elements;
- the Board broadcast message literal contains no `projectId`, `stageKey`, `boardRevision`, or
  `role` key.

Demand observed evidence, not reasoning, for these behavioural traps:

- cross-Stage `movementSettlePending` releases on the first successful settle refetch and after one
  failed settle refetch followed by success;
- keyboard drag → confirmation-required → focus stays inside the modal across at least two
  animation frames;
- terminal purge mid-drag causes the dnd-kit live region to emit no private street or Stage label;
- network-panel proof shows exactly one POST for 409 conflict, invalid same-Stage confirmation,
  modal cancel, drop outside, drop on unchanged gap, and stale Move-to;
- External Editor evidence proves unrelated project IDs never arrive in DOM, network, or cache.

Final diff review also confirms the plan status line, `docs/todo.md`, and the `docs/lessons.md`
entry are filled from observed evidence with placeholders removed, and that this plan is moved to
`implemented/` only after production deploy.

## Agy local-dev QA matrix

Run through Agy Option A against `http://localhost:8787` after a human signs its dedicated Chrome
in as Admin. Agy never runs OAuth, reads auth secrets, forges a session, or seeds fixtures through
raw SQL. Use Admin impersonation for internal Editor and an approved disposable assigned External
Editor fixture. Local mutating QA stays on disposable projects. If the required authenticated role
or real touch surface is absent, Agy stops and reports the blocker; it does not proceed
unauthenticated or substitute a synthetic pass.

| Path/scenario | Admin | Internal Editor (impersonated) | External Editor (assigned/impersonated) | Browser-only proof |
|---|---:|---:|---:|---|
| Pointer cross-Stage card gap and empty-column append | move; exact settled order | move | move assigned only | pointer-vs-link, geometry, overlay |
| Pointer same-Stage | allowed in Board order | no request/control | no request/control | collision + visual insertion |
| Mixed-priority column drop | optimistic visual gap may snap to priority-first canonical settled order | cross-Stage only | assigned visible cross only | server response wins; announcement position/count uses displayed settled order |
| Touch cross-Stage | move | move | move assigned only | **real touch surface**, delay vs scroll-fling |
| Touch same-Stage | allowed in Board order | forbidden UI | forbidden UI | real touch + autoscroll |
| Keyboard Space/arrows/Space across Stage | move | move | move assigned only | real sensor key handling/focus |
| Keyboard same-Stage | allowed | no request | no request | real sensor + announcements |
| **Move to…** top/middle/end | cross + same | cross only | assigned visible cross only | dialog focus/hidden-scope inspection |
| ↑/↓ | allowed Board order | absent | absent | focus after settled reorder |
| Workspace rail | append cross-Stage | append cross-Stage | assigned project only | confirmation/focus/broadcast |
| Confirmation accept/cancel | source held; accept one retry; cancel none | same | same neutral Editing copy | modal focus + timing |
| Keyboard drag → confirmation required | focus remains in modal ≥2 animation frames | same | same | proves dnd-kit restore cannot reclaim source handle |
| Conflict/409, two tabs | rollback/refetch/no retry | same | same assigned-safe | network count + two-tab state |
| Contract flag off / maintenance 503 | mutation disabled; Priority metadata preserved | disabled | disabled | exact status/live copy |
| Cross-tab broadcast | other tab refreshes | same | no scope broadening | two real tabs, ID-free payload, receiver-only scoped key/network |
| Refresh during drag/modal/pending | defer then one refetch | same | same | focus/poll/broadcast timing |
| Cross-Stage success with concurrent source-only reorder | target authoritative; source provisional; movement held through refetch | same | same assigned-safe projection | two-tab race + no second command before settle |
| Post-success refetch failure | saved result shown with recovery state; movement disabled | same | same | failed fetch then successful recovery |
| Terminal access loss during late response | purge wins | purge wins | unassignment purge wins | private DOM never restored |
| Horizontal/nested auto-scroll | both axes | both axes | both axes | real geometry/scroll ancestors |
| Link disambiguation | click/new-tab/context menu, no drag | same | same | native browser navigation |
| Screen-reader announcements | exact start/over/drop/cancel/conflict | same | same | real VoiceOver/NVDA live delivery; tree only diagnoses |
| Reduced motion, 200% zoom, phone reflow | pass | pass | pass | CSS/media/browser rendering |

For 409, hold Tab A's drag-start revision, move the project in Tab B, then drop in Tab A. Verify
one stale POST, no auto-retry, authoritative state, exact announcement, and deterministic focus.
For 503 flag-off, use the existing TB5A flag procedure only in local dev and restore it; do not add
a TB5B flag. For External, inspect DOM/network/cache and prove unrelated project IDs never arrive,
not merely that they are hidden.

Before Slice 5, the orchestrator records the named physical/remote-debuggable touch Chrome target
and real VoiceOver/NVDA path. Chrome desktop emulation is not a real-touch acceptance result, and
Chrome's accessibility tree is not a screen reader. If either path is unavailable, Slice 5 remains
blocked; this plan does not waive the touch or announcement outcome.

## Deploy and rollback

TB5B ships directly under the existing `tb5a_board_contract_enabled` contract gate. It does not
need its own flag:

- when TB5A is OFF or reports schema maintenance, TB5B has no mutation activators and is inert;
- a second UI flag would create four flag combinations without protecting a new server/schema
  boundary;
- the old native engine is removed, so a “new UI off” branch would either revive a forbidden
  second engine or leave no useful alternate mutation path.

This is a web-bundle/app-Worker-only deploy. Do not deploy background or webhook-ingress and do not
apply a migration:

```bash
cd portal/workers/app
npx wrangler deploy
```

Deploy record shape:

```text
TB5B deployed YYYY-MM-DD — commit <sha>; app Worker <version>;
no migration (next remains 0038); no background/webhook deploy;
tb5a_board_contract_enabled remained <state>;
rollback app Worker <previous version>; passive production checks <result>.
```

Before deploy, record current app Worker rollback version. After deploy, production danger-mode is
passive only: Dashboard/List/Kanban render, handles/Move-to appear for the already-authorized role,
links open normally, no console/network error, and no mutation is made. Mutating proof stays local
unless the orchestrator separately authorizes YOLO-mode under the disposable QA identity.

Rollback is app Worker version rollback. Because there is no schema/shared/server change, rollback
does not require D1 recovery, background rollback, flag change, or data repair. After production is
verified, update `docs/todo.md`, change this status line to implemented/deployed with commit and
Worker version, and `git mv` this file into `docs/plans/implemented/`.

## Risks and open questions for plan-tier review

1. **Resolved — confirmation-safe optimism.** Both role-safe transport keys must normalize and the
   canonical exported `stageMoveConfirmationReasons(from, to)` must return `[]` before a cross-
   Stage proposal can render optimistically. Uncertainty holds source. The UI never sends
   classifier-produced reasons; only the server response supplies retry reasons. This is display
   timing, not authorization.
2. **Resolved — response shape and source order.** The response target array is authoritative; a
   cross-Stage baseline-minus-mover source is provisional. Keep global movement serialization
   through the successful full Dashboard refetch, and hold visible recovery/error state plus
   `movementSettlePending` if it fails. This is UI-only; no shared/server change.
3. **Resolved — keyboard multi-container fallback.** Start with `sortableKeyboardCoordinates`.
   A Board-local coordinate getter over authorized droppable rectangles is approved as the no-
   dependency fallback; either path still needs Slice 4 real-browser proof across every rendered
   column, with at least five active, and off-screen columns.
4. **Resolved — collision strategy.** Use `pointerWithin`, then restricted `closestCorners`, with
   deterministic Stage-first and visual-successor tie-breaking. Tune only through public UI code
   and browser evidence.
5. **Resolved — auto-scroll boundary.** Use public dnd-kit core APIs only. If `.kanban` plus
   page/nested vertical ancestors cannot pass the real-browser matrix, implementation is blocked;
   there is no private import or dependency escape hatch and no Opus decision is needed.
6. **Resolved — touch evidence ownership.** Before Slice 5, the orchestrator nominates a physical
   touch-capable Chrome or remote-debuggable Android target. Emulation is diagnosis only; absence
   of real evidence blocks the slice. This is an orchestrator action, not an Opus item.
7. **Resolved — Move-to product shape.** Keep the position-aware two-step interaction: choose Stage,
   then a position listbox with `End of {Stage}` first and `Before {street} — position N` labels.
8. **Resolved — global movement serialization.** One Dashboard Stage/position command remains the
   approved global limit; it protects exact rollback, request premises, and provisional-source
   refetch settlement.
9. **Resolved by Opus ruling (2026-08-29) — sort identity interpretation.** Option A. Network key = authorization scope only; the brief's "sort" clause is satisfied by the mandatory derived {dashboardQueryKey, effectiveKanbanSort} interaction identity. See the ruled subsection for the full rationale and the supersession boundary.
10. **Resolved — announcement ownership.** dnd-kit owns proposal lifecycle and the Dashboard region
    owns confirmation/settled outcomes, with the single terminal-aware builder suppressing both
    paths after purge. Invalid, outside, and unchanged-gap drops use cancellation copy with zero
    request and suppress `Saving`; a real VoiceOver/NVDA pass must approve assertive/polite cadence
    or use the approved `onDragEnd`-announcement suppression fallback.
11. **Resolved — channel evolution.** Keep channel v1 as an additive discriminated union; old
    receivers ignore unknown types. The Board variant is ID-free, and strict parsing plus mixed-
    scope/runtime tests pin no metadata leakage, receiver-scope invalidation, self-ignore, and no
    rebroadcast.
12. **Resolved — rail optimism.** Rail optimism may change only the detail Stage and must roll that
    overlay back exactly on confirmation/error. Confirmation holds source; movement remains blocked
    through authoritative detail refetch. After a winner, emit the ID-free Board invalidation plus
    the existing project-resource invalidation when the detail query needs its project ID.

Any review conclusion requiring a route, response, shared contract, capability, migration, or new
dependency returns the plan to scope review before build.

## Lessons entry stub for implementation closeout

Add and fill this entry in `docs/lessons.md` from real build/browser evidence; do not land the
placeholders as a claimed lesson:

```markdown
## dnd-kit Kanban interaction timing in a real browser (TB5B, YYYY-MM-DD)

- **Observed behavior:** [specific pointer/touch/keyboard/autoscroll/focus or live-region behavior
  that happy-dom did not reproduce].
- **Root cause:** [event ordering, sensor activation, collision measurement, scroll-ancestor,
  overlay, or focus-restoration mechanism proven by instrumentation].
- **Fix:** [the exact configuration/code boundary that resolved it].
- **Rule:** dnd-kit reducer/placement and DndContext-handler mocks prove command wiring only;
  [precise future rule for which interaction change must be verified in a real browser].
```

This stub deliberately follows the existing TipTap lessons: native listener/event timing,
no-op transaction timing, and scroll/focus behavior can pass happy-dom while failing Chrome.
The build must replace speculation with observed evidence and the orchestrator must independently
verify the agent-reported result under §5.
