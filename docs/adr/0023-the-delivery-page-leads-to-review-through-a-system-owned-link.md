---
status: proposed
---

# The Delivery page leads to review through a system-owned Review link

A Project with a Delivery page and a film on it gets one **Delivery review link**: an ordinary
`client_links` row of kind `video_review`, owned by the system, made and kept in step by Publish
(and by Unlock, Re-lock, a premium mark and the Admin backfill). The public Delivery page carries its
address per film, so the client can reach the review screen with no staff step in between (#847).

## Decision

- **One per Project, for the life of the Project.** `client_links.delivery_review = 1` marks it; a
  partial unique index on `project_id` allows one row, revoked or deleted rows not excluded. Label
  `Delivery`, kind `video_review`, no passcode, comments, approval and download all on.
- **It never expires.** `expires_at` is NULL (migration 0077 makes the column nullable by the 0069
  column swap), never a far-future date. One SQL fragment (`reviewLinkOpenSql`, `packages/db`) and one
  TS helper (`reviewLinkExpired`) say "open"; `test/review-link-open.guard.test.ts` keeps a bare
  `expires_at > now` from reappearing. A site that was missed fails closed (NULL reads as expired).
- **It follows the page.** A Delivery page switched off closes the link too (0022's "only recourse" now
  reaches the link): the open fragment checks `delivery_pages.enabled`. Switching the page on reopens it.
- **Membership follows Publish.** The link carries each film of the latest Published set that is not
  locked: a Premium film joins when Unlocked and leaves when Re-locked. The sync is set-based SQL that
  reads the wanted state at commit time, so concurrent writers converge. The link is kept when its
  membership empties. Only Publish and the backfill create it; Unlock and the rest only change membership.
- **Versions: the published one and every older one.** "Every older Version" is read as every committed
  Version of the film with a version number at or below the published one, Trash included so a restore needs
  no sync. A Version uploaded after the Publish is never granted (it is not the client's to see until the
  next Publish). This is the reading of the ticket's "older Versions" as opposed to "never published".
- **Staff cannot edit it.** Every staff mutation (edit, add or remove a film, grants, replace, revoke, delete)
  answers 409 `delivery_review_managed`, with `delivery_review = 0` as a SQL backstop in each fence. It sorts first
  in the list. The staff DTO carries `delivery: true` and the address stays copyable.
- **The published Version downloads without a Release.** On this link only, a Version in the Project's
  latest Published set is downloadable (single, Range, Download all). `released` still means a Release row only.
- **The public page carries the address.** `review: { url } | null` per film: `/d/review?link=<id>#t=<secret>&v=<videoId>`.
  The film id rides in the fragment because `/d/review` reads only `?link=`. Present only while the guest gate is
  open, the link is open, the published Version is granted and the film is unlocked; staff Preview has none. It is
  built by a read-only leaf (`lib/delivery-review-entry.ts`) that both boundary guards scan.

## Supersedes, for this link only

- ADR 0021 section 2 (expiry, passcode, revoke, replace), section 4 ("nothing appears until staff grant": Publish
  grants) and section 5's "a Release is the only way to download".
- ADR 0022's "the Delivery page shares nothing with `client_links`" (the page now carries this link's address,
  including a Video id) and "switching off is the only recourse" (it also ends the link).

## Consequences

- Anyone holding the Delivery address can reach review and may verify an email, comment or approve. Approval never
  releases (0021 section 5). The per-link guest rate limits are now shared by every client of a Project.
- The guest session stays capped at 7 days (0021 section 3); a link with no expiry caps nothing else.
- Sync additions notify subscribers through the same digest as an ordinary link's add and grant, once.
- Rollback: a code rollback is safe for ordinary links. An older Worker reads a NULL expiry as expired, so the
  Delivery review link fails closed there; roll forward. See `docs/Guides/CI-Deploy.md`.
