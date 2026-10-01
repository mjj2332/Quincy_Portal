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
- The Calendar shows Subtasks as timed events, not in its all-day strip.
- The presets are code constants, not admin configuration.
