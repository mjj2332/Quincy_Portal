# #741 6s-ui — reuse ledger

Searches run: ReUI MCP for a drawing/annotation toolbar and a segmented tool control (no toolbar, segmented or annotation item; only weak matches, as recorded in `docs/plans/741-6s.md` §5), `mcp__ReUI__get_examples` for `toggle-group` (c-toggle-group-7, -10, -11), and `npx shadcn@latest view` / `add radio-group` in the `tmp/ReUI-Test-1` sandbox.

| Element | Reuse |
|---|---|
| Tool selector (Pen, Arrow, Line, Rectangle) in `components/quincy/markup-toolbar.tsx` | base-nova `radio-group`, vendored through the sandbox (`--path src/components/vendor-741-6s-ui`) into `components/reui/radio-group.tsx` with the skin edits and a children slot listed in its header; rendered as `<button role="radio">` via `render` + `nativeButton`; lucide `PencilIcon`, `ArrowUpRightIcon`, `MinusIcon`, `SquareIcon`. Radio, not toggle-group, because the tools are a single choice (one tab stop, arrow keys, aria-checked): `docs/plans/741-6s.md` SETTLED override 1.; the checked tool gains an inset `--border-hover` hairline |
| Pen colour swatches | installed `reui/toggle-group` (`ToggleGroup`, `ToggleGroupItem`), composition of MCP `c-toggle-group-10`; names from `PEN_COLOUR_NAMES`; single value, clicking the pressed swatch is ignored; the selection is a box-shadow ring on the inner circle (not an outline, which stays the keyboard focus ring) with the pressed fill cleared; each swatch carries a `title` |
| Stroke width dots | installed `reui/toggle-group`, composition of MCP `c-toggle-group-11`; pressed dot gains an inset `--border-hover` hairline; each dot carries a `title` |
| Width-cycle button (phone) | installed `reui/button` (`variant="outline"`); a `reui/toggle` cannot express three states |
| Undo, Redo, Clear | installed `reui/button` inside installed `reui/button-group`; lucide `Undo2Icon`, `Redo2Icon`, `Trash2Icon`. Icon-only on the phone form. `reui/tooltip` + `reui/kbd` rejected: a Base UI tooltip handles Escape with a document-level `stopPropagation`, so one Escape would close the tip instead of ending drawing; the `title` attribute, `aria-keyshortcuts` and the hint pill carry the shortcuts |
| Group dividers | installed `reui/separator` (vertical), hidden on the phone form |
| "Markup" / "Editing drawing" label | installed `quincy/Eyebrow` |
| Cancel / Save (Edit drawing), the toolbar's host slot | installed `reui/button` (`outline` / `default`), the variants `buttonClasses("secondary" / "primary")` resolved to; this is what lowers the `Lightbox.tsx` ratchet entry 28 to 22 |
| Pill container | layout `div` moved out of `Lightbox.tsx` with its classes, token for token (`drawbar` kept for `app.css` `:has(.drawbar) ~ .strip`); not ReUI `frame` (ADR 0014: a floating tool pill is not a surface); compact (phone) takes `--radius-lg` instead of the pill radius so a wrapped pill does not clip its corner controls |
| Hint pill + toolbar stack | layout `div` (`data-testid="lightbox-markup-stack"`): one bottom-anchored flex column, so the hint rides above the pill however many rows it wraps to; the hint keeps its `kbd` markup from the Lightbox (`SHORTCUT_KBD`), now with `⇧⌘Z redo` |
| Shape preview in the layer | existing `StrokeVisible` from `components/quincy/freehand-strokes.tsx`, rendered as the last bare child of `MarkupLayer` |
