# Revamp TB4 — Notification Outbox and Cloudflare Queues Plan

> **Status: APPROVED — plan review complete (2 Sol draft-review rounds, Opus tier-2 edited the plan
> directly to resolve round-2's 5 remaining findings rather than spending a revert, final verdict
> APPROVE 2026-08-25); not yet implemented, verified, or deployed.**

## Authority and outcome

Authority order for this plan is:

1. [`Decision-Sheet.md` D-17](../Decision-Sheet.md), limited to its durable-notification decision:
   notification rules and data remain Quincy-owned on Cloudflare, with a D1 outbox, Cloudflare
   Queue, and send-time authorization. D-17's freshness, discussion, pipeline, and Kanban
   sub-areas are already delivered or remain owned by other tracer bullets and are not TB4 scope.
2. [`Implementation-Plan.md` A10](../Implementation-Plan.md), limited to its durable-delivery
   paragraph: D1 outbox, Queue, recipient/channel ledger, recovery scan, and DLQ; immediate
   active/role/capability/membership/visibility reauthorization; silent, audited suppression;
   `unknown` for ambiguous email acceptance; and one producer per semantic event.
3. The approved [TB4 roadmap scope stub](./revamp_2026_portal/roadmap/TB4-Notification-Outbox-And-Queues.md).
4. The settled [Notifications on Cloudflare architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md),
   especially §§1–2, 7, 9, and 10.
5. The shipped [TB3 Project Discussion v2 plan](./implemented/Revamp-TB3-Project-Discussion-V2-Plan.md)
   and, more importantly, its actual service implementation in
   `portal/workers/app/src/lib/project-comments.ts`.
6. The existing rendition Queue/DLQ/Cron and Admin-operations implementation in
   `portal/workers/background` and `portal/workers/app`, used as this repository's concrete
   Cloudflare precedent.
7. This repository-native execution plan.

The primary user outcome is the roadmap's approved outcome: **“one existing project-comment
mention is delivered reliably without blocking or risking the comment.”**

TB4 is deliberately one narrow tracer bullet. It takes only newly-created project-comment mention
mappings—on comment create and newly-added mentions on edit—through the settled durable-delivery
flow. It does not create a general event bus, resolve recipients for future rail/Deadline/registry/
External Editor features, or migrate any other notification producer.

### Implementation precondition

TB0A, TB0B, TB1, TB2, and TB3 are deployed and accepted on current `main`; `docs/todo.md` identifies
TB4 as next. Implementation begins from a fresh branch off then-current `main`, records that base
commit, and rechecks the remote D1 migration ledger and Queue inventory before editing. This plan
authorizes no work in `prototype/` and no file outside the implementation, evidence, and eventual
status surfaces named below.

## Verified current state

### Existing notification inbox storage, API, and bell

Migration `portal/packages/db/migrations/0019_productive_victor_mancha.sql` and the Drizzle mapping
in `portal/packages/db/src/schema.ts` define the shipped `notifications` table:

| Column | Current D1 definition | Current meaning |
|---|---|---|
| `id` | `text PRIMARY KEY NOT NULL` | inbox-row UUID |
| `user_id` | `text NOT NULL REFERENCES user(id) ON DELETE cascade` | recipient |
| `project_id` | nullable FK to `projects(id) ON DELETE cascade` | optional project deep-link scope |
| `type` | `text NOT NULL` | one of the app's current notification types at the TypeScript seam |
| `title` | `text NOT NULL` | rendered bell title |
| `body` | nullable text | rendered bell body |
| `read_at` | nullable integer | per-user read state |
| `email_sent_at` | nullable integer | legacy best-effort email result mirror |
| `email_error` | nullable text | legacy best-effort email error mirror |
| `email_message_id` | nullable text | Cloudflare Email Service message ID mirror |
| `source_key` | nullable text | producer-supplied semantic source identity |
| `created_at` | `integer NOT NULL` | inbox-row creation time |

`notifications_user_unread_idx` indexes `(user_id, read_at, created_at)`. The partial unique index
`notifications_source_key_unique` enforces `(type, source_key, user_id)` when `source_key IS NOT
NULL`. For a mention, `type = 'mentioned'` and `source_key` is the mention-mapping UUID.

`portal/workers/app/src/routes/notifications.ts` owns the authenticated current-user surface:

- `GET /api/notifications?limit=1..50&cursor=<date>` lists only the caller's rows, newest first,
  and returns an unread count;
- `POST /api/notifications/:id/read` marks only the caller's unread row;
- `POST /api/notifications/read-all` marks all of the caller's rows; and
- `DELETE /api/notifications/:id` permanently removes only the caller's row and writes
  `notification.delete` to `audit_log`.

`portal/apps/web/src/components/Topbar.tsx` polls the list every 25 seconds, renders at most the
requested 25 rows in the existing bell menu, deep-links project mentions to
`/projects/:projectId?collaboration=open`, and optimistically reads/dismisses with server
reconciliation on the next poll. TB4 does not redesign or convert this UI.

**Relationship decision:** `notifications` remains the final, user-visible, read/dismissible
**in-app inbox projection**. It is not renamed, rebuilt, or repurposed as the outbox or delivery
ledger. The new `notification_outbox` stores durable work; the new
`notification_delivery_ledger` is authoritative for per-channel attempts and outcomes; its
optional `notification_id` points at the resulting inbox row with `ON DELETE SET NULL`. Dismissing
an inbox row therefore never deletes delivery history and never makes replay recreate the in-app
row. The existing `notifications.email_*` fields remain compatibility mirrors for old direct
producers and are best-effort updated for TB4 email results while the ledger—not those columns—is
the TB4 retry/idempotency authority.

### Current direct mention producer and exact call sites

`portal/workers/app/src/lib/notifications.ts` currently exports `notifyMentions()`. It:

- removes duplicate recipient IDs and excludes the actor;
- for Notice Board mentions, selects active targeted staff;
- for project-comment mentions, obtains active project members plus active Admins through
  `projectNotificationRecipients()`, then keeps only the specifically mapped target;
- writes one `notifications` row with `type = 'mentioned'` and `source_key = mention.id` through
  `emitNotifications()`;
- uses `ON CONFLICT (type, source_key, user_id) WHERE source_key IS NOT NULL DO NOTHING` for in-app
  idempotency;
- after a successful insert, calls `env.EMAIL.send({ from, to, subject, text, html })` when both
  `EMAIL` and `NOTIFICATIONS_FROM_ADDRESS` exist; and
- catches the whole operation. Email failures become `notifications.email_error`; no failure can
  fail the original route, but there is no durable retry, Queue, channel ledger, recovery, DLQ, or
  ambiguity classification.

There are exactly four live route call sites:

| Route source | Mutation | Mappings passed today |
|---|---|---|
| `portal/workers/app/src/routes/project-comments.ts` | comment POST | all newly-stored comment mappings |
| same file | author comment PATCH | newly-added mappings only |
| `portal/workers/app/src/routes/notice-board.ts` | Notice Board POST | all newly-stored post mappings |
| same file | author Notice Board PATCH | newly-added mappings only |

TB4 cuts over only the first two rows. The Notice Board path remains direct and all other calls to
`emitNotifications()`, `notifyProject()`, `notifyProjectAssignments()`, and
`notifySubtaskAssignee()` remain unchanged.

### TB3's shipped activity/outbox-intent value

`portal/workers/app/src/lib/project-comments.ts` now constructs and returns this exact immutable
value for each committed comment create/edit/delete, but does not persist it:

```ts
type ProjectCommentActivityOutboxIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type:
      | "project.comment.created"
      | "project.comment.edited"
      | "project.comment.deleted";
    projectId: string;
    actorId: string;
    occurredAt: string;
    source: { kind: "project_comment"; id: string; key: string };
    safePayload: { commentId: string };
    deepLink: { kind: "project_collaboration"; path: string };
  };
  broadDelivery: {
    registryKey:
      | "project.comment.created"
      | "project.comment.edited"
      | "project.comment.deleted";
    sourceActivityId: string;
    coalesce: null | { key: string; windowSeconds: 300 };
  };
  targetedMentionDelivery: false;
};
```

Its exact source keys are:

- create: `project-comment:<commentId>:created`;
- delete: `project-comment:<commentId>:deleted`; and
- edit: `project-comment:<commentId>:edited:<activityId>`.

Only edit carries the future broad-delivery coalesce hint
`project-comment-edit:<projectId>:<commentId>:<actorId>` / 300 seconds. `safePayload` contains only
the comment ID, and the deep link comes from the typed staff-route helper. The literal
`targetedMentionDelivery: false` means the broad activity intent is **not** a second targeted
mention producer.

TB4 preserves that object unchanged and persists it inside a versioned mention-specific outbox
envelope. It does not reinterpret `broadDelivery`, change the false flag, emit
`project.comment.created/edited/deleted` broadly, or create an activity table. For TB4's one event,
the semantic delivery source is still the mention-mapping ID, not the activity source key:

```ts
type ProjectCommentMentionOutboxPayload = {
  schemaVersion: 1;
  event: {
    type: "project.comment.mentioned";
    sourceKey: string; // project_comment_mentions.id
    recipientId: string;
  };
  authorizationAtOccurrence:
    | { kind: "admin" }
    | { kind: "project_member"; membershipIds: string[] };
  projectCommentActivity: ProjectCommentActivityOutboxIntent;
};
```

The authorization snapshot is deliberately narrow: it records only whether the currently active
target qualified as an Admin or the sorted UUIDs of their current `project_members` rows for this
project. It is not a future roster/recipient registry. No comment body, rich-text JSON, street,
author name, recipient email, or provider diagnostic is copied into the payload. The consumer
reloads the current targeted comment/author/project/recipient projection only after authorization
succeeds.

