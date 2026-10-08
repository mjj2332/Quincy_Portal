---
status: accepted
---

# The Gantt's keyboard layer (Adjust mode, `nudgeEvent`, per-edge resize) lives inside the vendored tree, not a Quincy wrapper

#219 PR A vendors ReUI's `@reui/gantt` — 9 files, `components/reui/gantt/` — then builds Quincy's
entire keyboard story for it directly inside those same 9 files rather than around them:
per-edge resize (a project bar's shoot/start edge is fixed, owner decision on #215), the modal
Adjust session (`gantt-bar.tsx`'s `matchGanttBarKey`/Space-to-enter/Arrow-to-step/Enter-to-commit),
`GanttApi.nudgeEvent` and the `GanttInternals` Adjust methods it and Adjust both call
(`gantt.tsx`), the pure keyboard-proposal math (`gantt-lib.tsx`'s
`computeGanttKeyboardProposal`/`isResizableEdge`), the announcement copy (`gantt-i18n.tsx`), and
the keyboard-owned ghost the existing drag-preview machinery now also renders (`gantt-view.tsx`).

`docs/reui-block-adoption.md:45-47` (the Board's own lesson) says: prefer additive props over
rewrites. `docs/reui-reuse.md:5-6` says a hand-rolled element needs its reason written in the
plan. Building ~2,800 new lines directly into a vendored tree is neither additive props nor
hand-rolling from scratch — it is a third thing this repo had no ADR for yet. This is that ADR.

## What was added, and roughly how much

`git diff --stat 4bb46296 HEAD` (the vendor-verbatim commit) against the current tree, test files
excluded:

| file | added / removed |
|---|---|
| `gantt-bar.tsx` | +679 / −10 |
| `gantt.tsx` | +962 / −13 |
| `gantt-dnd.tsx` | +227 / −99 |
| `gantt-view.tsx` | +380 / −37 |
| `gantt-lib.tsx` | +447 / −0 |
| `gantt-types.tsx` | +170 / −5 |
| `gantt-i18n.tsx` | +85 / −1 |
| `gantt-nav.tsx` | +8 / −2 |
| `gantt-recurrence.tsx` | untouched |

Roughly 2,960 net added lines across eight of the nine files. `gantt-lib.tsx` DID exist in the
registry item — 735 lines at the vendor-verbatim commit (`git show 4bb46296:…/gantt-lib.tsx | wc
-l`) — it is not a tenth, Quincy-only file; every one of its +447 lines is a pure ADDITION with
zero deletions, meaning the new keyboard/overlap math was appended beside the vendor's own
exports rather than replacing or restructuring anything already there. See below for why that
math lives here (inside the vendored file it shares a cycle-avoidance constraint with) rather than
in `components/quincy/`.

## Why it lives in the vendor tree rather than a Quincy wrapper

The honest reason is coupling, not convenience: the keyboard layer needs the same internals the
pointer layer already owns, and a wrapper would have had to re-implement or re-export most of
them rather than add a genuinely separate capability beside them.

- **The store's internals.** `nudgeEvent` and the five Adjust methods (`gantt.tsx`) are instance
  API methods on `createGanttStore`'s own closure, because the keyboard focus hand-off
  (`claimKeyboardFocus`/`consumeKeyboardFocus`/`clearKeyboardFocus`) has to survive a React
  remount: moving or resize-starting an event changes `segment.occurrence.key`
  (`gantt-lib.tsx`'s `buildEventIndex`), which unmounts and remounts the bar's DOM node and drops
  focus with no help from React. A Quincy wrapper sits one level up, in the React tree the store
  itself has no access to — it cannot claim a token inside a store closure it does not own, and
  duplicating the store to give a wrapper one of its own would mean forking the whole instance,
  not wrapping it.
- **The segment/occurrence model.** `computeGanttKeyboardProposal` needs the same day-grid snap,
  RTL axis and zoned-civil-day semantics `gantt-dnd.tsx`'s pointer `computeProposal` already
  encodes, so it was extracted to `gantt-lib.tsx` (the file with the largest share of pure
  additions, zero deletions) specifically so both `gantt.tsx`'s `nudgeEvent` and the eventual
  pointer path could share it without a cross-file
  cycle (`gantt-dnd.tsx` already imports from `gantt.tsx` for `useGantt`/`GanttInstance`, so the
  reverse import was not available). A wrapper outside the tree would need its own copy of that
  geometry — the exact "re-implement" half of the tradeoff.
- **The locked-edge/overlap/canDropEvent checks the pointer path runs.** `nudgeEvent`'s refusal
  gate (`proposeNudge`) is deliberately the *same* gate `gantt-dnd.tsx`'s pointer release now runs
  (`changeBlockedLocked`/`Invalid`/`Rejected` — renamed from `keyboardNudge*` once both paths
  needed the same three labels, dr-219a HIGH #1), the same `resolveOverlapPolicy`/
  `overlapsAnyNeighbour`/`clampToNeighbours` helpers, and the same per-edge `canResize` extracted
  in `gantt-dnd.tsx`. None of that is exported for outside reuse today — it is private to the
  registry item's own module graph — so a wrapper calling into it would either need those
  internals exported (widening the vendor's public surface for one consumer) or reimplemented
  (silently drifting from the pointer path's own rules the first time either one changes).

Put together: the keyboard layer is not a new feature bolted beside the Gantt, it is the Gantt's
existing gesture engine given a second input device. The two paths converge on the same
proposal, the same overlap rules, and the same announcement labels by construction, not by
discipline maintained across a file boundary — and that convergence is the actual correctness
property being protected (`nudgeEvent`'s comment thread and `gantt-dnd.tsx`'s pointer-release fix
both reference each other directly).

## Where a wrapper genuinely would have worked — said plainly, not glossed over

One of the eight edits is not like the rest: `gantt-nav.tsx`'s `border-border` fix (dr-219a
HIGH #3 — Tailwind v4 preflight's `border: 0 solid currentColor` painting a bare `border-b`
near-black). `GanttNav` already accepts a `className` prop merged through `cn()` at the end of its
own class list, and `border-border` (a color utility) and `border-b` (a width utility) are
different Tailwind class groups that `cn`'s tailwind-merge does not treat as conflicting — a
consumer passing `className="border-border"` (or `viewConfig.classNames?.nav`) from OUTSIDE the
vendor file would have fixed this exact defect with zero vendor edits. It was fixed in place
instead, alongside the file's other in-place fixes, for consistency of where skin fixes live in
this tree (`gantt-skin.guard.test.ts` scans the vendored files themselves, not a wrapper) — not
because a wrapper was infeasible here. Unlike the keyboard-layer edits above, this one did not
need to live in the vendor tree; it does, by choice, not by necessity.

## Considered options

- **A Quincy wrapper around `<Gantt>`/`<GanttBar>` that adds `onKeyDown` externally.** Rejected —
  see "the store's internals" above; a wrapper cannot reach `claimKeyboardFocus` or the private
  overlap/canDrop helpers without either an export surface built solely for it or a duplicated
  proposal engine that silently drifts from the pointer path.
- **Fork the Gantt into `components/quincy/`, the way the star control was forked (ADR 0003).**
  Rejected — ADR 0003's control was mouse-only and small; forking a 4,400-line, 9-file headless
  scheduling engine to add a keyboard layer would mean maintaining the WHOLE surface, not the
  narrow accessibility gap a fork bought for the star control.
- **Edit only the files the keyboard layer strictly touches, wrapper the rest.** Rejected as
  false economy — `gantt-nav.tsx`'s border fix (above) shows the boundary is not clean per-file;
  most of the nine files needed at least one edit, and splitting "vendor-owned" from
  "Quincy-owned" file-by-file would not have reduced the coupling, only hidden where it crosses.

## What this costs

A future ReUI version bump of `@reui/gantt` is a merge, not a re-vendor. The next `add` into the
sandbox will not land as a clean drop-in the way the Board's `kanban.tsx` (three small, additive
edits — `docs/reui-block-adoption.md`) does; it is a real merge against ~2,960 lines of Quincy
logic interleaved through the vendor's own control flow, closure state, and type definitions.

## What keeps that tractable

The per-file provenance headers. Every one of the nine files opens with the mechanical VERBATIM
edits (import paths, `cn`, the dropped `"use client"`) and then a dated, numbered log of every
Quincy edit after that — what changed, which issue or review round drove it, and why, in the order
it happened. A future re-vendor's job is to diff the new registry output against the same
sandbox process this vendoring used, then replay each dated entry in each header against the new
file, the same way this ADR's own table was built by reading those headers rather than reverse-
engineering the diff. The header is the merge instructions; losing it is the actual cost of this
decision, not the line count.

## Consequences

Do not "clean up" a Gantt file's keyboard logic into a `components/quincy/` wrapper on sight — the
coupling above is why it is not there, not an oversight. `gantt-nav.tsx`'s border fix is the one
counter-example on record; it stays in place for consistency with the guard that scans this
directory, not because it had to.

## How to verify

`gantt-adjust-*.dom.test.tsx`, `gantt-dnd-refusal-announce.dom.test.tsx`,
`gantt-bar-resize-grips.dom.test.tsx` and `gantt-nudge-event.dom.test.tsx` exercise the keyboard
layer directly; `gantt-resize-edges.test.ts` covers `canResize`/`isResizableEdge` in the node
suite. `gantt-skin.guard.test.ts` and `test-seam.guard.test.ts` (guard F) are the standing guards
against a re-skin or a vendor-slot test dependency creeping back in.

## Addendum (2026-09-27, #221)

#221 lets a subtask be dragged outside its project's shoot..deadline window: allowed, but with a
warning (caution styling and a reason beside the cursor while dragging, the reason announced on the
keyboard path), never blocked. Two additive vendor seams carry it, and both live in this tree for
the same reason the keyboard layer does:

- **`dropWarning(update) => string | null`**, beside `canDropEvent`. The surfaces it has to reach —
  the drag ghost (`gantt-view.tsx`), the cursor-following move clone and resize chip
  (`gantt-dnd.tsx`'s closure DOM), the announcer writes on pointer release, and the Adjust
  session's step/commit announcements (`gantt.tsx` / `gantt-bar.tsx`) — are all private to the
  vendor. A wrapper cannot style a ghost or append to a chip it never sees.
- **`onEventUpdate` may return `"deferred"`** — accept-and-defer: the consumer took the proposal
  and owns what happens next (a confirmation dialog, for example); the Gantt neither mutates
  `events` nor announces. It exists because `false` announces "That change was rejected." for a
  drop the consumer actually accepted (owner decision 2026-09-27).

What stays OUT of the vendor tree: the POLICY. What counts as "outside shoot..deadline", and the
reason text, belong to Quincy code (the consumer passes `dropWarning`). The vendor only renders and
announces whatever reason it is handed. Invalid beats warning: `dropWarning` is only consulted for a
proposal that is already valid, so a drop is never both. With neither seam used, DOM, announcements
and behaviour are unchanged. `gantt-drop-warning.dom.test.tsx` covers both.

The #219 comment inherited on #221 pointed at the event-calendar tree and ADR 0010 for this; that
was a mistake — the Gantt's seams are recorded here, not in 0010.

## Addendum (2026-09-29, #344)

#344 gives every expanded Project its own "+ Add task" row, which the vendored tree's single root
create-task button could not do. Two additive seams, again in this tree, because the row must sit
between the tree's own rows and be paired with a timeline spacer of the same height:

- **`onCreateGroupTask({ parentId, index, title })`** (presence opts in), gated per group by the
  existing `canCreateTask({ parentId })`. The row appears after each EXPANDED group's last
  descendant. A resource that declares a `children` array, even an empty one, counts as a group, so
  a Project with no Subtasks can be expanded and given its first. The callback resolves
  `{ ok: true }` (the row closes) or `{ ok: false, message }` (the typed title stays, the input is
  marked invalid and the message is announced from a polite status node in the row). The row keeps
  one fixed height in the tree, the timeline spacer and the dependency layer, so it never grows or
  overlays to show a message (an overlay was clipped by the tree's scroll edge): the vendor's own
  empty-title refusal shows as the empty input's placeholder, and the consumer makes a failed
  write's message visible (Quincy: a toast). The root-level `onCreateTask` / `displayCreateTaskHint`
  affordance is unchanged.
- **Up/Down focus movement** between the tree's row focus targets (group toggle, row checkbox, the
  create row), in DOM order. It is a small extension of this layer, not a change to the bar
  Adjust keyboard: bars are in the timeline pane and are untouched. Enter or Space on the row opens
  the input; Enter in the input submits; Esc cancels and returns focus to the row.

What stays OUT of the vendor tree: the write itself (`POST /api/projects/:id/subtasks`, title only,
the server applies the default range), the permission (`permissions.canEditChildren`), the error
copy, the hidden-by-filters pin and its toast. The vendor renders the row and its input and reports
what was typed. `gantt-create-task.dom.test.tsx` covers the seam; `ProductionGantt.writes.dom.test.tsx`
covers the consumer.

## Addendum (2026-10-07, #678 + #679): the "+" on the Project row, and an editor that keeps the row's columns

The idle "+ Add task" row under every Project was visual noise (#679), and the open editor's title
input covered the whole row, hiding Assignees and Due (#678). Both changes are additive and stay
inside this tree, for the same reason as #344 (the editor sits between the tree's own rows and is
paired with a timeline spacer):

- **No idle rows.** A creatable group's own row carries a `+` (`reui/button` ghost `icon-xs`, still
  `data-testid="gantt-group-create-task"`, a `data-gantt-tree-focus` stop after the chevron and the row's
  link, in visual order, before the next row; `sticky end-0` on a `bg-background` backing so a
  phone's narrow tree pane never clips it). It opens ONE editor row under the group's last visible descendant (the group's own
  row when it has none); a collapsed group expands first. `createAfter` holds only the open group,
  so the tree row, the timeline spacer and the dependency offset still read one source. An empty
  creatable group is now a leaf. Another group's `+` moves an EMPTY editor, and keeps a dirty one
  (a typed title, or the consumer's `createTaskDirty`) and focuses it, so nothing typed is lost.
- **The editor keeps the row's cells.** `GanttGroupCreateRow` mirrors `GanttTreeRow`: a name cell
  (the cancel x in the toggle gutter, then the title input) and one cell per column rendering the
  new `GanttColumn.renderCreate(ctx)`. With no column carrying one (the names-only layout, < 1024px since #734, `columns: []`)
  the editor is a **bottom sheet** instead of a row (owner decision, #678 round 2): the same component on
  `reui/sheet.tsx` (`side="bottom"`), headed "New task in <Project>", holding the title input, the
  new `renderCreateStack` controls (Assignees, Due) and Cancel / Add. It has no row, spacer or dependency
  offset (`createRowRem` is 0), and it provides an `OverlayContainerContext` slot like `ProjectSheet` so the
  controls' popovers portal inside its focus trap; `finalFocus` returns focus to the opener `+`.
- **Draft lifecycle contract.** The vendor owns the open state and the title; the consumer owns the
  rest of the draft and is told when the editor closes: `onCreateTaskClose({ parentId })` (cancel,
  success, collapse, the group leaving the data, the whole view unmounting, a changed
  `createTaskResetKey`). The editor row handles Escape on the input and, from #688, on any control inside the row that is DOM-contained in it and not `aria-expanded="true"` (a closed draft picker, the x): it closes the row and drops the draft. The draft's popups portal
  out of the row but their events bubble through it (#585, #670), so the containment check is the guard.

Reuse ledger for the phone sheet: the sheet itself `reui/sheet` (base-nova); Title input `reui/input`; Cancel / Add `reui/button`; the Title, Assignees and Due labels `reui/field` `FieldLabel` (a real `<label htmlFor>` above each control).

What stays out: the write (one `POST /api/projects/:id/subtasks` carrying `assigneeIds` / `schedule`
/ reminders only when set, the Checklist composer's body), the permission, the pickers
(`quincy/SubtaskAssigneePicker`, `quincy/SubtaskScheduleControl`) and the draft's state.
`gantt-create-task.dom.test.tsx` covers the seam; `ProductionGantt-create-draft.dom.test.tsx` and
`ProductionGantt.writes.dom.test.tsx` cover the consumer.

## Addendum (2026-10-08, #722 via #726 / #727 / #728): one scroller, a hard tree floor, two Quincy-only files

The Timeline had two scroll panes (tree and timeline) kept in step by a bidirectional scroll-sync
and a wheel driver, which drifted and put JS on the scrolling path. #722 restructures it in three
steps, all inside this tree for the same reason as everything above: the layout, the geometry reads
and the gesture handling are private to `gantt-view.tsx` / `gantt-dnd.tsx` / `gantt.tsx`.

- **Two panes become one scroller (#727).** `bodyRef` no longer scrolls. It holds the single scroller
  (`data-gantt-scroller`), whose content is a sticky `start-0`, x-clipped tree column and an isolated
  timeline column, each with its own sticky-top header. Tree rows and bars share one `scrollTop`, so
  they cannot drift; the scroll-sync and the wheel-driver effect are deleted. The splitter, the lane
  overlay (zoom control, offscreen chips) and the tree overlay (reorder indicator) are overlays
  outside the scroller, so "the visible pane rect" reads keep meaning what they did
  (`laneOverlayRef` / `treeOverlayRef`). The tree's width is one CSS variable, `--gantt-tree-inset`,
  on the body. Behaviour change: the tree no longer scrolls sideways on its own (it clips), and a
  horizontal wheel over it pans the timeline.
- **`GanttTreePanelConfig.minWidthHard` (#727), additive, default false.** Because the tree clips
  rather than scrolls, a consumer whose columns must stay visible (the Production Gantt) needs
  `minWidth` to be a floor, not a preference the container can override. With it set, the timeline
  lane takes what remains, capped only by the container. Without it the vendor clamp is unchanged.
- **Two new files, Quincy-only.** Neither exists in the registry item, and both are here for the
  reason `gantt-lib.tsx` is: the logic is shared by more than one vendored file and a wrapper could
  not reach it.
  - `gantt-track-geometry.ts` (#726, extended in #727): the one place the horizontal track geometry
    (`start`, `visibleWidth`, `trackWidth`, minus the tree inset) is computed, plus
    `GANTT_SCROLLER_SELECTOR`, `findScroller`, `GANTT_TREE_COLUMN_SELECTOR` and `GANTT_HEADER_PX`.
    `gantt-view.tsx` (auto-centre, infinite edge growth, re-seat, zoom anchors, header pan, chips),
    `gantt-dnd.tsx` (edge auto-scroll) and `ProductionGantt.tsx` all read it. Inlining it would put a
    copy of the RTL fold and the inset rule in each, which is the drift this change removes.
  - `gantt-wheel-zoom.ts` (#728): the only non-passive wheel listener in the Gantt. A cancellable
    listener makes the browser wait on script before it scrolls, so it must not sit on the scroller
    in the steady state; this helper attaches it only while Control or Meta is held (and uses
    `gesturestart` / `gesturechange` where `GestureEvent` exists), skipping the tree column so page
    zoom still works there. It is a self-contained lifecycle with module-level modifier state, which
    belongs beside, not inside, the 5,000-line view.
- **Scroll intent.** The intent listeners that gate infinite range growth moved to the body (the
  scroller spans the tree now). A pointer press or key inside the tree column edits the tree and
  scrolls nothing, so it is not intent; a wheel or touch there still is.

What stays out: the Production Gantt's choice of `minWidthHard` and its tree widths (consumer
policy). Covered by `gantt-single-scroller.dom.test.tsx`, `gantt-track-geometry.dom.test.tsx`,
`gantt-wheel-zoom.dom.test.tsx` and `gantt-view-overflow-clip.dom.test.tsx`.

## Addendum: names-only below 1024px, chips wait for the label (#734)

#734 (owner-approved follow-up to #722) moves the names-only task list from phones (<= 720px) to every
viewport below 1024px, because the 396px Name/People/Due list left a ~208px lane at 780px. This is a
consumer decision (`ProductionGantt.tsx` splits its old `narrowTree` into `namesOnly`, < 1024px, and
`phone`, <= 720px, which only picks the 44px row metric), so the vendor-tree surface that changes is small:

- **Create stack.** With no column carrying `renderCreate` (`columns: []`), the add-task editor is the
  bottom sheet at every width below 1024px, not only on phones. Nothing in `GanttGroupCreateRow` changed.
- **`GanttOffscreenChips`.** The chip appears once the bar and its external label are both outside the
  lane, using the label's measured rect rather than an estimated text width. The decision is the pure
  `offscreenSide` in `gantt-track-geometry.ts`, which `gantt-offscreen-side.test.ts` covers.
- **`zoomControl`** is the existing prop; the consumer passes `false` on the names-only layout.
  `wheelZoom` is independent of it and stays on.
- **#738: the zoom control can render into a consumer-provided target.** `GanttView` takes
  `zoomControlTarget?: HTMLElement | null`. An element portals the buttons into it as a toolbar
  `ButtonGroup` (ghost `icon-sm`, tooltip below); `undefined` keeps the floating box (vendor consumers,
  harness); `null` renders neither until the target mounts. Zoom state stays inside `GanttView`, so
  wheel and pinch anchoring is unchanged. The Production Gantt targets the Timeline nav row.

Covered by `gantt-offscreen-side.test.ts`, `gantt-offscreen-chips.dom.test.tsx`,
`gantt-wheel-zoom.dom.test.tsx`, `gantt-zoom-target.dom.test.tsx`, `ProductionGantt-zoom.dom.test.tsx`
and `ProductionGantt-narrow-layout.dom.test.tsx`.
