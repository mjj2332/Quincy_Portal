# Notifications on Cloudflare

**Status:** Settled reliable-delivery and project-event proposal  
**Related:** [TB4](../roadmap/TB4-Notification-Outbox-And-Queues.md), [TB4A](../roadmap/TB4A-Project-Workspace-Assignment-Rail.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB4C](../roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md)

## 1. Goal

Keep notification rules and data Quincy-owned while using Cloudflare infrastructure for durable asynchronous delivery. A successful project/comment operation must not depend on immediate Queue or email success.

## 2. Target flow

```text
Domain mutation
  ├── domain state
  ├── security audit
  ├── immutable safe activity event where applicable
  └── notification_outbox intent
         │
         ├── best-effort publish outbox id to Cloudflare Queue
         └── Cron recovery republishes pending/stuck rows

Queue consumer
  ├── claim with compare-and-set lease/token
  ├── resolve/recheck eligible recipient membership/access
  ├── upsert recipient/channel delivery ledger
  ├── insert mandatory in-app row idempotently
  ├── send optional email
  └── record sent/failed/unknown/suppressed; retry or DLQ
```

## 3. Conceptual schema

```text
project_activity_events
  id, project_id, actor_id, occurred_at
  activity_type, registry_version, source_key
  safe_payload_json, deep_link_context

notification_outbox
  id, event_type, registry_version, source_key
  activity_event_id nullable, actor_id nullable, project_id nullable
  payload_json, state, attempts, next_attempt_at
  claim_token nullable, claim_expires_at nullable
  last_error nullable, created_at, processed_at nullable

notification_deliveries
  id, event_type, source_key, recipient_id, channel
  membership_cycle_id nullable
  state: pending | claimed | sent | failed | unknown | suppressed
  claim_token nullable, claim_expires_at nullable
  attempts, provider_id nullable, last_error nullable
  created_at, sent_at nullable

notification_preferences
  user_id
  deadline_reminder_email_enabled
  future category/digest fields
```

Existing recipient-facing `notifications` remains the in-app inbox table initially.

Unique semantic delivery key:

```text
(event_type, source_key, recipient_id, channel)
```

Never deduplicate by random Queue message ID.

## 4. Claims, retries, and email ambiguity

- Claims use compare-and-set state plus random token and expiring lease.
- Duplicate Queue/recovery processing converges on the unique delivery row.
- Definitive transient pre-acceptance email failure may retry.
- An ambiguous timeout/connection loss after submission becomes `unknown`.
- Do not automatically retry `unknown`; provider acceptance may already have occurred.
- Manual replay warns that duplicate email is possible.
- Mandatory in-app delivery is unaffected by email outcome.
- Do not claim exactly-once email without provider idempotency support.

## 5. TB4 first event and operations

First durable event: project-comment mention.

TB4 must:

- write mention mapping and outbox intent in the same domain-write boundary;
- cut over one authoritative semantic producer;
- recheck active access at delivery;
- insert one in-app row;
- send optional mention email;
- prove retry, recovery, DLQ, and deduplication;
- add a compact Admin operational section showing pending/stuck outbox, DLQ, failed deliveries, and `unknown` email outcomes;
- allow safe replay/discard without exposing sensitive content.

## 6. Recipient contracts

### Targeted assignment

- Newly assigned Photographer/Editor receives one role-specific targeted event, including self-assignment.
- Removal is audit-only for the removed person.
- In TB4C, existing eligible Editors receive the broad roster-change event; the new assignee is suppressed from the duplicate broad row.

### Deadline reminders

Resolve active Editor membership cycles at occurrence/delivery time:

- assignment before fire qualifies;
- removal/deactivation suppresses;
- remove/re-add cannot receive prior-cycle event;
- unassigned Admins are not appended;
- a newly assigned Editor may receive future un-emitted occurrences.

### Broad registry

The membership cycle must begin no later than event occurrence and still exist at delivery. No delivered-history backfill. Mandatory in-app delivery includes the actor only when the actor is an eligible assigned Editor.

