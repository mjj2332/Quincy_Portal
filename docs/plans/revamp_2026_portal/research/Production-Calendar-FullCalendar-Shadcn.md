# Research — Production Calendar with FullCalendar + shadcn

**Conclusion:** FullCalendar Standard is the preferred specialized Calendar engine for TB5C, integrated through FullCalendar's official shadcn registry after Quincy's Base UI/Sera foundation exists.  
**Official-source recheck:** 2026-08-24

## Why a specialized engine

Quincy's requirement is not a static month picker. It includes Month/Week/Agenda rendering, multi-day ranges, timed overlap layout, direct event dragging/resizing, external dragging from Unscheduled, named Sydney timezone, rollback on failed persistence, responsive behavior, and accessible non-drag alternatives. Reimplementing calendar geometry from ordinary primitives would create a large bespoke interaction/layout surface unrelated to Quincy's core domain.

## FullCalendar official facts used by the plan

The official FullCalendar documentation provides:

- React integration;
- Standard DayGrid/month, TimeGrid/week, List/agenda-style views;
- Interaction support for event dragging/resizing and external dragging;
- callbacks that support reverting a failed event move/resize;
- named timezone configuration;
- an official shadcn registry for the Standard event calendar;
- multiple official shadcn visual flavors.

TB5C must recheck current stable package versions, licensing and registry output immediately before implementation rather than freezing today's patch in authority docs.

Official sources:

- https://fullcalendar.io/docs/react
- https://fullcalendar.io/docs/shadcn
- https://fullcalendar.io/docs/daygrid-view
- https://fullcalendar.io/docs/timegrid-view
- https://fullcalendar.io/docs/list-view
- https://fullcalendar.io/docs/editable
- https://fullcalendar.io/docs/eventDrop
- https://fullcalendar.io/docs/eventResize
- https://fullcalendar.io/docs/external-dragging
- https://fullcalendar.io/docs/timeZone

## Selected Quincy boundary

Use FullCalendar **Standard** only:

- DayGrid for Month;
- TimeGrid for Week;
- List for Agenda;
- Interaction for event drag/resize/external drag.

Do not add premium Scheduler/resource timeline plugins.

FullCalendar owns scheduling geometry and gesture mechanics. Quincy owns:

- Dashboard view switch;
- toolbar/date navigation;
- filters and typed URL state;
- Unscheduled panel;
- event content/identity/status;
- source capability/editability decisions;
- project confirmation and checklist schedule editor;
- conflict/DST/notification semantics;
- phone composition;
- semantic tokens and final visual treatment.

## Relationship to shadcn/Base UI

FullCalendar's official shadcn registry is a **specialized registry exception**, not a change to Quincy's ordinary primitive base.

Before adopting generated registry source:

1. inspect all generated files/dependencies;
2. identify any ordinary UI primitive dependencies that conflict with Base UI/Sera;
3. replace/wrap incompatible demo/toolbar pieces with Quincy-owned Base UI/shadcn primitives;
4. keep FullCalendar only for the calendar engine/markup it actually needs;
5. map visual variables into Quincy semantic tokens;
6. do not expose FullCalendar flavor switching to users.

The official flavor is selected by matched evidence at 1440×900, 1024×768 and 390×844 plus dense/read-only/editable/conflict states. Choose the flavor requiring the least override/drift, then pin it for TB5C.

## Alternatives not selected

### Community shadcn event-calendar projects

Not selected as the architectural foundation. They are separate community implementations and do not provide the same first-party FullCalendar engine/registry relationship. They may be inspected for ideas only if licensing/provenance is clear, but no code should be copied casually.

### Fully custom Quincy calendar

Rejected for v1 because month/time-grid/multi-day/overlap/drag-resize/touch/accessibility geometry would become a large bespoke subsystem. Reconsider only if the chosen FullCalendar Standard integration demonstrates a measured blocker against the approved Quincy UX or bundle/platform constraints.

## Implementation recheck gate

Before TB5C code:

- verify latest stable FullCalendar React/Standard packages and React 19.2 compatibility;
- inspect current official shadcn registry schema/flavors/source;
- confirm Standard-versus-premium license boundary;
- measure bundle/CSS impact;
- spike Month/Week/List with `Australia/Sydney` and one draggable/resizable fixture;
- prove permission-aware `editable`/event-specific editability, rollback callback, external drag, and focus/a11y adjunct strategy;
- compare official flavors with Quincy evidence before selecting one.
