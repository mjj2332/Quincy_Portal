# Production Calendar and Checklist Scheduling Architecture

**Status:** Settled proposal; implementation pending  
**Related:** [TB4D](../roadmap/TB4D-Checklist-Scheduling-Ranges.md), [TB5C](../roadmap/TB5C-Production-Calendar.md), [Frontend architecture](./04-Frontend-Architecture.md), [Freshness](./05-Route-And-Data-Freshness.md), [Calendar research](../research/Production-Calendar-FullCalendar-Shadcn.md)

## 1. Domain boundary

Calendar is a projection and interaction surface over two existing domain objects:

```text
Project
  one optional project Deadline milestone

Project checklist item
  optional due milestone OR start/end scheduled range
```

Calendar does not create a second project/task database, reinterpret shoot date as project start, or turn activity/comments/uploads into calendar events.

## 2. Checklist schedule model

Allowed states:

```text
Unscheduled        start = null, end/due = null
Due-only           start = null, end/due = value
Scheduled range    start = value, end = value, start < end
```

Rules:

- start-only is invalid;
- existing `due_date` is preserved as the effective end/due value;
- date-only end remains `YYYY-MM-DD` Sydney calendar date;
- timed civil values remain minute-precision Sydney wall-clock values;
- same-day and multi-day ranges are valid;
- no arbitrary maximum range in v1;
- no recurrence.

## 3. Additive persistence direction

TB4D should preserve `due_date` during migration and add the smallest fields needed for:

- optional start civil value;
- canonical UTC instants for timed start/end;
- selected UTC offset/fold for repeated local times;
- schedule/item version for guarded mutation;
- indexes supporting project/assignee/range queries.

Date-only end values do not get an invented midnight UTC instant. A physical rename of `due_date` is optional later and must not force a risky table rebuild merely for terminology.

## 4. Sydney-time contract

- Canonical zone: `Australia/Sydney`.
- Explicit UI label: Sydney time.
- Reject nonexistent spring-forward wall times.
- Repeated fallback wall time requires first/second occurrence selection and persistence of the chosen fold/offset.
- Month movement changes calendar date while preserving a timed item's wall-clock time/duration.
- Never use the viewer's browser timezone as the domain timezone.

## 5. Checklist reminder and event behavior

- End/due remains the existing checklist reminder boundary.
- Start creates no reminder in v1.
- Changing end resets/reversions the one-shot reminder marker/version under the same guarded mutation.
- Repeated same-item/same-actor schedule changes within five minutes coalesce to at most one broad Editor notification, but every committed operation remains represented in audit/activity as designed.
- Pure schedule movement is one semantic checklist-schedule operation, not a second Calendar-specific event.

## 6. Dashboard Calendar

Calendar is the third Dashboard view:

```text
List | Kanban | Calendar
```

Initial Calendar subviews:

- Month — portfolio milestones and multi-day work;
- Week — timed scheduling and drag/resize;
- Agenda — chronological list and primary narrow-width view.

First-use default is Month/today. URL state overrides remembered local fallback. Week begins Monday, includes weekends, displays 24-hour time, and keeps the full day reachable.

## 7. Event projection

### Project Deadline

Expose:

- event type/project ID;
- Deadline instant/civil presentation;
- project address/name;
- Stage presentation;
- checklist completion count;
- overdue/delivered state;
- authorized deep link;
- editability flag based on source permission/version.

Project has no Calendar duration in v1.

### Checklist

Expose only Calendar-required fields:

- checklist ID/project ID/title;
- assignee presentation-safe identity;
- start/end or due-only representation;
- completion/overdue state;
- project/Stage context;
- schedule version;
- authorized deep-link and editability flags.

## 8. Filters

Initial controls:

- Projects / Checklist items layers;
- multi-Editor OR filter plus Unassigned;
- Stage multi-select;
- show/hide completed checklist items;
- show/hide delivered projects;
- overdue-only;
- Dashboard text search.

