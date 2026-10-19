Answers: where the Video note composer lives (#927), what renders a note box on staff and Guest, how the phone sheet's single mode reaches it, and how iPhone Full screen hands the film to the system player.

One box, five callers: `quincy/NoteComposerBox` is the only note/reply/edit surface. A caller passes variants (new note, reply, edit, guest), a field, and controls; the box owns the layout, the visibility menu, the anchor chip and the keyboard-safe rows. Prototype: `design/prototypes/note-composer/project/`. Plan: `docs/plans/927-note-composer.md`.

## Parts
| What | Where |
|---|---|
| The box (variants new / reply / edit / guest, `phone`, `floating`) | `NoteComposerBox` portal/apps/web/src/components/quincy/NoteComposerBox.tsx:113, props `NoteComposerBoxProps` portal/apps/web/src/components/quincy/NoteComposerBox.tsx:70 |
| Draw row (‹ Done, tool radiogroup, colour popover, Undo / Redo / Clear); replaces the box's tool row while drawing | `NoteDrawRow` portal/apps/web/src/components/quincy/NoteDrawRow.tsx:68; sizes `NOTE_TARGET` / `NOTE_TARGET_PHONE` in the same file |
| Note body and draft media | `NoteBody` portal/apps/web/src/components/quincy/NoteMediaStrip.tsx:13, `NoteMediaStrip` portal/apps/web/src/components/quincy/NoteMediaStrip.tsx:22, `NoteMediaThumb` portal/apps/web/src/components/quincy/NoteMediaStrip.tsx:29 (both renderers, staff and Guest, use `NoteBody`) |
| The `note` editor preset: no field chrome (the box draws it), media at the end in the order chosen, `ref` handle (`pickMedia`, `focus`), `stripContainer` (where draft chips portal, the box's strip slot), `bubbleDockTo` / `bubbleDocked` (phone) | `isNote` portal/apps/web/src/components/QuincyRichTextEditorBase.tsx:253, `stripContainer` portal/apps/web/src/components/QuincyRichTextEditorBase.tsx:200 |
| Format bubble (dark) over the installed `RichTextBubbleBar` | `components/reui/rich-text-editor/rich-text-format-bubble.tsx` |

## Who feeds the box
| Caller | Where |
|---|---|
| Staff new note | `VideoNoteComposer` portal/apps/web/src/components/video/VideoNoteComposer.tsx:39, in `VideoNotesPanel` at every width |
| Staff reply / edit | `VideoNoteThread` portal/apps/web/src/components/video/VideoNoteThread.tsx:27 |
| Staff drawing canvas (pen, draw row) | `VideoMarkupOverlay` portal/apps/web/src/components/video/VideoMarkupOverlay.tsx:9 |
| Guest new note | `GuestNoteComposer` portal/apps/web/src/guest/GuestNoteComposer.tsx:28 (no visibility; the pen hidden when markup is off) |
| Guest reply / edit | `GuestNoteItem` portal/apps/web/src/guest/GuestNoteItem.tsx:3 |
| Guest compose state | `use-guest-compose` portal/apps/web/src/guest/use-guest-compose.tsx:108 |
Both screens feed the same controls (range marks, send / save with a `reason`, attach, pen); the box never reads a form store itself.

## One mode source on the phone
- `sheetMode` portal/apps/web/src/components/quincy/ReviewSheet.tsx:31 computes `browse | compose | draw | search` once (pen, field focus, the composer's hold, search); `useSheetMode` portal/apps/web/src/components/quincy/ReviewSheet.tsx:85 returns it on the control. A screen never overrides it.
- `ReviewSplit` hands it to the box through `SheetModeContext` portal/apps/web/src/components/quincy/ReviewSheet.tsx:101 (`{ mode, setHold, floating? }`). `null` outside a phone sheet: the box is the desktop form. Lesson: "A layout switched by two flags will disagree…".
- Browse stop: `portal/apps/web/src/lib/review-pane-geometry.ts` (`sheetStops`, `PHONE_QUERY`).
- Full screen compose floats the box (`floating`), centred, about 560px, in `ReviewPane` portal/apps/web/src/components/quincy/ReviewPane.tsx:213; not on iPhone.

## iPhone Full screen hands over (D1)
- `useImmersive` portal/apps/web/src/components/quincy/use-immersive.ts:33 takes `handoff`, called synchronously inside the press on iPhone instead of entering the in-app layer. Notes, drawing and Add note are not there. A rotation ("turn") is no user gesture, so it still enters the in-app layer.
- The test is `fullScreenHandsOver` portal/apps/web/src/lib/video-native-player.ts:71; the open is `openNativePlayer` portal/apps/web/src/lib/video-native-player.ts:57 via the player's `openSystemPlayer` portal/apps/web/src/components/quincy/VideoPlayer.tsx:302 (it keeps the play-first guard and the refusal notice).
- Wired by `handoff: () => playerRef.current?.openSystemPlayer?.()` in `VideoReviewViewer` portal/apps/web/src/components/video/VideoReviewViewer.tsx:207 and `GuestVideoScreen` portal/apps/web/src/guest/GuestVideoScreen.tsx:192.
- Safari tint on a direct film load: `ProjectSheet` sets `data-surface="inverse"` while the URL names a film (`filmOpen`) portal/apps/web/src/components/quincy/ProjectSheet.tsx:202. Lesson: "The Safari tint comes from the sticky or fixed element at the top edge at first paint (#927 T5)".

## Gates
`portal/apps/web/src/components/quincy/orphan.guard.test.ts` (a shared component lands with its first importer), `portal/apps/web/src/config/ui-primitive-ratchet.guard.test.ts` (no new raw controls), `design-system-guards.test.ts`. jsdom raises no keyboard: the iOS Simulator pass covers P1 to P5 with it up.

Last verified against 647cc09d