## 7. Deadline schedule

Conceptual data:

```text
projects
  deadline_local nullable
  deadline_at_utc nullable
  deadline_timezone nullable
  deadline_utc_offset nullable
  deadline_fold nullable
  deadline_version

project_deadline_reminders
  id, project_id, deadline_version
  occurrence_kind: advance | due_now
  offset_minutes nullable
  fire_at_utc
  state: pending | claimed | emitted | superseded
  claim_token nullable, claim_expires_at nullable
  claimed_at nullable, emitted_at nullable
```

Rules:

- `Australia/Sydney` is explicit.
- Reject DST gaps; ambiguous time requires earlier/later choice.
- Presets: 1 day, 4 hours, 1 hour; none preselected.
- Custom whole-number minutes/hours/days, 1 minute–30 days, max eight unique normalized offsets.
- Due-now always exists.
- Save increments version and supersedes old pending rows atomically.
- Past Deadline emits one Due-now/overdue event and skips elapsed advances.
- Scan every minute; target in-app creation within two minutes.
- Delivered/archive supersedes pending rows and does not auto-resume.
- Reminder email is default-on only after the per-user Notification Preferences toggle exists.

## 8. Editor-wide registry

Each registry entry defines:

- stable type and registry version;
- owning producer;
- source key;
- safe activity/notification payload;
- actor rule;
- recipient membership-cycle rule;
- deep link;
- coalescing;
- email default;
- producer cutover owner/tests.

Initial categories:

- team, Deadline/rules, Stage, Priority, selected operational project metadata, archive/restore;
- checklist create/edit/complete/reopen/delete/assignee/due changes;
- comment create/edit/delete;
- workflow-significant review/selection/annotation operations;
- user-visible collection/delivery operations.

Noise rules:

- no broad notification for pure Kanban/checklist reorder;
- one Deadline schedule event per Save;
- comment edits coalesce per comment/actor within five minutes;
- one user action/background job = one collection summary;
- no event for rendition/cache/manifest/retry bookkeeping;
- no duplicate targeted assignment + broad roster row to the new assignee.

## 9. Email defaults and preferences

```text
Category                         In-app        Email default
Targeted mention                 required      on, user-controlled
Targeted assignment              required      on, user-controlled
Project Deadline reminder        required      on, global per-user opt-out
Broad registry event             required      off
```

The first Notification Preferences page exposes **Project deadline reminder emails**. Per-project muting and digest controls are deferred until a broader subscription model exists. Preferences never suppress mandatory broad/Deadline in-app rows while membership remains eligible.

## 10. Copy/privacy

Broad rows/email may include:

- actor name;
- project street/name;
- event category and compact outcome;
- safe link;
- checklist title;
- collection type and aggregate counts.

Do not include:

- broad comment body excerpts;
- filenames;
- production notes content;
- client contact details;
- Dropbox paths;
- provider diagnostics.

Targeted mention emails retain their separately approved excerpt policy.

## 11. Producer ownership and rollback

Maintain one authoritative producer per semantic event. During cutover, old/new paths share stable delivery keys but do not both independently fan out. Disabling a producer never deletes domain/activity/inbox data. Pending outbox rows remain recoverable. Rollback restores one owner at a time without dual-write ambiguity.

## 12. Tests

- domain write survives Queue publication failure;
- pending/stuck recovery;
- duplicate Queue/replay yields one in-app row;
- active access/membership recheck;
- remove/re-add interval isolation;
- actor/unassigned-Admin behavior;
- targeted/broad assignment suppression;
- transient email retry and `unknown` no-auto-retry;
- Admin status/replay/discard;
- Deadline versions, Due-now, past Deadline, reschedule, delivered/archive suppression;
- one-minute scan/two-minute target;
- DST gap/fold behavior;
- comment edit coalescing;
- collection operation summary;
- privacy-safe copy;
- producer cutover exactly once.
