# TB5B — Kanban Interaction Modernization

**Primary user outcome:** the corrected project board is accessible, automatically refreshed and conflict-safe across pointer, touch and keyboard use.

## Preconditions

- TB5A ordering contract approved.
- TB5A correction live or otherwise established as the implementation baseline.
- Board query/freshness conventions from TB2 available.
- TB4A project deadline is included in board query/refresh data and its card-level RAW count removal is the baseline.

## Scope

- Keep project-as-card and stage-as-column.
- Migrate native HTML5 drag to dnd-kit through one bounded board implementation.
- Pointer, touch, keyboard and “Move to…” alternative.
- Visible drag handle separate from the canonical project link.
- DragOverlay, collision and nested/horizontal scroll handling.
- Route/scope/sort-keyed board query and focus/reconnect/poll refresh.
- Optimistic move with authoritative response from the TB5A contract.
- Guarded conflict behavior.
- Delay/reconcile incoming refresh while actively dragging.
- Preserve temporary view-only sort behavior and native direct/open-new-tab project links.
- Emit structured activity/outbox intent where appropriate.
- Apply the design-convergence contract to board controls/cards touched by the slice.
- Preserve the deadline label/overdue state through optimistic moves and refresh; do not reintroduce RAW count.

## Non-goals

- changing the TB5A ordering semantics;
- generic task-card database;
- separate card comments;
- card-detail feature;
- Pragmatic DnD production dependency unless dnd-kit proof fails;
- realtime board presence.

## Tests/QA

- within-column and between-column moves;
- empty columns;
- pointer, touch, keyboard and non-drag movement;
- DragOverlay and nested/horizontal scroll;
- optimistic rollback and stale conflict;
- external board change appears without reload;
- active drag is not reset by refresh;
- Board/temporary-sort control availability remains correct;
- direct project links and open-new-tab remain native;
- focus and announcements after success/conflict;
- activity/outbox exactly once;
- matched design-convergence evidence at desktop and narrow widths;
- typical board and 100+ card stress fixture.
- deadline display and absence of RAW count at desktop/narrow widths before, during and after movement.

## Acceptance

- all movement paths implement the same TB5A ordering contract;
- no pointer-only operation;
- no drag/link ambiguity;
- conflicts never silently overwrite newer state;
- refresh does not destroy an active interaction;
- the board remains coherent if the roadmap stops before TB6.

## Checkpoint

Retain dnd-kit or document a concrete measured blocker requiring a Pragmatic DnD comparison.
