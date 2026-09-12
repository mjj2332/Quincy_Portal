---
status: accepted
---

# The star control is Quincy-owned, not a registry component

Project priority renders as five stars on the Board (#81). ReUI ships a `rating` component that
looks exactly like the control the design called for, and the obvious move was to install it from
the registry alongside `avatar`, `card`, `item` and `kanban`.

We forked it instead. `components/quincy/PriorityStars.tsx` is Quincy-owned code that happens to
look like the vendor's component; `components/reui/rating.tsx` does not exist and must not be
created.

## Considered options

**Fork into `components/quincy/` (chosen).** Write the control ourselves, in the Quincy-owned layer
the shadcn CLI never touches.

**Install the registry `rating` and patch it.** Keep it in `components/reui/` and carry the
accessibility work as local edits to a vendored file.

**Install it and wrap it.** Leave the vendored component untouched and add keyboard and ARIA
behaviour in a wrapper around it.

## Why

The vendored `Rating` is mouse-only, and not marginally: click handlers on bare elements, no role,
no tab stop, no key handling, no route back to `null`, and a hardcoded Tailwind colour. Priority is
an Admin's primary scheduling gesture on the studio's primary screen, so it needs radiogroup
semantics, arrow-key traversal, Enter/Space to set, two ways to clear (re-activating the current
value, or Delete/Backspace on the group), 44px touch targets, and a tokenised colour. That is not a
patch to the vendor's component; it is a different component that shares a glyph.

Patching in place was rejected because of what the CLI does. `components.json` points at the
registry, and a future `shadcn add` of any block listing `rating` as a dependency would overwrite
the file and silently delete the accessibility work — the same hazard that already forbids running
the CLI against `portal/apps/web` at all. A wrapper was rejected because the behaviour that needed
fixing is the element structure itself: you cannot add a radiogroup around something that is not
made of radios.

There was precedent. `components/quincy/menu.tsx` is Base UI, moved out of the registry layer in
#56 for the same reason and for the same protection.

## Consequences

`components/quincy/` is the home for any control whose accessibility contract exceeds what the
registry ships. Its colocated DOM test is the contract, and the orphan guard requires it to have a
non-test importer in the slice that adds it — which is why the star control could not land before
the Board that consumes it.

The stars draw from one `--star-on` / `--star-off` token pair, shared with Asset rating
(`Lightbox.tsx`). Project priority and Asset rating are different concepts in the domain glossary
that deliberately share a glyph and a token; the pair replaced a raw hex in the Asset-rating styles,
so the two cannot drift into two different yellows.

A future reader finding a hand-written star control beside a registry that offers one should read
this as intentional. Do not "restore" it to `components/reui/`.
