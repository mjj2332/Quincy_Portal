# TB4B — Project Deadline, Reminders and Kanban Due Metadata

**Primary user outcome:** an authorized coordinator configures one project Deadline and bounded advance reminders from the left rail; every eligible assigned Editor is reminded reliably, and Kanban shows the Deadline instead of RAW count.

**Sequence:** after TB4A, before TB4C  
**Dependencies:** TB4 envelope, TB4A membership-cycle contract, TB2 freshness

## Left-rail and schedule contract

One combined Deadline block/editor: unset `Not set`; set civil time with visible Sydney label; reminder summary/next occurrence; overdue state; read-only without `editProject`.

One nullable project Deadline, separate from shoot/checklist schedule, in `Australia/Sydney`. Persist local civil value, zone, offset/fold, UTC instant and version. Reject DST gaps; repeated time requires earlier/later choice. Set requires date/time. Presets 1 day/4 hours/1 hour, none selected; custom 1 minute–30 days, max eight unique normalized offsets; Due-now always; save supersedes old pending rows.

Past Deadline allowed: overdue, skip elapsed advances, one current-version Due-now/overdue. Save conflict preserves draft and offers authoritative reload/reapply; no silent merge.

## Delivery

Every-minute scan targets in-app within two minutes. Resolve active Editor membership cycles at fire/delivery; assignment before fire qualifies, removal/deactivation suppresses, remove/re-add cannot receive prior-cycle event, unassigned Admin excluded. One semantic schedule event per save.

**TB4E compatibility:** External Editors use the same `roleOnProject="editor"` membership-cycle rule once TB4E ships, including mandatory in-app reminders and default-on reminder email subject to their personal preference. TB4B does not need a second schedule/recipient model.

## Email preference

Before default-on reminder email, ship personal Notification Preferences with **Project deadline reminder emails**. Mandatory in-app unaffected. TB4E later grants External Editors access to the same personal preference.

## Delivered/archive and Kanban

Delivered/archive supersedes pending occurrences but preserves metadata/history. Leaving/restoring does not auto-resume. Kanban shows `Due …`/overdue, removes card RAW count only; no Deadline sort/order/Stage mutation.

## Calendar compatibility

TB5C later projects this exact Deadline as the project Calendar milestone. Calendar drag with `editProject` must call the same versioned schedule mutation, preserve reminder offsets, use the same DST/conflict/event semantics, and never create a Calendar-specific schedule source of truth.

## Migration/rollback/tests

Add nullable/versioned project fields and occurrence indexes; existing projects start unset; rollback disables editor/scheduler/producer while retaining data. Tests cover set/edit/clear, presets/custom bounds, DST, past/reschedule/conflict, scan/dedupe, membership cycles, preferences, delivered/archive, Kanban metadata, External Editor future compatibility, and Calendar reuse of the same domain command.
