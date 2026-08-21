# Notifications on Cloudflare

**Status:** Proposed reliable delivery architecture  
**Related:** [Cloudflare research](../research/Cloudflare-Native-Architecture-Research.md), [TB4](../roadmap/TB4-Notification-Outbox-And-Queues.md), [TB4A](../roadmap/TB4A-Collaboration-Pane-Editor-Assignment.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB4C](../roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md)

## 1. Goal

Keep notification data and rules Quincy-owned while using Cloudflare-managed infrastructure for durable asynchronous delivery.

## 2. Current state

Quincy already has:

- notification event types;
- D1 notification rows;
- unread/read/delete APIs;
- source-key deduplication for selected events;
- email sent/message/error fields;
- project recipient resolution;
- mention-specific email content;
- scheduled background scans.
- multiple editor memberships and assignment notifications.

Primary weaknesses: notification and email emission is not uniformly separated from originating application operations through a durable outbox/Queue workflow; assigned editors do not receive a comprehensive project-change stream; and projects have no versioned multi-reminder deadline schedule.

## 3. Target flow

```text
Domain mutation in app Worker
  │
  ├── D1 transaction/batch
  │     ├── write comment/board/project mutation
  │     ├── write mention/subscription records
  │     ├── write audit/activity event
  │     └── write notification_outbox row(s)
  │
  ├── best-effort publish outbox ID to Cloudflare Queue
  └── return successful domain result

Queue consumer
  ├── claim pending outbox row idempotently
  ├── recheck recipient eligibility/preferences
  ├── insert/update in-app notification
  ├── send email when enabled
  ├── record delivery result
  └── retry or route persistent failure to DLQ

Cron recovery
  └── republish pending/stuck outbox rows
```

## 4. Why an outbox is required

D1 writes and Queue publication are not one atomic transaction.

Without an outbox:

```text
comment saved
→ queue publish fails
→ notification is permanently lost
```

With an outbox, the durable row remains pending and a scheduled recovery process republishes it.

## 5. Proposed schema

```text
notification_outbox
  id
  event_type
  source_key
  actor_id nullable
  project_id nullable
  payload_json
  state                 pending | processing | delivered | failed
  attempts
  next_attempt_at
  last_error
  created_at
  claimed_at nullable
  processed_at nullable

notification_preferences
  user_id
  event_type or category
  in_app_enabled
  email_enabled
  digest_mode
  updated_at

project/discussion subscription table
  user_id
  scope/thread_id
  level
  updated_at

notification_deliveries
  id
  event_type
  source_key
  recipient_id
  channel                in_app | email
  state                  pending | claimed | sent | failed | unknown
  claim_token nullable
  claim_expires_at nullable
  attempts
  provider_id nullable
  last_error nullable
  created_at
  sent_at nullable
```

Existing `notifications` remains the recipient-facing inbox table unless a later plan deliberately replaces it.

For TB4B, add a conceptual project deadline schedule (exact names belong to the reviewed implementation plan):

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

Require uniqueness by project/deadline version/offset and by event/source/recipient/channel delivery. Keep the new project fields distinct from shoot date/time window and checklist due literals.

## 6. Idempotency

Cloudflare Queues may redeliver messages, and batch retries can redeliver already processed items. Every delivery path must be idempotent.

Use a unique semantic key such as:

```text
(event_type, source_key, recipient_id, channel)
```

Examples:

```text
mention:<mention-map-id>
assignment:<project-member-id>
subtask-due:<subtask-id>:<due-literal>
project-stage:<project-id>:<stage-version>
comment-reply:<entry-id>:<recipient-id>
```

Do not rely on random Queue message IDs for business deduplication.

The in-app channel can provide exactly-once recipient rows through a D1 unique constraint and idempotent insert. Email needs a separate recipient/channel delivery ledger. Exactly-once email is promised only when the provider accepts a stable idempotency key. Without that capability, record an explicit at-least-once or at-most-once/unknown policy for ambiguous provider acceptance; do not claim that retries can guarantee both no loss and no duplicate email.

