# PR 2 plan: the guest phone composer (Opus)

Read at `26bcfa03`. Paths are under `portal/apps/web/src/` unless stated.

## 0. What this PR does

On the phone, the guest's notes sheet ends in the same pill strip that staff got in PR 1. The "Add a note" button and the stacked form go away on the phone. The guest page follows the visual viewport for as long as the phone screen is mounted. The Notes count becomes the number of open notes. Desktop and tablet (≥721px) keep today's form.

## 1. Frame → component map

| Frame / part | Renders it |
|---|---|
| **P2 rest**: header (back, title, version chip, Approve, ⋯) | `quincy/ReviewPhoneBar` (unchanged; it belongs to PR 3) |
| P2 film and control bar | `quincy/VideoPlayer` (`phoneFrameStep`, unchanged) |
| P2 grabber and stops | `ReviewSplit` → `SheetGrabber` (unchanged) |
| P2 tab row "Notes N" | `GuestVideoScreen` `headingContent`. N becomes **open notes** (§5) |
| P2 NotesFilter (Open · N, Everyone, search) | not built. This is PR 3 (C9/C10) |
| P2 notes list | `GuestNotesPanel` → `GuestThreadItem` (unchanged) |
| P2 composer pill (chip · field · pen, Send) | **new `guest/GuestNoteComposer.tsx`** (phone strip), with the field from `GuestNoteEditor` → `QuincyRichTextEditorBase` `pill` |
| P2 pill for an unverified guest, or while the editor chunk loads | `GuestNoteComposer`'s **shell** (same `InputGroup variant="pill"`, §3.1) |
| **P6-as-guest**: film (transport hidden) | `VideoPlayer` `transportHidden` (already wired) |
| P6 hint line | `GuestNoteComposer`, staff `PHONE_LINE` class |
| P6 + and tray | `GuestNoteComposer` + shared `ComposeTray` (`reui/collapsible`) |
| P6 pill, Send, Cancel | `GuestNoteComposer` (shared `PillSend`, `STRIP_TEXT_BUTTON` Cancel) |
| P6 keyboard box | `useVisualViewport(..., root = GuestApp's guest-column, track = phone)` (§4) |
| **P7-as-guest**: canvas and draft strokes | `use-guest-compose` `overlay` / `DraftSurface` (unchanged) |
| P7 draw tools (Undo, Done) | `use-guest-compose` `transportReplacement` (`MarkupToolbar`). C16 keeps the tools as they are |
| P7 pill with the pen pressed, placeholder "Add a note with this drawing…" | `GuestNoteComposer` (pen in `inlineEnd`) |
| **Edit own root note** | ⋯ Edit in `GuestNoteItem` → `beginEdit`. The same `GuestNoteComposer` strip: hint "Editing your note · …", Send named "Save" |

## 2. Reuse vs fork: recommendation

The guest cannot import `VideoNoteComposer`. It imports `lib/video-note-form-store` and `VideoNoteEditor`, and `VideoNoteEditor` imports `lib/api`. The boundary guard checks imports transitively.

**Recommended: share the staff-free pieces, keep a guest twin for the JSX.**

- **New `components/quincy/compose-strip.tsx`** (Quincy-owned; imports only `lib/utils`, `lib/use-scroll-fade`, `reui/*`, `quincy/ReviewSheet`, `quincy/VideoPlayer` (`PILL_ICON`) and `quincy/markup-toolbar`). It takes these **moved** out of `VideoNoteComposer.tsx`, unchanged:
  - the class constants: `PILL_CHIP`, `REST_CLAMP`, `COMPOSE_CLAMP`, `PHONE_LINE`, `STRIP_TEXT_BUTTON`, the strip grid class and `SHEET_TEXT`
  - the helpers `keepFocus` and `shortRange`
  - `useTrayKeepsFocus(trayRef)`, the native pointerdown/mousedown listener
  - `<ComposeTray open id testId toolbarRef>{controls}</ComposeTray>`: the Collapsible, the `keepMounted` region, the fade scroller, the `w-max` row, `RichTextToolbarSeparator` and the toolbar portal target
  - `<PillPlus>` and `<PillSend>`

  The staff composer imports them. **Its rendered DOM must not change.** Check this with `VideoNoteComposer.phone.dom.test.tsx` plus a before/after `outerHTML` diff in the PR verification (not committed).
