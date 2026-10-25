# #944 note composer box (post variant): frame map

Spec: #944 (Project collaboration and the Notice board on the note composer box), with the Attachments of #945 (#952, #954)
and the Link previews of #943. Prototype: `design/prototypes/note-composer/project/` (`composer.jsx`, `composer.css`), the
frames the Video note box was built from in #927 (`docs/plans/927-note-composer.md`). This maps each frame the post variant
uses to the component that renders it, for the two hosts. Frames the post variant does not use (C1, F1, C5–C7, G1, P4, P5:
the frame chip, in/out, the pen, visibility, Full screen) are Video-only and stay out of the post variant.

The two hosts:

- **Collaboration**: `portal/apps/web/src/components/ProjectDiscussionThread.tsx`. The composer is the box with
  `testId="discussion-composer-form"`; a comment's edit is the box with `testId="discussion-comment-edit"`, rendered in the
  comment's `article`. Both use the editor's `note` preset.
- **Notice board**: `portal/apps/web/src/components/NoticeBoard.tsx`. Both the new-notice box (`notice-board-composer` slot)
  and the edit box (`notice-board-edit-composer` slot) are `NoticeBox`, around the editor's `document` preset in `boxed` mode.

Every box is `components/quincy/NoteComposerBox.tsx` with `variant="post"`; the editor inside it is
`components/QuincyRichTextEditor.tsx` over `components/QuincyRichTextEditorBase.tsx`.

| Frame | What it shows | Collaboration | Notice board |
|---|---|---|---|
| R1 | The reply box: text, paperclip and round Send, no Cancel, the post variant's writing shape | Composer: `NoteComposerBox` `post` with `send` ("Post comment"); the paperclip is `attach` ("Add files") opening the editor's picker (`pickMedia`) | New notice: `NoticeBox` with `send`; same `attach` ("Add files"). `tall` (no seven-line cap, N1) and `TABLE_BAR_ROOM` above it for the docked table bar (N3) |
| E1 | Edit: Cancel and Save in place of Send | Comment edit: `NoteComposerBox` `post` with `save` (`onSave: saveEdit`, `onCancel: onEditCancel`), in the comment's `article`. Escape is left to the Project sheet (no `onEscape`, owner decision) | Edit: `NoticeBox` with `save`, in the notice's `article` |
| C2 | Empty state; Send held, with its reason as its title | `send.disabled` and `reason`: empty, `WAIT_FOR_UPLOADS`, `ATTACHMENT_RETRY_OR_REMOVE`, too long, too large (`lib/attachments-core.ts` holds the two shared lines) | The same reasons on `send` / `save`, from the same constants |
| C3 / P2 | The formatting bubble over a selection; on a phone docked to the box's top edge | `reui/rich-text-editor/rich-text-format-bubble.tsx` (`note` preset), dark per #927 D5; `bubbleDocked={phone}` and `bubbleDockTo` = `noteComposerBoxOf(field)` from `NoteComposerBox.tsx` | The `document` preset's bubble (alignment and highlight, N4) and the table bar, docked the same way (`bubbleDockTo`, `tableBarRoot` = the box's room) at every width (N3) |
| C4 | The strip of added media and file chips under the text | Photos and videos: the editor's `NoteDraftStrip` (media nodeviews drawing `NoteMediaThumb`) portaled into the box's `strip` slot (`stripContainer`). Attachments (#952): `note-draft-chip` items in the same strip (uploading, failed with Retry and Remove, ready). Link preview cards (B1): `LinkPreviewEditorNode` cards portaled into the box's `previews` slot (`previewContainer`), under the text and above the strip | Photos stay inline in the page (#944 story 13), so the strip holds only Attachments (#954) as `note-draft-chip`s (`stripContainer`). Link preview cards go to the box's `previews` slot (`previewContainer`), as on the Collaboration tab (B1) |
| P1 / P3 | Phone: the box with 44px controls; keyboard up | `NoteComposerBox` `phone` (from `PHONE_VIEWPORT_QUERY`): 44px tools, the box kept above the keyboard by `useFitAboveKeyboard` inside the box | `NoticeBox` `phone`, same box behaviour |

Tests that pin the wiring: `ProjectDiscussionThread.dom.test.tsx` ("in the note composer box (#950)", including the preview
slot of both boxes and Escape reaching the Project sheet) and `NoticeBoard-preview-slot.dom.test.tsx` (the preview slot of
both Notice boxes); the box itself is `quincy/NoteComposerBox.dom.test.tsx`, the editor's slot is
`QuincyRichTextEditor-preview-slot.dom.test.tsx`.
