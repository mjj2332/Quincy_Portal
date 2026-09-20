---
status: accepted
---

# External drop into the event-calendar is SPLIT: the hit-testing lives inside the vendored tree, the Quincy policy does not

#219 PR B vendors ReUI's `@reui/event-calendar` — 13 files, `components/reui/event-calendar/` —
and adds the ability to drag an unscheduled item from outside the calendar and drop it onto the
grid. ADR 0009 is the precedent: it put the Gantt's entire keyboard layer *inside* the vendored
files. This ADR reaches the same conclusion for the drop geometry and the **opposite** conclusion
for the commit, and the reason the two halves differ is the useful part.

## The decision

| half | lives | why |
|---|---|---|
| **geometry** — resolving a pointer position to a `{ start, end, allDay, resourceId }` target | `event-calendar-dnd.tsx`, beside `beginGesture` | it needs four private functions and a private DOM contract |
| **policy** — turning that target plus an unscheduled item into a `CalendarEvent` | `src/harness/reui-scheduling/external-drop-policy.ts`, a pure function | it needs nothing private at all |

## Why the geometry had to go inside

The hit-testing the owner asked for is four module-private functions in `event-calendar-dnd.tsx`:
`collectSurface`, `findColumn`, `findCell` and `pointerMinutes`. None is exported. Together they
encode three things a Quincy module outside the tree would have to re-derive:

1. **A private DOM attribute contract.** The geometry is read entirely off `data-ec-day`,
   `data-ec-bounds-start`, `data-ec-bounds-end` and `data-ec-resource`, authored by
   `event-calendar-time-grid.tsx` and `event-calendar-resource-view.tsx`. Re-deriving that outside
   is precisely the DOM scraping the owner ruled out, and it is ADR 0009's "silently drifting the
   first time either one changes".

2. **Auto-scroll compensation.** `pointerMinutes` subtracts `surface.scrollTop -
   surface.viewportStartScrollTop` because the viewport rect is captured ONCE at gesture start —
   deliberately, for a measured reflow reason the vendor comments. A reimplementation that
   re-measured per move would be subtly wrong only while the grid is scrolling during a drag,
   which is the hardest case to notice and the easiest to ship broken.

3. **The decisive one, which is NOT in ADR 0009: gesture lifecycle is module-level singleton
   state.** `activeGestureCancels` is the set `cancelActiveEventCalendarGestures()` drains when the
   calendar unmounts, and it is not exported. A gesture registered from outside the tree would be
   invisible to it and could outlive its calendar — a stranded `window` listener still holding
   `document.body`'s cursor. That cannot be fixed from outside at any price.

`computeProposal`, the vendor's own equivalent resolver, is a **closure inside `beginGesture`**,
not a module-level function. Nothing outside could call it even if the file exported every
top-level binding.

## Why the policy had to stay outside

`applyProposedUpdate` — the vendor's commit path — maps over `getState().events` looking for a
matching `id`. It can only ever **update an event that already exists**. An external drop
**creates** one. So the commit path is genuinely decoupled: the adapter hands out a target and
calls `onDrop`, and the consumer commits through the public `api.addEvent`.

Nothing about "an unscheduled Quincy item becomes a 60-minute calendar event, all-day items get a
full day, and a grade-block cannot land on a resource column" needs a single private binding. Put
that inside the tree and it becomes vendor surface to re-merge forever, for no benefit. It is a
pure function with a node test and no DOM.

## What this cost, against ADR 0009

`git diff --numstat` from the vendor-verbatim commit (`b24f947d`) to this one, across the 13
non-test vendored files:

| | ADR 0009 (Gantt keyboard) | this (calendar external drop + per-edge resize + DST fix + re-skin) |
|---|---|---|
| net added to the vendored tree | ~2,960 | **553** |
| removed from the vendored tree | ~167 | **51** |
| edits inside the vendor's own gesture control flow | many | **zero** |

The adapter is ~420 lines in one contiguous block at the end of `event-calendar-dnd.tsx`, below
every vendor binding. It **reads** four private functions and **writes** nothing: `beginGesture`
is untouched. The 51 deletions are the re-skin, the header line, and the `canResize` →
`canResizeEdge` rename — none is gesture logic.

That is the cheapest possible re-vendor story for something that needs private access at all, and
it is the reason this ADR reaches 0009's conclusion without paying 0009's price.