- **Guest JSX** goes in `guest/GuestNoteComposer.tsx`, which reads `SheetModeContext` and sets the holds. **State** stays in `use-guest-compose.tsx`.
- **Rejected: one shared `<ComposeStrip>` that staff migrates to.** The staff file mixes its phone and desktop branches in one grid, and it took 12 rounds to tune. Restructuring it in a guest PR is risk for no guest benefit. The pieces that carry the look move; about 40 lines of grid JSX are duplicated.

**Files:**
- New: `components/quincy/compose-strip.tsx`, `guest/GuestNoteComposer.tsx`, `lib/use-ink-canvas.ts`.
- Changed: `components/video/VideoNoteComposer.tsx` (imports only), `components/video/VideoReviewViewer.tsx` (uses `useInkCanvas`), `guest/use-guest-compose.tsx`, `guest/GuestNoteEditor.tsx`, `guest/GuestNoteField.tsx`, `guest/GuestVideoScreen.tsx`, `guest/GuestApp.tsx`, `guest/GuestNotesPanel.tsx`, `guest/GuestNoteItem.tsx`, `guest/guest-compose.ts`, tests, the ledger.

## 3. Guest specifics

### 3.1 The pill at rest and the lazy editor

On the phone, `addNote` becomes `compose.strip` whenever `canWrite` is true, at every stop and in every mode. The desktop `addNote` is unchanged.

**Verified guests get the real editor mounted at rest**, as staff do. iOS raises the keyboard only for a focus made inside the tap, so a field mounted after the tap would leave the guest pressing twice. Today the editor chunk loads on the first "Add a note". It will now load when the phone screen mounts for a verified writer (flag O1).

**While the chunk loads**, `GuestNoteField` takes a `fallback` prop. The strip passes the **shell**: the same `InputGroup variant="pill"` with:
- the live chip
- the placeholder in `text-muted-foreground`
- the pen and Send, both disabled
- `aria-busy`, and sr-only "Loading the note field…"

The strip has the same height, so nothing jumps.

**Unverified guests always get the shell.** Its text area is a `reui/button` (ghost, full width, start-aligned, "Add a note…", `aria-label="Add a note"`). Pressing it does two things:
- `requestVerify("compose")`
- starts the chunk (a `preloadGuestNoteEditor()` export in `GuestNoteField.tsx`)

The continuation calls `begin({ focus: true })`. The verify dialog's `finalFocus` returns `false` for the compose continuation, so the dialog does not take focus back from the field. iOS may not raise the keyboard on a focus made after an async code check. A second tap then does (flag O2; Simulator row R3).

### 3.2 Draft lifecycle (pill model, mirrors staff)

- **Focus on the pill** (`onFocusCapture`):
  - `clock.pause()`.
  - If `!isOpen`, call `beginFromFocus()`: reset, set `marks = {in: here()}`, open. No refocus.
  - If the draft is a pristine point draft (empty text, `out === null`, no strokes, not an edit), re-stamp `marks.in = here()`. Once there is text the anchor is frozen (D10, staff `stamp` rule).
- **Blur:** the sheet returns to browse and the draft is kept. The pill shows one line ending in an ellipsis (`REST_CLAMP`), and the chip shows the draft's anchor. A **pristine draft is closed on blur**, so the chip follows the film again and the range button goes back to "Add a note to mark a range".
- **Send:** a success runs `close()` and blurs (C7). A failure keeps the draft and shows the problem line. `"post"` is a hold while the send is out.
- **Cancel:** `close()`, then bump `editorKey` (which aborts uploads, as staff), then blur. It is disabled while pending.
- `useGuestCompose` takes `phone` from the screen (PHONE_QUERY) instead of its own `compact` query.

