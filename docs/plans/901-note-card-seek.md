# #901 — the whole note card seeks to its frame (plan, synthesized)

Synthesis of two blind plans (Opus deep-reasoner, Codex gpt-6.1-sol) against `origin/main@6fd107e6`.
Paths are relative to `portal/apps/web/src`. No prototype frame; matches the rest of the Portal.

## Build

- **New `lib/note-card-seek.ts`** (a `.ts`, not `.tsx`: the selector strings would otherwise trip
  `ui-primitive-ratchet.guard.test.ts`'s widget-role regex). Imports nothing staff-side
  (`guest-boundary.guard.test.ts`, ADR 0021).
  - `isCardSeekClick(event, card, gesture, selection)`, pure. False when: `defaultPrevented`,
    `button !== 0`, a modifier key, `detail > 1`; `!card.contains(target)` (React bubbles clicks from
    portaled ⋯ items, the guest delete AlertDialog and tooltips to the card); `target.closest(INTERACTIVE)`
    inside the card; a non-collapsed selection touching the card; the gesture moved past `TAP_SLOP`,
    was cancelled, or an ancestor scrolled between pointerdown and click.
  - `INTERACTIVE` = `a[href], button, input, textarea, select, label, summary, video, audio, form,
    [contenteditable]:not([contenteditable=false]), [role=button], [role=link], [role=menuitem],
    [role=checkbox], [tabindex]:not([tabindex="-1"])`.
  - `useNoteCardSeek(seek | null)`: `{}` when null; else `onPointerDownCapture` / `onPointerCancelCapture`
    record the gesture (never `preventDefault`, never capture the pointer), `onClick` calls `seek()`.
  - `NOTE_CARD_SEEKABLE` class string (see Look).
- `components/quincy/ReviewSheet.tsx`: export `TAP_SLOP` (6) so card and grabber share one threshold.
- `components/video/VideoNoteThread.tsx`: `seekable = thread.startFrame !== null`; spread
  `useNoteCardSeek(seekable ? () => onSeek(thread) : null)` on the root `Item`. `onSeek` is
  `session.seekToNote`, so drawing-frame landing, selection and the draw-mode guard are unchanged.
  Compare renders the same component, so it inherits this.
- `guest/GuestNoteItem.tsx` (`GuestThreadItem`): the same, calling `onSelect(thread)` (keeps the
  drawing-frame landing and "collapsed sheet opens to half").
- Unchanged: panels, `use-video-notes.ts`, timecode buttons, the Full screen cards (out of scope).
- No API, DTO or schema change.

## Look

- Card starts from installed `reui/item` `Item` (already `transition-colors duration-100`; not retimed).
- Hover, seekable and not selected only: `hover:bg-muted/50` + `hover:border-border-hover`, gated by
  `data-[selected=false]` so the selected `border-foreground` always wins.
  - Light: `--muted` = paper-100 (50%), `--border-hover` = greige-300.
  - Inverse (ADR 0024): `--muted` = ink-700 (50%), `--border-hover` = greige-400.
  - **Not full `bg-muted`:** on inverse `--muted` = `--secondary` = ink-700, the timecode chip's fill,
    so the chip would vanish on hover. Verified in `styles/tokens/inverse.css:34-35`.
- `cursor-pointer` on seekable cards. Tailwind 4 emits `hover:` under `@media (hover: hover)`; confirm in
  the built CSS during the browser pass.
- No `role`, no `tabIndex` on the card; the timecode stays the keyboard seek.

## Tests (red first)

- `lib/note-card-seek.test.ts`: the pure function — body true; each INTERACTIVE kind false; target
  outside card false; selection in/out of card; `detail 2`; 5px vs 7px move; cancel; defaultPrevented.
- `components/video/VideoNoteThread.dom.test.tsx`: body, header and reply-body clicks seek once; timecode
  seeks **exactly once**; Reply, ⋯ trigger, Edit/Delete (real portaled items), resolve, a link, reply
  editor and edit-form gap seek zero times; selection then click zero; `startFrame: null` zero; no
  tabindex/role on the card.
- `VideoNotes.markup.dom.test.tsx`: card click lands on the drawing frame and sets `data-selected`.
- `VideoCompare.dom.test.tsx`: one body-click regression.
- New `guest/GuestNoteItem.card-seek.dom.test.tsx`: the same matrix plus guest Edit, delete AlertDialog
  Cancel/Delete, `guest-reply-body`.
- Phone (`VideoReviewViewer.phone.dom.test.tsx`, `GuestVideoScreen.phone.dom.test.tsx`): tap seeks;
  drag past slop, pointercancel, scroll-then-click don't; grabber drag still resizes; guest tap on a
  collapsed sheet opens to half.
- Gates: ratchet, design-system, tailwind-literal-class, guest-boundary guards; `npm run verify`.
- Test ids, not ReUI data-slot selectors (`testing/test-seam.guard.test.ts`).

## Browser pass

Stage 1 (session): desktop + tablet in the built-in browser — rest, hover, selected+hover, general
note, menus, links, text selection, both lists, light page and inverse surface. Phone in iOS Simulator
Safari — tap, scroll, grabber drag, long-press select/copy, reply/edit with the keyboard up.
Stage 2: design-reviewer against the rest of the Portal. Then /code-review and Sol.

## Decisions

Settled (both planners agree): seek on `click`, not pointerdown; reply text seeks to its thread's frame;
general notes get no handler, cursor or hover; selected beats hover; double-click seeks once (first
click) and the second click selects text; card swipes scroll the list, only the grabber moves the sheet.

**Owner decisions (2026-10-17):**
1. A click on the card that only *dismisses* an open ⋯ menu does **not** seek — the film stays where it
   is. Record "a menu was open" at pointerdown (the card's own ⋯ menu; prefer the menu's own open state
   over a document-wide query where the card can reach it).
2. Notices inside a card (pinned, alert text) **do** seek on click.