### Existing Queue, DLQ, claim, Cron, and operator precedents

`portal/workers/background/wrangler.jsonc` already proves the project pattern:

- `quincy-renditions` consumes with `max_batch_size: 1`, `max_concurrency: 1`, `max_retries: 3`,
  and `dead_letter_queue: "quincy-renditions-dlq"`;
- `quincy-renditions-dlq` consumes with `max_batch_size: 10`, `max_retries: 3`;
- both app and background Workers can publish through producer bindings; and
- the background Worker already owns the hourly UTC Cron: `"0 * * * *"`.

`portal/workers/background/src/index.ts` routes by `batch.queue`, parses the body, explicitly
`ack()`s success and terminal DLQ recording, and explicitly `retry()`s failure. The rendition DLQ
consumer records an operator-visible D1 row and acknowledges it rather than uselessly retrying a
known exhausted main-queue message. `portal/workers/app/src/routes/admin.ts` atomically claims
open DLQ rows before replay/discard, reopens a claim if Queue publication fails, audits the
operator action, and returns `409` for a stale concurrent operation. `Admin.tsx` surfaces that
bounded list in the existing Integrations operator area.

The background Cron currently runs `reconcileAwaitingRawProjects()`, `scanStalledAutoHdr()`,
`scanDueSubtasks()`, and read-notification pruning. `scanStalledAutoHdr()` selects eligible rows,
then `processStalledAutoHdrCandidate()` uses a guarded single-row `UPDATE ... WHERE ...` claim,
per-candidate processing, diagnostics for a lost race, and claim rollback on delivery failure.
Other shipped claims use 10- or 15-minute leases and owner tokens. TB4 follows those patterns with
a 10-minute notification lease and does not rely on Queue message IDs or `max_concurrency: 1` for
correctness.

### Existing Cloudflare Email Service binding

Both `portal/workers/app/wrangler.jsonc` and `portal/workers/background/wrangler.jsonc` already
declare `"send_email": [{ "name": "EMAIL" }]`; both Env types expose optional `EMAIL` and
`NOTIFICATIONS_FROM_ADDRESS`. The deployed code passes that binding directly into
`emitNotifications()`, whose actual call is:

```ts
const result = await env.EMAIL.send({ from, to, subject, text, html });
// result.messageId is persisted on success; thrown Error.code/Error.message on failure today
```

The current code uses this in both Workers for every email-enabled notification type. It neither
uses nor needs a third-party vendor, SDK, API key, or new provider. Cloudflare's current first-party
[`SendEmail` Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes)
documents the same structured input, `{ messageId }` result, and coded errors. Its error table says
`E_RATE_LIMIT_EXCEEDED` means the sending rate limit was reached and
`E_DAILY_LIMIT_EXCEEDED` means the daily sending quota was reached. Those are admission gates: in
each case the already-reached governing quota rejects the current attempt before it can be accepted,
so TB4 allowlists exactly those two coded transient rejections for automatic retry. By contrast,
the same table describes `E_INTERNAL_SERVER_ERROR` only as an internal service error caused by
temporary Email Service unavailability; it gives no guarantee that the message was not accepted
before that error surfaced. TB4 therefore treats `E_INTERNAL_SERVER_ERROR`, an uncoded/unrecognized
exception, a lost invocation after an email attempt starts, or a failure to durably record a
resolved send as ambiguous `unknown`. Documented validation/sender/recipient/content/delivery
rejections remain terminal failures. This is intentionally conservative: only a proven
pre-acceptance transient rejection is automatically retried.

### Migration ledger and safety

Migration `0030_project_comment_read_markers.sql` is applied to production. `CLAUDE.md`/`AGENTS.md`
and `docs/todo.md` identify **0031** as the next available number. The exact recovery-export
directory established by TB3 is:

```text
/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/db-recovery/
```

`0030` is the now-proven additive-only `CREATE TABLE`/`CREATE INDEX` precedent. TB4 likewise adds
new tables and indexes only: no table rebuild, copy, drop, backfill, `PRAGMA foreign_keys` toggle,
or edit to existing notification/comment rows. This avoids the remote D1 table-rebuild failure
documented in `docs/lessons.md`.

## Scope constraints

### In scope

- Add a D1 notification outbox and recipient/channel delivery ledger.
- Write each new project-comment mention mapping and its outbox/ledger intent in the same D1
  domain-write boundary, reusing TB3's already-constructed immutable activity intent.
- Publish only `{ type: "notification_outbox", outboxId }` to a dedicated Cloudflare Queue after
  the transaction commits; a publication failure leaves recoverable D1 intent.
- Consume idempotently in the background Worker with a token/lease claim and immediate active,
  role, `collaborateOnProject` capability, occurrence membership-cycle/current membership or Admin,
  mention-mapping, comment, and project visibility checks.
- Insert the mandatory existing `notifications` in-app projection, then attempt the default-on
  optional mention email through the existing `EMAIL` binding.
- Retry only definitive transient pre-acceptance failures; record ambiguous email acceptance as
  `unknown` and never automatically retry it.
- Add a dedicated DLQ consumer plus the existing hourly Cron's bounded pending/queued-stuck/
  expired-lease recovery scan.
- Maintain exactly one producer for the project-comment mention semantic event by replacing the
  project-comment direct `notifyMentions()` calls at cutover while leaving Notice Board and every
  other producer direct.
- Add compact `adminBackend` delivery operations for pending/stuck, DLQ, failed, and unknown rows,
  with guarded replay/discard and an explicit duplicate-email warning for unknown email.
- Add focused schema/domain/Queue/email/auth/Admin tests, full repository gates, local and remote
  migration proof, manual QA, redacted evidence, and a migration/background-first/app rollout.

### Hard non-goals

- **No migration of every notification producer.** RAW/Edited/Stage/AutoHDR, assignment,
  annotation/review, subtask, due-today, Notice Board mention, and every event beyond
  project-comment mention keep their current direct path.
- **No full preferences or digest centre.** Targeted mention email preserves today's default-on
  behavior when the existing binding is configured. TB4 adds no settings table, per-project mute,
  digest cadence, or preference UI; later notification phases own the approved preference model.
- **No notification-bell redesign.** `Topbar.tsx`, its 25-second polling, list/read/read-all/
  dismiss API, copy, layout, and deep-link behavior remain the user inbox surface.
- **No roster, project Deadline, or broad recipient registry.** TB4 does not design or pre-build
  TB4A/TB4B/TB4C recipient contracts, a general membership-cycle schema, assignment rail,
  Deadline schedule, Editor-wide categories, activity feed, coalesced broad comment delivery,
  checklist scheduling, Calendar behavior, or External Editor policy. The mention envelope's
  occurrence-time snapshot of existing `project_members.id` values is the minimum needed to
  reauthorize this already-existing recipient without letting remove/re-add inherit old work.
- **No external notification vendor.** No push, SMS, webhook provider, third-party email SDK, or
  replacement email service. Only the existing D1 `notifications` projection and existing
  Cloudflare `EMAIL` binding are used.
- No Kanban, Stage, pipeline semantic, AutoHDR direct-send, route-freshness, discussion model,
  read-marker, comment UI, author-only, or rich-text change.
- No use of Queue message ID as semantic identity. Queue delivery is at least once; the D1 key is
  authoritative.
- No automatic retry from `unknown`, no user-visible reauthorization error, no silent access
  bypass, no duplicate producer, and no deletion of committed comment/audit/inbox data during
  replay, discard, rollback, or recovery.

## Exact implementation plan

### 1. Recheck the base, resources, and migration ledger

Before implementation, record:

- current branch/base commit and a clean/understood worktree;
- checked-in migration tail, Drizzle journal tail, and remote `d1_migrations` tail with 0030 last;
- absence of `notification_outbox`, `notification_delivery_ledger`, and their named indexes;
- current `quincy-notifications` / `quincy-notifications-dlq` resource absence or exact existing
  identity if provisioned separately before the branch;
- current background/app Worker versions for rollback; and
- current `EMAIL`, `NOTIFICATIONS_FROM_ADDRESS`, `DB`, existing Queue, and Cron binding inventory
  without printing secret values.

Re-read the TB4 stub, D-17, A10, core/07, current comment service/routes, both notification helper
implementations, both Wrangler configs, background `queue()`/`scheduled()`, Admin DLQ operations,
and current tests. If migration 0031 or either Queue name is now occupied, stop and revise this plan
before generating or provisioning anything; do not silently renumber or bind an unrelated Queue.

### 2. Add exact additive migration 0031

