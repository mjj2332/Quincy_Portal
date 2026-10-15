# Plan

## 1. Scope and UI contract

Implement audit rows **1–11**, with Q1 and Q2 treated as settled decisions. Prototype frames govern layout, hierarchy, copy and behaviour; live tokens govern visual values.

- **Surface:** operational review.
- **Archetype:** record detail.
- **Container family:** existing viewer, ReviewSplit and ReviewSheet; Frame-based tiles.
- **Density:** existing compact controls with phone touch targets.
- **Regions:** header → flexible film → transport → notes sheet; compose replaces the lower regions with the compact strip.
- **States:** retain drafts, pending operations, upload progress, empty states and inline errors; use Skeleton loading and Retry actions where required.
- **Motion:** retain installed overlay behaviour; no new entrance animation.

Viewer changes apply to **phone review below 721px**. Desktop composer, header, transport, shortcuts, Compare and pane preferences retain their current behaviour. Shared editor changes must be opt-in.

Full screen **#880**, desktop rail **#881** and Delivery **#882** remain separate follow-ups.

## 2. Frame → component map

Paths below are relative to `portal/apps/web/src/`.

| Frame | Rendering components | Planned change |
|---|---|---|
| **P1** staff, half | `video/VideoReviewViewer`, `quincy/ReviewPhoneBar`, `ReviewSplit`, `ReviewSheet`, `video/VideoNotesPanel`, `VideoNoteComposer`, `quincy/VideoPlayer` | Correct header, edge-to-edge film, plain transport, left-aligned tabs/count, filter chips and resting composer pill. |
| **P3** collapsed | Same components; `SheetGrabber` and `useSheetPane` | Retain tabs/count and compact composer; hide and inert the notes body. Recalculate collapsed height from the changed parts. |
| **P6** compose | Same mounted composer/editor, `ReviewSheet`, `ReviewSplit`, `lib/use-visual-viewport` | Hint → pill starting with **+**, timecode, editor, pen → round Send; Cancel below. Film flexes above it. |
| **P7** draw | `video/VideoMarkupOverlay`, `quincy/VideoStage`, composer and sheet | Keyboard dismisses; outlined film, top drawing bar with stamped timecode, Undo and Done; pen remains active in the composer. |
| **P9** staff ⋯ | `video/VideoReviewHeaderMenu`, `quincy/ReviewActionSheet` | Rows-only presentation, version-specific labels, Version details entry and deliberate initial focus. Preserve action hand-offs. |
| **P2** guest | `guest/GuestVideoScreen`, `GuestNotesPanel`, `use-guest-compose`, `GuestNoteField`; shared phone bar/player/sheet | Apply the same phone presentation through guest adapters. Public notes only, no staff status dot or visibility selector; retain verification and link capabilities. |
| **P10** guest ⋯ | `GuestVideoScreen` + shared `ReviewActionSheet` | Same rows-only treatment and `Download vN`; preserve guest download eligibility and verification. |
| **T1** staff phone | `video/VideoCollectionPanel` → `VideoCard` → `quincy/VideoTile` | Sentence-case status and shared Video/count heading treatment. |
| **T3** staff desktop | Same collection/tile components; `VideoGridToolbar` | `Video` heading with quieter `N films` metadata. Preserve existing collection actions and filtering. |

## 3. Audit rows 1–11

Here, **V** means `components/video/`, **Q** means `components/quincy/`, **G** means `guest/`.

