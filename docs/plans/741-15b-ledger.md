# 741 15b UI reuse ledger

One line per new UI element (AGENTS.md "Reuse ReUI before building UI").

| Element | File | Reuse |
|---|---|---|
| Unsubscribe page body (title, confirmation text) | `portal/apps/web/src/guest/GuestUnsubscribe.tsx` | installed `components/quincy/EmptyState` (the same component the guest `UnavailableScreen` uses), centred in a plain `<main>` like `UnavailableScreen` |
| Resubscribe / Unsubscribe button | same | installed `components/reui/button` (`default` for Resubscribe, `secondary` for the undo) |
| Inline "That didn't go through" error | same | a `<p role="alert">` in `text-destructive`, no widget role of its own and no ReUI item fits a one-line inline status inside an EmptyState (`reui/alert` was not searched: it is a boxed callout, heavier than the one line `GuestScreens` uses for field errors) |
| Unavailable state (unknown token, error) | same | the existing `UnavailableScreen` from `GuestScreens.tsx` (`quincy/EmptyState`), unchanged |
| Working state (before the first POST answers) | same | an empty `<main aria-busy>`; no element |
| Email-updates switch | NOT BUILT | stopped: the guest session body has no notification-allowed field or current subscribed state (see the 15b report) |
