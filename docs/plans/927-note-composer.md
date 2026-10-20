# #927 Note composer revamp — settled plan

Spec: #927 (issue body plus the owner's comment of 2026-10-19 on dark Safari chrome and iPhone Full screen). Prototype: `design/prototypes/note-composer/project/` (round 2), frames C1, F1, C2–C7, G1, R1, E1, P1–P5.
Integration branch: `feat/927-note-composer`, cut from `origin/main` at 6f0d40d6. This plan merges the blind Opus and Codex plans of 2026-10-19 (raw copies in `~/quincy-wt/notes-927/`, outside the repo) with the owner decisions below.

Paths are relative to `portal/apps/web/src/` unless they say otherwise.

## Owner decisions (2026-10-19)

- **D1 Full screen on iPhone hands over to the native player.**
  - On iPhone the Full screen button and the F key call the existing native handoff (`lib/video-native-player.ts`, `webkitEnterFullscreen`) instead of entering the in-app layer.
  - Notes, drawing and Add note aren't available in the native player.
  - A rotation can't hand over, because the handoff needs a user gesture. The turn entry stays the in-app layer, with dark chrome.
  - The test for "iPhone" is that the page has no element full screen (`document.fullscreenEnabled !== true`) and the video has `webkitEnterFullscreen`. Desktop, iPad and Android keep the in-app Full screen with the floating box.
  - Mind the not-ready guard at `video-native-player.ts:31`: iOS shows nothing below HAVE_CURRENT_DATA. Reuse the existing notice path.
