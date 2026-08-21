# TB4B — Project Deadline, Reminders and Kanban Due Metadata

**Primary user outcome:** an authorized coordinator can set one time-critical project deadline with several advance reminders, every currently assigned editor is reminded reliably, and the deadline is visible on the Kanban card.

**Sequence:** after [TB4A](./TB4A-Collaboration-Pane-Editor-Assignment.md), before [TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md)  
**Dependencies:** the accepted TB4 outbox/Queue envelope, TB4A roster contract and TB2 freshness conventions  
**Baseline reviewed:** `main` at `dfddccbaaaaeff4b0ce3146c58af338d070d345e`

## Current-main facts to preserve

- Projects have `shootDate` and `timeWindow`; checklist items have a separate optional literal Sydney due value.
- The collaboration pane has no distinct project deadline.
- Checklist reminders are one-shot and are not a configurable project reminder schedule.
- The background Worker already performs scheduled scans.
- Kanban cards show a RAW count and do not have project deadline metadata.
- Project deadlines must not change shoot, checklist or Kanban ordering semantics.

## User-approved product contract

1. A project has at most one nullable project-level due date/time, managed in the collaboration pane.
2. The deadline is independent of `shootDate`, `timeWindow` and checklist-item due values.
3. A project may have zero, one or multiple advance reminder rules.
4. Initial presets are 1 day, 4 hours and 1 hour; any subset may be selected.
5. Each current-version reminder produces one mandatory durable in-app notification for every eligible active assigned editor.
6. Kanban cards show the deadline and no longer show the card-level RAW count.
7. RAW counts outside Kanban and existing board order/sort behavior are unchanged.

## Collaboration-pane experience

Add **Due** and **Reminders** below the TB4A editor roster:

- show a readable date/time and explicit timezone;
- allow authorized users to set, edit or clear the deadline through an accessible minute-precise control;
- show selected lead-time chips/rules and each calculated fire date/time;
- provide 1 day, 4 hour and 1 hour presets;
- if custom rules are approved, use a bounded whole-number value/unit control;
- show read-only values to users without write capability;
- keep comment drafts, checklist popovers, pane scroll and unrelated controls intact during save/refetch.

## Deadline and reminder model

Conceptual additive model; exact names/types belong to the reviewed implementation plan:

```text
projects
  deadline_local nullable
  deadline_at_utc nullable
  deadline_timezone nullable
  deadline_utc_offset nullable
  deadline_fold nullable
  deadline_version

project_deadline_reminders
  id
  project_id
  deadline_version
  offset_minutes
  fire_at_utc
  state                 pending | claimed | emitted | superseded
  claim_token nullable
  claim_expires_at nullable
  claimed_at nullable
  emitted_at nullable
```

Invariants:

- a set deadline includes both date and time;
- the UI always labels a validated IANA timezone;
- persist the original local civil value, zone, selected UTC offset/fold and canonical UTC instant for deterministic rendering and audit;
- reject nonexistent DST-gap times; repeated local times require an explicit earlier/later occurrence;
- reminder offsets are unique positive integer minutes and resolve before the deadline;
- proposed custom bounds are whole-number minutes/hours/days, 1 minute through 30 days, at most 8 normalized offsets;
- setting, moving or clearing the deadline, or changing its rules, increments the version and supersedes older un-emitted occurrences atomically;
- existing projects migrate to no deadline and no reminder rules;
- no backfill derives a deadline from shoot or checklist fields;
- proposed past-offset behavior is to skip already-past occurrences rather than emit a catch-up flood.

## Reminder delivery

Use the TB4 outbox/Queue/DLQ contract:

1. Materialize versioned UTC fire times when the deadline/rules are saved.
2. Scan indexed due occurrences on the approved cadence; one minute is the proposed starting cadence.
3. Claim rows atomically with compare-and-set, a random token and an expiring lease.
4. Recheck the project's current deadline version.
5. Resolve active assigned editors from editor membership only. Do not append unassigned admins.
6. Create deduplicated outbox/delivery intent for each eligible editor.
7. Mark the occurrence emitted only after all mandatory in-app intents exist.
8. Send optional email only under the approved provider idempotency/ambiguous-acceptance contract.

