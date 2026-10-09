---
status: accepted
---

# Guest reviewer identity and the Review link contract

The Portal has only staff sessions. Native video review (ADR 0020, epic #741) lets a client review a
cut without an account. This builds on the approved D-04 link contract (30-day default expiry,
optional passcode, revocation, hashed tokens) and decides how a **Guest reviewer** is identified, what
a **Review link** grants, and how it is kept apart from the staff app. A future reader will see a
second, parallel API surface with its own cookie and Origin check, and an approval that does nothing by
itself. Both are this decision.

## Decision

1. **The token lives in the URL fragment**, so it never reaches server logs, referrers or analytics. The
   page exchanges it by POST for an HttpOnly cookie scoped to the guest path. Tokens are stored only as
   hashes; the server cannot rebuild a link.
2. **Link lifecycle.** Default expiry 30 days, or a date staff choose. An optional passcode. Revoking a
   link kills every open guest session on it at once.
3. **Identity is an email verified by a one-time code.** Codes are hashed, expire in 10 minutes, allow 5
   attempts, and are consumed once. Requests and attempts are rate-limited per link, per email and per IP,
   counted by attempt and reserved in a single statement. Responses are identical for known and unknown
   emails. A guest session is hashed, bound to one link, and lasts at most 7 days or the link's expiry,
   whichever is sooner. Watching needs no verification; commenting, approving and downloading do.
4. **Membership and grants.** A link holds one or more Videos from a single Project. A Version is visible
   only while its Video is a current member of the link and the Version is granted to it. A new Version
   never appears on a link until staff grant it. Removing a Video takes effect on the next request, and
   its notes and decisions are kept. One email verification covers every Video on the link.
5. **Approval is informational.** A client approving a Version, or requesting changes, is recorded per
   Version in an append-only log and never triggers delivery. **Staff Release** of one specific approved
   Version is what allows download, using a compare-and-swap on the approval revision so a stale view
   cannot release the wrong cut. Download needs both approval and Release.
6. **Premium unlock is enforced at the server.** A premium Video also needs a staff-granted unlock; a
   locked download is refused including byte-range and HEAD requests. The watermark is a browser overlay
   and a deterrent only.
7. **Guests see public content only.** Internal notes, internal replies, internal markup, and any count or
   marker derived from them never reach a guest route or a client email. A guest can copy only their own
   notes, and paste only onto Versions the link grants.
8. **Audit.** A guest action writes a null actor with guest and link provenance in the audit metadata. The
   audit actor column is already nullable. Staff impersonation provenance is unchanged.
9. **A separate guest API surface.** Every guest route is registered as terminal and has its own Origin
   check on mutations. A staff session is ignored on guest routes and a guest session is useless on staff
   routes. The guest page is a separate lazy-loaded app inside the same SPA entry, with no staff session and
   no router-driven navigation.
10. **Client email carries no link.** Because only the hash is stored, notification emails cannot include the
    Review link; the client opens the link they already hold. Each email has a one-click unsubscribe scoped
    to one guest and one link.

## Considered options

- **An invitee allow-list.** Declined: anyone holding the link, plus the passcode if set, may verify their
  own email and comment.
- **Approval triggers delivery.** Declined: the link is open, so one forwarded link would release a film.

## Consequences

- Sending codes to arbitrary unverified recipients needs a sender that allows it (the current email setup
  guide says Workers Paid); this must be proven from a preview deploy before the email-code slice.
- The guest surface is a second attack boundary and carries its own leak sweep in tests.
- The Review link delivers released video only. A future single delivery page for photos, Video and
  Floorplan is out of scope and is expected to reuse this contract.