Create `portal/packages/db/migrations/0031_notification_outbox_and_delivery_ledger.sql` with this
exact SQL (plus Drizzle's normal `--> statement-breakpoint` separators):

```sql
CREATE TABLE notification_outbox (
  id text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL,
  event_type text NOT NULL,
  source_key text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  recipient_id text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'queued', 'processing', 'completed',
      'suppressed', 'failed', 'dlq', 'discarded'
    )),
  available_at integer NOT NULL,
  queue_published_at integer,
  lease_token text,
  lease_expires_at integer,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error_code text,
  last_error text,
  completed_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (event_type, source_key, recipient_id)
);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_available_idx
  ON notification_outbox (status, available_at, created_at, id);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_lease_idx
  ON notification_outbox (status, lease_expires_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_queue_idx
  ON notification_outbox (status, queue_published_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_updated_idx
  ON notification_outbox (status, updated_at, id);
--> statement-breakpoint

CREATE TABLE notification_delivery_ledger (
  id text PRIMARY KEY NOT NULL,
  outbox_id text NOT NULL REFERENCES notification_outbox(id) ON DELETE restrict,
  event_type text NOT NULL,
  source_key text NOT NULL,
  recipient_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'sent', 'suppressed',
      'failed', 'unknown', 'discarded'
    )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  notification_id text REFERENCES notifications(id) ON DELETE set null,
  email_message_id text,
  last_error_code text,
  last_error text,
  last_attempt_at integer,
  delivered_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  UNIQUE (outbox_id, channel),
  UNIQUE (event_type, source_key, recipient_id, channel)
);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_outbox_idx
  ON notification_delivery_ledger (outbox_id, channel);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_status_updated_idx
  ON notification_delivery_ledger (status, updated_at, id);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_notification_idx
  ON notification_delivery_ledger (notification_id);
```

That last index is not optional. `notification_id` is the child key of an `ON DELETE SET NULL` FK,
and SQLite must locate every matching child row before it can delete a `notifications` parent.
Without an index on that column the plan for a parent delete is `SCAN
notification_delivery_ledger`, so both the user-facing `DELETE /api/notifications/:id` dismissal
and — far worse — the hourly Cron's existing bulk `DELETE FROM notifications WHERE read_at IS NOT
NULL AND read_at < ?` scan the whole append-only ledger once per deleted parent row, growing more
expensive every month. With the index the same delete plans as `SEARCH
notification_delivery_ledger USING COVERING INDEX notification_delivery_ledger_notification_idx
(notification_id=?)`.

The ledger's second unique constraint is core/07's exact semantic delivery key:
`(event_type, source_key, recipient_id, channel)`. For this tracer bullet,
`event_type = 'project.comment.mentioned'` and `source_key = project_comment_mentions.id`. Queue
message ID is deliberately absent. The outbox's three-column unique constraint ensures one
recipient envelope; the ledger permits exactly one row for each of that envelope's `in_app` and
`email` channels.

`schema_version` and `event_type` are intentionally runtime-validated rather than SQL-locked to
`1`/`project.comment.mentioned`. TB4's parser accepts exactly that version and event and rejects
everything else. Keeping the storage columns extensible is infrastructure reuse, not a generic
producer registry; SQL checks on today's only literal would force a future existing-table rebuild
when an approved TB4x producer starts using the settled outbox/ledger.

The outbox intentionally has no FK to project/comment/mention/user. Those domain rows can be
removed before dispatch; delivery must then reach the send-time authorization path and record an
audited suppression rather than cascade-delete the durable intent. The payload contains only the
safe TB3 intent plus stable IDs. The ledger points to its durable parent with `RESTRICT` and to the
dismissible inbox projection with `SET NULL`.

Add exact Drizzle mappings and indexes in `portal/packages/db/src/schema.ts`, export any required
types from `@quincy/db`, and update the migration journal/snapshot through the repository's normal
mechanism. A second `drizzle-kit generate` after the checked-in schema/migration state must be
empty. Do not accept a generated rebuild of any existing table.

### 3. Make the comment domain batch the sole mention-intent producer

Refactor `portal/workers/app/src/lib/project-comments.ts` so
`createProjectCommentActivityIntent()` runs **before** each mutation batch. Preserve its exact
shape and values. Add a focused builder that derives one `ProjectCommentMentionOutboxPayload` for
each newly-inserted mapping whose `mentionedUserId !== actorId`; it receives the already-created
TB3 intent rather than reconstructing an activity object. Extend the current project-mention
eligibility read—not the future registry—with a mention-only occurrence snapshot: active Admin
targets store `{ kind: "admin" }`; other active targets store all current matching
`project_members.id` values, sorted, under `{ kind: "project_member", membershipIds }`. The
snapshot contains no role-wide directory, email, name, or content data.

For create, the single D1 `batch()` contains, in order:

1. the existing append-monotonic comment INSERT;
2. every existing `project_comment_mentions` INSERT;
3. the existing author's read-marker upsert;
4. the existing `project_comment.create` audit INSERT;
5. one `notification_outbox` INSERT per non-self mention mapping; and
6. two `notification_delivery_ledger` INSERTs per outbox (`in_app`, `email`).

For edit, the single batch contains the existing guarded comment update; the conditional exact
`project_comment.edit` audit immediately after it; removed-mapping DELETEs; new-mapping INSERTs;
and outbox/two-ledger inserts only for new non-self mappings. An existing retained mention never
creates a new event. Removing a mention does not delete its durable outbox/ledger; if it has not
dispatched, the mapping-existence check suppresses it. Re-adding later creates a new mapping UUID
and therefore a new semantic event, which matches today's behavior.

For delete, move the exact `project_comment.delete` audit into the same batch as the comment
DELETE. It creates no mention outbox. Pending mention envelopes from that comment later fail
visibility/mapping reauthorization and are silently, auditably suppressed.

The audit rows keep their current action, target type, target ID, null metadata, and one-per-
successful-mutation semantics. Where a mutation can lose the route's prior existence check (edit/
delete), use the repository's existing ordered-batch pattern: the audit INSERT is an
`INSERT ... SELECT ... WHERE changes() = 1` immediately after the guarded domain statement, and
later mention/outbox statements cannot succeed against a missing parent. Inspect the returned
domain-statement result and do not report success for a zero-change race. The route stops calling
`audit()` for these three mutations so it cannot double-write. The service returns:

```ts
{
  comment?: CommentRow;
  activity: ProjectCommentActivityOutboxIntent;
  notificationOutboxIds: string[];
}
```

No Queue call occurs inside the D1 batch or service. Any failed comment/mention/audit/outbox/ledger
statement rolls back the whole batch; a successful batch proves the comment and its delivery intent
exist together.

### 4. Cut over exactly one producer and publish after commit

Add one typed Queue contract, owned at a shared seam used by app/background:

```ts
type NotificationOutboxMessage = {
  type: "notification_outbox";
  outboxId: string;
};
```

Add required producer binding `NOTIFICATION_QUEUE` → `quincy-notifications` to
`portal/workers/app/wrangler.jsonc` and the matching Env type. After a successful POST/PATCH
service result, `project-comments.ts` schedules—not awaits—the publication:

```ts
c.executionCtx.waitUntil(
  publishNotificationOutbox(c.env, result.notificationOutboxIds),
);
```

For each ID, `publishNotificationOutbox()` calls exactly:

```ts
await env.NOTIFICATION_QUEUE.send({
  type: "notification_outbox",
  outboxId,
});
```

On acceptance it guardedly sets a still-`pending` or already-`queued` row to `queued`, advances
`queue_published_at`, increments `publish_attempts`, and clears publish error fields. Accepting
`queued` here is required so Cron's duplicate recovery publication advances the stuck timestamp.
On rejection it leaves `pending` as `pending`, leaves an old `queued` timestamp old, increments
`publish_attempts`, records a bounded/sanitized error, and logs without throwing into the
already-returning comment request. If Queue delivery races ahead of the status update, the consumer
may claim `pending`; the post-send update's `WHERE status IN ('pending', 'queued')` then cannot
downgrade `processing` or a terminal row.

At the same cutover, remove both project-comment route calls to direct `notifyMentions()`. Narrow
that helper's public input to Notice Board only (renaming it to `notifyNoticeBoardMentions()` is
preferred) and update its two Notice Board call sites/tests. Do not retain a dormant project-
comment branch “for fallback.” The old direct and new outbox paths share the stable mapping source
key, but only one is invoked by any deployed comment request:

```text
before TB4 app: project comment → direct notifyMentions(mapping id)
after TB4 app:  project comment → transactional outbox(mapping id) → Queue consumer
unchanged:      Notice Board    → direct Notice Board mention helper
```

This is the load-bearing single-producer decision. The outbox consumer inserts
`notifications(type='mentioned', source_key=mappingId, user_id=recipientId)`, preserving the old
semantic identity and existing partial-unique backstop. It does not also call
`emitNotifications()` or construct a broad `project.comment.*` event.

### 5. Wire the dedicated Queue and background consumer

Provision `quincy-notifications` and `quincy-notifications-dlq`. In
`portal/workers/background/wrangler.jsonc`, add:

```jsonc
{ "queue": "quincy-notifications", "max_batch_size": 1, "max_concurrency": 1,
  "max_retries": 3, "dead_letter_queue": "quincy-notifications-dlq" },
{ "queue": "quincy-notifications-dlq", "max_batch_size": 10, "max_retries": 3 }
```

and producer binding:

```jsonc
{ "binding": "NOTIFICATION_QUEUE", "queue": "quincy-notifications" }
```

The background producer is required for Cron recovery; add its typed Env binding. Keep the
existing consumers, producer bindings, and hourly Cron unchanged. Extend the current queue parser/
dispatcher rather than adding another Worker. Route by queue name before body type, as the
rendition/DLQ implementation does.

For each main-queue message, validate the exact body and atomically claim with a new UUID token and
a 10-minute lease:

```sql
UPDATE notification_outbox
SET status = 'processing',
    lease_token = ?,
    lease_expires_at = ?,
    delivery_attempts = delivery_attempts + 1,
    last_error_code = NULL,
    last_error = NULL,
    updated_at = ?
WHERE id = ?
  AND (
    (status IN ('pending', 'queued') AND available_at <= ?)
    OR (
      status = 'processing' AND lease_expires_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM notification_delivery_ledger l
        WHERE l.outbox_id = notification_outbox.id
          AND l.channel = 'email' AND l.status = 'processing'
      )
    )
  )
RETURNING *;
```

Run that claim and the following in-app reclaim as the two statements, in this order, of one
`env.DB.batch()` transaction, binding the same outbox ID, new lease token, and `updated_at` value:

```sql
UPDATE notification_delivery_ledger
SET status = 'pending',
    last_error_code = 'delivery_lease_expired',
    last_error = 'In-app delivery lease expired; reclaimed by a new outbox owner.',
    updated_at = ?
