## 1. Integration route

- **Merge `origin/main` into `feat/880-video-revamp` once.** Verified tips: #880 `34bf6ca1`, main `f213612e`, base `8c0940c7`; read-only `git merge-tree` reproduces the ten conflicting files and stated hunk counts.
- Preserve the seven #880 commits; resolve against main’s current structures, then add focused integration fixes. Rebasing would replay dependencies through overlapping edits; re-applying the aggregate diff loses useful history without reducing conflicts.
- Review the resulting **diff against main**, especially cleanly merged files. Conflict-free application does not establish compatibility with the new composer, search or viewport model.
- One client-only PR; preserve Compare’s existing fullscreen path. Track the reconciled reuse ledger currently only in `ledger-880.md`.

## 2. Conflicting files

Paths below are under `portal/apps/web/src/`.

| File | Main changed | #880 changed | Resolution |
|---|---|---|---|
| `components/quincy/VideoPlayer.tsx` | Single phone row, `PILL_ICON`, `PHONE_PLAY_SLOT`, band slider, current-time-only readout, paused badge, `transportHidden`; transport stays mounted during drawing. | `immersive` prop, chrome timer, overlay dock/bar/card, touch markers, Add note, native-player control methods, F shortcut. | **Main structure wins.** Reapply immersive behavior around its persistent transport; retain phone geometry outside immersive. Suppress the ordinary paused badge in immersive; render one immersive Play control. |
| `guest/GuestVideoScreen.tsx` | `viewportRoot`, ink canvas, `GuestNoteComposer`, search/filter state, scoped focus, P10 actions, decision badge and quiet footer. | Immersive state, fixed layer, focus manager, marker card, Add note, orientation and Escape. | **Main screen wins.** Reapply mode/card/trap around it; adapt viewport ownership and composer presentation below. Keep decision/download controllers and dialogs outside the action-sheet lifetime. |
| `components/video/VideoReviewHeaderMenu.tsx` | `version`, clipboard/details rows, visible labels, current row geometry and hand-offs. | Optional `systemPlayer` row and availability check. | Keep main API; add `systemPlayer`, include it in trigger/separator predicates, invoke native entry synchronously before closing. Preserve every PR 3b row. |
| `components/video/VideoReviewViewer.tsx` | Popup element callback, root viewport writer, ink canvas, search Escape/snap restoration, clipboard/details slots and header changes. | Immersive state/hook, card, Add note, header hiding, Escape rung. | **Main viewer wins.** Reapply immersive wiring into `layout(slots)` and the existing capture snapshot; retain `takePopup` state and search handling. Remove #880’s rendered keyboard style. |
| `components/quincy/ReviewActionSheet.tsx` | Popup initial focus, hidden title/Close, `ACTION_ROWS`, body-type rows, synchronous trigger focus and hand-off. | Optional disabled-row `hint` using `ItemDescription`. | Keep main chrome/constants/focus; add only the hint API with an accessible explanation. Ordinary rows retain current geometry. |
| `components/quincy/ReviewPane.tsx` | Measured grabber, `SheetModeContext`, focus/blur handling, holds, search layout and text-room budgeting. | `immersive="off\|watch\|compose"`, hidden pane/handle/strip, floating composer. | Keep main mechanics and persistent provider; add immersive presentation independently of sheet stop sizing. Do **not** restore #880’s `max-h-[60%]` cap or disable composer mode propagation. |
| `components/video/VideoNotesHost.tsx` | Clipboard controller/dialog, `onSearchChange`, filtered session and corrected open count. | `NotesSlots.immersive` containing threads/clock/timecode/readOnly/assetId. | Union both contracts; preserve main’s panel props, clipboard ownership and count calculation. Add explicit handheld presentation input where needed. |
| `components/quincy/ReviewSheet.tsx` | Holds, search mode, composer context, text-room helper and revised inert rules. | Immersive parameter to `useSheetPane`, hiding head/body during immersive compose. | Keep main mode calculation; overlay immersive visibility rules. Search must still show head/body outside immersive; immersive watch hides the whole pane, compose exposes only its composer. |
| `guest/use-guest-compose.tsx` | `GuestStrip`, `fieldHost`/`focusField`, pristine stamping, tray/upload lifecycle and `penDown`. | Exports old global `focusEditorWhenReady`. | **Take main.** Use `compose.strip.focusField`; do not resurrect global polling. Add a guarded activation command only if existing strip commands cannot preserve a draft/anchor. |
| `lib/video-note-form-store.test.ts` | `stamp`, extras lifecycle, tray Escape tests. | `beginComposer` activation tests. | Keep both describe blocks. Extend them to cover activation followed by focus stamping, existing anchors/ranges, pending writes and reopening a preserved draft. |

