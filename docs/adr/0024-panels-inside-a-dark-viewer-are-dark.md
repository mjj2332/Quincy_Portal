---
status: accepted
---

# Panels inside a dark viewer are dark

The review viewers (the staff video viewer, its Compare, the guest video screen and the photo
Lightbox) are dark `data-surface="inverse"` stages. TB8-09 gave the panels inside them (notes,
Delivery, the Lightbox review panel, and notices on the stage) their own light
`data-surface="default"` scope, so a paper panel sat beside an ink stage. The owner found the light
panel uncomfortable and distracting next to the film (2026-10-14), so panels inside a dark viewer now
take the inverse roles like the rest of the stage.

## Decision

- A panel, pane, tab or notice rendered inside a dark viewer inherits the viewer's inverse surface.
  It does not open a `data-surface="default"` scope.
- **Toasts are the one exception.** They float above every screen and keep the app-wide light look,
  so `ToastViewport` keeps its default scope even when a viewer hosts it.
- A guard test fails when a `data-surface="default"` scope appears inside a dark viewer anywhere
  other than the toast viewport.
- The `[data-surface="default"]` block in `inverse.css` stays for the toast viewport and for any
  light surface outside the viewers.

## Considered

- **Keep TB8-09's light panels.** They give text-heavy panels paper contrast, but they put a large
  bright area beside the film, which pulls the eye away from it, and that is what the owner objected to.
- **Dark only for the staff video viewer.** This was rejected because the same reasoning applies
  to every dark viewer, and one rule is easier to keep than three exceptions.

## Consequences

- Rich-text, form and table content in the panels must read on the inverse roles. The inverse block
  already defines `--field-bg`, `--popover`, `--border` and the tone foregrounds for this, so new
  panel content must use roles, never raw paper colours.
- Supersedes TB8-09 §2.3a's "light panel inside the dark stage" for the viewers.
