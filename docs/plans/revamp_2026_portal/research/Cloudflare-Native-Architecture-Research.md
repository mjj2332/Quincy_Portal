# Research — Cloudflare-Native Collaboration Architecture

**Conclusion:** Cloudflare provides the infrastructure primitives Quincy needs without adopting a separate collaboration vendor. Quincy still owns the domain model and reliability design.

## D1

Useful for:

- discussions, entries, mentions, reactions;
- server-side read state/subscriptions;
- project/Kanban metadata;
- notifications/preferences/outbox;
- activity/audit references.

D1 `batch()` executes prepared statements sequentially as a transaction and rolls back the sequence when a statement fails. This supports writing a domain mutation, mention mappings, activity and outbox intent together.

D1 and Queue publication are not one atomic transaction, which is why an outbox/recovery scan is required.

## Cloudflare Queues

Useful for:

- asynchronous recipient fan-out;
- email delivery outside the request path;
- batching;
- retries/delays;
- dead-letter routing.

Important design consequence: delivery can be retried/redelivered, so business idempotency keys are mandatory.

## Dead-letter Queue

Configure a DLQ so messages that reach retry limits are retained for separate processing instead of being discarded.

Quincy must still provide:

- error visibility;
- replay process;
- idempotent consumer;
- access/preference recheck.

## Cron Triggers

Useful for:

- pending-outbox recovery;
- digest generation;
- notice expiry scan;
- due reminder scan;
- cleanup/retention.

Cron expressions execute in UTC and support an every-minute schedule (`* * * * *`). For an editable project deadline, a short scan over indexed D1 reminder occurrences can claim due rows, validate the current deadline version and feed the same outbox/Queue path. The reviewed TB4A plan must set an explicit scheduler cadence and user-facing delivery tolerance.

## Workflows

Useful for durable multi-step processes that wait/retry for minutes, hours or weeks:

- digest workflows;
- acknowledgement escalation;
- scheduled reminders;
- multi-step delivery/approval.

Workflows can sleep until a fixed `Date`/Unix timestamp. They remain an alternative for long-lived orchestration, but one Workflow per editable reminder adds cancellation/reschedule/version coordination that the initial D1 schedule + Cron scan avoids.

Not required for ordinary immediate comment mentions.

## R2

Useful for future comment/card attachments.

Patterns:

- Worker binding for authorized reads/writes;
- short-lived presigned PUT for direct upload;
- short-lived GET or Worker-proxied read depending authorization needs;
- D1 stores metadata and access relationships.

Presigned URLs are bearer credentials and must have short expiry for sensitive material.

## Durable Objects

Not required for current asynchronous behavior.

May be considered later for:

- strong per-board operation ordering under high concurrency;
- realtime presence/WebSockets;
- collaborative editing.

D1 guarded updates are sufficient for the current internal volume unless measurements prove otherwise.

## KV

Do not use KV as authoritative storage for:

- comments;
- unread state;
- card positions;
- reactions;
- notification delivery state.

Those require relational/transactional consistency. KV may cache non-critical derived/config data.

## Portability boundary

Hide Cloudflare mechanics behind domain interfaces where practical:

```ts
interface DiscussionRepository {}
interface ActivityRepository {}
interface NotificationOutbox {}
interface AttachmentStore {}
interface EmailSender {}
```

Use versioned Queue payloads and ordinary SQL migrations so the domain remains understandable/exportable.

## Official sources

- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/queues/
- https://developers.cloudflare.com/queues/configuration/batching-retries/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/workflows/
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- https://developers.cloudflare.com/r2/api/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
