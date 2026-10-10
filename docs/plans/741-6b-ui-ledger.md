# #741 slice 6b-ui: reuse ledger

One line per new UI element. Raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` and widget `role`: none added, so `config/ui-primitive-allowlist.ts` is untouched.

| Element | Item | Note |
|---|---|---|
| Collapsed "Draw" button (PencilIcon) | `components/reui/button` (`outline`) rendered by the shared `components/quincy/markup-toolbar.tsx` in its new `collapsed` state | 6s section 5 "Video rest state". Not forked: the toolbar gains `collapsed`, `onExpand`, `expanding`, `drawRef`. |
| Expanded pill (tools, colour, width, undo/redo/clear) | existing `MarkupToolbar` from 6s, unchanged | Reused whole. |
| Trailing "Done" | `components/reui/button` passed as the toolbar's `trailing` | Collapses the pill, strokes kept. |
| Markup surface over the picture | `components/quincy/freehand-strokes` `MarkupLayer` + `StrokeVisible`, driven by `lib/use-markup` | Mounted through `VideoStage`'s `overlay` slot (now handed the picture box). Hand-built SVG layer: no ReUI item draws on video; the 6-deep `signature-pad` search was rejected (own state, no shared history, no normalised points). |
| Key hint strip while drawing | `components/reui/kbd` | Hidden at phone width. |
| Cap notice ("as much markup as one note can hold") | `components/quincy/Notice` | Existing inline notice pattern. |
| Drawing chip in the composer / edit form | `ANCHOR_CHIP` styles, `reui/button` (`text`) for Remove | Same chip as the frame anchors. |
| "Add/Edit drawing", "Remove drawing", "Keep drawing" in the edit form | `components/reui/button` | Pending removal shown in the form and sent on Save. |
| "Drawing" mark on a note row | lucide `PencilIcon` in the existing eyebrow span | |
| Transport lock | `disabled` on existing `reui/button` and slider | No new element. |
| "Some markup can't be shown" over the picture, and the edit-form reason | Same copy as the Lightbox's `lightbox-markup-unsupported` note (`components/Lightbox.tsx`); overlay pill uses the key-hint strip's classes, the form line the existing label-type helper span | Tolerant read via `lib/read-stored-markup.ts`. Edit and Remove drawing are `disabled` with `aria-describedby` on that line (a native `title` does not show on a disabled button). No new primitive. |
| Drawing-load failure alert + Retry (edit form) | Hand-built `role="alert"` span in the edit form's control row, with `components/quincy/Button` (`text`) for Retry | Searched ReUI MCP "inline error alert with retry button and loading status text": closest `alert` / `c-alert-3`, `c-alert-4`, `c-alert-11` (not installed under `components/reui/` at this time) are icon + title block panels with an action slot, so in the wrapping flex row of Edit/Remove/chip controls they would break the row onto its own block; `quincy/Notice` fails the same way (block tone panel). A drawing read refused for a revision mismatch lands here too (nothing shown, list re-read). Revisit by swapping to `alert` if the row is ever restructured. |
| "Loading the drawing…" status | Hand-built `role="status"` span using the label type token | Same search; no ReUI item is a bare inline status line (`spinner` appears only inside the premium blocks listed, as a dependency). Text only, no animation. |