### 3.3 The + tray (guest)

- **Contents, in one sideways-scrolling row:**
  - back one frame / forward one frame
  - Mark in / Mark out (existing guest copy and testids; flag O8)
  - Clear marks (when marks are set)
  - the drawing chip and "Remove drawing" (and the "This note has a drawing" chip in an edit)
  - the separator
  - the whole formatting toolbar (C2)
- **No visibility toggle.**
- **Frame step:** yes. In compose the transport is hidden, so the tray is the only frame step (staff parity, C14). It moves the stamp of an empty point draft (`marks.in`). Once there is text it only steps the film.
- **Hold and close:** an open tray is the `"tray"` hold. Tray state lives in the hook, and reset, close, a post, a Version change and the desktop crossing all close it.

### 3.4 Hint and problem line (`PHONE_LINE`, 12px, clamped to 2 lines)

- **New note, point:** "Paused at {tc} · the note is stamped here" (P6, with no "Internal").
- **New note, range:** "From {a} to {b}".
- **Edit:** the existing lock hint if there is one (e.g. "The frames can't change while the note has a drawing."). Otherwise "Editing your note · at {tc}" or "… · from {a} to {b}".
- **The line also shows at rest** when there is a problem, an open edit (so a blurred edit cannot pass for a new draft), or no clock yet ("Loading the film…").
- **Problem:** the hint gives way to a problem line (`role="alert"`, destructive), as staff.
- **Edit conflict:** the problem line shows, then "Latest saved version: …" clamped to 2 lines. The note row in the list already shows the full latest text (flag O7).

### 3.5 Send vs "Post note" / "Save"

- **Phone:** a round icon Send (`size="icon-round"`, lucide `Send`).
  - `aria-label` is "Post note" / "Posting…" for a new note and "Save" / "Saving…" for an edit, with a `Spinner` while pending.
  - Disabled while: `pending`, the pen is down (`phase !== "off"`), an upload is out, or the text is empty.
- **Desktop:** unchanged ("Post note" / "Save", enabled when empty, the "Write a note first." message). This divergence is flag O13.

### 3.6 Edit flow entering the strip

- **⋯ Edit on the guest's own root note:**
  1. `writing.editRoot(thread)` → `beginEdit`.
  2. On the phone, focus the mounted pill field **synchronously inside the menu item's click**, so the keyboard rises.
  3. That root's `Menu` gets `finalFocus={() => (phone ? false : undefined)}`, so Base UI does not hand focus back to ⋯.
- **Content:** the edit doc lands through the editor's existing external `setContent` sync. After it applies, put the caret at the end.
- **Blocking:** Edit stays disabled while another draft is open (`composerOpen`).
- **Pen label:** the pen's `aria-label` follows `drawLabel` (Draw / Edit drawing / Redraw).

### 3.7 Pen (P7)

- **Where:** the pen is in `inlineEnd` when `markupAllowed`. It uses ghost `reui/button` + `PILL_ICON` + `SELECTED_HAIRLINE_PRESSED`, with `aria-pressed` while drawing.
- **Pressing it:** closes the tray, blurs, and calls `startDrawing`. Pressing it again is Done and refocuses the field inside the tap (`focusEditorWhenReady` runs its first check synchronously).
- **Fix:** the sheet's mode is `"draw"` while `phase !== "off"` (confirming **or** drawing). Today it is `phase === "drawing"` only, so the sheet would flash back to its browse stop during the frame confirm. Expose `penDown` from the hook.

### 3.8 Rows the pill displaces (phone only)

