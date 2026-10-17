---
status: accepted
---

# The Delivery review link downloads without a code

On the Delivery review link only, a guest downloads without verifying an email. Writing a note and
giving a Client approval still need the one-time code. This amends ADR 0021 section 3 ("commenting,
approving and downloading" need verification) for that one link, and leaves ADR 0023's rules on which
Versions download there unchanged (owner decision, 2026-10-14 grilling on the Delivery page film tiles).

## Why

The Delivery page already lets anyone holding its address download the published film with no sign-in
and no code (ADR 0022). Its film tiles now open the Delivery review link, so a client who taps a tile and
then downloads from the review screen hit a code the page itself never asked for: the same file, behind
a gate on one surface and not the other. Notes and approvals carry a name that staff act on, so they keep
the code; viewing and downloading carry none.

## Considered options

- **Every Review link downloads without a code.** Declined: on a private link staff send by hand the code
  is the only record of who took the file, and that link's films are not already public.
- **Keep the code for downloads on the Delivery review link too.** Declined: it contradicts the public page
  it serves, which hands out the same files with no code.
- **Drop the code for approval as well.** Declined: an approval with no verified email is "someone with the
  link clicked Approve", which staff can't act on.

## Consequences

- A download with no verified session is audited against the link and the Version, with no guest identity
  (only the opaque session id). A public Delivery page download writes no audit row at all, so this is more
  than that page records. A verified guest's download keeps their guest identity.
- Anonymous callers are limited by address and spend their own link pools, never the verified client's,
  so they cannot lock the client out of Download all.
- Which Versions download is unchanged: the published Version without a Release, an older one only once
  Released (ADR 0023). Every Review link other than the Delivery review link keeps the code for download.
- Only the guest download routes widen, and each re-reads in SQL, at its commit and byte fences, that the
  link is still a Delivery review link. A link that stops being one mid-request is refused with 401, no
  audit row and no bytes. Every write (notes, approvals, uploads) stays verified-only.