A newly assigned editor receives future occurrences after assignment, not already emitted reminders. A removed editor is suppressed at delivery.

## Kanban card change

- Include nullable deadline/timezone fields in the project-summary/board contract.
- Show a compact readable due label and accessible overdue state when set.
- Remove the RAW-count label/value from Kanban cards only.
- Keep priority and other approved metadata.
- Do not add deadline sorting or rewrite `boardPosition`.
- TB5A/TB5B must preserve the deadline display and RAW-count removal through ordering, optimistic movement and refresh.

## Permissions, audit and freshness

- Reuse the owner-approved project-coordination write capability.
- Collaboration visibility never grants mutation permission.
- Persist deadline/rule mutation, audit/activity and outbox intent in one D1 batch/transaction boundary where available.
- Refresh the pane, project detail, board card and later quick detail narrowly after mutation.
- Do not let background refresh close an open picker or reset a draft.
- Avoid sensitive content in audit/log payloads.

## Migration and rollback

- Recheck the next migration number against current `main`; `0030` is only the current candidate.
- Use additive nullable fields/tables/indexes and update Drizzle schema, journal and snapshot consistently.
- Prior Workers must tolerate the additive schema.
- Rollback disables mutation controls, scheduler and new reminder producer, restores previous card rendering and leaves additive data for a forward fix.
- Version checks must suppress stale occurrences after rollback, reschedule or clear.
- No production mutation is authorized by this planning file.

## Tests and manual QA

- create, edit and clear a deadline with timezone visible;
- choose one preset and several presets;
- validate approved custom bounds, duplicates after normalization, missing time, invalid zone and invalid offsets;
- DST-gap rejection and explicit earlier/later fold choice;
- each 1 day/4 hour/1 hour occurrence creates exactly one mandatory in-app row per eligible assigned editor;
- unassigned admins do not receive the editor-only reminder;
- reschedule, clear and rule removal suppress stale occurrences;
- concurrent Cron/Queue/recovery claims converge through lease/token predicates and unique deliveries;
- retry/DLQ/recovery does not duplicate the in-app row;
- scheduled delivery meets the approved tolerance;
- deadline edit refreshes pane and board without changing board order or local interaction state;
- deadline/overdue label remains readable at desktop and narrow widths;
- card RAW count is absent while non-Kanban RAW counts remain.

Run the repository full gate after targeted suites.

## Owner decisions required

1. **Timezone:** one labelled studio timezone (recommended starting point: `Australia/Sydney`) or selectable per project?
2. **Timing contract:** every-minute scan with delivery targeted within two minutes (recommended), or another tolerance?
3. **Past offsets:** skip occurrences already past when a deadline is set/moved (recommended), or emit one immediate catch-up summary?
4. **Custom bounds:** approve whole-number minutes/hours/days, 1 minute–30 days and an 8-rule cap, or choose other explicit bounds?
5. **Optional email:** enabled by default for deadline reminders or opt-in/disabled under the TB4 channel contract?

These are TB4B-gated; TB0 need only record the deferral.

## Non-goals

- recurring calendar deadlines or per-user private alarms;
- changing the checklist due literal or its existing one-shot reminder;
- replacing project shoot date/time-window semantics;
- deadline-based Kanban sorting;
- removing RAW counts outside Kanban cards;
- broad project-change alerts;
- a second editor-membership store.

## Acceptance

- one deadline with any approved set of reminder offsets can be set, changed or cleared from the pane;
- every current-version reminder creates one mandatory in-app row per eligible active assigned editor and stale versions never fire;
- timezone/DST and delivery-tolerance behavior match the approved contract;
- Kanban cards show deadline/overdue metadata, omit RAW count and retain direct-link/order behavior;
- project, checklist and shoot-date contracts remain unchanged;
- targeted tests, full gate, matched UI evidence and manual browser QA pass;
- production remains coherent if the roadmap stops after TB4B.

## Checkpoint

Approve timezone, scheduler tolerance, past-offset, custom-bound and optional-email decisions before the repository-native implementation plan. Accept TB4B before TB4C and before TB5A/TB5B.