| Row | Change and files | Behaviour to preserve |
|---|---|---|
| **1 — composing** | Rebuild phone presentation in `V/VideoNoteComposer.tsx`; add an opt-in compact presentation/control seam through `V/VideoNoteEditor.tsx` and `components/QuincyRichTextEditorBase.tsx`. Update `Q/ReviewSheet.tsx`, `ReviewPane.tsx`, viewer and viewport hook. Put extras in + sheet. | Same editor and upload owner across modes; focus-time stamp; submission confirmation, pending locks, network-failure draft retention; **Cancel intentionally aborts uploads**. |
| **2 — resting composer** | Same composer: timecode inside pill, pen inside, round Send. Apply equivalent guest presentation through `G/use-guest-compose.tsx` and `GuestNoteField.tsx`. **Phone only.** | Rich document, mentions for staff, media-only notes, character limits, visibility defaults and drawing attachment. Desktop remains unchanged. |
| **3 — header** | `Q/ReviewPhoneBar.tsx`, `V/VideoPhoneApprove.tsx`, `Q/ReviewActionSheet.tsx`, guest header caller. Visible **Approve (internal)** for staff; **Approve** for guests; sentence case; plain ⋯. | Latest-version restriction, permissions, archived/pending states, status mutation menu and guest Client approval flow. |
| **4 — controls** | Scoped phone-review presentation in `Q/VideoPlayer.tsx`: ghost play/pause, current time only, mute. | Scrubbing, markers, frame accuracy, mute state and fallback frame-step controls where no composer provides them. Desktop transport and shortcuts unchanged. Full-screen control belongs to #880. |
| **5 — film** | Phone-review layout in `ReviewSplit`, `VideoPlayer`, `VideoStage`: remove surrounding inset/border; add centred paused-play affordance. | Same `<video>` node and clock, containment/letterboxing, Social preview, watermark, markup coordinates and media errors. |
| **6 — tabs** | Phone branch in `V/VideoReviewViewer.tsx`; corresponding guest Notes head. Left-aligned tabs with adjacent count chip. | `keepMounted` panels, Delivery state, count semantics, keyboard tab navigation and collapsed→half behaviour. |
| **7 — notes head** | `V/VideoNotesPanel.tsx`, `use-video-notes.ts`, `lib/video-note-view.ts`; shared presentation for guest notes. Open/count chip, Everyone chip, search; Version details moves to header ⋯. | Status/visibility filtering, marker/list consistency, selected-note navigation, pinned open edit/reply, copy/paste and **author-only** mutations. Filter semantics need the decision below. |
| **8 — action sheet** | `Q/ReviewActionSheet.tsx`, `V/VideoReviewHeaderMenu.tsx`, viewer and guest callers. Remove visible title/✕; retain accessible title; display `Download vN`, `Remove vN…`; add Version details. | Real download anchors, capability gates, export options, Copy link, Create Review link, destructive confirmation, synchronous focus return and Escape ownership. Native-player row follows in #880. |
| **9 — draw** | `V/VideoMarkupOverlay.tsx`, `Q/VideoPlayer.tsx`, `VideoStage.tsx`; guest draw adapter. Match P7’s top bar and outlined film. | Pause/confirm before drawing, frame-bound strokes/history, Undo/Redo, limits, permission gates and Done returning to the same composer. Keep desktop markup UI unchanged. |
| **10 — status case** | Local `normal-case` treatment on the status Badge in `Q/VideoTile.tsx`. | Status values, dot/tone, accessible full label and every other Badge consumer. Applies to phone and desktop tiles. |
| **11 — collection heading** | `V/VideoCollectionPanel.tsx`: `Video` plus `N films`, using the full loaded collection count. | Upload, Review links, Trash, sorting/filtering, selection and drop behaviour. Filtered totals stay in `VideoGridToolbar`; do not display an invented zero while loading. |

Across all rows, retain the existing author-only checks—including the deliberate impersonation behaviour—and existing mutation/audit paths.

## 4. Keyboard fix mechanism

### Viewport and layout

1. **Track the visual viewport throughout phone review**, rather than enabling measurement solely while an editable has focus. Update `useVisualViewport` and both staff/guest roots to follow `resize` and `scroll`, with cleanup on exit.
2. The phone viewport host uses **`visualViewport.height` and `offsetTop` once**, anchored to the layout viewport. Without that API, use the existing dynamic viewport fallback. Remove conflicting phone minimum heights; desktop sizing stays unchanged.
3. Maintain one flex column:
   - header: intrinsic, non-shrinking;
   - film: `flex: 1; min-height: 0`;
   - compose strip: intrinsic, non-shrinking.
4. During compose, hide/inert the grabber, tabs, list and browse transport. Keep their ancestry stable. Remove the compose pane’s **60% height cap** and draft-driven expansion. Do not reserve the browse transport’s height in P6.
5. The strip ends at the visual viewport bottom, immediately above the keyboard. **Do not also subtract keyboard height or add a second keyboard inset.** Safe-area padding must not double-count the obscured bottom area.
6. Treat approximately **100px as the baseline strip target**, not a hard-coded total viewport calculation. Measure its token-sized equivalent; the touch-target conflict below must be settled first.

### Focus, blur and drafts

Separate **presentation mode**, **editor focus**, **auxiliary sheet state** and **draft data**.

- On first phone focus, pause and freeze the displayed frame in the form store. Staff currently freezes the anchor on the first nonempty edit; add an explicit focus-stamp command so stepping before typing cannot silently change the point anchor.
- Preserve an existing draft’s stamp through blur, + and draw. An abandoned empty focus session may release its stamp; marks and drawings retain their existing precedence.
- Ordinary blur outside composer controls returns to the previous browse stop **without discarding the draft or remounting the editor**.
- Continue viewport measurement during keyboard dismissal. As it grows, remeasure sheet stops and collapsed content; restore transport, tabs and list in normal flow.
- Handle keyboard dismissal that retains DOM focus as a separate Simulator case: the viewport must recover without overlap, and subsequent blur must restore browse.
- Cancel remains the deliberate discard boundary: clear the store and reset the editor so its cleanup aborts uploads. Blur is never Cancel.