Semantics:

- project event matches selected Editor when that user has Editor membership on the project;
- checklist event matches selected Editor when that user is the assignee;
- no Editor selected = all otherwise authorized events;
- Calendar filtering never widens authorization;
- External Editor candidate/filter sets are constrained by their visible projects.

## 9. URL and query state

Typed query parameters own:

- active date;
- Month/Week/Agenda;
- layers;
- selected Editor IDs/Unassigned;
- selected Stage keys;
- completion/delivered/overdue toggles.

Back/Forward restores state. Copying URL shares the intended slice subject to recipient authorization. Invalid/inaccessible IDs are ignored or removed safely.

## 10. Server range endpoint

Use a dedicated range-bounded endpoint rather than browser N+1.

Request identity includes:

- visible range;
- event layers;
- filters;
- active/archived scope where allowed;
- principal/access scope.

Response contains normalized authorized event projections plus bounded Unscheduled data/counts. Search/filter/count operations are authorization-aware server-side. Do not download all historical schedule data on login.

## 11. Direct manipulation

### Existing project Deadline

- draggable only with `editProject`;
- not resizable;
- before commit show lightweight old/new Deadline plus reminder consequences;
- preserving reminder offsets creates a normal new project schedule version.

### Due-only checklist

- draggable;
- not resizable;
- Month shifts date; Week shifts timed due if timed;
- explicit editor handles date-only ↔ timed or due-only ↔ range conversion.

### Checklist range

- drag shifts start/end together preserving duration;
- end-edge resize changes end;
- start-edge resize deferred;
- Week snap = 15 minutes;
- explicit editor remains minute-precise.

### Agenda/accessibility

Agenda has no drag/resize. Every editable event provides keyboard-operable Move/Reschedule. Success/conflict/rollback is announced and focus returns predictably.

## 12. Unscheduled panel

Direct creation defaults are intentionally explicit:

- project dropped on Month → Deadline at 17:00 Sydney on target date;
- project dropped on Week → Deadline at target 15-minute slot;
- no advance reminder offsets selected automatically;
- project confirmation still required;
- checklist dropped on Month → date-only due milestone;
- checklist dropped on Week → one-hour range;
- Agenda does not accept external drag.

Empty Calendar space does not create a new project/checklist item.

## 13. Conflict, refresh, and overlap

- Optimistically render a proposed move/resize.
- Project Deadline uses expected project schedule version.
- Checklist uses expected schedule/item version.
- On `409`, revert, fetch authoritative event, keep selection/context, and explain conflict; never auto-retry stale intent.
- Incoming refresh during active drag is reconciled/deferred using the same interaction-preservation principle as TB5B.
- Same-assignee timed checklist ranges may overlap. Display a non-blocking conflict indicator; do not reject or auto-reschedule.
- Project Deadline/date-only milestones do not count as exclusive resource bookings.

## 14. FullCalendar/shadcn role

TB5C rechecks/pins the latest stable FullCalendar Standard React integration and uses FullCalendar's official shadcn registry.

Use Standard capabilities only:

- DayGrid/Month;
- TimeGrid/Week;
- List/Agenda;
- Interaction for event drag/resize/external dragging;
- named `Australia/Sydney` timezone.

No premium Scheduler/resource timeline. FullCalendar is a specialized scheduling engine, not Quincy's ordinary primitive base or visual authority. Quincy owns toolbar/filters/Unscheduled panel/event renderers/dialogs/confirmations/responsive behavior/tokens. Inspect generated registry source and do not introduce a second ordinary primitive base. Select/pin the official shadcn flavor only after matched Quincy evidence.

## 15. Non-goals

- Day/year/resource timeline in v1.
- Shoot-date event layer in v1.
- Recurrence.
- Google/Outlook/Apple/ICS synchronization/export in v1.
- Empty-slot global task/project creation.
- Hard resource-booking constraints or capacity scoring.
- Calendar-specific notification semantics.
