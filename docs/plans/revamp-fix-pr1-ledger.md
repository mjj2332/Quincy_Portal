# Video-review revamp fix, PR 1 (staff compose) reuse ledger

One line per new or changed UI element in the phone note composer (audit rows 1, 2, and the row-9 draw check). Plan:
`revamp-fix.md` (settled), `revamp-fix-opus.md` §3–§4. Paths are under `portal/apps/web/src/`.

ReUI MCP (`mcp__ReUI__search`) timed out on two queries on 2026-10-15, so the searches below ran against the local copy
`tmp/ReUI_Full_Source_Code/` (it may be out of date). Nothing new is installed. `config/ui-primitive-allowlist.ts` is
unchanged: the diff adds no raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role` outside
`components/reui/` and `components/quincy/` (the tray's `role="region"` is a landmark on `CollapsibleContent`, not a
widget role).

| Element | Where | Uses |
|---|---|---|
| Compose pill (the field as one row) | `QuincyRichTextEditorBase.tsx` (`pill`, `inlineStart`, `inlineEnd`) | `components/reui/input-group.tsx`: the editor's own `InputGroup`, with `InputGroupAddon` `align="inline-start"` / `"inline-end"`. The same composition as the registry's `blocks/ai-chat-8/components/composer.tsx` (InputGroup, inline-end addon, round icon Send). |
| Pill radius | `components/reui/input-group.tsx` | New scoped `variant="pill"` → `rounded-[var(--radius-pill)]` (owner decision C5). The default variant renders as before; the only caller is the phone composer. Adaptation note 6 in the file. |
| Timecode chip (in the pill) | `VideoNoteComposer.tsx` (`video-note-anchor`) | The existing `ANCHOR_CHIP` span, moved into the inline-start addon. Range shown in the short form (C6). |
| + (Note options) | `VideoNoteComposer.tsx` (`video-note-extras`) | `components/reui/button.tsx` `variant="ghost" size="icon"` + lucide `Plus`, the same control as the pen beside it (`COARSE` 44px hit target). No `quincy/IconButton` exists. Not a `CollapsibleTrigger`: the open state lives in the form store (`extras`) so Escape, Cancel, a post and `leave` close it; `aria-expanded` / `aria-controls` are set by hand. |
| + tray | `VideoNoteComposer.tsx` (`video-note-tray`) | `components/reui/collapsible.tsx` (`Collapsible`, `CollapsibleContent keepMounted`), a `region` named "Note options". Searched: `reui/sheet` (modal, takes focus and drops the keyboard), `reui/popover` (takes focus; outside presses close it while typing), drawer (not installed; modal). Collapsible is the non-modal fit (owner decision C1). |
| Visibility choice (in the tray) | `VideoNoteComposer.tsx` | `components/reui/toggle-group.tsx`, the existing desktop usage, repeated in the tray. |
| Frame step, Set in, Set out, Clear marks, Remove drawing, drawing chip (in the tray) | `VideoNoteComposer.tsx` | `components/quincy/Button.tsx` (the existing buttons, moved); the drawing chip is the existing `ANCHOR_CHIP` span. |
| Formatting toolbar (in the tray) | `QuincyRichTextEditorBase.tsx` (`toolbarContainer`) | The existing `components/reui/rich-text-editor` `RichTextToolbar`, portalled into the tray; the whole toolbar (C2). |
| Pen (in the pill) | `VideoNoteComposer.tsx` (inline-end addon), `VideoMarkupOverlay.tsx` | The existing Draw button (`components/reui/button.tsx` ghost icon). While the composer draws it stays in the pill with `aria-pressed`, and pressing it again is Done (P7). |
| Send | `VideoNoteComposer.tsx` (`video-note-post`, phone only) | `components/reui/button.tsx` new scoped `size="icon-round"` (`size-11 rounded-[var(--radius-pill)]`, owner decision C5; adaptation note 7) + lucide `SendHorizontal`; while posting `components/reui/spinner.tsx`, phase in `aria-label`. Desktop keeps the `quincy/Button` "Post". |
| Hint line ("Internal · paused at TC · the note is stamped here"), lock line, problem line | `VideoNoteComposer.tsx` (`video-note-stamp`, `video-note-problem`) | Plain `<p>` / `<div role="alert">` in the existing `[font:var(--type-label)]` role (C3). Refresh notes: `components/quincy/Button.tsx` `variant="text"`. |
| Cancel | `VideoNoteComposer.tsx` (`video-note-cancel`) | `components/quincy/Button.tsx` `variant="text"` (existing). |
| Compose-mode context and holds | `components/quincy/ReviewSheet.tsx` (`SheetModeContext`, `setHold`) | Quincy-owned; no UI. |
| Transport hidden in compose | `components/quincy/VideoPlayer.tsx` (`transportHidden`) | The existing transport block, `hidden` (still mounted). |

## Round 2 (after the iOS Simulator pass on 698c2d51)

No new elements; existing ones restyled to the prototype (P6, kit.jsx `Composer`, quincy.css `.tc-chip` / `.ibtn.sm`).

| Element | Where | Change |
|---|---|---|
| Timecode chip (in the pill) | `VideoNoteComposer.tsx` (`PILL_CHIP`) | Small mono, `--text-xs` (12px, the `.tc-chip` size and the smallest the design rules allow; no mono-small token exists). The desktop `ANCHOR_CHIP` is unchanged. The tray's drawing chip uses the same class. |
| Pill text column | `QuincyRichTextEditorBase.tsx` | In `pill` only: the text box is `flex-1 min-w-0` and the inline addons take `--space-1` padding. Default layout unchanged. |
| + and pen (in the pill) | `VideoNoteComposer.tsx`, `VideoMarkupOverlay.tsx` (`PILL_ICON` in `quincy/VideoPlayer.tsx`) | Same ghost icon `reui/button`, drawn at 32px (`.ibtn.sm`) with a transparent `after:` pseudo-element keeping the 44px hit area, in place of `COARSE`'s 44px box. The desktop pen keeps `COARSE`. |
| + tray | `VideoNoteComposer.tsx` (`video-note-tray-row`) | Two rows: visibility, frame steps, Set in / out (and Clear marks, drawing chip, Remove drawing when present) on one `flex-nowrap overflow-x-auto` row; the toolbar (already a sideways scroller) on the second. The visibility description is dropped on the phone; the hint line names the visibility. |
| Hint line | `VideoNoteComposer.tsx` | 12px per P6; the `line-clamp` moves to an inner `<p>` so the grid row cannot shrink it to nothing. |
| Cancel | `VideoNoteComposer.tsx` | Same `quincy/Button` `variant="text"`, drawn 32px (`.ibtn.sm`) with a vertical `after:` hit area; keeps the field's focus on press, like Send. |

## Round 3 (design review of round 2)

No new hand-built elements. One reused item is added: `components/reui/separator.tsx` (vertical) between the marks and the formatting in the tray row.

| Element | Where | Change |
|---|---|---|
| + tray | `VideoNoteComposer.tsx` (`video-note-tray-scroller`, `video-note-tray-row`) | One row: visibility, frame steps, Set in / out (and Clear marks, drawing chip, Remove drawing), `reui/separator`, then the formatting toolbar (still the editor's `RichTextToolbar`, portalled in). The scroller is the outer node; the row inside it is `w-max py-px`, so the scroller never clips the controls vertically. The right-edge fade is `lib/use-scroll-fade.ts` (`useScrollFade` + `SCROLL_FADE_MASK_CLASSES`), the same one the rich-text toolbar uses. The tray's grid row is `auto` (it no longer shrinks). |
| Timecode chip | `VideoNoteComposer.tsx` (`PILL_CHIP`) | `.tc-chip` amber on semantic tokens: `text-warning-foreground` and an 18% `color-mix` of `--warning-foreground` (on the inverse surface that is `--signal-caution-on-inverse`, star-amber). Not the `warning-light` Badge: Badge would bring its own height, padding and type to a mono timecode. |
| Pill | `QuincyRichTextEditorBase.tsx` (`PILL_GROUP`) | P6 `.composer-input`: `bg-surface-sunken` (ink-700 on inverse), `border-transparent`. Focus is a 2px `outline-ring` drawn on the edge (negative offset by `--border-width-bold`, with its at-rest twin per the #552 guard), not FIELD_GROUP's offset outline. `[&_[contenteditable]]:min-h-0` drops the editor's 64px floor in the pill only. `FIELD_GROUP` is unchanged. |
| Send | `components/reui/button.tsx` `size="icon-round"`, `VideoNoteComposer.tsx` | lucide `Send` (P6's angled glyph). Disabled keeps the primary fill at the base's reduced opacity on the inverse surface; adaptation note 7 updated. |
| Strip gutter | `VideoNotesPanel.tsx` | Compose keeps the browse side padding (`--space-4`); only top and bottom tighten. |
| Keyboard pan | `lib/use-visual-viewport.ts` (`root`), `VideoReviewViewer.tsx`, `guest/GuestVideoScreen.tsx` | No UI. The hook writes the root's height and transform inside the visual-viewport event; in the pill, ProseMirror's scroll-to-selection scrolls only the pill's own box. |

## Round 4 (Simulator pass and design review of round 3)

No new elements.

| Element | Where | Change |
|---|---|---|
| Compose layout | `components/quincy/ReviewPane.tsx` | The strip is fixed and the film flexes (plan §3): in compose the sheet stays `flex-none` up to `max-h-full` (was `100% - --space-9`), and the film's cell (`flex-1 min-h-0 overflow-hidden`) gives up its height first. The 96px film floor is gone in compose, so the strip always fits whole above the keyboard. |
| + | `VideoNoteComposer.tsx` | Rendered at rest too, ahead of the chip, so nothing inside the pill moves on focus; at rest it opens the tray and enters compose. |
| Pill alignment and shape | `QuincyRichTextEditorBase.tsx` (`PILL_GROUP`, inline addons), `components/reui/input-group.tsx` | `items-end` with the addons lifted 6px, so +, chip and pen sit on the last line; Send `self-end`. The pill radius is half the 44px phone control height (`rounded-[22px]`, adaptation note 6 updated): a stadium on one line, capped corners once it wraps. |
| Tray separator | `VideoNoteComposer.tsx` | The toolbar's own `RichTextToolbarSeparator` (from `reui/rich-text-editor/rich-text-toolbar.tsx`), replacing the bare `reui/separator`: 16px, centred, the same divider the toolbar uses. |
| Send | `components/reui/button.tsx` `size="icon-round"` | Always the primary fill; disabled dims only the icon (`disabled:opacity-100 [&:disabled_svg]:opacity-50`). Adaptation note 7 updated. |
| Pill focus | `QuincyRichTextEditorBase.tsx` | Unchanged this round (round 3's 2px edge ring). Not switched to a `--border-strong` hairline: that token is not re-scoped on the inverse surface (ink-900 on the ink-700 pill), so the focus state would all but vanish. Reported for a decision. |
| Keyboard box | `lib/use-visual-viewport.ts` | No UI. Attached in a layout effect (on before the next frame), also follows page scroll, and on the way out restores the page scroll before releasing the root. |

## Round 5 (Simulator pass of round 4)

No new elements.

| Element | Where | Change |
|---|---|---|
| Keyboard box | `lib/use-visual-viewport.ts` (`root`, `track`), `video/VideoReviewViewer.tsx` | No UI. The phone dialog follows the visual viewport for as long as it is open (`track`), not only in compose mode, so iOS's first pan on focus, which lands before React turns compose mode on, is followed in the same event. The root is passed as an element (the popup's callback ref into state). The guest screen keeps its compose-only box (its own pass is a later PR). |
| Pill focus | `QuincyRichTextEditorBase.tsx` | Unchanged (round 3's 2px ring). Stopped, not switched: a `--border-strong` hairline is 1.26:1 on the ink-700 pill (`--border-strong` is ink-900 and inverse.css does not re-scope it), under the 3:1 a focus indicator needs. Reported for a decision with the options. |
| Pill radius | `components/reui/input-group.tsx` | `rounded-[22px]` kept: the design guards pass on it, and there is no height token for the 44px phone control (the codebase spells 44px raw as the WCAG target). |

## Round 6 (owner decision on the pill focus)

No new elements.

| Element | Where | Change |
|---|---|---|
| Pill focus | `QuincyRichTextEditorBase.tsx` (`PILL_GROUP`) | A `--border-hover` hairline (`--border-width-hair`) drawn as the outline over the transparent border, on any focus of the field (`:focus`, a tap included), replacing round 3's 2px `--ring` edge ring. 4.41:1 on the ink-700 pill (greige-400 on the inverse surface). Still one focus line (#613): the border is never recoloured. |

## Round 7 (the first-focus flash, from the deep-reasoner diagnosis)

No new elements.

| Element | Where | Change |
|---|---|---|
| Pill focus on a tap | `QuincyRichTextEditorBase.tsx` (`revealOnFocus`, `handleDOMEvents`, `focusField`), `VideoNoteEditor.tsx`, `VideoNoteComposer.tsx`, `VideoNotesPanel.tsx` | No UI. With `pill` and `revealOnFocus={false}` (the staff viewer's notes host only), a touch or pen press on the unfocused field is focused with `preventScroll` and the caret placed at the press, so iOS does not pan the viewer to reveal it. Mouse, trackpad, an already-focused field and the guest screen keep the browser's focus. The pill's refocus paths (upload tray Cancel/Remove, table tools) use `preventScroll` too. |
| Viewer backdrop (phone) | `components/reui/dialog.tsx` (`overlayProps`, divergence note), `VideoReviewViewer.tsx` | The base-nova dialog backdrop, re-styled on a phone only: `data-surface="inverse"` with `bg-background` (ink-900) and no blur, instead of the scrim. Desktop keeps the scrim. |
| Keyboard box | `lib/use-visual-viewport.ts` | Unchanged behaviour; doc comment corrected (the pan is drawn by Safari's UI process, so the fix is not to pan). |

## Round 8 (Simulator measurement of the first-focus flash)

No new elements.

| Element | Where | Change |
|---|---|---|
| Keyboard box | `lib/use-visual-viewport.ts` | No UI. The hook sets `transition: none` on the root it drives (cleared on release): reui `DialogContent`'s `duration-100` (transition-property `all`) eased every write, which was the flash. |
| Pill focus on a tap | `QuincyRichTextEditorBase.tsx`, `VideoNoteEditor.tsx`, `VideoNoteComposer.tsx`, `VideoNotesPanel.tsx` | Round 7's `revealOnFocus` / `focusField` reverted: measured no effect on iOS's keyboard scroll. |
| Viewer backdrop (phone) | `components/reui/dialog.tsx`, `VideoReviewViewer.tsx` | Kept from round 7 (solid ink on a phone) as the floor. |

## Round 9 (design review of round 8)

No new elements: every change is to an element with a line above.

| Element | Where | Change |
|---|---|---|
| Pill radius | `components/reui/input-group.tsx` | `rounded-[calc((var(--space-7)-var(--space-1))/2)]`: half the 44px control height from the spacing tokens ((48 - 4) / 2 = 22px), replacing the `22px` literal. |
| + (Note options) | `VideoNoteComposer.tsx` | `aria-pressed` while the tray is open (alongside `aria-expanded`), with the markup toolbar's pressed treatment (`aria-pressed:bg-secondary` plus `SELECTED_HAIRLINE_PRESSED`, the inset `--border-hover` hairline, now exported from `quincy/markup-toolbar.tsx`). On the inverse pill `--secondary` and `--muted` are the pill's own ink-700, so a fill alone (the old `aria-expanded:bg-muted`, and the pen's `aria-pressed:bg-secondary`) was invisible. |
| Pen (Draw) in the pill | `VideoMarkupOverlay.tsx` | The same hairline on the phone pill's pen while drawing (compact only; the desktop transport's pen is unchanged). |
| Pill text box | `QuincyRichTextEditorBase.tsx` (`PILL_TEXT`, `PILL_SCROLLER`), `VideoNoteComposer.tsx` (`REST_CLAMP`, `COMPOSE_CLAMP`) | The block padding (`--space-2`) moves from the ProseMirror node to the text box, and the scroll moves to the box's child, so scrolled text clips inside the padding, never at the hairline. One line is the same 8 + 24 + 8 px as before. |
| Pill wrapped layout | `QuincyRichTextEditorBase.tsx` (`usePillWrap`, `pillTextWraps`) | Once the draft takes a second line the field gets `data-wrapped`: the text box takes the full width on top (`order-first basis-full`), + and the chip stay left and the pen goes right (`ms-auto`) on a row under it; Send keeps `self-end` beside the pill. The attribute is written in the editor's transaction or a ResizeObserver callback, before the next paint. It unwraps only when the text is one line that would fit the inline row (no flip-flop). The 4-line clamp now applies at full width. |
| Film floor (compose mode) | `quincy/ReviewSheet.tsx` (`useSheetTextRoom`, `SHEET_FILM_FLOOR`), `ReviewPane.tsx`, `VideoNoteComposer.tsx` (`data-sheet-text`), `VideoNoteEditor.tsx` / `QuincyRichTextEditorBase.tsx` (`contentAttributes`) | The film keeps `--space-9` (96px, the plan's K1 / K3 rows): the sheet publishes `--sheet-text-room` (the row's height less the floor less the rest of the sheet) and the pill's text clamp reads it, one line at least. Below one line the film yields. |
| Safari bars after Cancel | none | Investigated, not changed: Safari re-tints its bars from the fixed viewer's edges (ink-800) after the document scroll iOS makes for the keyboard. See lessons.md, "Safari tints its bars from the page's edges only after the document scrolls". |

