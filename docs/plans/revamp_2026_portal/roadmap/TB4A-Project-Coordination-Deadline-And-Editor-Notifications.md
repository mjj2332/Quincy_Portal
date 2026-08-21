# TB4A — Project Coordination, Deadline and Editor Notifications

**Primary user outcome:** an authorized coordinator can assign the right editors and set a time-critical project deadline in the collaboration pane, and every active assigned editor is reliably alerted to approved project changes and advance deadline reminders.

**Sequence:** after [TB4](./TB4-Notification-Outbox-And-Queues.md), before [TB5A](./TB5A-Kanban-Ordering-Model-Correction.md)  
**Dependencies:** TB2 route-safe freshness conventions, TB3 collaboration/discussion surface, and the accepted TB4 outbox/Queue envelope

## Current-main facts to preserve

At baseline `ff01974f91f4b459a31352fbdf20981e6d38977a`:

- `project_members` already supports multiple editor rows and the Edit Project form already selects multiple editors;
- the collaboration pane hosts the checklist and project comments but has no editor-roster control or project deadline;
- checklist assignee and due-date controls already use compact anchored popovers and are the interaction precedent;
- projects have `shootDate` and `timeWindow`, while checklist items have a separate optional literal Sydney due value;
- notifications are stored in D1 and can send email, but most request-path delivery is direct/best-effort;
- the background Worker already performs scheduled scans, but the checklist due reminder is one-shot and not a configurable project reminder schedule;
- Kanban cards show a RAW count and do not receive a project deadline.

This slice reuses those assets. It does not create a second editor-membership model, reinterpret shoot/checklist dates, or replace the TB4 delivery envelope.

## User-approved product contract

1. An authorized user can assign or remove multiple editors directly in the project collaboration pane without opening Edit Project.
2. The editor picker behaves like the checklist assignee control: compact, anchored, keyboard accessible, searchable when needed, and capable of showing multiple selected people.
3. Every active assigned editor, including the actor, receives a mandatory durable in-app notification for every user-visible project event in the approved registry. Email is an additional channel under its approved reliability/preference contract.
4. A project can have one nullable due date/time, configured in the collaboration pane.
5. The project can have zero, one or multiple advance reminder rules. Initial presets are 1 day, 4 hours and 1 hour; any subset may be selected.
6. Kanban cards show the due date/time and no longer show the RAW count.
7. The project deadline is independent of `shootDate`, `timeWindow` and checklist-item due values.

## Collaboration-pane experience

Add a compact **Project coordination** section near the top of the pane:

- **Editors:** selected-editor chips/avatars plus an Add or Manage action. The popover lists eligible active editors, supports selecting several people, and lets an authorized user remove one editor without clearing the rest.
- **Due:** a readable date/time plus timezone. An authorized user can set, edit or clear it through an accessible minute-precise picker.
- **Reminders:** selected lead-time chips/rules with presets for 1 day, 4 hours and 1 hour. Users can choose one or several. Each rule also shows its calculated fire date/time. If custom rules are enabled, the proposed first bounds are whole numbers in minutes/hours/days, 1 minute through 30 days, at most 8 unique normalized offsets per project.
- Users without the write capability see the current values read-only.
- Saving one control does not close/reset unrelated comment drafts, checklist popovers or pane scroll.
- Mutation success updates the collaboration pane, project detail, Kanban card and quick-detail caches without a browser reload.

Do not force a user through the full Edit Project dialog for these routine actions. Keep that existing editor UI as a rollout fallback until this surface is verified.

## Editor membership contract

Reuse `project_members` and its editor role.

Recommended mutation shape:

- idempotent add-editor and remove-editor operations, or an equivalent guarded delta endpoint;
- expected membership/project version to reject a stale concurrent change;
- active/eligible user validation on the server;
- existing `editProject`/admin capability gate unless the owner approves a broader role;
- audit exactly once per add/remove;
- assignment/removal activity and outbox intent in the same D1 batch boundary where available;
- remove only the editor role. If the same user is also a photographer or holds another role, preserve that row/role;
- no self-assignment privilege escalation;
- authoritative roster returned after mutation.

Do not implement the pane by submitting a possibly stale full editor list through the existing general project PATCH without a concurrency guard.

## Project-change event registry

“All changes” is a product registry, not every D1 write. Each enabled event defines a versioned type, stable source key, actor, project, summary payload, deep link, recipient rule and bulk-coalescing behavior.

| Category | Initial user-visible events |
|---|---|
| Coordination | editor added/removed; project deadline set/moved/cleared; reminder rules changed |
| Project | project details updated; stage changed; priority changed; board position changed |
| Checklist | item created, edited, completed/reopened, reordered or deleted; assignee changed; item due changed |
| Comments | project comment created, edited or deleted; mention remains an additional targeted event |
| Collections | project collection item/batch added, updated or removed across photos/RAW/edited assets, videos, floorplans, copy, links and delivery artifacts |

Rules:

