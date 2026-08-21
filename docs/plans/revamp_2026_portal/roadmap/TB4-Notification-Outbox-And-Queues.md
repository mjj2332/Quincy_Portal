# TB4 — Notification Outbox and Cloudflare Queues

**Primary user outcome:** one notification event is delivered reliably without blocking or risking the originating action.

## First event

Project-comment mention.

TB4 proves the durable delivery envelope only. [TB4A](./TB4A-Collaboration-Pane-Editor-Assignment.md) reuses it for targeted assignment events, [TB4B](./TB4B-Project-Deadline-And-Reminders.md) for scheduled reminders, and [TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md) for the broad event registry. None may broaden TB4 before this checkpoint is accepted.

## Scope

- Add D1 outbox schema.
- Write outbox intent in the same batch as the comment/mention mapping.
- Publish outbox ID to a Queue.
- Add idempotent Queue consumer.
- Recheck access/active status.
- Insert in-app notification and send email.
- Configure retries and DLQ.
- Add pending-outbox recovery scan.
- Record delivery status/error.

## Non-goals

- migrate every event type;
- redesign notification bell;
- implement all preferences/digests;
- external notification platform.
- editor-roster UI/mutations (TB4A), project deadline/reminder scheduling (TB4B), or editor-wide event migration (TB4C).

## Acceptance

- Queue outage does not lose the notification intent;
- duplicate delivery creates one in-app recipient row; email follows a provider-supported idempotency contract or an explicitly documented ambiguity policy;
- access removal prevents delivery;
- transient failure retries;
- permanent failure is visible/recoverable;
- comment creation remains successful and fast.

## Checkpoint

Accept the event envelope/idempotency/observability pattern before migrating other events.