Claims use compare-and-set predicates and expiring leases: only a pending row, or a claimed row whose lease expired, may receive a new random claim token; only that token may move the row to its next state. Cron overlap, Queue redelivery and recovery therefore converge on the unique recipient/channel record.

## 7. Queue and DLQ policy

- Configure a main notification Queue consumer.
- Set explicit batch/retry settings after volume testing.
- Configure a dead-letter Queue.
- Add a DLQ consumer or administrative recovery process.
- Acknowledge successful messages individually when using batches so one failure does not duplicate an entire successful batch unnecessarily.
- Store sufficient payload version/type information to reprocess safely.

## 8. Recipient resolution

The assigned-editor guarantee uses a dedicated resolver over active `project_members` editor rows. The existing general helper appends active admins even under its editor filter and must not be reused unchanged for TB4B/TB4C recipient fan-out.

Resolve/recheck at processing time:

- active status;
- project membership/admin access;
- the event-specific actor rule;
- notification preferences for optional channels;
- project/thread mute;
- access revocation since the original event.

Do not deliver project content to a user who lost access after event creation.

For editor-wide events, the minimum guarantee is a mandatory in-app row for every active user, including the actor, whose editor membership began on or before the event's `occurred_at` and still exists at processing time. Project/thread mute and preferences do not suppress this mandatory channel; they may control optional email/digest delivery. Preserve any existing additional recipient policy for targeted event types rather than silently narrowing it. Do not backfill delivered history to a newly assigned editor.

## 8a. Editor-wide project event registry

“Every project change” must be expressed as an approved, versioned registry of user-visible domain events. The first TB4C registry should cover:

- editor membership, deadline and reminder-rule changes;
- project metadata, stage, priority and board movement;
- checklist create/update/complete/reopen/reorder/delete, assignee and due changes;
- project-comment create/edit/delete, with mention notification kept as an additional targeted event;
- project collection additions, updates and removals across photos/RAW/edited assets, videos, floorplans, copy and delivery artifacts.

Do not emit on internal cache writes, delivery bookkeeping or every row written by a bulk import. One human operation/job should produce one useful summary where per-item alerts would create noise. Each event type must define actor behavior, source key, copy, deep link, recipient set and coalescing rule before its producer is enabled.

## 9. Email

Keep email behind an internal interface:

```ts
interface EmailSender {
  send(message: NotificationEmail): Promise<DeliveryResult>;
}
```

The current Cloudflare Email Service adapter can implement it. This isolates provider API details and permits future replacement without changing domain events.

Store:

- attempted/sent timestamp;
- message ID;
- last error;
- retry classification;
- template/version used.

## 10. Preferences

Proposed user controls:

```text
Category                In-app       Email
Mentions                required/on  user choice
Replies                  user choice user choice
Editor assignments       required/on  user choice
TB4C registry events     required/on  user choice/digest
Project due reminders    required/on  user choice
Non-TB4C project events  user choice user choice/digest
Notice board             user choice user choice/digest
```

Thread/project subscription levels may further refine categories:

```text
all activity
replies and mentions
mentions only
muted
```

Optional email/digest and non-TB4A event defaults require product approval. Mandatory in-app delivery does not.

Every TB4C registry event—including editor add/remove, project, checklist, comment and collection changes—and every TB4B project due reminder is an exception to project/thread mute while the user remains an assigned editor. Removal from the editor role ends future eligibility.

## 11. Digests and Workflows

Use a Queue for ordinary event delivery.

Use Cron/Workflow only when the process is genuinely long-lived or aggregated:

- daily/weekly digest;
- notice acknowledgement escalation;
- delayed reminder;
- scheduled notice expiry;
- multi-step approval sequence.

Do not start a Workflow for every comment mention.

## 11a. Project deadline reminders

Represent each selected reminder as a positive lead-time offset from one versioned project deadline. Provide 1 day, 4 hour and 1 hour presets and allow any subset; a bounded custom number/unit rule may normalize to integer minutes.

