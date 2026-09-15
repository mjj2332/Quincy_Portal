---
status: accepted
---

# The enriched notification payload is staff-only

An External editor sees a deliberately narrowed view of a Project. Naming an actor, an Asset
filename or a comment's text in a notification is new information reaching that user, and #116's
enrichment (ADR 0007) had to decide, per type, whether it may. This ADR records the answer and the
alternative it declined.

## Decision

1. **`actor`, `subject` and `assetId` are absent from the external payload for all thirteen types.**
   `externalNotificationListItemSchema` is unchanged and strict; the external branch of
   `GET /notifications` runs no enrichment; `externalVisibleNotificationCte` — the authorization
   boundary — has no new call site.
2. **The reason is the copy the boundary already chose, not an absence of data.**
   `packages/shared/src/external-notification.ts`'s `COPY` renders `comment_added` as "Annotation
   feedback was added to assigned media." and `mentioned` as "You were mentioned in a project comment."
   — no name, no filename, no excerpt — where the staff copy names all three. That anonymisation is a
   decision; a read model must not quietly reverse it.
3. **The declined alternative: per-type carve-outs.** The comment and annotation routes already show an
   External editor the commenter's name and text, and the review route shows the filenames of Assets
   they may see, so a narrow "`mentioned` may enrich" rule would be defensible. It was declined because
   each carve-out must prove that the notification's own visibility predicate implies the route's
   predicate (`hasProjectCollaborationAccess`, `isUserVisibleAsset`, capability checks), and one
   divergence between the two is a leak. Staff-only needs no such proof.
4. **Fallback, never suppression.** A notification an External editor is entitled to always arrives,
   carrying its stored copy. Enrichment can never make a row disappear.
5. **Tested as a boundary, not a sample.** A leak test seeds a staff colleague's annotation and mention
   and asserts the external list contains neither the colleague's name, the Asset's filename nor the
   comment text while both rows are present; a strict-schema test pins today's exact key set; and the
   same `mentioned` event is shown enriched for a staff recipient and plain for an external one.

## Consequences

- Reversing any part of this — even for one type — needs the owner, a superseding ADR, and the
  per-type authorization proof in point 3.
- The External editor's Project routes may stay richer than their notifications. That asymmetry is
  accepted: the routes have their own predicates, the notification list has one.
- Staff photographers are inside the boundary but still gated per Asset: a filename reaches them only
  when the annotated Asset is in a RAW collection, mirroring `/media/asset/:id/thumb`.
