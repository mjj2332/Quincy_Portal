# TB4 — Notification Outbox and Cloudflare Queues

**Primary user outcome:** one notification event is delivered reliably without blocking or risking the originating action.

## First event

Project-comment mention.

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

## Acceptance

- Queue outage does not lose the notification intent;
- duplicate delivery creates one notification/email;
- access removal prevents delivery;
- transient failure retries;
- permanent failure is visible/recoverable;
- comment creation remains successful and fast.

## Checkpoint

Accept the event envelope/idempotency/observability pattern before migrating other events.
