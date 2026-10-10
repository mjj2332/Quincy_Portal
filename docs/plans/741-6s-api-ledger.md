# #741 6s-api — reuse ledger

| Element | Reuse |
|---|---|
| "Some markup can't be shown" notice under an annotation (`Lightbox.tsx`, `data-testid="lightbox-markup-unsupported"`) | Text line styled with the existing `META_TEXT` class from `components/quincy/Eyebrow.tsx`, the same treatment as the author-role meta beside it. No new component; not interactive. |
| Disabled "Edit drawing" with an explanatory `title` | Existing `reui/button` text variant via `buttonClasses("text")`, already used for Edit note / Delete in the same row; only `disabled` and `title` added. |
| Line, arrow, rectangle SVG renderers and `MarkupLayer` (`components/quincy/freehand-strokes.tsx`) | Quincy-owned extracted renderer from 6a, extended. ReUI `signature-pad` rejected (pixel coordinates, variable ink width, its own history) — see `docs/plans/741-6s.md`. |
