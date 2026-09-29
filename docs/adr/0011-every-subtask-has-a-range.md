---
status: accepted
---

# Every Subtask has a range: unscheduled and due-only are gone

A Subtask used to be in one of three scheduling states — unscheduled, due-only (a milestone), or
range — derived from which date columns were filled. We collapse that to one: every Subtask has
a Subtask range, one day at the shortest. Three states cost a mode picker in two editors, a
milestone diamond and an "Unscheduled" badge on the Gantt, an Unscheduled panel and an external
drop on the calendar (ADR 0010), and a kill-switch that could leave ranges unavailable. The
screens that consume a schedule all want a span anyway.

When no range is given, one rule supplies it — on the project page, on the Gantt's "Add task",
and in the one-time migration of existing rows: copy the Project's shoot date to Deadline, once;
the copy is the Subtask's own thereafter and does not follow later Project reschedules. A missing
or unparseable shoot date falls back to the Project's creation date, a missing Deadline makes a
one-day range, and a range never runs backwards — any inversion collapses to one day on the
later-known end (the Deadline, or the old due date). Historical: this conversion was applied once by the
#341 backfill and no code implements it now. A former due-only Subtask keeps its due as
the end and starts on the shoot date; a timed one starts at 00:00 studio time on that date, so
the range never mixes a date end with a timed end.

## Consequences

- ADR 0010 (external drop onto the calendar) is superseded once this lands: there is nothing
  unscheduled left to drop.
- A Subtask's "due" is the end of its range, so due-day reminders and overdue checks are
  unchanged — but migrated Subtasks now carry an end and can be overdue on arrival.
- Reversing this needs a data migration, not a flag: the database enforces that a range exists.