- **"Copy my notes from another version":** a ghost button in the Notes tab's top row (the phone `deliveryRow`), with the paste status line right after it.
  - This is the staff analogue of its paste Notice in the list head.
  - Alternative: a ⋯ row per C11. P10 does not show one (flag O3).
- **Identity ("Reviewing as … / Not you?") and the email-updates switch:** on the phone they move to the end of the list's scroll region, after the last thread or the empty state. They no longer sit as a fixed band between the list and the pill. `GuestNotesPanel` gets `footerInList` (flag O4).
- **Composer wrapper in `GuestNotesPanel`:** take staff's classes:
  - at rest: `border-t` + `pt-[var(--space-3)]`
  - in compose: `flex min-h-0 shrink flex-col`, no border, no top padding
  - drop `-m-1 p-1 overflow-y-auto` on the phone
- **Pane padding in compose:** keep the side `--space-4` and tighten top and bottom as `VideoNotesPanel` does.

## 4. Keyboard mechanism

**Driving the box:**
- `GuestVideoScreen` calls `useVisualViewport(phone && sheetControl.composing, () => { if (!sheetControl.held) blurComposerField(); }, viewportRoot, phone)`. The guest page then follows the visual viewport whenever the phone screen is mounted, not only in compose (PR 1 r5).
- The hook alone writes `height`, `transform` and `transition: none`. Drop the screen's inline `style`, `data-keyboard`, and the column's `has-[[data-keyboard=true]]:min-h-0`.

**The root is GuestApp's `guest-column`, not the screen.**
- `GuestApp` takes the column through a callback ref into state and passes `viewportRoot={column}`, an element not a ref (lesson: a ref object never re-runs the effect).
- The column is the document's top element (document y = 0), so `translateY(offsetTop)` is exact on a page that is a document rather than a fixed dialog.
- It also holds the archived notice and the grants-changed notice ("That video was updated by the studio…"). That notice can show while composing. With the screen as the root, the notice would push the strip into the keyboard by its own height.

**Document classes:**
- Phone column: `flex h-dvh flex-col overflow-hidden`. The hook's inline height overrides `h-dvh`, which stays as the no-`visualViewport` fallback. `min-h-dvh` must go on the phone: a min-height would beat the shrunken height and leave Cancel behind the keyboard.
- Phone screen root: `flex min-h-0 flex-1 flex-col`.
- Desktop: the column `h-dvh` and the screen `min-h-0` give the same computed result as today.
- The document never scrolls at rest. iOS's own keyboard scroll is put back by the hook, which also restores `scrollY` on settle.

**Delivery row:** on the phone it is the sheet's body part, so compose mode hides it with `inert` and it never competes with the strip. Desktop is unchanged.

**Ink canvas:** move `INK_CANVAS_ATTR` and the effect from `VideoReviewViewer` into `lib/use-ink-canvas.ts` (`useInkCanvas(on)`). The viewer and the guest screen (`useInkCanvas(phone)`) both use it. Without it, the band iOS shows while it scrolls back as the keyboard drops is cream. Side effect: a direct phone load of a video link may tint Safari's bars ink (flag O6).

**Recovery when the keyboard is dismissed without Cancel:**
- A blur → `ReviewSplit`'s blur check ends compose. The draft is kept and the editor stays mounted.
- No blur (some iOS paths): `onKeyboardGone` blurs unless a hold is on.
- Holds (tray, post) keep the strip on the full-height root with Cancel reachable.
- The hook keeps following the viewport while the keyboard animates away.

**Other fields:** replies, reply edits, and the verify, decision and paste dialogs now see a shrunken root while their keyboard is up. This is the same as staff since r5 and gets a Simulator row (R14).

**Leaving:** All videos, a Version change, or the desktop crossing makes the hook clean up and clear its three styles, and the column turns back to `contents` for the list.

## 5. Open-note count (C19 / D22)