WHERE outbox_id = ?
  AND channel = 'in_app'
  AND status = 'processing'
  AND EXISTS (
    SELECT 1 FROM notification_outbox o
    WHERE o.id = notification_delivery_ledger.outbox_id
      AND o.status = 'processing'
      AND o.lease_token = ?
  );
```

The returned row from the first statement is still the sole proof that this invocation won the
claim. If it returns no row, the new token cannot satisfy the second statement and the duplicate is
acknowledged. If either statement fails, D1 rolls the batch back. When an expired outbox is won, the
token guard lets that specific new owner reset only a stale `in_app = processing` ledger row to
`pending`; the next channel step can therefore redo the unique/idempotent inbox insert immediately,
without waiting for Cron. Do not reset attempts here: the normal `pending` to `processing` step
records the new channel attempt.

The `available_at <= ?` fence binds the same `now` used elsewhere in the batch and is what keeps a
duplicate or redelivered message from jumping an intended backoff. Both paths that release work
schedule it forward — the quota-rejection path in §6 step 5 and the in-app release in §6 step 4 each
set `available_at` to the retry time — and retrying a rate-limited send early is guaranteed to fail
again and burn the message's remaining attempts against the same closed quota gate.

A terminal/missing row or a row with a current lease is not claimed and the duplicate message is
acknowledged. A current lease means another invocation owns the work. A row that is `pending`/
`queued` but not yet due is the one case that must not simply be acknowledged: read that row's
`status`/`available_at` once, content-free, and `message.retry({ delaySeconds })` with the remaining
delay, capped at the Queue's maximum, so the work stays in the Queue instead of depending on Cron.

The `NOT EXISTS` fence makes an expired email-`processing` attempt unclaimable too; only §7 may
convert that ambiguous attempt to `unknown`; the new in-app reclaim statement does not touch email.
Other expired work is safely reclaimable. Every subsequent update includes `outbox_id`, `lease_token`, and
`status = 'processing'`; losing ownership stops work and acknowledges without side effects.

Although configuration remains `max_concurrency: 1`, tests race two claims. Exactly one token wins.
Correctness comes from D1 constraints/claims, not implicit serialization.

This follows Cloudflare's first-party contracts: a D1
[`batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) is a transaction
whose statements execute sequentially and roll back as a unit on failure, while Queue
[`ack()`/`retry()` and max retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
are delivery controls rather than semantic deduplication. The dedicated DLQ is an ordinary Queue
that receives a message only after the main consumer exhausts its configured retries, matching
Cloudflare's [DLQ contract](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

### 6. Reauthorize immediately, then deliver in-app and email independently

Add one background-side recipient resolver at the shared DB/capability seam; do not import Hono
middleware into the background Worker and do not invent a future recipient registry. For this one
event it reloads, by outbox ID/source mapping ID:

- the outbox recipient and actor IDs;
- `user.active`, current global role, name, and email;
- `roleHasCapability(currentRole, 'collaborateOnProject')`;
- current eligibility matching today's project mention picker/producer: active Admin, or an active
  user with a current `project_members` row for the exact project;
- the occurrence authorization snapshot: `{ kind: "admin" }` still requires current Admin role,
  while `{ kind: "project_member" }` requires at least one current row whose
  `project_members.id` is present in the stored `membershipIds`;
- the exact `project_comment_mentions` row still mapping this recipient to the comment;
- the exact comment still belonging to the outbox project; and
- the project, current author name, street, and current normalized comment body needed for the
  targeted copy.

There is no membership-cycle table today, so TB4 uses the identity the shipped schema already has:
each `project_members.id` is one concrete membership-row lifetime. Requiring intersection with the
occurrence snapshot means retaining either of two original project roles preserves eligibility,
while remove/re-add creates a new row ID and cannot inherit an old mention. Admin-at-occurrence is
the existing global-access branch and must still be Admin at send time. This is a mention-only
reauthorization input, not TB4A/TB4C's future role-delta or broad-recipient contract. The persisted
mention-mapping UUID separately ensures a removed/re-added mention is a new semantic occurrence.

Run this resolver immediately before the in-app channel. If it fails, use one D1 batch to mark both
unfinished ledger rows `suppressed`, mark the outbox `suppressed`, clear the lease, set
`completed_at`, and insert a system audit:

```text
action:      notification.delivery.suppressed
actor_id:    NULL
target_type: notification_outbox
target_id:   <outbox id>
meta_json:   event type, source key, recipient id, and bounded reason code only
```

Then `ack()` with no retry and no user-facing error. No notification or email is created.

For the mandatory `in_app` channel:

1. after the claim batch has reset any stale `processing` row for this outbox to `pending`,
   guardedly move only its `pending` ledger row to `processing` and increment attempts; a `sent` row
   remains terminal and is skipped, while a prior lost invocation can no longer leave this channel
   stuck;
2. re-run the resolver immediately before the insert;
3. in one D1 batch, insert the existing projection with the exact current copy and semantic key:

   ```sql
   INSERT INTO notifications (
     id, user_id, project_id, type, title, body, source_key, created_at
   ) VALUES (?, ?, ?, 'mentioned',
     'You were mentioned', 'You were mentioned in a project comment.', ?, ?)
   ON CONFLICT (type, source_key, user_id)
     WHERE source_key IS NOT NULL DO NOTHING;
   ```

   In that same D1 batch, follow it with an ownership-guarded convergence update rather than
   trusting the INSERT's `changes()` result:

   ```sql
   UPDATE notification_delivery_ledger
   SET status = 'sent',
       notification_id = (
         SELECT id FROM notifications
         WHERE type = 'mentioned' AND source_key = ? AND user_id = ?
         LIMIT 1
       ),
       delivered_at = ?, updated_at = ?, last_error_code = NULL, last_error = NULL
   WHERE id = ? AND outbox_id = ? AND channel = 'in_app' AND status = 'processing'
     AND EXISTS (
       SELECT 1 FROM notification_outbox o
       WHERE o.id = notification_delivery_ledger.outbox_id
         AND o.status = 'processing' AND o.lease_token = ?
     )
     AND EXISTS (
       SELECT 1 FROM notifications
       WHERE type = 'mentioned' AND source_key = ? AND user_id = ?
     );
   ```

   Require this ledger update to affect one row. It marks `sent` with the notification ID selected
   from the inserted-or-existing row.
   A duplicate Queue delivery therefore converges on one inbox row. If that row was later dismissed
   after a prior `sent` ledger outcome, replay never runs this insert again.
4. on a D1/platform failure, **release before retrying**. A bare `message.retry()` here is a no-op:
   §5's claim guard refuses any row whose lease is still live, so the redelivery would meet this
   invocation's own unexpired lease, be acknowledged as a duplicate, and silently leave the work to
   Cron up to an hour later — never reaching a Queue retry or the DLQ at all. Instead, mirror the
   quota path in the email step below. In one ownership-guarded D1 batch (`outbox_id`,
   `lease_token`, `status = 'processing'`), reset this outbox's `in_app` ledger row from
   `processing` back to `pending`, then release the outbox to `queued` with `lease_token` and
   `lease_expires_at` cleared and `available_at` set to the retry time, then call
   `message.retry({ delaySeconds })`. This release is safe only at this point in the sequence,
   because email has not been attempted yet; it is forbidden once the email channel has reached
   `processing`, where step 8 requires the lease to be left in place. If the release itself fails,
   `ack()` and let §7's expired-lease recovery reclaim the row rather than retrying into a lease
   this invocation can no longer clear. Never attempt email until in-app is durably `sent`.

For the optional/default-on `email` channel:

1. re-run authorization immediately before the attempt. If access disappeared after in-app, mark
   only unfinished email `suppressed`, audit the suppression, and complete the envelope; do not
   retract the already-authorized inbox row;
2. guardedly mark email `processing` **before** calling the binding. This is the ambiguity fence;
3. call the existing structured `env.EMAIL.send()` with the current safe project link and the
   existing project-mention format: author name, project street, and `truncateForEmail()` excerpt,
   with the existing single-pass HTML escaping;
4. on `{ messageId }`, mark email `sent` with `delivered_at`/`email_message_id`, then best-effort
   mirror `email_sent_at`/`email_message_id` onto the still-existing `notifications` row;
5. on `E_RATE_LIMIT_EXCEEDED` (Cloudflare says the sending rate limit was reached) or
   `E_DAILY_LIMIT_EXCEEDED` (Cloudflare says the daily sending quota was reached), treat the
   already-reached quota as a definitive pre-acceptance rejection, mark email back to `pending`,
   store only the bounded code/message, release the outbox lease to `queued`, set `available_at` to
   the retry time, and call `message.retry({ delaySeconds })` with bounded exponential backoff from
   `message.attempts`. These are the complete automatic-retry allowlist;
6. on a documented validation, sender/domain, recipient, suppression, content/header, or
   `E_DELIVERY_FAILED` rejection, mark email `failed`, mirror a bounded error if the inbox row still
   exists, complete the envelope, and `ack()`—in-app remains successful;
7. on `E_INTERNAL_SERVER_ERROR`—which Cloudflare documents only as temporary internal service
   unavailability, without a non-acceptance guarantee—or any uncoded/unrecognized error after the
   call begins, mark email `unknown`, mirror the safe code `email_acceptance_unknown`, complete the
   envelope, and `ack()` with no automatic retry; and
8. if the invocation dies or D1 cannot record the result after email became `processing`, leave the
   token/lease in place. A Queue retry during that lease cannot claim/send again; §7 converts the
   expired email attempt to `unknown`, never `pending`.

**The email-status invariant.** Every path in this plan — consumer, DLQ, Cron, and Admin — upholds
exactly one rule, and it is what makes the Admin replay UX safe:

> A `failed` email channel means the submission is **provably** not accepted: it never left
> `pending`, or Cloudflare returned a documented permanent rejection, or the binding is absent.
> An `unknown` email channel means a submission may already have been accepted. Once an email
> channel reaches `processing`, no path may move it to `failed` or `discarded` — only `sent`,
> `unknown`, or (on a proven pre-acceptance quota rejection) back to `pending` are reachable.

Replay of a `failed` email therefore cannot duplicate a real send, which is why it needs no
acknowledgement, while replay of an `unknown` email always requires the explicit duplicate
acknowledgement in §8. Any transition that would launder `processing` into a
replayable-without-warning status is a defect, not a shortcut.

If `EMAIL` or `NOTIFICATIONS_FROM_ADDRESS` is absent, mark email terminal `failed` with
`email_configuration_missing`; mandatory in-app delivery still completes. This is visible to
Admin operations without turning a comment or inbox success into failure.

After both channels are terminal (`sent`, `suppressed`, `failed`, `unknown`, or `discarded`), mark
the outbox `completed` unless the whole occurrence was pre-send suppressed. Clear the lease and
set `completed_at`. Raw provider errors and payload JSON never leave server logs/DB and never enter
the Admin response.

### 7. Add DLQ recording and hourly pending/stuck recovery

On `quincy-notifications-dlq`, validate `{ type, outboxId }`.

The DLQ is a **separate consumer with its own concurrency setting**, so `max_concurrency: 1` on
`quincy-notifications` serializes nothing here: a DLQ message can be handled while an invocation
that still holds this outbox's lease is awaiting `EMAIL.send()`. Cloudflare documents no guarantee
that the failed invocation has finished, nor that its submitted message was not accepted, before
the exhausted message reaches the DLQ. The DLQ handler therefore obeys both standing invariants
rather than assuming either — it never disturbs a live lease, and it never converts an email attempt
that reached `processing` into a status Admin can replay without the duplicate warning.

First, fence on the lease. If the outbox is `processing` with `lease_expires_at > now`, record
nothing terminal and `retry()` the DLQ message (its own `max_retries: 3` bounds this) so the active
owner can finish and write its own result. If DLQ retries then exhaust, the outbox row is still
durable and the expired-lease resolution below reaches it on the next tick. Only when the outbox is
nonterminal **and** not actively leased, in one D1 batch scoped throughout to that same outbox ID
and to a nonterminal, unleased row:

- mark an `email` ledger channel that is `processing` `unknown` with `email_acceptance_unknown` —
  a submission may already have been accepted, exactly as in §6 step 8 — and mark it `failed` with
  the bounded `queue_retries_exhausted` code only when it is still `pending`. Never move `email`
  from `processing` to `failed`;
- mark a `pending`/`processing` `in_app` channel `failed` with `queue_retries_exhausted`; its
  unique INSERT is idempotent, so replaying that channel cannot duplicate an external side effect;
- mark the nonterminal outbox `dlq`, clear its (already expired) lease, set the bounded
  `queue_retries_exhausted` error, and update its timestamp;
- insert a content-free `notification.delivery.dlq` system audit; and
- `ack()`.

A Cron tick or Queue redelivery racing this handler therefore produces one guarded winner, and an
already-`unknown` email channel is never rewritten by it.

As with the rendition precedent, do not retry a successfully recorded exhausted message inside
the DLQ. If its D1 recording fails, `retry()` the DLQ message; the original outbox row remains
durable and Cron can still rediscover it. An invalid body is logged and acknowledged because it
cannot identify a valid durable intent; the only producer emits the typed body.

Keep the existing `"0 * * * *"` UTC Cron. Add
`recoverNotificationOutbox(env, controller.scheduledTime)` as an independently caught step so it
cannot prevent or be prevented by RAW reconciliation, stalled AutoHDR, due subtasks, or pruning.
Use `NOTIFICATION_DELIVERY_LEASE_MS = 10 * 60_000`,
`NOTIFICATION_QUEUE_STUCK_MS = 30 * 60_000`, and a maximum 100 IDs per tick.

First, resolve ambiguous expired email attempts in a guarded D1 batch:

```sql
UPDATE notification_delivery_ledger
SET status = 'unknown',
    last_error_code = 'email_acceptance_unknown',
    last_error = 'Email attempt lease expired after submission began.',
    updated_at = ?
WHERE channel = 'email'
  AND status = 'processing'
  AND outbox_id IN (
    SELECT id FROM notification_outbox
    WHERE status = 'processing' AND lease_expires_at <= ?
  );

UPDATE notification_outbox
SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
    completed_at = ?, last_error_code = 'email_acceptance_unknown',
    last_error = 'Email outcome requires operator review.', updated_at = ?
WHERE status = 'processing' AND lease_expires_at <= ?
  AND EXISTS (
    SELECT 1 FROM notification_delivery_ledger l
    WHERE l.outbox_id = notification_outbox.id
      AND l.channel = 'email' AND l.status = 'unknown'
  );
```

Then, as the fallback when no Queue redelivery has already taken ownership and performed §5's
immediate reclaim, reset only the D1-idempotent in-app channel from an expired claim; unlike email,
retrying its unique INSERT cannot duplicate an external side effect:

```sql
UPDATE notification_delivery_ledger
SET status = 'pending',
    last_error_code = 'delivery_lease_expired',
    last_error = 'In-app delivery lease expired before completion.',
    updated_at = ?
WHERE channel = 'in_app' AND status = 'processing'
  AND outbox_id IN (
    SELECT id FROM notification_outbox
    WHERE status = 'processing' AND lease_expires_at <= ?
  );
```

Then release those other expired outbox claims for safe replay:

```sql
UPDATE notification_outbox
SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
    available_at = ?, last_error_code = 'delivery_lease_expired',
    last_error = 'Delivery lease expired before an ambiguous email attempt.', updated_at = ?
WHERE status = 'processing' AND lease_expires_at <= ?
  AND NOT EXISTS (
    SELECT 1 FROM notification_delivery_ledger l
    WHERE l.outbox_id = notification_outbox.id
      AND l.channel = 'email' AND l.status IN ('processing', 'unknown')
  );
```

Finally select bounded recovery candidates:

```sql
SELECT id
FROM notification_outbox
WHERE (status = 'pending' AND available_at <= ?)
   OR (status = 'queued' AND queue_published_at <= ? AND available_at <= ?)
ORDER BY created_at, id
LIMIT 100;
```

The second binding is `now - NOTIFICATION_QUEUE_STUCK_MS`; the first and third are `now`. The
`queued` branch carries the same `available_at` fence as the `pending` branch so recovery cannot
republish work that is deliberately waiting out a backoff window. Publish each ID through the same
helper used by the app/background producer. A send failure leaves `pending`, or leaves an old `queued`
timestamp eligible for the next tick; a successful duplicate publication only advances the
timestamp. Unique ledger/inbox keys and the claim make repeated Cron/Queue delivery harmless.

### 8. Add compact Admin delivery operations

Reuse the existing `adminBackend` gate and the operator-queue area in
`portal/apps/web/src/screens/Admin.tsx`; do not add a new top-level route or redesign the bell.
Add:

```text
GET  /api/admin/notification-deliveries?view=pending_stuck|dlq|failed|unknown&limit=1..100&cursor=...
POST /api/admin/notification-deliveries/:outboxId/replay
POST /api/admin/notification-deliveries/:outboxId/discard
```

The list uses `(updated_at, id)` cursor pagination and returns counts for all four views. Each row
contains only: outbox ID, event label, project ID/street if still available, recipient display
name if still available, channel(s), status, attempts, safe error code, created/updated/last-attempt
timestamps, and whether unknown email makes duplication possible. It never returns `payload_json`,
comment ID/body/excerpt/rich text, recipient email, raw error text, contact details, Dropbox paths,
provider diagnostics, or Queue message IDs.

View semantics are exact:

- `pending_stuck`: `pending`, `queued` older than 30 minutes, or `processing` past its lease;
- `dlq`: outbox status `dlq`;
- `failed`: ledger status `failed` (including email configuration/permanent failures), excluding a
  duplicate copy already represented as DLQ in the selected view; and
- `unknown`: email ledger status `unknown`.

`unknown` is keyed on the email ledger channel alone, deliberately independent of outbox status: a
`dlq` or `discarded` outbox whose email channel is `unknown` still appears in that view carrying its
duplicate warning. That overlap is intentional and must not be “deduplicated” away — the warning is
the only thing standing between an operator and a duplicate email to a real recipient.

Replay and discard are both guarded state transitions, not direct sends, and **both** reject an
active, unexpired lease with `409`. An operator action must never clear a lease an invocation still
holds: the repository's own rendition-DLQ precedent already claims atomically *before* the side
effect for exactly this reason, so that a concurrent discard loses the race rather than landing
after the work has already started. Discard is not exempt — a discard that lands between the guarded
`email = processing` update and the actual `EMAIL.send()` call cannot stop the in-flight send, and
must not leave behind a status implying it did.

Replay never resets a `sent` or `suppressed` channel and never recreates a dismissed inbox
row. It resets only selected `failed`/`discarded`/DLQ-pending channels to `pending`, or an explicitly
confirmed unknown email to `pending`; resets the outbox to `pending`, clears lease/completion/DLQ
fields, audits `notification.delivery.replay`, and schedules the same Queue publication. If Queue
publication fails, D1 remains pending for Cron. A replay that races discard or another replay has
one guarded winner; the loser receives `409`.

For an unknown email, the first replay request without this exact body:

```json
{ "acknowledgeDuplicateEmail": true, "channels": ["email"] }
```

returns `409` with code `duplicate_email_possible`. The UI confirmation copy is:

> Cloudflare may already have accepted this email. Replaying can send a duplicate. In-app
> delivery will not be recreated. Replay email anyway?

Only the affirmative action sends the acknowledgement. The API ignores no missing/false flag and
never includes `in_app` in that replay.

Discard rejects an active, unexpired lease with `409` exactly as replay does. On an unleased or
expired row it guardedly marks only non-`sent` channels `discarded`, with one exception that keeps
the email-status invariant intact: an `email` channel that is currently `processing` becomes
`unknown` with `email_acceptance_unknown`, and an `email` channel that is already `unknown` stays
`unknown`. Neither is ever rewritten to `discarded`, because a `discarded` channel is replayable
without the duplicate warning and a submission may already have been accepted. It marks the outbox
`discarded`, clears its (already expired) lease, audits `notification.delivery.discard`, and never
deletes rows, notifications, comments, or audit. For unknown email, discard means “accept this
unresolved outcome and do not send again” — the outbox is closed while the email channel keeps its
`unknown` status, so any later replay still meets the acknowledgement gate. The UI states that
plainly. Every operator mutation returns the refreshed content-free row.

The compact Admin card shows four count/filter controls, a bounded table, Refresh, Replay, and
Discard. Unknown rows show a visible “Duplicate email possible” warning. Use existing table,
status, toast, disabled-in-flight, and confirmation patterns; add only TB4-specific styles needed
for wrapping at 390px.

### 9. Preserve legacy producers and compatibility fields

Keep `emitNotifications()` and every current non-project-comment caller intact. Do not route their
notification rows through the new ledger opportunistically. Keep `EMAIL_ENABLED_EVENTS`, current
copy, email content, project recipient behavior, current notification API, pruning, and dismissal.

For TB4 rows only, the ledger is authoritative. After email terminal state, update the associated
inbox row's legacy fields if it still exists:

- `sent`: set `email_sent_at` and `email_message_id`, clear `email_error`;
- `failed`: set bounded `email_error`;
- `unknown`: set `email_error = 'email_acceptance_unknown'`; and
- `suppressed` before any in-app insert: no inbox row exists to mirror.

Never inspect those legacy fields to decide a TB4 retry. Notice Board and all old producers
continue using them exactly as today.

### 10. Add focused automated coverage

Add migration tests, pure classifier/claim tests, Miniflare Worker tests, and DOM tests at the
existing package/workspace owners. At minimum prove:

1. migration 0031 applies after the complete baseline; exact tables/checks/FKs/indexes exist;
   duplicate outbox recipient and duplicate semantic channel keys fail; notification dismissal
   sets ledger `notification_id` null without deleting ledger/outbox, and both a single dismissal
   and the Cron prune delete plan as an indexed `SEARCH` of
   `notification_delivery_ledger_notification_idx` rather than a `SCAN`;
   project/comment/mention/user removal cannot cascade away the durable intent; and
   foreign/integrity checks remain clean;
2. comment create and newly-added-edit mention mapping, exact audit, outbox, and two ledger rows
   commit or roll back together; self mention creates the mapping but no delivery intent; retained
   edit mention creates none; remove/re-add gets a new mapping/source event; delete creates no new
   mention event and keeps existing durable history;
3. the persisted payload contains TB3's exact activity object/source keys/coalesce hint/false flag,
   the exact mention-only Admin or sorted membership-row-ID occurrence snapshot, no comment content
   or contact data, and no broad `project.comment.*` delivery is emitted; every envelope from one
   comment mutation carries the same single constructed `activity.id` and does not create an
   activity row;
4. route POST/PATCH no longer calls the direct project mention helper; Notice Board still does;
   one mutation yields one audit, one activity intent, and one semantic mention producer;
5. Queue publication failure leaves the successful comment plus `pending` outbox; the route does
   not await an unresolved Queue/email operation; later Cron publication delivers;
6. two concurrent claims, duplicate Queue delivery, duplicate Cron publication, and operator
   replay yield one winning lease, one ledger result per channel, and exactly one `notifications`
   row; replay after bell dismissal does not recreate it; specifically, a Queue redelivery that
   claims an expired outbox whose `in_app` ledger remains `processing` after a lost prior invocation
   resets that channel to `pending` in the claim batch and completes the idempotent in-app delivery
   without waiting for Cron, producing neither a stuck ledger nor a duplicate inbox row;
7. active current Admin from an Admin occurrence and an active current project member retaining at
   least one occurrence-time membership-row ID, with `collaborateOnProject`, qualify; deactivated,
   role/capability-ineligible, membership-removed, remove/re-added-with-a-new-row-ID,
   mapping-removed, comment-deleted, project-deleted, wrong-recipient, and self cases suppress
   before send and create one content-free suppression audit with no retry/user error;
8. reauthorization runs again immediately before email; access removed between channels suppresses
   email without retracting the already-authorized in-app row;
9. `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` retry with delay and preserve one in-app
   row; `E_INTERNAL_SERVER_ERROR` becomes `unknown` and is acknowledged with no automatic retry,
   exactly like unrecognized/uncoded throws; a permanent code becomes `failed` without Queue retry;
   success records message ID; binding absence is visible failed; in-app stays independent in every
   case;
10. a crash/failure after email ledger becomes processing leaves the lease; immediate Queue retry
    cannot send again; unlike the safe in-app takeover in item 6, a redelivery cannot reclaim this
    outbox, and expired Cron recovery turns the email unknown and never republishes it. Prove the
    email-status invariant holds against every other path from that same state: a DLQ message
    arriving for an outbox whose lease is still live is retried rather than recorded, and once the
    lease has expired the DLQ handler marks that email `unknown`, never `failed`; an operator
    discard against a live lease returns `409`, and against an expired one records the email
    `unknown`, never `discarded`; an already-`unknown` email survives DLQ, discard, and Cron
    unchanged. Assert directly that no path produces a `failed`/`discarded` email channel whose
    ledger shows `attempts > 0` from a `processing` state, and that each of these rows still
    demands the duplicate acknowledgement on replay;
11. fourth failed main-queue attempt reaches the configured DLQ (one initial plus three retries),
    DLQ receipt is recorded/acked, and replay/discard use one guarded winner;
12. Cron is bounded to 100, publishes due pending and 30-minute queued-stuck work, reclaims safe
    expired leases, does not republish terminal/suppressed/discarded/unknown work, and cannot block
    other scheduled jobs;
13. Admin routes require `adminBackend`, paginate/filter/count correctly, never serialize sensitive
    payload/error/email/comment data, and enforce the exact unknown-email acknowledgement;
14. Admin UI loading/empty/error/four-filter/concurrent-operation/unknown-warning states are
    accessible and do not alter the existing bell; and
15. all old notification tests remain green, proving every non-project-comment producer still
    follows its old path; and
16. a D1/platform failure during in-app delivery releases the in-app ledger row and the outbox lease
    before `message.retry()`, so the redelivery actually claims and completes the work instead of
    meeting its own live lease and being acknowledged; and a duplicate or redelivered message for a
    row whose `available_at` is in the future is retried with the remaining delay rather than
    claimed early, leaving quota backoff and the Queue attempt budget intact.

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run the repository-standard gate exactly:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Record every workspace result separately. The shared suite remains mandatory because
`npm run test --workspaces` silently misses it. No unexplained TypeScript, React, Queue, timer,
unhandled rejection, migration, D1, or console warning is accepted.

Also record these source audits:

```bash
rg -n 'notifyMentions|notifyNoticeBoardMentions|project.comment.mentioned|targetedMentionDelivery' workers/app/src workers/app/test workers/background/src packages/db/src
rg -n 'notification_outbox|notification_delivery_ledger|notification_id|source_key' packages/db/src packages/db/migrations workers/app/src workers/background/src
rg -n 'NOTIFICATION_QUEUE|quincy-notifications|quincy-notifications-dlq|max_batch_size|max_concurrency|max_retries|dead_letter_queue' workers/app workers/background
rg -n 'EMAIL\.send|E_RATE_LIMIT_EXCEEDED|E_DAILY_LIMIT_EXCEEDED|E_INTERNAL_SERVER_ERROR|unknown|message\.retry|message\.ack' workers/background/src workers/background/test
rg -n 'notification-deliveries|payload_json|email|comment' workers/app/src/routes/admin.ts apps/web/src/screens/Admin.tsx workers/app/test apps/web/src
```

Review the final diff against the scope/non-goals and route/producer tables above. The audit must
prove one project-comment mention producer, unchanged Notice Board/legacy producers, exact queue
bindings, no broad registry/event activity, no future roles/contracts, and no sensitive Admin
serialization.

### Local migration apply and verification

Run the focused migration suite. Then apply the whole migration chain to an isolated local D1 and
the ordinary persisted local database:

```bash
TB4_LOCAL_D1_DIR="$(mktemp -d)"
npx wrangler d1 migrations apply quincy-portal --local --persist-to "$TB4_LOCAL_D1_DIR" --config workers/app/wrangler.jsonc
npx wrangler d1 execute quincy-portal --local --persist-to "$TB4_LOCAL_D1_DIR" --config workers/app/wrangler.jsonc --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 3; PRAGMA table_info('notification_outbox'); PRAGMA index_list('notification_outbox'); PRAGMA table_info('notification_delivery_ledger'); PRAGMA foreign_key_list('notification_delivery_ledger'); PRAGMA index_list('notification_delivery_ledger'); PRAGMA index_info('notification_delivery_ledger_status_updated_idx'); PRAGMA foreign_key_check; PRAGMA quick_check;"
npm run db:migrate:local
```

Require 0031 last, exact column/check/default shapes, the outbox PK/unique plus four named indexes,
the ledger PK/two unique constraints plus three named indexes, exact `RESTRICT` outbox and `SET
NULL` notification FKs, empty tables on clean apply, empty `foreign_key_check`, `quick_check = ok`,
and no migration after 0031. Run query-plan probes for the recovery, the four Admin list access
patterns, and both notification-delete paths (single dismissal and the Cron prune), requiring an
indexed `SEARCH` of the ledger rather than a `SCAN` on the latter two. Preserve output before
deleting the temporary directory.

### Manual QA matrix

Use the built app Worker at `http://localhost:8787`, not Vite `5173`. Use a clearly labeled
disposable project, non-sensitive comments, mocked/fault-injected Queue/email seams where required,
and a reviewer-approved second principal only where access removal must be observed. Do not have an
agent sign into Google. Redact names, streets, emails, comment text, cookies, tokens, payloads, and
provider messages from evidence.

1. **Normal end-to-end mention.** Create a comment mentioning one eligible non-actor. Confirm the
   response is `201`, comment/mapping/audit/outbox/two ledger rows commit, Queue message carries only
   outbox ID, one bell row appears with the existing collaboration deep link, and one email uses the
   existing author/project/excerpt copy. Add a second mention on edit and confirm only that new
   mapping creates a second event. Remove/re-add and confirm the new mapping identity creates one
   new event.
2. **Comment speed and independence.** Hold Queue publication unresolved/rejected, then hold email
   unresolved in the background consumer. The comment response and UI success do not wait for
   either. The composer clears once, audit exists once, and no Queue/email result can turn the
   comment response into failure.
3. **Queue outage cannot lose intent.** Force app `NOTIFICATION_QUEUE.send()` to reject. Confirm
   comment/mapping/audit/outbox/ledger remain committed and outbox is `pending`. Restore Queue,
   invoke the hourly recovery function at a controlled timestamp, consume the message, and confirm
   delivery without editing/reposting the comment.
4. **Duplicate delivery and replay idempotency.** Deliver the same outbox ID concurrently and
   sequentially, then replay it. Confirm one claim winner, one ledger row/channel, one in-app row,
   one email attempt unless explicitly replaying an allowed failed/unknown email, and no duplicate
   activity/audit. Dismiss the bell row and replay: it remains dismissed.
5. **Access removal suppression.** Pause before the consumer's first resolver, deactivate the
   recipient or remove their project membership, then continue. Confirm no inbox/email, outbox and
   ledgers suppressed, one content-free system audit, no retry, no user-visible error, and the
   original comment remains. Remove and re-add the recipient before delivery and prove the new
   `project_members.id` does not inherit the old occurrence; repeat for removed mention mapping/
   deleted comment. Restore the reversible fixture.
6. **Between-channel authorization.** Pause after in-app commit and remove access before email.
   Confirm the inbox row stays, email is suppressed, suppression is audited, and no retry occurs.
7. **Quota-transient, persistent DLQ, and email unknown.** Inject exactly
   `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` and confirm delayed retry with one in-app
   row. Continue failing through one initial plus three retries and confirm DLQ/failed visibility.
   Inject a permanent code and confirm failed/no retry. Inject `E_INTERNAL_SERVER_ERROR`, an
   uncoded error, and a post-send-recording failure; confirm each becomes unknown with no automatic
   retry. Confirm that a DLQ arrival for an outbox whose email had reached `processing` records that
   channel `unknown` with its duplicate warning, never a warning-free `failed`, and that a discard
   attempted against a live lease returns `409`.
8. **Cron stuck recovery.** Seed old queued work, a safe expired in-app lease, and an expired email
   processing lease. Confirm the first two republish/idempotently finish, while the email lease
   becomes unknown and is never automatically republished. Confirm at most 100 are selected and
   unrelated scheduled jobs still run after an injected recovery error.
9. **Admin operations/privacy.** As Admin, exercise all four filters, cursor/load-more, Refresh,
   replay, discard, stale concurrent actions, and responsive layout. Confirm no content/email/raw
   error appears in response, DOM, console, or screenshots. Unknown replay first returns the exact
   duplicate warning/409; cancel changes nothing; affirmative replay sends only email; discard
   sends nothing and deletes nothing.
10. **Single producer regression.** Trace one create and one newly-mentioned edit through logs/D1.
    Require one `project_comment.*` audit, one TB3 intent embedded in one mention envelope per
    mapping, one inbox row, and no direct project-comment `notifyMentions()`/`emitNotifications()`
    call. Confirm Notice Board mention and at least one legacy project notification still use the
    unchanged direct helper and never create outbox/ledger rows.
11. **Bell/UI regression.** At 1440×900, 1024×768, and 390×844 confirm bell count, list/read/read-
    all/dismiss, Escape/outside click/focus, collaboration link, Admin card, and existing Admin tabs
    remain correct. Console and Network are clean; restore/delete every test mutation.

### Exact evidence paths

Create only redacted evidence under:

```text
docs/plans/revamp_2026_portal/evidence/TB4/base-ledger-bindings-and-resources.txt
docs/plans/revamp_2026_portal/evidence/TB4/migration-0031-local.txt
docs/plans/revamp_2026_portal/evidence/TB4/automated-gates.txt
docs/plans/revamp_2026_portal/evidence/TB4/domain-transaction-and-single-producer-tests.txt
docs/plans/revamp_2026_portal/evidence/TB4/queue-claim-idempotency-recovery-and-dlq-tests.txt
docs/plans/revamp_2026_portal/evidence/TB4/authorization-email-classification-tests.txt
docs/plans/revamp_2026_portal/evidence/TB4/admin-operations-and-privacy-tests.txt
docs/plans/revamp_2026_portal/evidence/TB4/manual-qa.md
docs/plans/revamp_2026_portal/evidence/TB4/queue-outage-recovery.md
docs/plans/revamp_2026_portal/evidence/TB4/access-removal-and-single-producer.md
docs/plans/revamp_2026_portal/evidence/TB4/email-retry-dlq-and-unknown.md
docs/plans/revamp_2026_portal/evidence/TB4/admin-delivery-operations-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB4/admin-delivery-operations-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB4/admin-delivery-operations-390x844.png
docs/plans/revamp_2026_portal/evidence/TB4/production-migration-queues-and-deploy.txt
docs/plans/revamp_2026_portal/evidence/TB4/production-smoke-and-monitoring.md
docs/plans/revamp_2026_portal/evidence/TB4/rollback-record.md
```

`manual-qa.md` records fixture/account disposition, exact timestamps, outbox/ledger state
transitions, Queue attempt counts, lease tokens redacted to last four characters, auth changes,
expected/actual in-app/email counts, Cron scheduled time, Admin response-field audit, console/
Network outcome, and every not-applicable item with rationale. Screenshots contain no comment
content or email. Do not preserve raw Queue bodies, cookies, tokens, or `payload_json` in evidence.

### Production migration, Queue provisioning, and deployment

TB4 changes D1 schema, app API/frontend/binding configuration, and background Queue/Cron consumer/
producer configuration. It creates two Queue resources. It does not change webhook-ingress,
Workflow, R2, KV, or an external provider. The additive tables and Queues must exist before either
new Worker version uses them; the consumer must deploy before the producer app.

After review, full gates, local proof, manual QA, and human authorization:

1. record current background and app Worker versions as rollback targets, current Queue inventory,
   binding inventory, and remote migration preflight;
2. take and verify the recovery export in the established directory:

   ```bash
   TB4_RECOVERY_DIR="/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/db-recovery"
   TB4_RECOVERY_FILE="$TB4_RECOVERY_DIR/quincy-portal-before-tb4-$(date -u +%Y%m%dT%H%M%SZ).sql"
   npx wrangler d1 execute quincy-portal --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 5; SELECT name, type, sql FROM sqlite_master WHERE name IN ('notification_outbox','notification_delivery_ledger','notification_outbox_status_available_idx','notification_outbox_status_lease_idx','notification_outbox_status_queue_idx','notification_outbox_status_updated_idx','notification_delivery_ledger_outbox_idx','notification_delivery_ledger_status_updated_idx','notification_delivery_ledger_notification_idx'); PRAGMA foreign_key_check; PRAGMA quick_check;"
   npx wrangler d1 export quincy-portal --remote --output "$TB4_RECOVERY_FILE"
   test -s "$TB4_RECOVERY_FILE"
   shasum -a 256 "$TB4_RECOVERY_FILE"
   ```

   Require 0030 last, all new names absent, empty FK check, and quick check `ok`.
3. apply migration 0031 exactly once from `portal/workers/app`:

   ```bash
   npx wrangler d1 migrations apply quincy-portal --remote
   ```

4. postflight the exact table/check/FK/index shapes, zero initial rows, recovery/Admin query plans,
   empty FK check, and quick check `ok`. If apply is failed or ambiguous, stop before Queue/Worker
   rollout and inspect ledger/schema; never blindly rerun or edit `d1_migrations`;
5. create the two Queues only after confirming their names are free, then record their IDs/settings:

   ```bash
   npx wrangler queues create quincy-notifications
   npx wrangler queues create quincy-notifications-dlq
   ```

6. deploy the background Worker first from `portal/workers/background`, confirm its new main/DLQ
   consumers, producer binding, unchanged hourly Cron, existing consumers, and health:

   ```bash
   npx wrangler deploy --message "TB4 notification outbox consumer and recovery"
   ```

7. make one final web build with accepted hashes, then deploy the app Worker from
   `portal/workers/app`, confirming the new producer and existing Email/Queue/service bindings:

   ```bash
   npx wrangler deploy --message "TB4 project mention outbox producer and operations"
   ```

   Do not deploy webhook-ingress. This follows the repository's background → webhook-ingress → app
   binding order while skipping the unchanged middle Worker.
8. perform a reversible authenticated production smoke: one new project-comment mention to an
   approved active recipient, outbox/ledger/main Queue processing, existing bell/deep link, email
   receipt if the reviewer controls the inbox, Admin counts/privacy, exact audit/single-producer
   query, and no console/Worker errors. Do not inject production Queue/email faults or alter a real
   user's access merely for smoke evidence; rely on local deterministic fault tests for those.
9. delete the disposable comment if permitted, archive the fresh disposable project (do not reuse
   TB3's archived fixture), clear/resolve only smoke-created operator rows through the product
   operations, record post-deploy migration/Queue/Worker state, and monitor error/DLQ/unknown/
   pending counts and comment latency.
10. only after verified production acceptance, update this plan's status/deployment record and
    `docs/todo.md`, commit evidence, and `git mv` this file to `docs/plans/implemented/` with the live
    commit hash.

Because TB4 necessarily changes the background Worker's Queue configuration and Cron handler, this
is **not** an app-only deploy. Background deploys first, then app; webhook-ingress is unchanged.

### Concrete rollback and fix-forward

If the new producer path is faulty but domain comments are healthy, roll back the app Worker to the
recorded pre-TB4 version first. That stops creation of new outbox events and restores the old direct
project-comment mention producer for new requests. Keep the TB4 background Worker live long enough
to drain already-committed TB4 outbox rows: old direct code cannot recreate those past mappings,
and the stable `(mentioned, mappingId, recipient)` inbox unique key remains a final overlap
backstop. Never temporarily enable both producers in one app version.

If the background consumer is unsafe, pause/roll it back instead; comments and D1 intents remain
safe while delivery is delayed. Do not switch the new app to direct notification as an ad hoc
fallback. Fix the consumer, redeploy background, and let Cron recover pending/stuck rows.

Application/Worker rollback does not roll back migration 0031 or delete Queue resources, outbox,
ledger, notifications, comments, or audits. Old code ignores the additive tables. Do not drop
tables, purge Queues containing valid IDs, restore the full recovery export over production, or
edit the migration ledger. A schema defect is fixed forward with the next reviewed available
migration after inspecting real remote state and preserving all valid history.

Unknown email remains unknown through rollback. Manual replay after rollback still requires the
duplicate warning and a version that exposes the guarded operation; never convert unknown rows to
pending with ad hoc SQL.

## Acceptance checklist

- [ ] Implementation begins from recorded current `main`; TB0A–TB3 remain live, 0030 is remote
      last, 0031 and both Queue names are free, and no work enters `prototype/` or unrelated phases.
- [ ] D-17 and A10 are applied only to durable notification delivery; freshness, discussion,
      pipeline, Kanban, Stage, rail, Deadline, Calendar, registry, and External Editor work remain
      absent.
- [ ] Migration `0031_notification_outbox_and_delivery_ledger.sql` is additive only and creates the
      exact two tables, checks, FKs, constraints, and indexes in §2 — including
      `notification_delivery_ledger_notification_idx`, without which every notification dismissal
      and every hourly Cron prune scans the whole ledger — with no existing-table rebuild,
      rewrite, backfill, drop, or PRAGMA toggle.
- [ ] The exact semantic channel key is `(event_type, source_key, recipient_id, channel)`, with
      `event_type = project.comment.mentioned` and source key equal to the mention-mapping UUID;
      Queue message ID is never an idempotency key.
- [ ] `notifications` remains the user-visible inbox/read/dismiss projection; the ledger is TB4's
      authoritative channel record; dismissal sets `notification_id` null without deleting history
      or enabling in-app recreation; legacy `email_*` fields remain compatibility mirrors only.
- [ ] Every new non-self project-comment mention mapping, exact comment mutation, existing
      `project_comment.*` audit, one outbox, and two channel ledger rows commit or roll back in the
      same D1 batch.
- [ ] TB3's exact immutable `ProjectCommentActivityOutboxIntent` is constructed before and persisted
      inside the mention envelope unchanged, including source-key formats, edit coalesce hint, and
      `targetedMentionDelivery: false`; all envelopes from one mutation reuse its single
      `activity.id`; no broad delivery/activity table or event is activated.
- [ ] Comment create publishes every new mapping; edit publishes only newly-added mappings;
      retained mentions do not repeat, removed pending mentions suppress, re-added mentions use a
      new mapping/source key, and delete creates no new mention event.
- [ ] Project-comment direct `notifyMentions()` calls are removed at cutover and the helper is
      narrowed to Notice Board; all other producers remain direct. One comment mention has exactly
      one semantic producer, one audit/activity intent, and one inbox row.
- [ ] Queue publication uses `waitUntil`, carries only typed outbox ID, never blocks the comment,
      and leaves a recoverable pending row on rejection; Queue/email outcome cannot change a
      successful comment response.
- [ ] `quincy-notifications` and `quincy-notifications-dlq` use the exact established main/DLQ
      batch, concurrency, retry settings; background owns both consumers and the recovery producer.
- [ ] Consumer claims use a token, 10-minute lease, guarded ownership updates, and D1 unique keys;
      concurrent/duplicate Queue/Cron/replay deliveries produce one channel outcome and one inbox
      row without relying on `max_concurrency: 1`; the same atomic claim batch resets a stale
      `in_app = processing` row for the newly owned outbox to `pending` for immediate idempotent
      completion, but never resets or takes over `email = processing`.
- [ ] Every channel rechecks current active status, global role, `collaborateOnProject` capability,
      occurrence membership cycle through the existing `project_members.id` snapshot, current
      Admin/membership eligibility, exact mapping/recipient/comment/project visibility, and actor
      exclusion immediately before its send; remove/re-add cannot inherit old work.
- [ ] Failed reauthorization is silently suppressed without retry or user-visible error and writes
      one content-free system audit; removal before first dispatch creates neither inbox nor email.
- [ ] Mandatory in-app delivery is committed before optional email and is independent of every
      email result. Replay never recreates a sent/dismissed in-app row.
- [ ] Email uses only the existing Cloudflare `EMAIL` binding and existing targeted mention copy;
      success stores message ID, only `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` retry,
      documented permanent errors fail terminally, and missing configuration is visible without
      affecting in-app/comment.
- [ ] `E_INTERNAL_SERVER_ERROR`, uncoded/unrecognized/post-submission ambiguity, and an expired
      processing-email lease become `unknown`, never automatic retry; manual replay requires the
      exact duplicate warning and acknowledgement and replays email only.
- [ ] The email-status invariant holds on every path: a `failed` email is provably unaccepted, and
      no consumer, DLQ, Cron, or Admin transition moves an email channel out of `processing` into
      `failed` or `discarded`. The DLQ handler and Admin discard both refuse to disturb an
      unexpired lease — DLQ retries, discard returns `409` — and on an expired one they record an
      in-flight email attempt as `unknown`, keeping the duplicate warning on any later replay,
      including where the outbox itself is `dlq` or `discarded`.
- [ ] A transient in-app failure releases its own ledger row and lease before `message.retry()`, so
      Queue retry and DLQ progression actually work instead of being absorbed by the plan's own
      claim guard; and no claim or Cron republication takes work whose `available_at` is still in
      the future.
- [ ] Main-queue persistent failure reaches the dedicated DLQ after one initial plus three retries;
      DLQ receipt is recorded/content-free/audited/acked, and no exhausted message disappears from
      operations silently.
- [ ] The existing hourly Cron independently resolves ambiguous email leases, safely reclaims other
      expired leases that no Queue consumer has already reclaimed, republishes due pending/30-minute
      queued-stuck IDs, processes at most 100, and cannot block existing scheduled jobs.
- [ ] `adminBackend` operations show bounded pending/stuck, DLQ, failed, and unknown lists/counts;
      responses/UI expose no payload, content, excerpt, email, raw error, contact, path, provider,
      or Queue-message data.
- [ ] Admin replay/discard are atomic guarded operations with one race winner, content-free audits,
      no row/domain deletion, Queue-failure recovery, and precise unknown-email semantics/copy.
- [ ] Existing bell polling, unread/read-all/dismiss/deep-link/focus behavior and every old
      notification producer remain unchanged and regression-tested.
- [ ] Automated fault tests prove Queue outage cannot lose intent, duplicate delivery/replay creates
      one in-app row, access removal suppresses, transient retry/persistent DLQ/unknown work,
      comment latency/success is independent, and audit/activity/producer are not duplicated.
- [ ] Full typecheck, web build, every workspace test, dedicated shared suite, source audits, local
      migration/query-plan/integrity proof, and manual QA are green with no unexplained warning.
- [ ] Exact redacted evidence exists under `docs/plans/revamp_2026_portal/evidence/TB4/`; every
      fixture is restored/disposed and no sensitive payload, token, email, or comment content is
      committed.
- [ ] Production rollout records both rollback targets, exact remote preflight, verified recovery
      export in the established `db-recovery/` directory, one 0031 apply, exact postflight, Queue
      creation/config, background-first then app deploy, reversible smoke, and monitoring.
- [ ] Rollback preserves additive schema/history and single-producer ownership; pending outbox stays
      recoverable, unknown email is never reset ad hoc, and schema mistakes use reviewed fix-forward.
- [ ] After production verification, this plan/status and `docs/todo.md` are updated and this file
      moves with `git mv` to `docs/plans/implemented/` with the live commit hash.

## Implementation-time human checkpoint

Before manual/production QA, the reviewer must identify which current recipient/inbox may receive a
disposable mention email and whether the existing local disposable second account/session is
already human-authenticated and approved for access-removal testing. No agent signs into Google,
provisions a production user, deactivates real staff, sends repeated test email to an uncontrolled
address, or injects production Queue/email failure merely to satisfy evidence. Deterministic
Miniflare/Worker tests remain mandatory when live destructive fault injection is declined.