Recommended delivery mechanism:

1. Validate an IANA timezone and resolve the entered civil time to one instant, then save the original local value, zone, selected UTC offset/fold, canonical UTC instant, incremented version, pending reminder occurrences, audit and deadline-change outbox intent in one D1 batch/transaction boundary.
2. Mark older un-emitted occurrences superseded when the deadline is moved, cleared or its rules change.
3. Run a short Cron scan, recommended every minute, to claim occurrences whose UTC fire time is due through a compare-and-set state/lease/token transition.
4. Recheck the current deadline version and active editor membership.
5. Emit one deduplicated TB4 outbox event per occurrence/recipient and create the unique recipient/channel delivery row before recording the occurrence emitted.
6. Recover stale claims and retry delivery through the ordinary Queue/DLQ path.

A Workflow `sleepUntil` can schedule a fixed instant, but one editable D1 schedule plus a short scan is the recommended first design because reschedule/cancel/version checks remain centralized. Reminder occurrences already in the past when a deadline is first configured or moved are skipped rather than flooding recipients, unless the owner approves a different rule.

Civil-time handling is blocking, not an incidental formatter choice: nonexistent local times in a DST gap are rejected with a useful error; repeated local times require an explicit earlier/later occurrence selection and persist that fold/offset for audit. A fixed studio zone and a selectable per-project zone use the same rules.

## 12. Observability and administration

Provide enough visibility to answer:

- Was the domain event recorded?
- Was an outbox row created?
- Was it queued/claimed?
- Which recipients were eligible?
- Was in-app delivery inserted?
- Was email sent?
- What failed and how many times?
- Is it in the DLQ?
- Can it be replayed safely?

A minimal admin/status view or support query may be added after the first delivery proof.

## 13. Rollout

TB4 should migrate only one event type first, preferably project-comment mention.

TB4A begins only after the outbox envelope, idempotency and recovery pattern is accepted. TB4B follows the proven roster contract. TB4C registry producers may cut over incrementally behind a cohort/feature gate, but TB4C is not accepted until every owner-approved initial checklist, comment, project and collection category is live. Maintain a producer-ownership table keyed by semantic event: exactly one old or outbox producer is authoritative at a time, and both paths share the recipient-delivery key during cutover. Keep old paths only for unrelated or explicitly unmigrated events.

## 14. Tests

- domain write succeeds even when Queue publish fails;
- pending outbox recovery republishes;
- duplicate Queue deliveries create one in-app recipient row; email follows the documented provider idempotency/ambiguity contract;
- access is rechecked;
- preferences/mute are honored for optional channels while mandatory TB4C in-app events remain enabled for assigned editors;
- transient failure retries;
- persistent failure reaches DLQ/state;
- successful message is not retried with a failed sibling batch item;
- actor behavior matches the event contract; TB4C includes the actor only when the actor is an assigned editor;
- email content/deep link remains correct;
- audit/domain mutation is not duplicated.
- all active assigned editors, including the actor, receive one mandatory in-app registered change;
- a removed/deactivated editor is suppressed at delivery;
- deadline offsets 1 day/4 hours/1 hour each fire once at the current deadline version;
- reschedule, rule removal and deadline clear supersede stale occurrences;
- past occurrences follow the approved skip policy;
- timezone/DST boundary and minute-level delivery tolerance;
- bulk collection changes coalesce according to the event contract;
- concurrent Cron/Queue/recovery claims converge through lease/token compare-and-set and recipient/channel uniqueness;
- ambiguous email-provider acceptance is surfaced according to the approved email contract rather than reported as guaranteed exactly-once.

## 15. Non-goals

- External Knock/Novu managed service.
- Operating a separate notification platform in TB4.
- Realtime WebSocket inbox.
- Replacing the current inbox UI simultaneously with all backend delivery changes.
- Claiming exactly-once email without provider idempotency support.