### The alternative that was considered and rejected

Extending `beginGesture`'s `kind` union with `"external"` and threading a payload through it.
`beginGesture` carries roughly 35 closure variables and several `occurrence!` non-null assertions
predicated on a segment existing — assertions that are sound for move/resize/create, where a
segment always exists, and unsound for a payload-only gesture, where none does. Threading an
external gesture through it means auditing every one of them and re-paying 0009's merge cost for
no functional gain.

### Addendum — #241 (2026-09-21)

Two statements above are true of the commit they measured and no longer true of the tree. #241
painted the time grid on a wall-clock axis, and the gesture engine has to read a pixel the same
way the column paints it, so:

- **The attribute contract is six, not four.** Both grid views also publish `data-ec-wall-start`
  and `data-ec-wall-end`. They are optional to the reader: a column without them is read as
  elapsed-linear, exactly as before.
- **`pointerMinutes` was rewritten and takes `timeZone`**, and its four call sites inside
  `beginGesture` pass it. That is a one-argument edit at each site, not a control-flow change —
  every caller still receives elapsed minutes — but "`beginGesture` is untouched" is no longer
  literally so, and a re-vendor must replay it. `event-calendar-dnd.tsx` entry 5 is the
  instruction.

The decision itself is unchanged: geometry inside the tree, policy outside it.

### Addendum — #240 (2026-09-21)

#240 gave the calendar a keyboard path for MOVING and RESIZING existing events, and split it the
way this ADR split external drop:

- **The pure half is its own file**, `event-calendar-keyboard.ts` (Quincy-authored, not vendored):
  the key matcher and the proposal calculator. No DOM, no store, no private binding. The Gantt
  keeps its matcher in `gantt-lib.tsx`; the calendar's is separate because it carries four
  geometries' worth of movement rules where the Gantt has one axis.
- **The private half is inside the vendored file**, `beginKeyboardAdjust` in
  `event-calendar-dnd.tsx`, for ADR 0009's reason and this ADR's decisive one: it must join the
  module-level gesture-cancel registry. `event-calendar-dnd.tsx` entry 6 is the re-vendor
  instruction.
- **The attribute contract is seven.** The chip authors `data-ec-event-id`, which the session
  uses to find an event's chip again after a commit re-renders it as a different element. The
  session also READS `data-ec-wall-start` / `data-ec-wall-end`. Detector 9 still holds: all of
  this is inside the tree.
- **The grammar is the Gantt's, by owner decision** (ADR 0009): Space enters, M / S / E retarget,
  Enter or Space commits, Escape cancels. A vertical time-grid step is ELAPSED time, so the
  repeated hour's second pass — which #241 left unreachable by pointer — is reachable by
  keyboard. The agenda opts out: its rows are read-only by the vendor's own design.

The "Keyboard-initiated drop" bullet below is therefore half-answered: there IS a keyboard path
into the calendar now, but it adjusts events that already exist. Cell/slot navigation, keyboard
create, and a keyboard path for an unscheduled-tray drop are still open, and whether the last one
reuses `EventCalendarExternalDropTarget` is still undecided.

## What enforces this

Prose does not. `event-calendar-skin.guard.test.ts` Detector 9 scans every non-test file under
`src/` **outside** `components/reui/event-calendar/` for `data-ec-`, and fails on any hit. The day
somebody starts re-deriving the drop geometry from outside the tree, that test goes red and points
at this ADR.

## What this does NOT decide

- **Where the policy half lives long-term.** It is under `src/harness/` today because PR B ships
  no production consumer, and `src/harness/` is the one tree the build plugin and the reachability
  guard already keep out of production. When #222 wires the real panel it moves to `lib/`. The
  vendored half does not move.
- **Whether the preview is good enough.** The adapter previews a drop through the vendor's own
  `internals.setSlotDraft`, so the user sees the vendor's dashed slot box, not a Quincy-styled
  ghost of the item being dragged. That was a deliberate choice to avoid duplicating the carry-clone
  DOM, and a real consumer may want more. Revisit with a consumer in front of you, not before.
- **Keyboard-initiated drop.** #240 added a keyboard path for adjusting existing events only (see
  its addendum above); nothing yet lets a keyboard drop a tray item. Whether that
  reuses `EventCalendarExternalDropTarget` is its follow-up issue's call, not this ADR's.
