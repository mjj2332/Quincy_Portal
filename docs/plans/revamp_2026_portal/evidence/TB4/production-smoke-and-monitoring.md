# TB4 production smoke and monitoring

Production target: `https://quincy.flamingfire.my`  
Evidence timestamps are UTC; Asia/Kuala_Lumpur is UTC+08:00.

## Disposition and role

- The human operator created exactly one disposable project-comment mention on the labeled
  project `ZZZ TB4 Prod Smoke — DELETE ME`.
- Comment creation was done by the human operator because the earlier agent-driven production
  mutation was blocked by the product confirmation gate. This run was verification and cleanup
  only; it created no comment or mention and did not use Google OAuth.
- The disposable recipient and all record identifiers are redacted here. No comment text, email
  address, cookie, token, payload data, or raw provider error is included.

## Production smoke record

The authenticated Admin project page showed the single smoke comment at `2026-08-26T02:04:20Z`
(UI precision: `2026-08-26T02:04:20.559Z`). The project remained labeled and unarchived.

The narrowly scoped remote D1 read found one mention mapping for that comment. The mapping and
outbox were created at `2026-08-26T02:04:20.559Z`. The outbox's queue-publication marker was
`2026-08-26T02:04:20.642Z`; it reached `completed` at `2026-08-26T02:04:25.105Z`.

| Durable record | Observed state and timestamps |
|---|---|
| Outbox | `completed`; one publish attempt and one delivery attempt; created `02:04:20.559Z`, queue-published `02:04:20.642Z`, completed `02:04:25.105Z` |
| In-app ledger | One row; `sent`, one attempt, delivered `02:04:25.105Z` |
| Email ledger | One row; `sent`, one attempt, delivered `02:04:25.105Z` |

The durable timestamp markers establish the observed lifecycle `pending at domain commit → queued
after publication → completed after delivery`; the short `processing` interval was not sampled by
a separate live poll and is not given a fabricated timestamp. Both ledger rows were terminal.

## Bell and deep link

In the already-authenticated disposable-recipient Chrome session, the bell contained exactly one
smoke-created `mentioned` row (alongside one pre-existing assignment notification). The smoke row
was visible at `2026-08-26T02:04:25Z` and its inspected link was exactly:

`/projects/[redacted-project-id]?collaboration=open`

The notification was not clicked or marked read. The pre-cleanup remote D1 read found exactly one
inbox row for the mention source and one corresponding in-app ledger row.

## Admin operations and privacy

The authenticated Admin → Integrations → Notification delivery panel returned HTTP 200 and showed:

- Pending / stuck: `0`
- DLQ: `0`
- FAILED: `0`
- UNKNOWN: `0`
- Panel state: “No matching deliveries” / queue clear.

The scoped Admin response contained only `view`, `items`, `nextCursor`, and `counts` fields. The
captured response and the scoped delivery-panel DOM contained no comment content, email address,
payload, cookie, token, or raw provider error. The Admin panel had no smoke-created operator row
to acknowledge or resolve. Unrelated existing operator rows were not touched.

## Audit and single-producer check

Before cleanup, the narrowly scoped D1 trace for the redacted comment found exactly one
`project_comment.create` audit row, one `project.comment.mentioned` outbox row, two channel-ledger
rows, and one in-app notification row. No edit audit was present. The project-comment path used the
TB4 outbox producer; no direct legacy project-comment `notifyMentions`/`emitNotifications` path
was observed for this source.

## Console and Worker diagnostics

- Browser console: clean; no error or warning entries on the Admin delivery panel, recipient
  dashboard, or the post-refresh checks.
- Admin delivery refresh network response: HTTP 200; the privacy audit above found no disallowed
  fields or values.
- A brief `wrangler tail` attempt for the app Worker could not attach because the local Wrangler
  session requested separate Cloudflare OAuth. No OAuth flow was started and no workaround was
  attempted. The successful terminal outbox/ledger state and clean browser diagnostics provide no
  observed smoke-associated Worker error, but a live tail record is unavailable.

## Cleanup

- The disposable comment was deleted through the product UI as the Admin author. After the native
  confirmation flow closed, the project page showed `No comments yet`; this postcondition was
  captured at `2026-08-26T02:14:37Z`.
- The disposable project itself was left labeled, unarchived, and otherwise unchanged for the
  orchestrating session to archive separately.
- No Admin notification operator row required acknowledgement after the smoke; no other row,
  comment, notification, project, membership, or account was altered.
