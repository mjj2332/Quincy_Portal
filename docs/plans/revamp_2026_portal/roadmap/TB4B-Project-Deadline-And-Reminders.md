# TB4B — Project Deadline, Reminders and Kanban Due Metadata

**Primary user outcome:** an authorized coordinator configures one project Deadline and bounded advance reminders from the left rail; every eligible assigned Editor is reminded reliably, and Kanban shows the Deadline instead of RAW count.

**Sequence:** after TB4A, before TB4C  
**Dependencies:** TB4 envelope, TB4A membership-cycle contract, TB2 freshness

## Left-rail experience

Activate one combined **Deadline** block in the rail established by TB4A:

- unset: `Not set`;
- set: `24 Aug · 17:00`, visibly labelled `Sydney time`;
- reminder summary such as `3 reminders` and next future occurrence;
- overdue state is explicit text/visual state;
- one anchored/viewport-contained editor changes Deadline and rules transactionally;
- read-only display for users without `editProject`;
- preserve unrelated drafts/pickers/scroll.

## Schedule contract

- one nullable project Deadline;
- separate from `shootDate`, `timeWindow`, and checklist due literal;
- `Australia/Sydney` IANA zone;
- persist local civil value, zone, selected offset/fold, UTC instant, version;
- reject daylight-saving gaps;
- ambiguous fallback time reveals earlier/later offset choices;
- set Deadline requires date and time;
- presets: 1 day, 4 hours, 1 hour; none preselected;
- custom whole-number minutes/hours/days, 1 minute–30 days;
- maximum eight unique normalized positive offsets;
- Due-now occurrence always exists;
- save increments version and atomically supersedes old pending occurrences;
- no backfill from shoot/checklist values.

## Past and rescheduled Deadlines

- Past Deadline is allowed and immediately displays overdue.
- Skip all elapsed advance offsets.
- Emit exactly one current-version Due-now/overdue event.
- Rescheduling creates a new version; a future offset may fire again for the new Deadline.
- Previously delivered notifications remain history.

## Conflict behavior

Save carries expected schedule version. On conflict:

- keep local draft/editor open;
- show authoritative current schedule alongside it;
- offer **Reload current values** or **Reapply my draft**;
- never silently merge reminder sets or use last-write-wins.

## Delivery

- Scan every minute; target mandatory in-app creation within two minutes.
- Claim with compare-and-set lease/token and recheck current version.
- Resolve active Editor membership cycles at fire/delivery time.
- Editor assigned before fire qualifies; removal/deactivation suppresses.
- Remove/re-add cannot receive prior-cycle event.
- Unassigned Admins are not appended.
- Create one deduplicated recipient/channel intent per occurrence.
- One immediate semantic event per schedule Save: set/moved/cleared/Deadline-and-reminders-updated.

## Email preference

Before enabling default-on reminder email:

- add deep-linkable Notification Preferences page;
- expose one global per-user toggle: **Project deadline reminder emails**;
- advance and Due-now/overdue email obey it;
- mandatory in-app rows do not;
- per-project mute/digest is deferred.

## Delivered/archive interaction

Entering delivered or archiving:

- supersedes all pending advance/Due-now occurrences;
- preserves Deadline/rules/history as read-only metadata;
- sends no future reminders.

Leaving delivered/restoring does not resume. Coordinator must save/confirm a new version.

## Kanban card

- Add Deadline/timezone data to project summary.
- Show `Due 24 Aug · 17:00` and accessible full year/timezone/overdue text.
- Omit metadata entirely when unset.
- Remove card-level RAW count only.
- Keep Priority/other approved metadata.
- No Deadline sort, Stage change, or `boardPosition` mutation.

## Migration/rollback

- Add nullable/versioned project fields and occurrence table/indexes.
- Recheck migration number/current schema.
- Existing projects start with no Deadline/rules.
- Prior Worker tolerates additive state where practical.
- Rollback disables editor/scheduler/producer, leaves data, and relies on version suppression.
- Previous card bundle may temporarily restore RAW count without corrupting Deadline data.

## Tests/QA

- set/edit/clear and read-only;
- presets none/one/many and custom bounds/normalization/cap;
- missing time/invalid zone/DST gap/fold;
- past Deadline and one Due-now event;
- reschedule/re-fire and stale suppression;
- save conflict choices;
- one-minute scan/two-minute target;
- Queue/recovery duplicates;
- membership-cycle recipients/unassigned Admin exclusion;
- immediate schedule event once;
- preference default/opt-out;
- delivered/archive suspension/no resume;
- rail/Collaboration-only/Kanban desktop/compact/phone;
- no board order/RAW-count collateral;
- full gate/manual QA.

## Acceptance

The versioned Sydney schedule is deterministic and conflict-safe; reminders reach exact eligible Editors once; user email choice exists; suspension and Kanban metadata are correct; production remains coherent before TB4C.