- one human mutation emits one useful event;
- one high-volume import/background job emits a summary rather than one alert per row/file;
- delivery bookkeeping, cache writes and other internal state do not emit user alerts;
- every active editor whose membership began on or before the event time is a required mandatory in-app recipient when delivery runs, including the actor;
- access/editor membership is rechecked immediately before content delivery;
- preferences or project/thread mute may affect optional email/digest delivery but cannot suppress the mandatory in-app event while the editor remains assigned;
- a newly assigned editor gets the assignment notification and events created after assignment, not delivered history or older queued events;
- existing mention, assignee and other targeted notifications remain additive;
- each recipient/channel delivery is idempotent by semantic event/source/recipient/channel key.

The reviewed implementation plan must inventory the exact current producer routes/jobs and approve the registry/copy/coalescing rule before enabling each producer. “Anything in collections” cannot be satisfied by a single generic database hook.

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

notification_deliveries
  event_type
  source_key
  recipient_id
  channel
  state
  claim_token nullable
  claim_expires_at nullable
  provider_id nullable
```

Invariants:

- a set project deadline includes both date and time;
- the UI always labels a validated IANA timezone;
- persist the original local civil value, chosen zone, selected UTC offset/fold and canonical UTC instant for deterministic rendering and audit;
- reject nonexistent DST-gap times; repeated local times require an explicit earlier/later occurrence choice;
- reminder offsets are unique positive integer minutes and must resolve before the deadline;
- proposed custom-rule bounds are 1 minute through 30 days, whole-number minutes/hours/days, at most 8 rules, with duplicate normalized values rejected before save;
- setting/moving/clearing a deadline or changing rules increments the version and supersedes all older un-emitted occurrences;
- one D1 batch/transaction boundary writes the deadline/rules, audit/activity and applicable outbox intent;
- existing projects migrate to no deadline and no reminders;
- no backfill derives a deadline from shoot or checklist fields;
- past reminder occurrences are skipped rather than emitted as a catch-up flood under the proposed default.

## Reminder delivery

Use the TB4 outbox/Queue/DLQ contract.

Recommended first scheduler:

1. Materialize versioned UTC fire times when the deadline/rules are saved.
2. Run a short Cron scan, proposed every minute.
3. Atomically claim due pending rows with a compare-and-set predicate, random claim token and expiring lease; only that token may complete the transition, and recovery may reclaim only expired leases.
4. Verify the row still matches the project's current deadline version.
5. Resolve active assigned editors whose membership began no later than the event, including the actor, and create deduplicated outbox intent.
6. Create recipient/channel delivery rows unique on event/source/recipient/channel; mark the occurrence emitted only after the mandatory in-app intents exist.
7. Let the TB4 consumer insert exactly one in-app notification per recipient. Send optional email according to the approved provider contract; exactly-once email requires provider idempotency support, otherwise ambiguous acceptance is surfaced under an explicit at-least-once or at-most-once policy.

Cloudflare Cron schedules run in UTC and support every-minute expressions. Workflows can sleep until a fixed instant, but a D1 schedule is the proposed first design because deadline edits, cancellation, version invalidation and recovery stay centralized.

## Kanban card change

- Include the nullable project deadline/timezone in the project-summary/board contract.
- When set, show a compact, readable due label and an accessible overdue state.
- Remove the RAW-count label/value from Kanban cards.
- Keep priority and other approved card metadata.
- Do not remove RAW counts from list, detail or collection surfaces.
- Do not add deadline sorting or let deadline changes rewrite `boardPosition`.
- TB5A and TB5B must preserve this metadata contract through ordering correction, movement, optimistic updates and automatic refresh.

## Permissions, privacy and audit

- Preserve current project collaboration visibility, including the existing stage-hidden member fallback.
- Keep comment edit/delete author-only; editor-wide notifications do not create moderation rights.
- Reuse current capability checks; do not let pane visibility imply write access.
- Validate active/eligible editor IDs server-side.
- Recheck membership/access and optional-channel preferences when a queued event is delivered.
- Do not include project content in a notification after editor removal or deactivation.
- Audit roster, deadline and reminder mutations with before/after values while avoiding sensitive content in logs.

## Migration and rollout

- Recheck the next migration number against current `main`; `0030` is only the baseline candidate.
- Use additive nullable fields/table/indexes and update Drizzle schema, journal and snapshot consistently.
- Existing Workers must tolerate the additive schema.
- Producer categories may enable behind internal cohort/feature gates in bounded increments, but TB4A cannot be accepted until every required initial checklist, comment, project and collection category is live.
- Maintain a per-event producer-ownership/cutover table. Exactly one legacy or outbox producer is authoritative for each semantic event, with a shared recipient-delivery key preventing duplicates during transition.
- Keep the current Edit Project editor selector and only genuinely unrelated/unmigrated old notification producers until parity is verified.
- A rollback disables pane mutation controls/scheduler/new producers and restores the previous card rendering; additive deadline/reminder data remains for a forward fix.
- No production mutation is authorized by this planning file.

## Tests and manual QA

### Editor roster

- assign several editors from the pane and remove one;
- preserve a simultaneous photographer/other role;
- reject inactive, ineligible and unauthorized targets;
- concurrent add/remove does not lose another user's change;
- retry is idempotent and audit/activity occurs once;
- mandatory in-app membership/change events include the acting assigned editor;
- collaboration-only access remains exact.

### Deadline/reminders

- create, edit and clear a date/time with timezone visible;
- choose one preset, several presets and a valid custom rule if enabled;
- reject duplicates after normalization, zero/negative offsets, missing time, fractional values, unsupported units, more than 8 rules and values outside 1 minute–30 days;
- 1 day, 4 hour and 1 hour occurrences each create exactly one mandatory in-app row per eligible editor;
- moving/clearing deadline or removing a rule suppresses stale occurrences;
- past-offset policy, IANA timezone validation, DST-gap rejection and explicit earlier/later fold handling;
- scheduled scan delay meets the approved tolerance;
- concurrent Cron/Queue/recovery claims converge through the lease/token predicate and unique recipient/channel rows;
- Queue retry/DLQ/recovery creates one in-app row; email follows the approved provider idempotency/ambiguous-acceptance policy.

### Project changes

- one event for every required initial checklist/comment/project/collection registry case;
- comment mention plus editor-wide event deduplicate independently;
- mandatory in-app behavior includes the actor and ignores mute/preferences while the editor remains assigned;
- every event-time-eligible current editor receives the event;
- editor removal/deactivation between mutation and delivery suppresses delivery;
- bulk asset/collection import uses its approved summary/coalescing rule;
- deep links open the correct project/collaboration context.

### UI/Kanban

- keyboard, focus return, Escape, portalled popover clipping and screen-reader labels;
- collaboration-panel and phone widths;
- open draft/picker/scroll survives background refresh;
- Kanban deadline/overdue label at desktop and narrow widths;
- card RAW count absent, non-Kanban RAW counts unchanged;
- deadline edit refreshes the board without changing order;
- direct/open-new-tab project link remains native.

Run the repository full gate after targeted suites.

## Owner decisions required before implementation

1. **Write capability:** retain current `editProject`/admin only (recommended), or allow another collaborator role to change roster/deadline/reminders?
2. **Timezone:** one labelled studio timezone (recommended starting point: `Australia/Sydney`) or selectable per project? Storage/scheduling remains canonical UTC either way.
3. **Timing contract:** every-minute scan with delivery targeted within two minutes (recommended), or another explicit tolerance?
4. **Email:** mandatory in-app is fixed; is email enabled by default, and does the provider support stable idempotency keys? Otherwise choose and disclose at-least-once or at-most-once handling for ambiguous acceptance.
5. **Registry/noise:** approve the exact producer list and bulk coalescing policy, especially reorder and high-volume collection events.
6. **Queued events/history:** exclude events created before a new editor's membership (recommended) and never backfill delivered history, or choose a different queued-event rule?
7. **Past offsets:** skip reminder fire times already past when a deadline is set/moved (recommended), or emit one immediate catch-up summary?
8. **Custom bounds:** approve the proposed whole-number minutes/hours/days, 1 minute–30 days and 8-rule maximum, or set different explicit bounds.

These choices do not reopen the four user-approved outcomes.

## Non-goals

- separate assignment, comments, deadline or Kanban-card domain stores;
- recurring calendar deadlines or per-user private alarm schedules;
- realtime chat/presence/WebSockets;
- changing checklist due persistence or its existing one-shot reminder in this slice;
- replacing shoot date/time window;
- deadline-based Kanban sorting;
- removing RAW counts outside Kanban cards;
- migrating every notification type outside the approved registry;
- external collaboration/notification/Kanban vendor.

## Acceptance

- multiple editors can be added/removed in the collaboration pane without opening Edit Project, with correct concurrency, capability, role preservation and audit behavior;
- one project deadline with any approved set of reminder offsets can be set/changed/cleared from the pane;
- each current-version reminder creates one mandatory in-app row per eligible editor and stale-version reminders never fire;
- every required initial project, checklist, comment and collection event is live before TB4A acceptance and reaches every event-time-eligible active assigned editor, including the actor, through exactly one mandatory in-app row;
- optional email follows the approved provider idempotency/ambiguous-delivery contract and is never represented as guaranteed exactly-once without provider support;
- project/comment/checklist/collection permissions remain exact and access removal stops content delivery;
- Kanban cards show due date/time, omit RAW count and retain direct-link/order behavior;
- targeted tests, full gate, matched UI evidence and manual browser QA pass;
- production remains coherent if the roadmap stops after TB4A.

## Checkpoint

Approve the permission, timezone/DST, timing, event-registry, optional-email/queued-history, custom-bounds and past-offset contracts before writing the repository-native TB4A implementation plan. Accept TB4A before TB5A/TB5B so subsequent board work preserves the deadline metadata contract.
