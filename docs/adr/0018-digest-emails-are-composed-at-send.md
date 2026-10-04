---
status: accepted
---

# Digest emails are composed at send, from the stored notification copy

ADR 0007 settled that a notification's copy is composed on the write path, stored in `notifications.title`
and `notifications.body`, and that its email is composed there too, so an email says exactly what was
true when the event happened. The Email digest (#481, built in #489) breaks the second half of that: a
digest email goes out hours after the events it carries, from the Portal's hourly Cron, and it carries
many of them. This ADR records where that email is assembled.

## Decision

1. **A digest email is composed when it is sent, not when the event happened.** The write path now only
   records a pending digest item for a non-exempt notification of a recipient who is not on Immediately.
   The hourly digest run (`runEmailDigests`) gathers a recipient's pending items, drops what the recipient
   has already read, and composes one email grouped by Project.
2. **The copy is the stored `title` and `body`, exactly as the notification centre had it at write time.**
   It is not re-enriched (ADR 0007 enriches at read, in the app worker, and that resolver belongs there).
   The cost is that a digest line no longer says who commented or quotes the comment the way today's
   immediate mention email does. That is a known shortfall against the glossary's "who did what", and richer
   digest copy is a separate follow-up, deliberately not part of #489.
3. **The external boundary is unchanged (ADR 0008).** For an External editor the stored copy is already the
   static external copy, and the digest additionally re-applies the notification centre's own visibility
   predicate (`externalVisibleNotificationWhere`, now shared from `@quincy/db`) immediately before sending.
   Anything the centre would not list is suppressed, never emailed.
4. **Reminders stay immediate.** Subtask reminders, Subtask due-today and Deadline reminders keep their
   inline path and their own switches. They are the only exempt types.
5. **A per-recipient-per-slot row is the idempotency key.** `notification_digests` is `UNIQUE(recipient_id,
   slot_at)` with the slot being the hourly Cron tick in UTC, so a retried or concurrent run sends once. An
   ambiguous send ends `unknown` and is never resent, the same rule as `finishEmail`. A proven quota
   rejection returns the items to pending for the recipient's next slot.
6. **The delivery ledger records both halves.** The email ledger row moves `pending` to `deferred` when
   the item is created and to `sent`, `suppressed`, `failed` or `unknown` with the digest's outcome. A
   `deferred` row is never resent, replayed or discarded by recovery, the DLQ or an operator.

## Consequences

- Existing users take the Twice daily default on deploy, which changes email for the whole studio at once.
- A digest is capped at 50 items; the rest are marked sent and summarised as "and N more" linking to the
  notification centre.
- `notifications.email_sent_at` and `email_message_id` are mirrored from the digest's message, so older
  readers of those columns still work.
- **Project activity (#490) is digest-only and its items carry no email ledger row.** The last statement of the
  broad in-app batch (`deliverBroadInApp`) records a pending `notification_digest_items` row for each delivered
  activity occurrence whose recipient still has "Include Project activity" on, with `ledger_id` NULL. A broad
  outbox has no email phase, so a ledger row would be a replayable `pending` row nothing could drain. The
  item's own `state` and `outcome_code` are therefore the audit trail for activity email (parent story 23's
  ledger outcome is met for ordinary items and deliberately not for activity). Activity never emails inline,
  for any cadence; an Immediately user's activity goes out in the hourly digest. Turning the switch off
  suppresses pending activity (`activity_excluded`) at the next slot, including a toggle that races composition.