- Add `openThreadCount(threads)` to `guest/guest-compose.ts`: `threads.filter(t => !t.resolved && (!t.deleted || t.replies.length > 0)).length`.
  - This is the server's `OPEN_ROOT` rule (`workers/app/src/lib/video-version-summaries.ts`, `guest-review.ts` `publicNoteCount`).
  - The guest list is public-only, so public is implicit.
  - Resolved threads do not count. A tombstone that kept replies counts. An empty tombstone does not. Replies never count.
- The count is used in `headingContent`, so the phone tab and the desktop heading both change. W3 also shows the open count, but this is a desktop behaviour change (O5).
- Add sr-only " open" after the number. The test that asserts `"Notes 1"` needs updating.
- Show 0 like the staff tab does. D22's "hidden at 0" reads as a tile rule (O5).

## 6. What is phone-only

Phone means `PHONE_QUERY` (<721px):
- the strip and the shell
- the tray
- the pill props on `GuestNoteEditor`
- the compose and pristine-release behaviour
- the pen in the pill and the `penDown` draw mode
- the Send rules
- the placement of Copy notes, paste status and the footer
- synchronous focus on Edit and Menu `finalFocus=false`
- the column root and classes, viewport tracking, and the ink canvas

The desktop form (`use-guest-compose` `form`), "Add a note", the top-slot paste row, the footer under the list and the 60% composer cap are byte-unchanged. **Exception:** the heading count rule (O5).

Crossing 721px while composing swaps trees. The draft survives in the hook (text, marks, strokes). Uploads in flight are aborted (O9).

## 7. Reuse ledger and allowlist

| Element | Where | Uses |
|---|---|---|
| Shared strip pieces | `quincy/compose-strip.tsx` | Moved from `VideoNoteComposer` unchanged (classes, `keepFocus`, `shortRange`, `ComposeTray` = `reui/collapsible` + `useScrollFade` + `RichTextToolbarSeparator`, `PillPlus`, `PillSend` = `reui/button` `icon-round` + `reui/spinner`) |
| Guest pill (field) | `GuestNoteEditor` → `QuincyRichTextEditorBase` | Existing `pill`, `pillWrap`, `inlineStart`/`inlineEnd`, `toolbarContainer`, `contentClassName`, `contentAttributes`; `reui/input-group` `variant="pill"` |
| Pill shell (unverified or loading) | `GuestNoteComposer` | `reui/input-group` `variant="pill"` + `InputGroupAddon` + ghost `reui/button` (O10) |
| Timecode chip | `GuestNoteComposer` | Shared `PILL_CHIP` span (anchor, short range, pencil when merged) |
| + / tray / toolbar | `GuestNoteComposer` | Shared `PillPlus`, `ComposeTray` |
| Frame step, Mark in/out, Clear marks, Remove drawing (tray) | `GuestNoteComposer` | Existing `reui/button` usages from the guest form, moved; `min-h-11` hit target |
| Pen | `GuestNoteComposer` | Ghost `reui/button` + `PILL_ICON` + `SELECTED_HAIRLINE_PRESSED` (the staff P7 treatment) |
| Hint and problem line | `GuestNoteComposer` | `<p>` / `div role=alert` in `PHONE_LINE` |
| Send | `GuestNoteComposer` | Shared `PillSend` |
| Cancel | `GuestNoteComposer` | `quincy/Button variant="text"` + `STRIP_TEXT_BUTTON` + `keepFocus` |
| Copy my notes (phone), paste status | `GuestVideoScreen` delivery row | Existing ghost `reui/button` and status `<p>`, moved |
| Footer in the list (phone) | `GuestNotesPanel` | Existing rows, moved inside the `ScrollArea` |
| Keyboard box, ink canvas | `GuestApp`, `GuestVideoScreen`, `lib/use-ink-canvas.ts` | No UI |