## 3. Semantic integration

- **Viewport:** the old “zero compose translateY in immersive” mechanism is obsolete. Keep `useVisualViewport` as sole height/transform/transition writer; retain its offset correction and `transition: none` in immersive, including keyboard dismissal settling.
- **Guest containing block:** main now deliberately transforms `GuestApp`’s column. Switch the single viewport writer to the immersive screen element while immersive, clearing the column’s styles first; restore column ownership on exit. This avoids a fixed layer constrained by a transformed ancestor. Keep notices and verification usable.
- **Rotation:** retain width-based `PHONE_QUERY` for ordinary layout and device-based detection for D14. Track viewport/ink and use handheld controls while `phone || (immersive && phoneDevice)`; landscape width must not disable keyboard correction or ink canvas.
- **Composer context:** keep `SheetModeContext` mounted; feed compose/draw mode and real tray/post holds during immersive. Add note must expose the pane in `flushSync`, pause/stamp, then focus synchronously inside the gesture. Closing hides it while preserving the draft; Cancel retains main’s discard behavior.
- **Editor identity:** main’s guest phone/desktop branches render different composer trees. Preserve one editor host across immersive transitions and rotation; test the real editor node, selection and uploads. Keep desktop presentation through props/classes around that host.
- **Composer room:** budget against visual height minus dock, safe areas, hint/tray/actions and a film floor. Adapt `useSheetTextRoom` for the floating overlay; its existing calculation does not subtract the immersive dock. Long text yields before actions disappear.
- **Search on entry:** blur/suspend hidden search without clearing its query or falsely enabling compose. Preserve the return stop; on exit restore a usable search state without asynchronously reopening the keyboard. Rotation during composition keeps the composer exposed.
- **Transport:** P1 remains Play → time → spacer → Mute → ⤢, with main’s 44px Play allocation. Immersive F1/F2 uses Play → time → spacer → Mute → **visible “Add note”**; #880 currently places Add note before Mute and hides its phone text. Override `transportHidden` during immersive compose.
- **Drawing:** keep main’s mounted slider underneath `transportReplacement`; hold chrome through confirmation/drawing, disable marker interaction then, and return Done to the same composer. Preserve Social and watermark overlays.
- **Markers:** main’s absolute marker lane now shares a 32px band with a slider whose touch area extends to 44px. Do not combine that geometry with #880’s downward 44px marker band. Give immersive marker interaction reserved space or explicit gesture arbitration; preserve thumb alignment, clusters and 22px reach.
- **Escape/focus:** snapshot layers/search first, then form draw/confirmation/tray/dirty handling, Social, card, composer, immersive, Compare, viewer. Guest capture must not close the composer while its drawing handler also consumes Escape. Return focus only to visible, non-inert targets; hidden Social/header controls need an immersive fallback.
- **Guest trap/delivery:** verify the sibling `GuestVerifyDialog` can take modal focus without fighting `FloatingFocusManager`; suspend/nest the trap appropriately and resume on return. Hide decision badge, desktop delivery row and notes quiet line in immersive; restore their current state on exit.
- **Native hand-off:** always offer the row, including feature-minimal hosts; unsupported means disabled with explanation. Handle synchronous throws/rejections visibly and verify playback-clock recovery. Story 15 explicitly includes AirPlay: temporarily remove remote-playback restrictions during hand-off and restore on failure, native exit, Version change and unmount.

