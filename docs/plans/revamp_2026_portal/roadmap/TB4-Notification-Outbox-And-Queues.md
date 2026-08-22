# TB4 — Notification Outbox and Cloudflare Queues

**Primary user outcome:** one existing project-comment mention is delivered reliably without blocking or risking the comment.

## First event

Project-comment mention only.

## Scope

- Add D1 outbox and recipient/channel delivery ledger.
- Write mention mapping and outbox intent in the same domain-write boundary.
- Publish outbox ID to Cloudflare Queue.
- Idempotent consumer with lease/token claims and access recheck.
- Insert in-app row and send optional email.
- Retry definitive transient failures; record ambiguous email acceptance as `unknown` without automatic retry.
- Configure DLQ and Cron pending/stuck recovery.
- Maintain one authoritative old/new semantic producer.
- Add compact Admin delivery operations: pending/stuck, DLQ, failed, unknown; safe replay/discard with duplicate warning for unknown email.

## Non-goals

- every notification producer;
- full preferences/digest centre;
- notification bell redesign;
- roster/Deadline/broad registry work;
- external notification vendor.

## Acceptance

- Queue outage cannot lose intent;
- duplicate Queue/replay creates one in-app row;
- access removal suppresses;
- transient retry, persistent DLQ, unknown email behavior;
- Admin operations work without sensitive content;
- comment remains successful/fast;
- one producer and audit/activity not duplicated;
- full gate/manual QA.
