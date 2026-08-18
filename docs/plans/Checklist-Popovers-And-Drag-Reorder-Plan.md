# Checklist popovers and drag reorder — Plan

**Status: APPROVED — Terra (2 rounds) + Opus (2 reverts) plan-review complete. Not yet built.**

## Problem and scope

The project checklist has already shipped its compact accordion form, but each row still exposes
its metadata editor and action menu as inline blocks.  The current move controls can only swap a
task with one adjacent item.  This change makes the existing compact checklist behave like the
specified Trello reference without changing the checklist's accordion/progress behaviour, its
single-assignee data model, or its title-editing interaction:

1. Replace the inline assignee/date controls and inline overflow group with click-anchored,
   collision-aware due-date, assignee, and Delete-only popovers.
2. Replace Move up/Move down with a grip-only sortable drag-and-drop interaction that also works
   with the keyboard.
3. Change the add-item form into a compact composer that can preselect the same assignee/due-date
   values before one create request.

This is a frontend-plus-small-route change.  It needs no schema or migration: `project_subtasks`
already has a numeric `position`, optional one-user `assignee_id`, and optional literal
`due_date` ([`schema.ts:218–239`](../../portal/packages/db/src/schema.ts#L218)).  It also does
not need to add create-time metadata support: the currently shipped strict `createInput` already
accepts optional `assigneeId` and `dueDate`, validates the assignee, stores both values, and
notifies a newly assigned user ([`project-subtasks.ts:31–36`](../../portal/workers/app/src/routes/project-subtasks.ts#L31),
[`79–90`](../../portal/workers/app/src/routes/project-subtasks.ts#L79)).  The frontend will begin
using that existing contract, and its coverage will be made explicit rather than duplicating
validation or changing an already-correct server API.

## Source map

- [`SubtaskChecklist.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L29) owns
  checklist state and network mutations.  It loads/sorts checklist rows at lines 66–75, loads the
  assignable project-user list at lines 76–80, and has the current item-contained
  `pointerdown`-outside listener at lines 81–86.  The title focus-transfer layout effect and its
  synchronous Escape cancellation marker are at lines 87–98 and 162–168; they are preserved.
  The create request is at lines 105–111, the old adjacent `move()` request at lines 112–124,
  deletion/focus restoration at lines 125–136, and current row/inline-control/add-form markup at
  lines 148–178.
- [`SubtaskChecklist.dom.test.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.dom.test.tsx#L41)
  is the existing happy-dom coverage: compact/edit state at lines 60–103, the inline menu and
  move request at lines 105–137, and the title-only add request at lines 139–147.  It will be
  rewritten for the new controls rather than leaving stale assertions behind.
- [`app.css:1023–1054`](../../portal/apps/web/src/styles/app.css#L1023) contains all current
  checklist layout, edit-control, overflow, and composer selectors.  In particular, the current
  flex grouping is at line 1038, old metadata controls at 1043 and 1048–1051, the ellipsis
  reveal at 1046–1047, and old inline actions at 1052–1053.
- [`Topbar.tsx:58–69`](../../portal/apps/web/src/components/Topbar.tsx#L58) is the required
  open/close precedent: while open it installs Escape and `pointerdown` listeners, prevents the
  Escape default, and returns focus only for Escape.  It also shows that outside pointer closing
  must consider both trigger and floating content.
- [`ProjectCollaborationPanel.tsx:72–79`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L72)
  makes prevented Escape inside the checklist essential: the overlay otherwise closes when focus
  is inside it.  Its existing deletion idiom is the exact required confirmation form at
  [`line 84`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L84):
  `if (!window.confirm(...)) return` before the DELETE request.
- [`project-subtasks.ts`](../../portal/workers/app/src/routes/project-subtasks.ts#L72) owns the
  collaboration-access-first list/create/update/delete routes.  The old direction-only request
  schema is at line 37 and the old `POST .../move` two-row snapshot swap is at lines 123–145;
  both are being removed.  Its update path's calendar validation/nullable semantics are at lines
  17–36 and 93–120 and remain the one source of truth for date/assignee validation.
- [`project-subtasks.test.ts:31–114`](../../portal/workers/app/test/project-subtasks.test.ts#L31)
  contains the authenticated Worker integration coverage, including the old `/move` assertion at
  lines 57–63 and the create-with-assignee/due fixture at lines 36–43.
- [`board-position.ts:8–13`](../../portal/packages/db/src/board-position.ts#L8) exports the
  proven 1024-gap/midpoint `computeInsertPosition(before, after)` primitive.  The project board
  route applies it at [`projects.ts:268–287`](../../portal/workers/app/src/routes/projects.ts#L268),
  and its guarded-update/renumber fallback is at lines 37–74.  This is the ordering model to
  adapt for subtasks, except that its rebase does not leave every board row 1024-spaced after the
  final target update (see section 2's deliberately different subtask recipe).  Dashboard's
  distinct native HTML5 cross-stage drag is at
  [`Dashboard.tsx:82`](../../portal/apps/web/src/screens/Dashboard.tsx#L82) and
  [`199–224`](../../portal/apps/web/src/screens/Dashboard.tsx#L199), while its within-column
  ordering remains arrow buttons at lines 98–99; neither is being changed or reused.
- [`portal/package.json:31–32`](../../portal/package.json#L31) pins the workspace's actual
  React and React DOM runtime to `^18.3.1` (the installed lock resolution is 18.3.1); the web
  workspace currently has only its scripts/happy-dom dev dependency at
  [`apps/web/package.json:1–14`](../../portal/apps/web/package.json#L1).

## 1. Shared anchored-popover primitive and row metadata/actions

### Change

Add a small reusable frontend primitive, proposed as
`portal/apps/web/src/components/AnchoredPopover.tsx`, rather than three bespoke floating
implementations in `SubtaskChecklist`.  It should expose a narrow controlled
`useAnchoredPopover` hook/component contract: an `open` value and close callback, reference and
floating ref setters/props, and the computed floating style.  It is deliberately *not* a general
application dialog/menu system—its only responsibility is positioning and close boundaries.

Implement it with `@floating-ui/react`'s `useFloating`, `autoUpdate`, `offset`, `flip`, and
`shift` middleware.  Render every floating-content node through `FloatingPortal`, because both
`.project-collaboration--overlay` (`overflow: hidden`) and
`.project-collaboration__scroll` (`overflow: auto`) would otherwise clip an in-place,
absolutely-positioned popover before `flip`/`shift` could help.  Use an 8px viewport collision
padding and a small visual offset from the trigger, with placement chosen per trigger but
permitted to flip/shift.  This is necessary for the narrow, fixed right panel: the only existing
CSS dropdown is parent-corner anchored, whereas these controls must survive a click near every
panel/viewport edge.  Wrap the portaled content in `FloatingFocusManager` with `modal={false}`,
`returnFocus={false}`, and `order={['reference', 'floating', 'content']}`, so Tab follows the
logical popover order across the portal without turning these small non-modal popovers into a
focus trap; the existing explicit `focusin` boundary closes one when Tab actually leaves its
trigger/floating pair.  `returnFocus={false}` is required on **every** `FloatingFocusManager`
usage: Escape already explicitly returns focus to its trigger on the next task, whereas an outside
pointer/focus close must not have the library return focus to the trigger.  Give each assignee
popover (row and composer) `initialFocus={searchInputRef}` so its search input receives focus on
open.  Give each due-date and Delete popover explicit `initialFocus={0}`: neither has a clearly
correct inner initial target, so its trigger deliberately remains the initial focus target.  Escape
must **not** use a
`window` listener: attach the same React bubble-phase `onKeyDown` handler to each trigger and
floating-content container.  When an open popover receives Escape there, it calls
`preventDefault()`, closes, and returns focus to its trigger on the next task.  This deliberately
runs before `ProjectCollaborationPanel`'s native window listener, so that listener observes the
prevented event and cannot close the overlay.  On global `pointerdown`, close only when the target
is in neither the trigger nor floating content; on global `focusin`, close when the newly focused
element is in neither.  Open popovers only from a trigger `click`, never `pointerdown`; install
those outside-close listeners in an effect after the open state has committed, never
synchronously in the opening event, so the opening click cannot also close the new popover.
Remove the listeners when it closes.  Outside pointer/focus closing does not steal focus back;
that matches the Topbar distinction.  A single checklist-level active-popover identity
(`item id + kind`, or `composer + kind`) ensures only one floating panel exists at once.  Because
portal descendants do not participate in a row's DOM containment or `:focus-within`, the row's
existing `onBlur` boundary check must treat focus into that row's own identified floating ref as
remaining inside the row, and the row must receive an explicit
`subtask-checklist__item--popover-open` is-open class while it owns the active popover.  That class
is specifically what keeps its control/reveal styling active while
focus is portaled; `:focus-within` alone cannot do so.

Add exact runtime dependencies to
[`portal/package.json`](../../portal/package.json#L1), alongside the workspace's existing runtime
dependencies (including web-only React/Tiptap packages), then regenerate the root lockfile with
the normal npm workspace install:

- `@floating-ui/react@0.27.16`
- `@dnd-kit/core@6.3.1`
- `@dnd-kit/sortable@10.0.0`
- `@dnd-kit/utilities@3.2.2`

These selected releases accept React 18 (the Floating UI React adapter's React peer range includes
18; dnd-kit core/sortable support React 16.8+ and their selected core/sortable/utilities versions
are mutually compatible).  They are therefore compatible with the project's pinned installed
React 18.3.1 source-map version above; retain the exact package versions, then let `npm install`
record the transitive resolutions in `portal/package-lock.json`.  No dependency belongs in a
Worker package.

Keep the existing compact summary ordering (checkbox, title, due, assignee, actions), but replace
each metadata display with its always-present trigger:

- The due trigger is a labelled icon button when unset; when set, it is a button containing the
  existing literal-safe compact `<time>` badge from `formatDueDate`.  Its popover owns a local
  draft split with the existing `dueDateParts()` helper: native `date` and `time` inputs, **Save**,
  and **Remove**.  Save calls the existing `update(item, { dueDate }, ...)` shape once, combining
  date/time exactly as the current inline fields do; Remove calls `{ dueDate: null }`.  Escape,
  a toggle-click, outside pointer, or focus departure discards a dirty local draft without a
  PATCH.  Do not create a calendar grid or reminder configuration UI.
- The assignee trigger is a labelled person icon button when unset, or the current initials avatar
  button when set (retaining the full-name tooltip and screen-reader description).  Its popover
  has an autofocusable search input and a client-side, case-insensitive filter over the already
  loaded `users` list from lines 76–80.  A member button calls the current update shape with that
  member id and auto-closes; clicking the member that equals `item.assignee?.id` calls
  `{ assigneeId: null }` and auto-closes.  There is no synthetic “Unassigned” row and no
  multi-select state.
- The ellipsis trigger opens one small popover containing exactly **Delete**.  On Delete, first
  use `window.confirm("Delete this subtask?")` in the `ProjectCollaborationPanel` style.  A false
  result makes no DELETE request and leaves the popover usable; a true result closes it and runs
  the existing `remove(item, index)` sequence, preserving its next-row/add-composer focus fallback.
  If that deletion empties the list while the composer is open, focus the composer's title input
  rather than the closed-state Add button, which is not then rendered.
  There is no Convert-to-card action or custom in-popover confirmation.

All due/assignee/ellipsis controls remain real buttons in the Tab order.  Give unset due/assignee
buttons a row-control class that is visually revealed on row `:hover`, `:focus-within`, or the
button's own `:focus-visible`; never use `display: none`, `visibility: hidden`, or a mouse-only
event.  Keep populated badges/avatar visible at rest, and keep active controls visible while
their popover is open.  Retain the existing full-row hover/focus paper treatment and add ordinary
focus-visible outlines to every trigger and popover action.  CSS must constrain the title and
right-side controls with `min-width: 0` so long titles cannot force buttons out of the 460px panel.

Delete the old `openMenuId` state/listener, `move`, `moveFromMenu`, inline
`.subtask-checklist__overflow-actions`, and `.subtask-checklist__edit-controls`.  This deletes
**only** the old Move-menu focus-restoration logic.  The delete-flow next-row/Add-button focus
fallback and title-edit focus-transfer `useLayoutEffect` are unaffected and must remain exactly as
implemented; section 3's replacement closed-state Add button must retain the fallback's existing
`id={\`subtask-add-${projectId}\`}` target.  Title editing
remains exactly as implemented: click/Enter/Space opens the title input, blur/Enter saves,
Escape synchronously marks cancellation before blur, and the existing guarded `useLayoutEffect`
focus transfer remains intact.  Crucially, due/assignee controls now work whether or not a title
is editing; do not rewrite that marker, blur, or focus-transfer logic while extracting the row.

### Non-goals

- No new app-wide popover, dialog, menu, calendar, or reminder primitive; the shared hook is a
  purposely small checklist-facing positioning/close-boundary helper.
- No multi-assignee model, “Unassigned” list row, Convert to card, custom date grid, reminder
  scheduling, or changes to due-date literal formatting/validation.
- No change to title-edit lifecycle, accordion state, progress computation, project access,
  existing update notification behavior, or the collaboration overlay's Escape policy.

## 2. Sortable checklist and reorder API

### Change

Wrap only the ordered checklist-item list in `DndContext` and `SortableContext` from dnd-kit;
leave the Dashboard's native HTML5 Kanban drag system untouched.  Each subtask becomes a small
sortable-row component so `useSortable` can safely own its refs.  Attach `setNodeRef`, transform,
and transition to the row article, but attach `attributes`, `listeners`, and
`setActivatorNodeRef` only to a dedicated, labelled grip button.  The checkbox, title, metadata
triggers, and ellipsis must never start a drag.

Use a `PointerSensor` with a short distance activation constraint to avoid accidental drags, plus
`KeyboardSensor` with dnd-kit's `sortableKeyboardCoordinates`.  The focused grip must support
Space to pick up, Arrow keys to move through the vertical list, and Space to drop; retain the
library accessibility announcement/instructions and give the grip a task-specific accessible
name such as `Reorder Call client`.  Suppress a busy row's activation with
`useSortable({ id, disabled: isBusy })`, not the grip button's HTML `disabled` attribute: retain
the button in the Tab order (with appropriate `aria-disabled` state) so it cannot lose focus to
`body` mid-request.  Beginning a drag closes any popover and does not change title-edit semantics.
Clear the reorder busy state before scheduling post-reload grip-focus restoration, so `.focus()`
always targets an enabled activator.  Add the usual dragging-source styling and collision-friendly
sortable transforms, not a full-row `draggable` attribute.

In `onDragEnd`, return before deriving neighbors or issuing a request when `over` is null (cancelled
or dropped outside the sortable area) or `over.id === active.id` (a no-op drop).  Only for a real
target change, remove the active id from the current ID array, use the resulting destination index,
and derive the target's immediate `beforeId` and `afterId` from that remaining array.  Do not send
a position supplied by the client.
POST this exact contract:

```text
POST /api/projects/:projectId/subtasks/:subtaskId/reorder
Content-Type: application/json

{ "beforeId": "<UUID> | null", "afterId": "<UUID> | null" }

200 { "position": <number> }
409 { "error": "Subtask order changed; reload and try again" }
```

`beforeId` means the task immediately preceding the moved item and `afterId` the task immediately
following it in the desired order; either is `null` only at the relevant edge, and both are null
only for the sole remaining item.  The frontend does not make the reorder optimistic: after a 200
it calls the existing `load()` to replace the canonical sorted list; after a 409 it also reloads
and announces the retryable error.  This avoids locally retaining stale numeric positions after a
competing reorder.  After either reload, use a stable per-task grip ref: focus the dragged task's
grip if it remains; otherwise focus the grip at the former dragged row index, clamped to the new
list's last index (the nearest remaining row), or the closed-state Add button when the list is
empty.  A 409 therefore never claims to retain the old order; it replaces it with canonical state
before applying that deterministic focus fallback.

Replace the old `moveInput` and route at
[`project-subtasks.ts:37`](../../portal/workers/app/src/routes/project-subtasks.ts#L37) and
[`123–145`](../../portal/workers/app/src/routes/project-subtasks.ts#L123) completely.  The new
strict body schema accepts nullable UUID `beforeId`/`afterId`, rejects the target id as either
neighbor, duplicate ids, malformed input, and impossible endpoint combinations.  After the same
access-before-existence checks, the route reads the target and the project list ordered by
`position, id`, removes the target, resolves the two requested neighbors, and rejects with 409 if
they are not exactly adjacent in that snapshot.  The ordinary (non-tied) path calculates its stored
position only with `computeInsertPosition(before.position | null, after.position | null)`, exactly
preserving that helper's float midpoint—**never round the midpoint**, because rounding can collide
with a neighbor.  `project_subtasks.position` is declared as `integer` in `schema.ts`, but SQLite
will intentionally hold these non-integral midpoint values as REAL; no schema migration is needed.
The rebase branch is only for a tied midpoint as defined below, not for merely adjacent integer
positions or otherwise "exhausted" integer gaps.

Use a stricter subtask-specific guard than the board route rather than trusting that read.  The
board fallback at [`projects.ts:37–74`](../../portal/workers/app/src/routes/projects.ts#L37)
renumbers its *current* sorted snapshot, then applies a final target midpoint; it is not the
full-list 1024-spacing rebase required here.

1. In the ordinary non-tied path, the one target `UPDATE` is the success sentinel.  Its `WHERE` clause
   requires the target id/project/old position, each non-null requested neighbor id/project/old
   position, and `COUNT(*)` for this project to equal the snapshot's full row count.  It also has
   an explicit ordering predicate, always excluding the target: with both neighbors, `NOT EXISTS`
   a row strictly after `(before.position, before.id)` and strictly before
   `(after.position, after.id)`; with only `beforeId`, `NOT EXISTS` a row strictly after it; with
   only `afterId`, `NOT EXISTS` a row strictly before it; with neither, the guarded count is one.
   “Strictly” is the lexicographic `(position, id)` comparison, so tied positions are unambiguous.
   Thus no other current subtask can sit between the requested neighbors (or beyond the requested
   edge).  Exactly one changed sentinel row is success; zero is 409, never a stale successful
   response.
2. If the float midpoint equals either neighbor, form the desired complete list by removing the
   target from the ordered snapshot and inserting it between the requested neighbors.  With this
   float primitive, that is a tied stored-neighbor condition: distinct adjacent integers such as
   `1024` and `1025` produce `1024.5` and remain on the ordinary path, not the rebase path.
   Assign **every** row in that desired list its new position
   `(index + 1) * 1024`; unlike the board route, no target midpoint overwrites that rebase.
   Execute one guarded `UPDATE`, not a batch of per-row writes.  Bind `?1` once to a JSON-array
   string containing the complete desired snapshot, with `{ id, oldPosition, newPosition }` for
   every row; bind `?2` to `updated_at` and `?3` to `project_id`.  Drive both the assignment and
   guards from `json_each(?1)`: `UPDATE project_subtasks SET position = (SELECT
   CAST(json_extract(value, '$.newPosition') AS INTEGER) FROM json_each(?1) WHERE
   json_extract(value, '$.id') = project_subtasks.id), updated_at = ?2 WHERE project_id = ?3 AND
   (id, position) IN (SELECT json_extract(value, '$.id'), json_extract(value,
   '$.oldPosition') FROM json_each(?1)) AND (SELECT COUNT(*) FROM project_subtasks
   WHERE project_id = ?3 AND (id, position) IN (SELECT json_extract(value, '$.id'),
   json_extract(value, '$.oldPosition') FROM json_each(?1))) =
   json_array_length(?1) AND (SELECT COUNT(*) FROM project_subtasks WHERE project_id = ?3) =
   json_array_length(?1)`.  The two count guards make the predicate false for every row unless the
   complete project snapshot is still present, so a stale snapshot cannot update only its
   still-matching subset.  The exact bound-parameter formula is `3` (one reused numbered JSON
   snapshot, timestamp, and project id), independent of N; therefore the D1 100-parameter limit
   imposes **no checklist-length maximum** on this rebase design (the feature adds no separate
   item-count cap).  Its sole success check is `meta.changes === <snapshot row count>`; any other
   count returns 409.  D1 `batch()` executes
   every prepared statement and reports each statement's own result—it does not conditionally
   skip later statements or roll them back when an earlier statement changes zero rows.  That is
   exactly why this fallback must be one statement covering every rebased row, rather than
   independently guarded writes relying on a shared sentinel.  Consequently, a failed full
   snapshot guard makes the one `UPDATE` affect no positions; a successful write rebases every
   position atomically.  This retains
   fractional arbitrary inserts whenever the float midpoint is non-tied and safely restores uniform
   gaps only for tied positions.

On the one successful write path, set `updated_at`, write one
`project_subtask.reorder` audit entry containing `{ beforeId, afterId }`, and respond with the
computed target position.  In the rebase branch this intentionally restamps `updated_at` on every
rebased row (not just the target), because that one statement rewrites each row's position; the
ordinary-gap branch continues to restamp only its target.  This serialized timestamp difference is
intentional.  The route has no notification side effect.  The old
`project_subtask.move` action, `{ direction: "up" | "down" }` endpoint, client calls, tests,
Move buttons, and their Move-menu focus-restoration logic are all deleted—there must be no legacy
caller left.

### Non-goals

- No Kanban/Dashboard change, no generic cross-list sortable abstraction, and no drag across
  projects, checklist groups, or pipeline stages.
- No full-row dragging, native HTML5 DnD retrofit, pointer-only interaction, or removal of
  keyboard reordering.
- No schema/migration, position supplied by the client, silent last-writer-wins response, or
  assignment/reminder notification from a reorder.

## 3. Add-item composer

### Change

Replace the always-visible title input/form at
[`SubtaskChecklist.tsx:178`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L178) with
a closed-state `+ Add an item` button with `id={\`subtask-add-${projectId}\`}`.  On activation,
render an autofocusable title input, Add and Cancel buttons, and compact Assign/Due-date triggers
below it.  The latter reuse the exact
shared anchored-popover primitive and the same `AssigneePopover`/`DueDatePopover` presentation
from section 1, but bind to composer-local `newAssigneeId` and `newDueDate` state rather than
calling `update()`.

Cancel and a successful create clear title plus both metadata drafts, close any composer popover,
and restore focus to the closed-state Add button.  Handle Escape on the composer's own DOM element
in the same React bubble-phase `onKeyDown` mechanism as the item popovers: it must call
`event.preventDefault()` before closing/resetting and restoring focus, so the collaboration panel's
window Escape listener cannot also close the overlay.  Add remains
disabled for a blank/whitespace title and is busy while its request is running.  On submit, issue
one existing create request with exactly `{ title, assigneeId?, dueDate? }`, omitting unset
optional keys.  The existing server `createInput`/`eligibleAssignee` validation and insert at
[`project-subtasks.ts:31–36`](../../portal/workers/app/src/routes/project-subtasks.ts#L31) and
[`79–89`](../../portal/workers/app/src/routes/project-subtasks.ts#L79) already accept and persist
the title, assignment version, and due date in the existing create request, then perform its
existing audit and initial assignment-notification side effects as separate awaited operations.
This is not one atomic transaction; no new endpoint is needed.  Do not create a title-only task
and patch it afterward.

Append the returned task only after the successful POST (as today), retain the live error notice
on failure and leave the composer/open draft intact for retry.  The new returned row must be
usable by the same popovers and sorter immediately.  Use the current shared `users` list—do not
add a second member request for the composer.

### Non-goals

- No draft persistence, add-on-enter from arbitrary page keys, secondary create request, or
  server-side change to the already-supported `assigneeId`/`dueDate` creation contract.
- No redesign of the accordion or progress bar, and no changes outside the checklist component
  and its direct CSS/tests.

## Tests and verification

### Frontend DOM coverage

Update [`SubtaskChecklist.dom.test.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.dom.test.tsx#L41)
instead of retaining tests for removed controls.  In happy-dom, add/retain these direct behavior
tests:

1. Preserve accordion/progress, literal due-formatting, compact title edit, and Escape marker
   assertions.  Specifically prove the old raw select/date/time edit block and old inline
   Move buttons are absent while title click/Enter/Space, blur/Enter save, Escape cancel, and the
   `ProjectCollaborationPanel` Escape containment integration still work.
2. For due and assignee triggers in both populated and unset rows, assert the labelled icon/button
   exists and is tabbable before any edit mode; focus it and assert that `document.activeElement`
   is a descendant of its row.  (Happy-dom cannot prove `:focus-within` selector matching.)  Open
   each, assert its floating content is present and associated with its trigger, then exercise
   Escape/toggle cancellation, outside `pointerdown`, and outside focus without a PATCH.  Due-date
   Save must emit the exact combined date/time PATCH; Remove must emit `dueDate: null`.  Assignee
   search must filter the loaded users, assign on another member click, and unassign when the
   selected member is clicked again, each auto-closing after its one PATCH.
3. Open the ellipsis popover and assert it contains Delete only.  Mock `window.confirm`: false
   must issue no DELETE; true must issue exactly the current DELETE, close the popover, remove the
   row, and restore focus to the next row/add fallback, including deletion of the last row to the
   replacement Add button carrying `subtask-add-${projectId}` when the composer is closed.  If the
   composer is open when that deletion empties the list, focus its own title input instead—the
   closed-state Add button is not then rendered.  Include Escape/outside-pointer/outside-
   focus cancellation.  Confirm only one popover can be open when switching triggers, including
   opening a second trigger while the first is open; assert the first closes, no stale outside
   listener closes the second during its opening click, and no double-open state remains.
4. Exercise the closed `+ Add an item` state, composer opening/autofocus, Cancel reset/focus, its
   Escape reset/focus behavior, and the composer-specific assignee/due popovers.  Set both fields
   then Add, and assert one POST body contains title, `assigneeId`, and combined `dueDate`; assert
   no follow-up PATCH occurs.  On rejected POST, assert the populated draft stays available to
   retry.
5. Do not claim that happy-dom can drive dnd-kit's keyboard sensor: its absent/unreliable layout
   geometry makes `sortableKeyboardCoordinates` non-deterministic.  Instead unit-test an extracted
   pure neighbor helper with beginning/middle/end resulting orders: after removing the active id,
   it returns `beforeId = remaining[destinationIndex - 1] ?? null` and
   `afterId = remaining[destinationIndex] ?? null`; also cover `over: null` and `over.id ===
   active.id` as no-op results which issue no reorder request.  DOM-test mounted labelled grips and
   that non-grip controls are not activators, plus the 409 reload focus helper: focus the surviving
   dragged grip, otherwise the clamped nearest grip, otherwise Add.  Mock a settled reorder
   request/load and assert its grip remains focused or regains focus only after busy clears.  The
   real Space/Arrow/Space keyboard-sensor sequence and its `/reorder` request contract are required
   browser checks below, not happy-dom claims.

Add panel-integration coverage in
[`ProjectCollaborationPanel.dom.test.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx#L104),
mirroring its title-edit Escape containment test: cover six cases—each row due-date, assignee, and
ellipsis popover; each composer due-date and assignee popover; and the composer itself.  Dispatch a
cancellable, bubbling Escape **from the element that actually owns focus** in each case: the
trigger for due-date and ellipsis popovers (their explicit `initialFocus={0}`), the autofocused
assignee search input for both assignee popovers, and the autofocus composer title input for the
composer itself.  Assert `event.defaultPrevented` directly as well as asserting that only the
relevant popover/composer closes while the collaboration overlay remains open.  This proves the
required bubble-phase `preventDefault()` ordering against the panel's earlier-registered window
listener without relying on the portaled focus target being inside the panel root.

Happy-dom cannot meaningfully prove real pointer geometry, `elementFromPoint` collision behavior,
CSS hover rendering, auto-scroll, transforms, or a physical drag gesture's browser event sequence.
It also cannot reliably exercise `sortableKeyboardCoordinates`.  Do **not** overclaim simulated
pointer or keyboard-sensor events; browser verification is mandatory for actual grip-only pointer
dragging, keyboard DnD, flip/shift collision at panel/viewport edges, and hover/focus-reveal
visuals, including the actual CSS `:focus-within` reveal that happy-dom cannot assert.

### Worker tests

Update [`project-subtasks.test.ts`](../../portal/workers/app/test/project-subtasks.test.ts#L31):

1. Remove every `POST .../move`, `{ direction }`, and `project_subtask.move` assertion.  Add
   authenticated reorder tests for inserting at the beginning, middle, and end; verify list order,
   200 response position, `updated_at`/one `project_subtask.reorder` audit record, and no
   assignment notification.
2. Cover malformed/duplicate/self/cross-project neighbor ids and stale/non-adjacent neighbors as
   400/404/409 as appropriate.  Create a stale pair, change the order so those references are no
   longer adjacent, then submit the stale pair and assert 409 plus no mutation/audit; this checks
   the server's neighbor snapshot guard rather than treating client ids as authoritative.  Add a
   genuinely tied-neighbor fixture to force the rebase branch: seed the two requested adjacent
   neighbors with the exact same position (for example `1024`, with deterministic id ordering) and
   move a separate target between them; assert all list positions regain the 1024 spacing while the
   requested order is retained.  Extend that coverage with a separate 24-item fixture whose
   requested adjacent neighbors are likewise exactly tied—not merely narrowly spaced—so it reaches
   the same rebase branch and succeeds with every row correctly ordered/spaced.  It must prove the
   JSON-snapshot statement handles a list well beyond the former 16-item D1 bind-parameter ceiling.
3. Keep and make explicit the create test that sends title, eligible `assigneeId`, and due date
   together, asserting 201's serialized assignment/due value, persisted fields, one audit record,
   and the initial notification.  Keep invalid date/time and ineligible-assignee coverage, which
   proves create reuses the existing validation rather than a composer-only bypass.

### Manual/browser verification and required commands

In a real authenticated browser, use a project containing long titles, populated and unset
assignee/due values, and enough items to scroll.  At the normal 460px panel, its wide breakpoint,
and a narrow viewport, verify: due/assignee icon reveal and keyboard focus visibility, including
the actual CSS `:focus-within` reveal; every popover flips/shifts without clipping, follows the
specified non-modal portaled Tab order, closes for Escape/outside pointer/focus, and returns focus
on Escape; assignee search/toggle and due Save/Remove work; Delete confirms; the composer submits
metadata in one create; and pointer dragging begins only on the grip, auto-scrolls when needed,
and lands at first/middle/last positions.  Repeat the documented keyboard grip sequence with a
screen reader or browser accessibility tree check.  Confirm the accordion/progress and inline
title edit did not change, the old inline blocks/Move actions no longer exist, and Dashboard Kanban
reordering is untouched.

Before commit/deploy, run the project-required verification from `portal/`:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

The final explicit shared-package command is required because the workspace test command omits it.

## Routing and review

Under [`docs/Subagent-Orchestration.md`](../Subagent-Orchestration.md) §§1–2, this is a normal
frontend-plus-small-backend feature: it has no auth, payment, schema, or migration work.  It must
follow the standard plan pipeline exactly: **Terra draft (this) → fresh Terra review (at most two
rounds) → Opus plan-tier review → build**.  Any Opus-requested revision returns to a fresh Terra
within the documented capped loop.  The builder then self-checks the full plan, receives a fresh
read-only Terra diff review, resolves findings, receives the final focused review/Opus
final-draft review as required by the policy, and the orchestrator independently runs the §5
verification gate before commit and deployment.

## Review-focus decisions and risks

- The shared popover hook is intentionally narrow: it removes repeated Floating UI and global
  close-boundary logic without inventing a pseudo-generic design system.  Review trigger/floating
  ref lifetime and focus-close boundaries, particularly while replacing one open popover with
  another inside the fixed overlay.
- Creation metadata is already implemented server-side despite the prior UI not using it.  Review
  must preserve the existing strict `createInput`, eligibility check, assignment version/audit,
  and notification semantics rather than adding duplicate validation or a second PATCH.
- Reorder is an arbitrary neighbor-pair contract, not the former adjacent swap.  Review the
  composite `(position, id)` adjacency checks and rebase batch as closely as the already-proven
  board guard: a stale client must receive 409/reload, never a silently accepted incorrect slot.
- The accessibility decision is deliberate: icon controls stay mounted/tabbable while CSS merely
  changes their visibility, and the dnd-kit keyboard sensor replaces the keyboard ability lost by
  removing Move up/down.  Browser verification remains required for physical dragging and visual
  collision/reveal behavior that happy-dom cannot lay out.

## Builder notes from final Opus review (non-blocking, absorb during build)

The plan was APPROVED with one note flagged for the builder to handle as a judgment call — it did
not require a third Opus→Terra revert round:

1. **§2's post-reorder-reload focus fallback has the same composer-open gap §1's delete flow was
   fixed to handle (F5), but wasn't given the same fix.** Both currently end their fallback chain
   at "the closed-state Add button when the list is empty" — but that button isn't rendered while
   the composer is open. In §1 this was fixed by falling back to the composer's title input when
   the composer is open at the moment the list empties. §2 (an even rarer path: every other item
   gets deleted by someone else mid-drag while the composer happens to be open) still ends at the
   unfixed version. Reusing the exact same fallback wording from §1 in §2 closes it. No crash
   either way — the unfixed version just no-ops a `.focus()` call and leaves focus on `<body>` —
   so this is safe to fix inline during build rather than blocking on it.