## 4. Tests and gates

- Retain #880’s `immersive.test.ts`, orientation/native-player tests, `use-immersive.dom.test.tsx`, marker/card tests, `ReviewPane.immersive`, `VideoPlayer.immersive`, staff and guest immersive suites, F-key and activation tests.
- Reconcile main’s `VideoReviewViewer.phone.dom.test.tsx`, `ReviewSheet.dom.test.tsx`, `GuestVideoScreen.phone.dom.test.tsx` and `VideoPlayer.dom.test.tsx`; preserve their viewport, ink, search, row geometry and persistent-slider assertions.
- Retain composer/guest writing, `NotesFilterHead`, `VideoNotes`, guest delivery/paste and desktop header/layout regression suites. Update P9/P10 item lists for the new row without removing current actions.
- Add **real-editor identity** cases: portrait → immersive → landscape → portrait → minimise; dirty draft, selection and upload survive. Guest verification must use the actual modal/focus integration.
- Add keyboard cases for first Add note, long text + tray, draw → Done, keyboard dismissal with/without holds, search → rotation, root-target hand-off and cleanup. Assert one viewport correction and `transition: none`.
- Add marker-versus-scrub gesture cases, drawing lock, filtered marker/card consistency, D19 no playback popup, Show in notes visibility/scroll, Version-change cleanup and every Escape rung.
- Extend viewport mocks so visual viewport resizes and device orientation changes are independently controllable; do not let keyboard tests manufacture a turn.
- Guard F: roles/labels or Quincy-authored test ids, never ReUI-only `data-slot` selectors. Keep `ui-primitive-ratchet` allowlist unchanged; run design-system, phone-breakpoint, inverse-contrast, container-focus, registry and routing guards.
- Luna owns test reconciliation/non-browser QA; Sol reviews the final main-relative diff. Run focused suites, then `npm run verify` from `portal/`.

## 5. Frame map and reuse ledger

| Frame/slot | Integrated component and reuse |
|---|---|
| **P1 entry** | `VideoPlayer` existing phone row; ReUI Button/Toggle + `IconTip`; ⤢ immediately after Mute. |
| **F1 portrait** | Same `VideoPlayer`/`VideoStage` nodes; immersive top bar, scrim dock and centre Play; `ReviewSplit` floats the existing composer. |
| **F2 landscape** | Same tree; `useDeviceOrientation` + `useImmersive`, handheld control presentation and landscape safe-area gutters. |
| **F3 marker card** | `VideoTimelineMarkers` → staff/guest immersive adapter → `ReviewNoteCard`; installed `reui/item`, `InitialsAvatar`, existing note-body renderers, `IconButton` and Button. |
| **F4 native player** | P9/P10 `ActionRow` → `VideoPlayerControl.openSystemPlayer` → `video-native-player.ts`; browser owns the displayed player. |
| **P9 staff slot** | `VideoReviewHeaderMenu`/`ReviewActionSheet`; preserve details/clipboard rows, insert native row in the primary group. |
| **P10 guest slot** | `GuestVideoScreen`/`ReviewActionSheet`; native row in the primary group, above the decisions separator. |

- Reconcile `ledger-880.md` per changed element, including composer/context adaptations, marker gesture area and unsupported hint. Reuse installed components; preserve recorded searches/rejections for custom media chrome. ReUI plan: operational record detail, existing inverse viewer, dense controls with 44px touch targets, existing loading/empty/error states, opacity-only chrome fade.

## 6. Risks and owner decisions

