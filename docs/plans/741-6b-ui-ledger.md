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
