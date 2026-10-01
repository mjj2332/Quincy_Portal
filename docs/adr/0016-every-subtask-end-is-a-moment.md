---
status: accepted
---

# Every Subtask end is a moment; all-day is a preset time, and reminders count back from it

Amends ADR 0011.

ADR 0011 left every Subtask with a range, but each range was either date-only or timed, chosen
by a Date/Timed mode shared by both ends. Every date and time field is moving to one
`schedule-10` popup, and Subtasks are gaining configurable reminders like the Deadline's. A
date-only end has no instant to count a reminder back from, and the mode would have meant an
"All day" toggle in every popup. Instead, the date-only kind is retired: every Subtask start and
end is a Sydney civil date-time. Picking a date without a time fills in a preset: **09:00** for a
start, **17:00** for an end (and for a Deadline picked by a date-only shortcut). The default
Subtask range becomes the shoot date at 09:00 through the Deadline at its own time.

Subtask reminders mirror Deadline reminders. They count back from the Subtask's due (the end of
its range): "Due now" is always on, 1 day / 4 hours / 1 hour or custom offsets can be added (at
most 8), and every Subtask assignee receives them. Every Subtask defaults to "1 day before" plus
"Due now". Completing the Subtask or archiving its Project cancels pending reminders, and changing
the range reschedules them.

## Considered options

- **Keep date-only ends behind an "All day" slot per end, with reminders anchored at 08:00 on the
  end day.** Rejected: it keeps a second kind of endpoint in every reader (Calendar, Timeline,
  validation, reminders) to save typing a time.
- **Default to "Due now" only, as the old single alert did.** Rejected: with a 17:00 end, the old
  08:00 "due today" heads-up would have become an alert at the due time, too late to act on.
  "1 day before" restores a warning in advance.

## Consequences

- Existing date-only Subtasks are migrated by filling in the presets (09:00 start, 17:00 end) and
  given the default reminders. The `date` endpoint kind, the `subtask_schedule_mixed_endpoint_kinds`
  rule and the hourly 08:00 `scanDueSubtasks` "due today" pass are retired with them.
- A range now only needs its start before its end; the old one-day minimum came from date-only
  ends.
- The Calendar shows every Subtask as a timed event, never as a date-only chip. A Subtask inside one
  day sits in the Week and Day time grid between its start and end. A Subtask that spans days follows
  the event calendar's own convention for a multi-day timed event, a bar across its days in the
  all-day lane; the vendor tree is not forked to change that.
- The presets are code constants, not admin configuration.

## What shipped in #423

- **One picker.** The range variant of the date-time popup (`DateTimeField variant="range"`) is the
  only way to set a Subtask range, in all four editors: the Checklist row, the Checklist composer, the
  Timeline Subtask cell and the Calendar's schedule editor. A Start | End toggle chooses which end the
  calendar, the time column and the typed time edit. Today, Tomorrow, This week (today 09:00 to Sunday
  17:00), Next week (Monday 09:00 to Sunday 17:00) and, when the Project has one, Project default set
  both ends at once. A repeated daylight-saving time asks Earlier or Later per end, and Apply stays
  disabled until the start is before the end by instant. The Date/Timed select, the native endpoint
  inputs and the fold radios are gone.
- **Presets are constants.** `SUBTASK_START_PRESET_TIME` (09:00) and `SUBTASK_END_PRESET_TIME`
  (17:00) in `packages/shared`; a day picked without a time takes the preset for its end.
- **Default range.** An untouched new Subtask takes the Project default: the shoot date at 09:00
  through the Deadline at its own time (the Sydney creation date without a shoot date; that day 09:00
  to 17:00 without a Deadline; and when the Deadline is not after the start, the start moves to 09:00
  on the Deadline's day, or the day before). The list response carries it as `projectDefaultRange`
  so the composer can show the concrete range; an untouched composer still sends no schedule and the
  server fills it.
- **Server.** A date-only end is refused with `subtask_schedule_time_required`, naming the endpoint
  that lacks a time. A legacy `kind` in a request body is ignored, so an open tab from before the
  change gets that field-named error for a date-only end and succeeds with a timed one. The start
  must be before the end by instant, which allows a range under a day.
- **Data.** Migration 0052 converts every date-only row to 09:00 / 17:00 and seals the table with a
  CHECK that refuses anything else (`docs/Guides/CI-Deploy.md`, "Subtask presets (0052)").
- **Not yet.** Subtask reminders (the `Subtask reminder` term) arrive separately; this change only
  makes every end a moment they can count back from.