- **“`duration-*` without a `transition-*` property animates every property, inline style writes included”**: retain root `transition: none`; browser evidence is required.
- **“Safari tints its bars from the page’s edges only after the document scrolls”**: compare fresh load with post-compose; do not add a scroll nudge or theme-color change.
- **“A phone field outside the composer needs its own keyboard layout, and iOS raises the keyboard only for a focus inside the tap”**: Add note needs both synchronous focus and a correct immersive keyboard layout.
- **“ItemGroup’s sm gap beats a plain gap-0, and an Item’s render element does not merge”**: preserve `ACTION_ROWS`; put row geometry on Item.
- **“Escape needs an order, decided before anything runs; per-Version state must not outlive its Version”**, **“A collapsed or mode-hidden pane must stay mounted…”**, and **“Touch targets: grow a 44px box toward empty space…”** govern the integration.

| Open frame/component conflict | Recommendation for owner |
|---|---|
| F1/F2 translucent 64px Play versus #880’s solid default Button and size override | Reuse main’s ink Play-badge treatment through a scoped token/size adaptation; preserve F-frame sizing. |
| F3 translucent blurred rounded card versus installed outlined Item | Keep settled Item structure and root-only content; approve tokenized media treatment or explicitly accept the opaque surface. |
| F-frame compact composer versus main’s full pill/tray/Cancel behavior | Preserve main behavior and keyboard accessibility; approve the measured floating layout rather than reintroducing clipping. |
| P9’s native row immediately after Create Review link versus PR 3b’s added details/clipboard rows | Put native immediately after Create Review link; keep details/clipboard after it and Remove below the rule. Guest native follows primary actions, before decisions. |
| F-frame marker visuals versus separate 44px touch regions | Prefer reserved immersive marker space; owner approves any measured dock-height deviation. Unsupported native hints may grow their row; ordinary rows stay 50pt. |

## 7. Browser pass

Serve the integrated ref through `serve-branch.sh`; use iPhone 18 Pro Safari via the iOS Simulator harness. Record viewport, server PID/cwd/HEAD/bundle before and after; screenshots share one folder.

| Row | Screen/state | Measurement and evidence |
|---|---|---|
| I1 | Staff + guest P1/P2 | 56pt header, single transport row, Play 44px slot, Mute→⤢ order, no overlap; portrait screenshots. |
| I2 | Staff + guest F1 | ⤢ works with no element fullscreen; header/list/badge/delivery absent; title, Exit and visible Add note fit safe areas. |
| I3 | Staff + guest playback | Time chrome disappearance at 3000ms; tap toggles chrome without toggling playback; held states remain visible. |
| I4 | Staff + guest F3 | Marker tap pauses/selects/card; scrub drag still seeks; record hit rectangles and cluster behavior; Show in notes reveals the thread. |
| I5 | Staff + guest Add note, **keyboard up** | First tap opens keyboard; stamped frame correct; film remains visible; pill/Send/Cancel above keyboard; long draft + tray fit; capture root/viewport bounds and transition. |
| I6 | Staff + guest drawing/Social | Pen hides keyboard, strokes survive, controls stay held; Done returns to same field; Social and guest watermark remain correctly aligned. |
| I7 | Staff + guest D14 | Actual Simulator rotation, initial landscape, turn-back, button-entered persistence and minimise suppression; no entry from keyboard resize alone. |
| I8 | Staff P9 + guest P10/F4 | Row order, 50pt ordinary row pitch, unsupported hint, native entry/return and failure Notice; preserve decision/download rows. AirPlay availability needs device evidence beyond Simulator entry. |
| I9 | Staff + guest focus/recovery | Escape ladder, visible focus return, guest Tab containment and verification; search before rotation; decided guest badge/quiet line restored; compare fresh/post-compose Safari bars. |
| D1 | Desktop **1280×800** | Staff + guest immersive, F key, actual element fullscreen/rejection/browser Escape, popup/toast visibility and draft identity; Compare transport/fullscreen unchanged against main. |

- Agy measures; design-reviewer inspects screenshots before reading verdicts; session verifies both. Every PASS/FAIL includes measurements and screenshot path; focus rows record `document.hasFocus()`.
- Planning only: no files changed, tests executed, commits or merge performed.