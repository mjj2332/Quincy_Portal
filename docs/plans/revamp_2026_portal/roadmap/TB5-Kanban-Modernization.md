# TB5 — Existing Kanban Modernization

**Primary user outcome:** the current project board is accessible, automatically refreshed and conflict-safe.

## Scope

- Keep project-as-card and stage-as-column.
- Migrate native HTML5 drag to dnd-kit through one bounded board implementation.
- Pointer, touch, keyboard and “Move to…” alternative.
- DragOverlay/scroll handling.
- Route-keyed board query and focus/poll refresh.
- Optimistic move with authoritative response.
- Guarded conflict behavior.
- Preserve priority, `boardPosition` and shoot-date modes.
- Emit structured activity/outbox intent when appropriate.

## Non-goals

- generic task-card database;
- separate card comments;
- card-detail feature;
- Pragmatic DnD production dependency unless dnd-kit proof fails;
- realtime board presence.

## Acceptance

- moves within/between columns;
- empty columns;
- keyboard/non-drag movement;
- touch and nested scroll;
- rollback/conflict;
- external board change appears without reload;
- active drag is not reset by refresh;
- direct project links/open-new-tab remain native.

## Checkpoint

Retain dnd-kit or document a concrete blocker requiring a Pragmatic DnD comparison.