- **D2 Send needs text or media.** No API change. With only a drawing, Send stays disabled with the title "Add a few words to post the drawing". This amends story 15 and frame C2. Media-only notes already pass.
- **D3 Turn-upright stays.** `lib/immersive.ts::mustTurnUpright` (the 2026-10-16 decision) is unchanged, and story 39 is dropped.
- **D4 Edit locks the other control.** Editing a note's range disables the pen, and editing its drawing disables in/out, using the existing lock-hint title. There is one Save and no API change. The server rejects `markup_and_frames` together.
- **D6 Dark chrome only where Safari allows it** (decided after T5's spike, fixture screenshots in `~/quincy-wt/notes-927/t5-spike/`).
  - Measured on iOS 27: `viewport-fit=cover` and `theme-color` change nothing. Safari takes the top strip's tint from the sticky or fixed element at the top edge at first paint, and doesn't re-sample when the review mounts.
  - So when a review URL loads directly, the shell's cream sticky header (`quincy/ShellHeader.tsx`, `sticky top-0 … bg-background`) must not paint at the top edge. The review is the first thing there and the strips load dark. Precedent: #928's "Dashboard mounted" header rule.
  - Opening a film from inside the Portal (an in-app navigation) keeps whatever tint the page loaded with. The owner has accepted this.
  - Dropped: the `use-review-chrome` hook, `viewport-fit=cover` and `theme-color`, which were measured to do nothing.
- **D5 The bubble is dark.** The formatting bubble uses the viewer's semantic popover tokens (ADR 0024), not the light bubble of C3/P2.
- **D7 Drawing on a phone keeps the bigger film** (2026-10-20). While the pen is down (P4) the phone collapses the notes list and gives the film the room, so the canvas is as large as it can be. P4 draws the notes list still showing above the box, as at rest; the build keeps its own layout on purpose (owner decision), so a design review should not flag it.

## Session defaults (both plans agree)

- **Range crossing keeps the shipped `markFrame` semantics.** A crossed endpoint is cleared, not swapped. Lesson: "A range shortcut that sets both ends silently rewrites the one you were not editing (#683)".
- **Legacy formatting is kept.** Old notes keep their headings and checklists in the schema and round-trip unchanged. The `note` preset blocks creating new ones (no input rules, commands or slash) but never flattens existing content.
- **Anchor freeze:** the chip follows the playhead until the first text, the first accepted media (upload start) or the first stroke. Focus alone doesn't freeze it on desktop. The phone keeps its D10 rule, stamp on focus, which is equivalent because focus pauses the film.
- **Stroke width:** 4 (`DEFAULT_PEN`) for new strokes. Saved strokes keep their own widths.
- **Phone drawing row:** 44px targets. Below the width where all of them fit, the row scrolls sideways (with no wrapping and no smaller targets). Bubble buttons and Send on a phone are 44px as well.
- **Reply:** R1 drops the visible Cancel. A reply is dismissed by Esc and by the reply toggle that opened it, and both need accessible names.
- **Clear** removes a saved drawing being edited too, even when there are no local strokes.
- **Media strip, posted notes** (no frame shows them): 56px tiles that open the existing image/video dialogs. The draft strip shows a thumb, the file name and ×. Size shows only from the local File while uploading.
- **Esc order:** the colour popover, then drawing, then the Full screen box, then Full screen. Lesson: "Escape needs an order, decided before anything runs; per-Version state must not outlive its Version (#741 5b)".
- **Avoid PR #928's files** (`styles/app.css`, `docs/lessons.md`, the shell). Use utilities. Lessons are appended in T11 once #928 has merged.

## Frame map

| Frame | Component |
|---|---|
| C1 | `components/video/VideoReviewViewer` → `VideoNotesPanel` → `VideoNoteComposer` → `quincy/NoteComposerBox` (staff); `quincy/VideoPlayer` with no range or pen; `quincy/VideoStage` with no timecode chip |
| F1 | `quincy/ReviewPane` floating → the same `NoteComposerBox` (`floating`), ~560px, centred above the controls. Not on iPhone (D1) |
| C2 | `NoteComposerBox`, empty staff state. Send rule per D2 |
| C3 | `reui/rich-text-editor/rich-text-format-bubble.tsx` over the installed `RichTextBubbleBar` (`note` preset), dark per D5 |
| C4 | The box's anchor chip, plus the draft media strip (editor media nodeviews rendering `NoteMediaThumb`) |
| C5 | The visibility `reui/dropdown-menu` radio items, a scoped two-line item variant carrying each description |
| C6 | `quincy/NoteDrawRow` on desktop: ‹ \| tools (radiogroup) \| colour \| Undo, Redo, Clear |
| C7 | `NoteDrawRow`'s colour `reui/popover` |
| G1 | `guest/GuestNoteComposer` → box (guest), with no visibility and the pen hidden when markup is off |
| R1 | `VideoNoteThread` / `GuestNoteItem` reply → box (reply): paperclip and Send |
| E1 | `VideoNoteThread` edit / Guest edit → box (edit): fixed visibility label, Cancel, Save; D4 lock |
| P1 | Box `phone` inside `quincy/ReviewSheet`, two rows at rest; `lib/review-pane-geometry.ts` browse stop |
| P2 | The bubble `docked` on the box's top edge |
| P3 | Phone box with range, strip and visibility, keyboard up |
| P4 | Phone `NoteDrawRow` over the canvas, keyboard down, and back up after a text tap. Needs a defined sheet mode |
| P5 | The phone colour popover with Clear under the swatches |

## Tickets (task graph; each file has exactly one owner at a time)

Every ticket is built test-first (`tdd` skill), starts from the integration branch, and merges the integration tip back in before it reports done. UI tickets follow the ReUI skill and its self-check. Detail for each ticket is in both raw plans; where they differ, this file wins.

- **T1 Media split + strip.** No blockers.
  - Owns: `lib/note-media-strip.ts` plus a Node test, `quincy/NoteMediaStrip.tsx` (`NoteBody`, `NoteMediaThumb`) plus a DOM test, and `quincy/EmbeddedImage.tsx` / `EmbeddedVideo.tsx` (a scoped `size="thumb"` variant).
  - The split is pure and never rewrites the stored doc. Cases: text only; media at the end; media mid-text in an old note; lists around media; media only; order kept; input untouched.
  - Done when the split tests and the thumb → dialog tests pass and the import stays Guest-safe.
- **T2 Editor `note` preset.** Blocked by T1, for the thumb.
  - Owns: `lib/rich-text-tiptap.ts`, `components/QuincyRichTextEditorBase.tsx`, `components/QuincyRichTextEditor.tsx`, new `reui/rich-text-editor/rich-text-format-bubble.tsx` (vendored through the sandbox per `docs/reui-reuse.md`, with an adaptation note), `quincy/Embedded{Image,Video}EditorNode.tsx`, `components/video/VideoNoteEditor.tsx`, `guest/GuestNoteEditor.tsx`, and `QuincyRichTextEditor*.dom.test.tsx`.
  - The `composer` preset (Project discussion) and `document` (Notice board) keep their toolbars.
  - Bubble: B, I, S, Link \| Bulleted, Numbered, each with `aria-pressed`; `docked` on a phone.
  - The paperclip opens the existing picker through a ref handle. Uploads, paste and drop all land at the end of the doc (an appendTransaction plugin); a stable selection order survives out-of-order completion. ⌘B, ⌘I, ⌘K, ⌘Z, ⇧⌘Z and ⌘↵ still work.
  - Done when the real-TipTap red cases pass and the discussion/document tests are unchanged.
- **T3 Box + draw row.** No blockers.
  - Owns: new `quincy/NoteComposerBox.tsx` and `quincy/NoteDrawRow.tsx` with their DOM tests, and `quincy/markup-toolbar.tsx` (new exports only: the Lightbox renders as before).
  - Presentational and Guest-safe: no `lib/api`, no form store.
  - Props cover the variant (staff/guest/reply/edit), phone/floating, the chip model, in/out (`rangeStep`, `lib/video-note-marks.ts`), attach, pen and draw controls, visibility, send, cancel/save, the field slot and the strip slot.
  - Done when the variant matrix, the radiogroup, every label, phone Clear in the popover and the 44px phone targets pass, and the Lightbox tests stay green.
- **T4 Player/stage removals.** No blockers.
  - Owns: `quincy/VideoPlayer.tsx`, `quincy/VideoStage.tsx`, `components/video/CompareView.tsx`, `VideoPlayer*.dom.test.tsx`, a new `VideoStage.dom.test.tsx`, and `VideoCompare*.dom.test.tsx`.
  - Removes the range button, the Draw transport action slot and the phone frame step. Keeps `VideoRangeHandles` and the "I O in/out" hints. Removes the picture's timecode · frame chip in every viewer.
  - Done when those tests pass.
- **T5 iPhone Full screen + dark chrome on direct review loads.** No blockers.
  - Owns: `quincy/use-immersive.ts` (the D1 iPhone branch) and its tests, `lib/video-native-player.ts` if the branch needs it, and `quincy/ShellHeader.tsx` / `quincy/RailedShell.tsx` / the shell tests for the D6 header rule (#928 has merged into the integration branch, so these files are free). `styles/app.css` too, if the rule needs it.
  - D1: on iPhone the Full screen button and F call the native handoff; a turn still enters the in-app layer.
  - D6: on a review URL, no cream sticky header paints at the top edge from first paint. Every other screen keeps its header.
  - Done when the DOM tests pass. The real-app Simulator check (staff and Guest review loaded directly: fresh, after compose and Cancel, Full screen) is the session's job in the browser pass.
- **T6 Staff composer + drawing.** Blocked by T2, T3 and T4.
  - Owns: `components/video/VideoNoteComposer.tsx`, `VideoMarkupOverlay.tsx` (`useVideoMarkup` returns `{ overlay, draw }` in place of the transport actions), `VideoNotesHost.tsx`, `VideoNotesPanel.tsx`, `lib/video-note-form-store.ts` (drop `extras`; anchor freeze), and `VideoNotes*.dom.test.tsx` / `VideoNoteComposer*.dom.test.tsx`. Rewrite those tests; don't delete them.
  - Done when the `VideoNotes.dom` end-to-end cases from the spec's table pass: three-press in/out and the chip; pen → row → ‹/Esc keeping strokes; Clear dropping the pencil; visibility reset to Internal; Send and ⌘↵; D2; no in/out or pen in the player.
- **T7 Staff reply + edit.** Blocked by T1, T2, T3 and T6.
  - Owns: `components/video/VideoNoteThread.tsx` plus its test.
  - Reply: paperclip and Send, Esc to dismiss. Edit: fixed label, Cancel/Save, three-press in/out, pen + row, and the D4 lock.
  - A click on a portaled bubble or palette doesn't seek the card (lesson: "A portaled menu's click bubbles to the card that renders it (#901)").
- **T8 Guest.** Blocked by T1, T2 and T3.
  - Owns: `guest/use-guest-compose.tsx`, `guest/guest-compose.ts`, `GuestNoteComposer.tsx`, `GuestNoteField.tsx`, `GuestNoteItem.tsx`, `GuestNotesPanel.tsx`, `GuestVideoScreen.tsx` (removals only: frame step, the toolbar slot), and the Guest compose/write/upload/item/phone/immersive tests.
  - Keeps transport injection, verification, operation fences and upload cancellation.
  - Done when `GuestNotesWrite` passes (no visibility; pen hidden when markup is off; posting) and `guest-boundary.guard` stays green.
- **T9 Full screen box.** Blocked by T6 and T8.
  - Owns: `quincy/ReviewPane.tsx` and the `*immersive*.dom.test.tsx` files.
  - The same mounted composer floats at ~560px, centred above the controls; Add note and Esc toggle it; the draft and focus survive.
- **T10 Phone sheet + safe areas.** Blocked by T5, T6 and T8.
  - Owns: `quincy/compose-strip.tsx` (delete the tray, `PillPlus`, `PillSend`, tray-only `STRIP_*`), `quincy/ReviewSheet.tsx` (no tray hold; a draw-with-keyboard mode, one mode source), `lib/review-pane-geometry.ts` (the two-row browse stop), `components/video/VideoReviewViewer.tsx`, `GuestVideoScreen.tsx` (taken over after T8), and their phone tests.
  - Done when the phone DOM tests pass, ready for the Simulator rows P1–P5.
- **T11 Docs + verify.** Blocked by T1–T10.
  - Owns: `docs/maps/*` (a notes composer entry), `docs/lessons.md` (after #928 merges, with any new lesson including T5's spike result), and `docs/plans/video-revamp-prototype-audit.md` if affected.
  - Done when `npm run verify` from `portal/` is green.

**Initial frontier:** T1, T3, T4 and T5. T2 opens when T1 merges.

## After the tickets

1. `code-review` skill on the integration branch; the fixes go to one implementer.
2. Two-stage browser pass through `serve-branch.sh`: the built-in browser for desktop and tablet; Safari on the iOS Simulator for P1–P5 (keyboard up and down, portrait and landscape, fresh load against after compose + Cancel, Full screen and the native handoff); then design-reviewer, blind, against the frames.
3. The draft PR goes ready for review. It closes #927.
