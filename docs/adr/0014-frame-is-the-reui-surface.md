---
status: accepted
---

# `frame` replaces `card` as the Portal's ReUI surface

Supersedes ADR 0002.

The Dashboard is being rebuilt on `@reui/solution-crm-7`: one set of Projects shown through
Table / Board / Calendar / Timeline tabs, with a shared Filter, Display menu and search. That
block ships only on the `frame` surface. ADR 0002 committed the Portal to `card` (the surface of
`kanban-board-3`, the first adoption) and rejected both per-block surfaces and rewriting a block
onto a local idiom.

The owner chose to adopt `solution-crm-7` as shipped and move the Portal to `frame`, rather than
recompose it onto `card`. 0002's own reasoning decides it: rewriting a block onto another surface
"is not an adoption, it is a bespoke screen with extra steps", and mixing surfaces on one screen
reads as two applications. Since the whole Dashboard is being replaced, the Board's
`kanban-board-3` cards are the only `card` surface on it, and they are rebuilt as `frame` cards in
the same programme.

## Consequences

- Every later block search passes `surface: "frame"`. A block that ships only on `card` is
  adopted by putting its content in `Frame` / `FramePanel`, not by reopening this decision.
- The `--frame-*` roles (radius, panel radius, border, background, gap) must be bridged to Quincy
  tokens in `styles/`, as the sidebar roles were. Quincy's radii are square, so frames render
  square, unlike ReUI's preview. That is the token set winning, as 0002 already noted for cards,
  not a porting defect.
- `card`, `avatar` and `item` stay in `components/reui/` as shared primitives while anything still
  uses them. Do not delete `card` just because the Board no longer does.
- `testing/test-seam.guard.test.ts` guard F still applies: a surface change renames vendor-authored
  `data-slot` values (`card` → `frame-panel`), which is exactly why DOM tests may not select them.