### The + sheet

**Recommended interaction, requiring the owner decision below:** + deliberately dismisses the keyboard and opens a modal bottom sheet.

- Capture the editor selection; mark the transition as opening extras so blur does not restore the browse sheet underneath.
- Keep the editor and uploads mounted.
- Use a small ReUI Sheet with a scrollable body constrained by available viewport room.
- Formatting commands act on the captured selection without repeatedly focusing the editor under the modal.
- Image/video picker actions remain direct user gestures and use the existing editor upload controller.
- Closing the sheet returns to + without automatically raising the keyboard. Tapping the pill resumes editing; Cancel and successful Send finish their existing operations.

## 5. Reuse ledger

All listed primitives are already installed; no registry adoption is planned.

| Element | Reuse |
|---|---|
| Viewer, flexible split and three-stop sheet | Existing Quincy `ReviewSplit`, `ReviewSheet`, `SheetGrabber`; retain their existing custom geometry rationale. |
| Header, back and version chip | `ReviewPhoneBar`, `VersionChip`, ReUI `Button`, existing Versions sheet. |
| Approve controls | Existing `VideoPhoneApprove`, `VideoReviewStatusPill` and guest decision controls. |
| ⋯ trigger | Quincy `IconButton`, using its plain treatment. |
| Composer field and rich document | Existing `VideoNoteEditor` / `GuestNoteField` → `QuincyRichTextEditorBase`, ReUI `InputGroup` and rich-text parts. |
| +, pen, Send and Cancel | Installed ReUI/Quincy buttons; pill and round geometry await the variant decision below. |
| Extras sheet | ReUI/base-nova `Sheet`, existing toggle group, buttons, rich-text toolbar controls and upload tray/controller. |
| Transport and paused play | Existing `VideoPlayer`, ReUI `Button`, `Slider`, `VideoTimelineMarkers`. |
| Tabs and count chip | ReUI `Tabs`; existing Badge-based count treatment. |
| Filter chips and search | Quincy `Menu` radio items, ReUI Button/InputGroup/Input; semantics await owner decision. |
| Action rows and separators | `ReviewActionSheet`, ReUI `Item`, `ItemGroup`, `ItemSeparator`; accessible `SheetTitle`. |
| Version details | Existing details rows and Item composition. |
| Drawing | Existing `MarkupLayer`, `StrokeVisible`, `MarkupToolbar` commands and ReUI buttons. |
| Tiles and status | Existing `VideoTile`, ReUI Frame/FramePanel and Badge. |
| Loading, empty and errors | Installed Skeleton, Quincy EmptyState/Notice and existing Retry actions. |

No new raw interactive primitives or growth of `ui-primitive-allowlist.ts`. Do not copy prototype HTML controls into application files.

## 6. Conflicts and owner decisions

These are explicit build gates for the affected elements.

| Conflict | Proposed treatment for owner review |
|---|---|
| **Pill/round geometry versus installed components** | InputGroup has a square field shape; Button lacks a round variant. Approve narrowly scoped component variants using existing tokens, rather than call-site geometry overrides or global restyling. |
| **P6 dimensions versus phone rules** | Prototype has a 40px field/send, smaller pen/Cancel and 15px input; shipped controls enforce larger touch targets and 16px phone editor text. Approve the measured token/touch-safe equivalent and its resulting strip height. |
| **Plain one-line prototype versus rich notes** | Retain one editor/document and every existing toolbar command, including commands beyond B/I/U. Approve a bounded editable viewport and attachment/progress/error presentation; do not flatten rich drafts or silently hide media. |
| **What “Everyone” means** | Prototype supplies no filter behaviour; shipped filtering is visibility, not author. Recommend an author filter plus local search over permitted note text, retaining visibility filtering in an explicitly named location. Owner must settle author/reply matching, search scope, count semantics and placement. |
| **Capabilities absent from the replacement head/P9** | Retain copy/paste, visibility filtering and other existing controls under the prototype’s “unchanged” rule. Version details relocation is authorised by Q2; exact placement of additional actions needs agreement. |
| **+ and keyboard** | Approve the dismiss-keyboard modal interaction described above, or specify keyboard-retaining accessory behaviour. |
| **P7 versus current drawing toolbar** | Current tools live below the picture; P7 places Undo/Done over it and omits other tools. Approve their retained access through compact drawing controls/+; do not remove tools silently. |
| **Initial sheet focus** | Focus the sheet container instead of the first row. Preserve visible keyboard focus; do not suppress global focus rings. If “no initial ring” includes keyboard opening, settle that accessibility distinction explicitly. |