**`config/ui-primitive-allowlist.ts` is unchanged.** Nothing adds a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<dialog>`. The tray's `role="region"` is a landmark on `CollapsibleContent`, as in PR 1.

`guest-boundary.guard.test.ts` must stay green: `compose-strip.tsx` imports nothing that reaches `lib/api`. Run the guard after the move.

## 8. Conflicts for the owner (do not resolve silently)

- **O1.** The editor chunk now loads on screen mount for every verified writer on a phone. This is the price of a first tap that raises the keyboard.
- **O2.** For unverified guests, the shell opens verify. After the code, iOS may not raise the keyboard (no tap gesture), so a second tap is needed.
- **O3.** Where "Copy my notes from another version" goes on the phone: the Notes tab top row (recommended) or a ⋯ row (C11 for staff, but not in P10).
- **O4.** Identity and email-updates rows move to the end of the list's scroll on the phone. P2 shows neither.
- **O5.** The desktop heading count becomes open notes (W3 conformant, but a desktop change). Also: show 0 or hide it at 0?
- **O6.** The ink canvas on the guest phone page may tint Safari's bars ink on a direct load. This overlaps PR 3. The fallback is to skip it and accept a cream band as the keyboard drops.
- **O7.** In an edit conflict, "Latest saved version" is clamped to 2 lines in the strip.
- **O8.** Tray copy: guest "Mark in / Mark out" or staff "Set in / Set out"?
- **O9.** The 721px crossing remounts the guest editor (draft kept, uploads lost). Staff keeps one node.
- **O10.** `InputGroup` holding a button rather than an input, for the shell.
- **O11.** The guest delivery row (chips, Request changes, Download all) stays at the top of the Notes tab. It is not in P2 and is left for PR 3.
- **O12.** A guest PR touches the staff composer file (an import-only move, with no DOM change).
- **O13.** Send on the phone is disabled when the text is empty. Desktop "Post note" stays enabled and shows its message.

## 9. Tests

### DOM tests

- **`guest/GuestNotesWrite.dom.test.tsx`, "the phone sheet composer":** rewrite the two "Add a note" phone tests and add:
  1. A verified guest's sheet ends in the pill (chip, editor, pen, Send disabled) at collapsed, half and full, and there is no `guest-add-note`.
  2. An unverified guest sees the shell. Tapping it opens verify and starts the chunk. After the code, the draft has begun and the field has focus. The dialog's `finalFocus` does not steal that focus.
  3. Focus puts the pane in `data-mode=compose`, pauses the film, shows the hint with the stamp, and shows + and Cancel.
  4. Blur keeps a draft with text (ellipsis at rest), and a pristine draft is released.
  5. + is `aria-expanded`/`aria-pressed`. An open tray holds compose after a blur. A pointerdown in the tray is default-prevented. Frame step moves the stamp only on an empty draft. Mark in/out work. The toolbar is portalled into the tray.
  6. Send is disabled when the text is empty. A post holds compose until it settles. Success → browse with the note listed. Failure keeps the draft and shows the problem line.
  7. Cancel discards text, marks and the drawing, and remounts the editor.
  8. The pen blurs. Mode is `draw` during the frame confirm and while drawing. The pen is `aria-pressed`. Pressing it again is Done and refocuses.
  9. Edit from ⋯ fills the pill. The hint reads "Editing your note". Send is labelled Save. The field is focused in the click and ⋯ does not regain focus. Save sends the patch.
  10. The chunk's loading state renders the shell (`aria-busy`).
  11. On the phone, the footer rows are inside the list's scroll, and Copy notes and paste status are in the Notes tab top row.
  12. A Version change closes the draft.
- **Desktop describes in the same file:** unchanged, and must stay green.
- **New `guest/GuestVideoScreen.phone.dom.test.tsx`:** modelled on `VideoReviewViewer.phone.dom.test.tsx`, with `visualViewport` stubbed. Cases:
  - the column follows the viewport from mount, before any focus, with `transition: none`
  - the keyboard going away without a blur ends compose, unless the tray holds it
  - the styles clear on All videos and on crossing to desktop
  - `html[data-ink-canvas]` is set on the phone and removed on leave
  - a grants-changed notice above the screen still leaves the strip inside the box
- **`guest/GuestApp.dom.test.tsx`:** the open count (resolved not counted; a tombstone with replies counted; an empty tombstone not; replies not), on both the phone tab and the desktop heading. Update `"Notes 1"`.
- **`guest/guest-compose.test.ts`:** a unit test for `openThreadCount`.
- **Must stay green:**
  - `VideoNoteComposer.phone.dom.test.tsx` and `VideoReviewViewer.phone.dom.test.tsx`, after the move
  - `guest-boundary.guard.test.ts`
  - `ui-primitive-ratchet.guard.test.ts`
  - `design-system-guards.test.ts`
  - `npm run verify`

### iOS Simulator rows

Each row is a phone shot with its measurement, checked against the named frame.

- **R1 (P2):** verified guest at half, collapsed and full. Pill at the foot, live chip, open count matches the fixture.
- **R2 (P2):** unverified shell. Tap → verify dialog, keyboard up for the code.
- **R3 (P6):** verify-then-compose. Record whether the keyboard rose; one more tap raises it.
- **R4 (P6):** tap the pill → keyboard. Hint, pill and Cancel above the keyboard, header visible, film ≥96px, no flash or cream band.
- **R5 (P6):** typed text visible and the caret in the pill.
- **R6 (P6):** a 3–4 line draft wraps (`--radius-lg`, addon row underneath), and the film floor holds.
- **R7 (P6):** + tray open with the keyboard still up. The row scrolls, Mark in/out and frame step work, bold applies.
- **R8 (P7):** pen → keyboard down, canvas, tools. Pen again or Done → back to compose with the keyboard.
- **R9 (P6):** edit own note from ⋯. Keyboard up with the text, "Editing your note", Save works.
- **R10 (P6 → P2):** Cancel. Back at rest, Safari bars recorded against a fresh load.
- **R11 (P2):** blur recovery. Dismiss the keyboard by tapping the film or the keyboard's dismiss → browse stop, first line with an ellipsis. A tap resumes the draft.
- **R12 (P2):** Send → note listed, strip at rest.
- **R13 (P6):** a notice row present while composing (if it can be produced) → strip still above the keyboard.
- **R14 (P2):** a reply in the list with the keyboard up → field visible.
- **R15 (W3):** desktop and tablet in the built-in browser. Form unchanged, heading shows the open count.
- **R16:** fresh direct load of a single-video link. Safari bar colour recorded for O6.

## Conclusion

**Decision:**
- Share the staff-free strip pieces through a new `components/quincy/compose-strip.tsx`. This is a move with no DOM change for staff.
- Build the guest strip as `guest/GuestNoteComposer.tsx`, with its state in `use-guest-compose.tsx`.
- Mount the real editor in the pill at rest for verified guests. Unverified guests get a pill-shaped shell that leads to verify.
- Drive the keyboard box on GuestApp's `guest-column`, with `track = phone`.
- Count open public root threads with the server's `OPEN_ROOT` rule.

**Why:**
- The guard forbids reusing the staff composer whole.
- Restructuring the shipped staff JSX is not worth the risk.
- A field that is already mounted is the only reliable way to raise the iOS keyboard on the first tap.
- Driving the column keeps the strip above the keyboard even with notices shown.

**Next:**
1. The session takes O1–O13 to the owner (O3, O5 and O6 first).
2. ui-builder builds from this plan and the P2/P6/P7 frame sources.
3. Run the §9 DOM tests and `npm run verify`, then rows R1–R16, then design-reviewer.

Plan inputs: `/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/.claude/worktrees/fix-revamp-guest-compose-98fea1/docs/plans/revamp-fix-pr2-brief.md`. The plan goes to `.../docs/plans/revamp-fix-pr2-opus.md`.