# 741 15b UI reuse ledger

One line per new UI element (AGENTS.md "Reuse ReUI before building UI").

| Element | File | Reuse |
|---|---|---|
| Unsubscribe page body (title, confirmation text) | `portal/apps/web/src/guest/GuestUnsubscribe.tsx` | installed `components/quincy/EmptyState` (the same component the guest `UnavailableScreen` uses), centred in a plain `<main>` like `UnavailableScreen` |
| Resubscribe / Unsubscribe button | same | installed `components/reui/button` (`default` for Resubscribe, `secondary` for the undo) |
| Inline "That didn't go through" error | same | a `<p role="alert">` in `text-destructive`, no widget role of its own and no ReUI item fits a one-line inline status inside an EmptyState (`reui/alert` was not searched: it is a boxed callout, heavier than the one line `GuestScreens` uses for field errors) |
| Retry phase body (transient first-POST failure) | same | installed `components/quincy/EmptyState` (`tone="error"`, title "We couldn't unsubscribe you just now"), the same component and centred `<main>` as every other phase; its `<p role="alert">` message and the installed `components/reui/button` Retry sit in its children |
| Unavailable state (unknown token, error) | same | the existing `UnavailableScreen` from `GuestScreens.tsx` (`quincy/EmptyState`), unchanged |
| Working state (before the first POST answers) | same | an empty `<main aria-busy>`; no element |
| Email-updates switch | `portal/apps/web/src/guest/GuestSubscriptionRow.tsx` | installed `components/reui/switch` (the Admin and review-link allow fields use it the same way), with a native `<label htmlFor>` like `GuestScreens`. Placement: a quiet row at the foot of `GuestNotesPanel` (new `footer` slot), below the list and outside the `ScrollArea`, `shrink-0`, with a top hairline. It sits in the desktop aside and in the phone drawer alike, so the >=721px exact-viewport layout is unchanged; the row is `min-h-11` below 721px and on coarse pointers. State lives in `guest-subscription.ts`, owned by `GuestApp` like `guest-drafts.ts` |
| Switch failure line | same | `<p role="alert">` in `text-destructive`, as the unsubscribe page; no ReUI item fits a one-line inline status |
