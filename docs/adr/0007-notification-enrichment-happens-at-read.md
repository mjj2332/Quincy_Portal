---
status: accepted
---

# Notification enrichment happens at read

The notification write path is mature: an intent in `notification_outbox`, a Queue consumer, a
per-channel `notification_delivery_ledger`, and the `notifications` row a recipient finally reads.
The read path returned seven fields, so `NotificationList.tsx` could only ever show the category —
"New review feedback" with "12 King Street has new review feedback." — even though the system knew
who commented, on which Asset, and what they said. #116 makes a row say what happened. This ADR
records where that copy is assembled, and why it is not the write path.

## Decision

1. **The payload gains three structured parts and the server composes the copy.** A staff row now
   carries `actor` (`{ id, name }`), `subject` (`{ kind, label }`) and `assetId`, each nullable, beside
   the existing fields. `title` and `body` are overwritten in place with the enriched copy; there is
   no parallel `enrichedTitle` for the browser to reassemble. The stored copy has always been composed
   server-side (`notificationCopy`, `renderProjectActivityNotification`), the row's accessible name and
   caution toning read `title` untouched, and the external boundary (ADR 0008) then lives in exactly
   one server module rather than shipping to the browser as policy. The parts are still returned
   because the row needs them structurally: the web derives initials from `actor.name` and prefers
   `assetId` over the Project cover for its thumbnail.
2. **Enrichment resolves at read, from the row's own `source_key`.** `comment_added` joins the
   annotation (author, Asset, note); a Project mention joins the comment; a Notice Board mention joins
   the post; subtasks join `project_subtasks`. Where no source row names the actor —
   `assigned_to_project`, the two activity types, and `subtask_assigned` — the resolver walks
   `notification_delivery_ledger → notification_outbox.actor_id`. Denormalising at emit was declined:
   it would freeze a name and a filename that later change, need a backfill for every existing row, and
   put presentation copy inside an outbox whose payloads are an authorization contract
   (`external-notification-visibility.ts` matches on them).
3. **Enrichment is per field and degrades per type.** `NOTIFICATION_ENRICHMENT` in
   `packages/shared/src/notification-enrichment.ts` declares every one of the thirteen types, and a
   test enumerates them, and a route test holds every returned row against the declaration. Seven
   have no actor and that is the design: their leading slot stays reserved and empty and their titles
   stay as they are (`subtask_due_today` still gains the subtask's title as its subject and body; the
   other six change nothing). A resolvable actor still fills the avatar when the title cannot be
   composed.
4. **The stored copy is the durable record, not a cache.** A deleted annotation, comment, subtask or
   membership, a source whose provenance does not add up (an annotated Asset in another project, a
   mention addressed to someone else), or a source that fails a visibility gate, degrades to the stored
   `title`/`body`. Each part degrades on its own: a comment whose Asset a photographer may not see
   keeps its actor and loses the filename, the note and the thumbnail together. One fallback path,
   whether the reason is "gone" or "not permitted".
5. **Every enriched fact is gated by the route that already exposes it.** A returned `assetId` is one
   `/media/asset/:id/thumb` will serve (`isUserVisibleAsset`, `superseded_at IS NULL`, RAW-only for
   photographers). Comment text and subtask titles need collaboration access — an admin, or an explicit
   `project_members` row — because the comment and subtask routes answer 403 to a non-member editor
   even though `viewAllProjects` shows them the project. Notice Board text needs the Notice Board
   capability. The web never has to second-guess any of it.
6. **The page is enriched in at most six batched queries** (five source lookups and one membership
   check), each chunked at 80 ids like `lib/project-covers.ts`, each skipped when its group is empty.
   A test asserts the prepared statement count is the same for a one-row and a thirty-row page.
7. **Coalescing is untouched.** Leading-edge suppression stays; a burst produces one notification and
   there is no aggregated "3 new comments" row.

## Consequences

- Two write paths reach `notifications`: the legacy `emitNotifications` inserts directly with no outbox
  row, and the durable consumer inserts with a ledger link. So `ledger → outbox.actor_id` exists only
  for some types. Staff `subtask_assigned` is legacy-direct and `project_subtasks` records no assigner,
  so that row renders without an actor until a follow-up emits a staff outbox row for it.
- The staff list response is now parsed through a strict schema before it is returned. Adding a field
  means editing `staffNotificationListItemSchema`, deliberately.
- Enriched copy reflects the source row as it is now: an edited comment shows its current text, a
  renamed user their current name.
- Emails are unchanged. They are composed on the write path, which this ADR does not touch.
