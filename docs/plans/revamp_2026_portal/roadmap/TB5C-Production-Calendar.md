# TB5C — Production Calendar

**Primary user outcome:** Admins, internal Editors, and assigned-scope External Editors can visualize, filter, navigate and directly reschedule authorized project/checklist work on a shared production Calendar.

**Sequence:** after TB5B, before TB6  
**Dependencies:** TB2 freshness/URL conventions, TB4B project Deadline, TB4D checklist scheduling, TB4E External Editor authorization/projection, TB5B interaction policy, TB1 shadcn platform

## Dashboard surface

Add third Dashboard view:

```text
List | Kanban | Calendar
```

Initial subviews:

- Month;
- Week;
- Agenda.

First use Month/today; URL state wins over remembered fallback. Week starts Monday, includes seven days, uses 24-hour Sydney time and full-day reachability. Phone defaults to Agenda; Month remains compact with selected-day/list disclosure. Week phone interaction must prove usability or fall back to action-based editing rather than shrinking desktop geometry blindly.

## Audience/access

- Admin/internal Editor: their normal authorized project scope.
- External Editor: assigned projects only.
- Calendar never broadens project authorization.
- External Editor sees all scheduled work on assigned projects plus **My tasks** quick filter; project Deadlines read-only, checklist scheduling mutable under Collaboration rights.

## Event layers

### Project
One milestone at project Deadline. Show address/name, Stage, checklist completion, overdue/delivered state. No duration inferred from shoot date and no synthetic elapsed-time progress percentage.

### Checklist
Due-only milestone or scheduled range. Show title, assignee, project/Stage context, completion/overdue state.

No shoot-date layer, activity/comment/upload events or recurrence in v1.

## Filters and URL state

Initial controls:

- Projects / Checklist items;
- multi-Editor OR plus Unassigned;
- Stage multi-select;
- show/hide completed checklist items;
- show/hide delivered projects;
- overdue-only;
- Dashboard search.

Project event matches selected Editor membership; checklist event matches selected assignee. URL query owns active date/subview/layers/Editor IDs/Stage/status toggles. Back/Forward and copied links restore the same authorized slice; inaccessible IDs are ignored/removed.

## Server range API

Use one range-bounded, server-authorized Calendar endpoint plus bounded Unscheduled projection. Request/query identity includes visible start/end, layers, filters, scope and principal/access state. Return only Calendar-safe fields. No browser N+1 project→checklist fetches, all-history login download, or client-side authorization.

## Direct manipulation

### Project Deadline

- draggable only with `editProject`;
- never resizable;
- project move opens lightweight confirmation with old/new Deadline and reminder consequences;
- same TB4B schedule version/offset/DST/event command; no Calendar-specific mutation semantics.

### Checklist

- due milestone draggable, not resizable;
- range drag preserves each endpoint's Sydney civil/wall-clock time-of-day on the moved dates, not
  elapsed duration, across DST;
- end-edge resize changes end; start-edge resize deferred;
- Month moves whole days preserving each endpoint's Sydney civil/wall-clock time-of-day, not elapsed
  duration, across DST;
- Week snap 15 minutes;
- Agenda uses Move/Reschedule action;
- explicit editor performs timed/date-only and due-only/range conversion.

Every editable event has keyboard-operable Move/Reschedule. Success/conflict/rollback announcements and focus return are deterministic.

## Unscheduled panel

- Project → Month drop = 17:00 Sydney Deadline on target date; Week drop = target 15-minute slot; no reminder offsets invented; confirmation required.
- Checklist → Month drop = date-only due milestone; Week drop = one-hour range.
- Agenda no external drag.
- External Editor can drag unscheduled checklist entries but not project Deadline entries.
- Empty Calendar space does not create new work.

## Conflict/DST/overlap

- Optimistic event placement then guarded domain mutation.
- Stale `409` reverts/fetches authoritative state and never auto-retries.
- Sydney DST gap rejects/reverts; repeated time asks first/second occurrence.
- Incoming refresh during active manipulation is reconciled/deferred.
- Same-assignee timed checklist overlaps allowed; display non-blocking conflict indicator; completed/date-only/project Deadline entries do not become hard bookings.

## FullCalendar + shadcn

At implementation recheck and pin latest stable **FullCalendar Standard** React integration via FullCalendar's official shadcn registry.

Use Standard DayGrid/TimeGrid/List/Interaction only; no premium Scheduler/resource timeline. FullCalendar owns calendar geometry/drag/resize/external drop mechanics. Quincy owns Dashboard integration, toolbar, filters, Unscheduled panel, event rendering, edit/confirm dialogs, role/read-only treatment, responsive/accessibility and semantic styling.

Inspect registry source/dependencies before adoption so the one Calendar registry exception does not create a second general primitive system. Compare official FullCalendar shadcn flavors against Quincy evidence and pin the least-drift flavor; users do not choose themes.

## Non-goals

Day/year/resource timeline, shoot-date layer, recurrence, external Google/Outlook/Apple/ICS sync/export, empty-slot creation, hard capacity booking, Calendar-specific notifications.

## Tests/QA

- authorized range endpoint and no project leakage;
- Month/Week/Agenda + phone behavior;
- URL state/back-forward/share;
- Editor/Unassigned/Stage/status/search filters;
- project/checklist event presentation/progress;
- project drag confirmation/reminder version;
- checklist drag/end-resize/15-minute snap;
- Unscheduled defaults;
- Sydney gap/fold;
- stale rollback/no retry;
- overlap indicator;
- keyboard action/focus/announcement;
- refresh during drag;
- External Editor assigned-only/read-only-vs-mutable behavior;
- dense/multi-day/performance fixture;
- matched Quincy evidence and bundle/CSS/dependency review;
- full gate/manual QA.

## Acceptance

Calendar is a third authorized projection over existing project/checklist sources, not a parallel scheduling system. All three audiences can use it without access leakage, and direct manipulation remains permission-, timezone-, notification-, conflict- and accessibility-consistent with canonical source editors.