Sentence casing in rows 3/10 is already directed: scope it to these surfaces, leaving global Button/Badge defaults intact.

Missing Full screen/native-player actions are documented #880 dependencies, not controls to add in this work.

## 7. Verification plan

### Unit and DOM

- **Viewport hook:** shrink/grow, nonzero offset, resize/scroll sequencing, blur-before-resize, missing API, cleanup and desktop disabled path.
- **ReviewSheet/ReviewPane:** compose and extras transitions; restored stop after blur; inert hidden regions; stable video/editor identity across stops, modes and breakpoint crossings.
- **Composer:** replace tests that expect focus to reveal the tall panel. Assert compact presentation and extras access.
- **Focus stamping:** focus at frame A, step to B, type, submit at A; refocus an existing draft; abandon an empty focus session; verify range/drawing precedence.
- **Real rich editor integration:** selection survives +; formatting and media target the same editor; blur/draw do not abort an upload; Cancel does; media-only notes remain postable.
- **Viewer/header:** replace “Version details is inside the phone list” expectations; verify labels, action gates, hand-offs and nested Escape ordering.
- **Notes filters:** extend `video-note-view` tests after semantics are settled; retain open-form pinning, deep links, marker consistency and author-only coverage.
- **Guest:** extend `GuestApp`, `GuestNotesWrite` and `GuestSocial` suites; preserve verification, public-only data, upload routes and `guest-boundary.guard`.
- **Tiles:** update existing title/count tests, including filtered versus total counts. Browser verification establishes rendered casing; retain selection/menu/drop tests.
- **Desktop regression:** existing composer, player keys, layout, Compare, Social, status and late-response suites.

Run targeted suites first, ReUI C1–C4 checks on changed files, design/primitive guards, then `npm run verify` from `portal/`.

### Browser pass

Phone rows run in **Safari on the iPhone 18 Pro Simulator with the actual on-screen keyboard**. Capture the prototype beside each applicable build state at matching dimensions.

| Row | Required evidence |
|---|---|
| P1/P2 half, 16:9 | Header, film, transport, tabs, chips and composer bounds; role-specific controls. |
| P3 collapsed/full transitions | Film remains visible; retained head/composer; list scroll stays local. |
| Portrait-film regression | Half-stop geometry and contained picture remain correct. |
| P6 keyboard open | Type a recognisable sentence; caret and typed text visible; strip above keyboard; film visible; page does not scroll away. |
| P6 long/rich draft | End of text remains editable; approved media/progress/error treatment fits. |
| Keyboard dismissed without Cancel | Draft retained; viewport recovers; controls and tabs do not overlap. |
| Keyboard hide retaining focus | No stranded reduced-height layout; subsequent blur restores browse. |
| + from keyboard-open state | Keyboard/sheet transition, formatting selection, visibility/range controls and return focus. |
| Upload followed by blur/draw/+ | Upload survives; Send remains held appropriately. Cancel aborts it. |
| P7 | Keyboard hidden, outlined film, correct drawing timecode, Undo/Done and return to composer. |
| P9/P10 | Rows-only sheet, version labels, pointer-open focus, keyboard navigation and action hand-offs. |
| T1 | Sentence-case status, heading/count, reachable actions and no horizontal overflow. |
| T3 at 1280×800 | Heading/count hierarchy, unchanged grid/actions/filtering. |
| Desktop review and 720/721 crossing | Existing controls/shortcuts and node identity preserved. |

Every row records measurements and screenshot paths. Record focused captures with `document.hasFocus() === true`. Serve only through `serve-branch.sh`; record server pid, cwd, HEAD and bundle before/after.

The session judges stage 1. The Opus design reviewer independently inspects every screenshot before reading those verdicts.

## 8. PR split and ownership

| PR | Scope |
|---|---|
| **1 — keyboard, composer and draw** | Rows **1, 2, 9**; viewport/layout mechanism, shared presentation seams and guest counterparts. Prioritise the keyboard defect. |
| **2 — phone chrome and notes head** | Rows **3–8**, building on PR1. Includes browse film/transport, tabs, filter head and action sheet. |
| **3 — tile corrections** | Rows **10–11**, independently reviewable. |

An **Opus builder reads the prototype source** for UI implementation, per project policy. Luna owns tests/non-browser QA; Sol owns diff review. Each PR carries its frame map and reuse ledger, and receives both browser stages.

The required independent **Opus planning review remains outstanding** because Opus was unavailable here. Settle the conflicts above and that review before building.

Installed: none; planning only.  
Motion: existing component motion; no new entrance.  
States: preserved, with compact exceptional-state presentation awaiting approval.  
Checks: source inspection only; tests and browser pass not run.  
Deviations: unresolved conflicts and Opus planning gate listed above.