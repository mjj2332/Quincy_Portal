# TB5B — Kanban Interaction Modernization

**Primary user outcome:** the accepted project board is accessible, automatically refreshed, and conflict-safe across pointer, touch, keyboard, and non-drag use.

**Preconditions:** TB5A Stage/order contract accepted; TB2 query conventions; TB4B Deadline metadata; TB4E External Editor scope/capabilities if that role is live before TB5B.

## Scope

- Replace native HTML5 drag with dnd-kit.
- Dedicated handle separate from project link.
- Pointer/touch/keyboard sensors and explicit **Move to…** alternative.
- DragOverlay and horizontal/nested scroll behavior.
- Board query keyed by authorization scope/sort with focus/reconnect/poll/broadcast freshness.
- Optimistic move with authoritative TB5A response/rollback.
- Reconcile/defer incoming refresh during active drag.
- Preserve Board-only reorder controls and view-only Priority/shoot-date sorts.
- Preserve direct/new-tab links, Deadline/overdue metadata, and no card RAW count.
- External Editor sees only assigned projects and can move Stage under `moveProjectStage`; no hidden broad project corpus exists client-side.
- Pure position reorder remains no broad notification.

## Calendar interaction convention handoff

TB5C uses FullCalendar rather than dnd-kit for calendar geometry, but reuses the accepted **interaction policy** proved here: explicit source capability, optimistic proposal, guarded authoritative mutation, stale rollback/no auto-retry, active-drag refresh reconciliation, keyboard/non-drag alternative, deterministic focus/announcement.

## Non-goals

Changing Stage/order semantics, generic task-card schema, duplicate comments, card detail, Calendar implementation, second production Kanban drag engine, realtime presence.

## Acceptance

All board movement paths implement TB5A, no pointer-only operation/drag-link ambiguity exists, conflicts never overwrite newer state, authorization scope is server-safe, and the interaction conventions are stable enough for TB5C to consume without sharing drag engines.
