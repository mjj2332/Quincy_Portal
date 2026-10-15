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
