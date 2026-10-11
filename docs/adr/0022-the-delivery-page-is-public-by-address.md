---
status: proposed
---

# The Delivery page is public by address, one per Project

Each Project has exactly one **Delivery page**, at `/d/<address-slug>-<short random suffix>`, open to
anyone holding the address: no sign-in, no email code, no passcode, no expiry. Its only job is letting
the agent download the deliverables with no friction, as the studio's Pixieset deliveries do today.
This departs on purpose from the D-04 link contract (hashed tokens, expiry, passcode, revocation) and
from ADR 0021's guest identity, which stay in force for Review links. The Delivery page shares nothing
with `client_links`.

## Decision

- **One page per Project, one address.** The slug is set at the first Publish and never changes, even if
  the property address is edited. The random suffix keeps an address that is public knowledge from
  finding a delivery before the campaign goes live.
- **Protection is per Asset, not per link.** Ordinary deliverables are treated as public. Premium Assets
  are protected at the server: a locked premium photo is served only as a burned-in watermarked preview,
  and every full-res or web-size download of a locked Asset is refused.
- **An Admin can switch the page off.** Off shows a plain "not available" page; switching on restores the
  same address. There is no unpublish and no regeneration.
- Pages are `noindex` and sent with `Referrer-Policy: no-referrer`.

## Considered options

- **Reuse ADR 0021's Review link plumbing** (hashed fragment token, cookie, optional code). Declined: one
  page per Project needs no per-recipient links, and a token URL staff cannot re-copy defeats an
  effortless delivery.
- **A pure address slug.** Declined: guessable before a listing is public.

## Consequences

- Anyone who learns the address can download the non-premium set. Switching the page off is the only
  recourse; the address cannot be rotated.
