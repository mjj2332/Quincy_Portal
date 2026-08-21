# Notifications on Cloudflare

**Status:** Proposed reliable delivery architecture  
**Related:** [Cloudflare research](../research/Cloudflare-Native-Architecture-Research.md), [TB4](../roadmap/TB4-Notification-Outbox-And-Queues.md)

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

Primary weakness: notification and email emission is not uniformly separated from originating application operations through a durable outbox/Queue workflow.

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
```

Existing `notifications` remains the recipient-facing inbox table unless a later plan deliberately replaces it.

## 6. Idempotency

Cloudflare Queues may redeliver messages, and batch retries can redeliver already processed items. Every delivery path must be idempotent.

Use a unique semantic key such as:

```text
(event_type, source_key, recipient_id)
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

## 7. Queue and DLQ policy

- Configure a main notification Queue consumer.
- Set explicit batch/retry settings after volume testing.
- Configure a dead-letter Queue.
- Add a DLQ consumer or administrative recovery process.
- Acknowledge successful messages individually when using batches so one failure does not duplicate an entire successful batch unnecessarily.
- Store sufficient payload version/type information to reprocess safely.

## 8. Recipient resolution

Resolve/recheck at processing time:

- active status;
- project membership/admin access;
- actor exclusion;
- notification preferences;
- project/thread mute;
- access revocation since the original event.

Do not deliver project content to a user who lost access after event creation.

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
Project assignments      on          user choice
Due reminders            on          user choice
Pipeline/project events  user choice user choice/digest
Notice board             user choice user choice/digest
```

Thread/project subscription levels may further refine categories:

```text
all activity
replies and mentions
mentions only
muted
```

Exact defaults require product approval.

## 11. Digests and Workflows

Use a Queue for ordinary event delivery.

Use Cron/Workflow only when the process is genuinely long-lived or aggregated:

- daily/weekly digest;
- notice acknowledgement escalation;
- delayed reminder;
- scheduled notice expiry;
- multi-step approval sequence.

Do not start a Workflow for every comment mention.

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

Keep the old path for unrelated events until each is migrated. Do not switch all notification types in one deployment.

## 14. Tests

- domain write succeeds even when Queue publish fails;
- pending outbox recovery republishes;
- duplicate Queue deliveries create one notification/email;
- access is rechecked;
- preferences/mute are honored;
- transient failure retries;
- persistent failure reaches DLQ/state;
- successful message is not retried with a failed sibling batch item;
- actor is excluded where required;
- email content/deep link remains correct;
- audit/domain mutation is not duplicated.

## 15. Non-goals

- External Knock/Novu managed service.
- Operating a separate notification platform in TB4.
- Realtime WebSocket inbox.
- Replacing the current inbox UI simultaneously with all backend delivery changes.
