# TB5B — Kanban Interaction Modernization

**Primary user outcome:** the accepted project board is accessible, automatically refreshed, and conflict-safe across pointer, touch, keyboard, and non-drag use.

**Preconditions:** TB5A Stage/order contract accepted and live/baseline; TB2 query conventions available; TB4B Deadline metadata baseline.

## Scope

- Replace native HTML5 drag with dnd-kit.
- Dedicated drag handle separate from project link.
- Pointer, touch, keyboard sensors and explicit **Move to…** alternative.
- DragOverlay and horizontal/nested scroll behavior.
- Board query keyed by scope/sort and focus/reconnect/poll freshness.
- Same-browser invalidation.
- Optimistic move with authoritative TB5A response/rollback.
- Reconcile/defer incoming refresh during active drag.
- Preserve Board-only reorder controls and view-only Priority/shoot-date sorts.
- Preserve direct/open-new-tab links, Deadline/overdue metadata, and no card RAW count.
- Emit only accepted activity/outbox semantics; pure position reorder remains no broad notification.

## Non-goals

- changing Stage/order semantics;
- generic task-card schema;
- duplicate comments;
- card detail;
- second production drag engine;
- realtime presence.

## Tests/QA

- within/between/empty-column moves;
- pointer/touch/keyboard/non-drag;
- handle/link separation;
- DragOverlay and nested/horizontal scroll;
- optimistic rollback/stale conflict/focus/announcement;
- external change without reload;
- active drag survives refresh;
- view-only sort controls/write behavior;
- direct link/new tab;
- normal and 100+ card fixture;
- Deadline/no RAW before/during/after movement;
- matched desktop/compact/phone evidence;
- full gate/manual QA.

## Acceptance

All movement paths implement TB5A, no pointer-only operation or drag/link ambiguity exists, conflicts never overwrite newer state, and dnd-kit is retained unless a concrete measured blocker justifies a separately reviewed alternative.
