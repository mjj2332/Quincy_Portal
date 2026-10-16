# #880 Full screen — resume on main after the revamp fix (settled 2026-10-16)

Session synthesis of two blind plans (Opus: `880-resume-opus`, Codex: `880-resume-codex`) for
porting `feat/880-video-revamp` (tip `34bf6ca1`, base `8c0940c7`) onto `origin/main` `f213612e`
(revamp fix PR 1–3b). The original settled #880 plan (issue comment, 2026-10-14) still holds
except where this file overrides it. Paths under `portal/apps/web/src/`. Prototype:
`design/prototypes/video-review-revamp/project/` (F1–F4; P1, P9, P10 slots).

## Owner decisions (2026-10-16)
1. **Full screen composer on a phone = the P6 compose strip** (not F1's bare pill). Immersive
   compose provides `SheetModeContext` `{mode:"compose", setHold}`.
2. **Native-player row order:** staff ⋯ directly after Create Review link (before Version details,
   Copy shown notes, Paste); guest ⋯ after Download vN / Download all…, before Copy my notes….
3. **AirPlay allowed during the hand-off:** `VideoStage` keeps `disableRemotePlayback` and
   `controlsList="nodownload noremoteplayback"` normally; `openSystemPlayer` lifts the
   remote-playback restriction (attribute + the `noremoteplayback` token only — `nodownload` and
   PiP stay) for the hand-off and restores it on `webkitendfullscreen` / `fullscreenchange` exit,
   on failure, on Version change and on unmount.
4. **F3 card width = a new named 420px token** (no raw value; design-system guards stay green).

## Route
Merge `origin/main` into `feat/880-video-revamp` (no rebase, no re-apply).
- **Commit M:** the merge, mechanical resolutions only, main's structure wins; green on `tsc` and
  the conflicted files' tests.
- **Commits S1–S7**, one concern each with its tests (below). Sol reviews `git diff origin/main...HEAD`.

## Per conflicting file (main wins unless stated)
- `quincy/VideoPlayer.tsx`: keep main's P1 tree (PILL_ICON, PHONE_PLAY_SLOT, band slider, markers
  lane, PLAY_BADGE, transportHidden, mounted transport under a replacement). Add
  `handheld = phone || (immersive && phoneDevice)` and use it wherever main styles by `phone`.
  Drop #880's `video-immersive-play`; the centre badge is main's PLAY_BADGE inside the chrome fade.
  ⤢ uses PILL_ICON when handheld, keeps `data-testid="video-fullscreen"`, sits after Mute (P1).
  Immersive dock row: Play → time → spacer → Mute → **visible "Add note"** (drop `max-[721px]:sr-only`).
  `transportHidden` is ignored while immersive.
- `video/VideoReviewViewer.tsx`: main's `useVisualViewport` / popup-callback / search handling;
  delete #880's `keyboard` return and DialogContent `style` (the hook is the sole writer). Header
  menu: main's props + `systemPlayer`. Phone header wrapped `hidden`+`inert` in immersive.
  `toggleAddNote` uses `forms.stamp(assetId, frame)`.
- `guest/GuestVideoScreen.tsx`: main's screen; #880's immersive wrapper (FloatingFocusManager,
  `data-immersive`, `fixed inset-0`) without `h-dvh` / `data-keyboard` / inline style. The
  header-hide wrapper encloses the bar, **delivery row and decision badge**; the notes quiet line is
  hidden in immersive and restored after.
- `video/VideoReviewHeaderMenu.tsx`: main's; add `systemPlayer` row per decision 2; include it in
  the null-guard and separator predicates; native entry runs synchronously before the sheet closes.
- `quincy/ReviewActionSheet.tsx`: main's; re-add optional `hint` as `ItemDescription`, wired with
  `aria-describedby` (not in the accessible name). Geometry stays on the Item (`ACTION_ROWS`).
- `quincy/ReviewPane.tsx`: main's mechanics + #880's `full` branches; never restore `max-h-[60%]`.
- `quincy/ReviewSheet.tsx`: `hide = (active && main's rule) || (immersive==="compose" && (head||body))`.
- `video/VideoNotesHost.tsx`: `NotesSlots` carries both `immersive` and `clipboard`.
- `guest/use-guest-compose.tsx`: main's; use `compose.strip.focusField()`; no `focusEditorWhenReady`.
- `lib/video-note-form-store(.test).ts`: main's; **delete `beginComposer`**, use `stamp`.

## Semantic commits
- **S1 viewport + ink.** Retire "zero translateY in immersive" (it is main's fix-r8 keyboard
  correction). Both screens: `useVisualViewport(handheld && (composing || searching || (imm &&
  composeOpen)), gone, root, handheld)` and `useInkCanvas(handheld)`, so a landscape iPhone (844pt,
  `phone` false) is tracked. Keyboard gone in immersive → blur the field, composer stays shown.
  Guest: the column keeps the hook's transform and the immersive root's `fixed inset-0` resolves to
  the column (the visual-viewport box) — comment + test; if the Simulator shows the layer clipped,
  stop and report. Fades name `transition-opacity` only.
- **S2 dock.** One always-rendered wrapper around [replacement, transport] (`contents` outside
  immersive, overlay classes inside); never choose between two nodes (no slider remount).
  `--immersive-controls-h` measured from the wrapper.
- **S3 markers.** `touch` grows the 44px band **up** into the dock's scrim (`before:bottom-0
  before:h-11`), drop `mb-[--space-6]`, only when handheld; track-centre pointerdown still scrubs.
- **S4 composer.** Immersive compose provides the compose `SheetModeContext` (decision 1), so the
  stamp give-back effect cannot eat Add note's stamp; Add note = `flushSync(show)` → stamp →
  synchronous focus inside the tap (staff editor; guest `strip.focusField()`).
- **S5 entry from sheet modes.** A turn mid-compose enters immersive compose with the same editor
  node, focus and keyboard. A turn mid-search blurs search and `onSearching(false)` (query kept).
  A marker tap never changes the sheet stop (D19).
- **S6 menus.** Rows per decision 2; guest `sheetHasActions` counts the system row. Label "Open in
  iPhone player" on iPhone/iPod UA, else "Open in system player"; unsupported = disabled + hint.
- **S7 AirPlay hand-off** per decision 3, with tests for every restore path.
- **Card token** (decision 4) lands with S2 or its own commit.
- Guest trap vs `GuestVerifyDialog`: confirm the dialog's field takes focus on an unverified Add
  note; if not, disable the trap while `verifyOpen`.

## Tests
- Update #880 suites: `VideoPlayer.immersive` (play badge, mounted transport, visible Add note,
  PILL_ICON ⤢, upward band), `VideoReviewViewer.immersive` (stamp, no DialogContent style, hook
  writes at 844×390 with a phone device, compose strip), `GuestImmersive` (focusField, column
  transform, header-hide holds delivery/badge, ⋯ row, watermark), `ReviewPane.immersive` (modeValue).
- Reconcile main: `VideoReviewViewer.phone.dom.test` rowNames gains the system row after Create
  Review link; `GuestVideoScreen.phone.dom.test` row/⋯-absent assertions; `VideoPlayer.dom.test`
  no-host cases unchanged; `ReviewSheet.dom.test` with `immersive="off"`; composer phone suites
  unchanged as guards.
- New: (a) turn mid-compose keeps editor node + focus; (b) turn mid-search; (c) landscape
  phone-device Add note gets viewport writes + ink canvas; (d) empty immersive composer gives the
  stamp back; (e) band: centre pointerdown seeks, tap above a marker opens the card; (f) guest ⋯
  with only the system row; (g) unverified guest Add note focuses the verify field; (h) AirPlay
  restriction lifted on hand-off and restored on exit / failure / Version change / unmount.
- Guards: test-seam guard F (Quincy test ids, no vendor `data-slot`), ui-primitive-ratchet
  (allowlist unchanged), design-system-guards, phone-breakpoint, ADR 0024 inverse, guest
  inverse-contrast, container-focus, routing-transport. Then `npm run verify`.

## Frame → component map
- **P1** ⤢ after Mute in the single row (PILL_ICON). **F1** `ReviewSplit immersive=watch|compose`;
  `VideoPlayer[data-immersive]`: `video-immersive-bar` (⤡ + title · vN), `VideoStage` + PLAY_BADGE,
  dock wrapper (band, `VideoTimelineMarkers touch`, Play/time/Mute/Add note); composer = P6 strip
  in the floating pane. **F2** same tree, `readPhoneDevice` + `useDeviceOrientation`, safe-area
  gutters. **F3** `ReviewNoteCard` via `VideoImmersiveNoteCard` / `GuestImmersiveNoteCard`.
  **F4** `lib/video-native-player.ts` via the P9 / P10 `ActionRow`.
- Still open for the owner, reported in the PR: the disabled row's hint (in no frame); the centre
  badge in desktop immersive (in no frame); landscape-with-keyboard layout (~150pt) — measure in
  S10 first, and only if composer + dock overflow, hide the dock row while the field has focus.

## Browser pass (iOS Simulator iPhone 18 Pro Safari, staff + guest; desktop 1280×800)
Staff S1–S13, guest G1–G8, desktop D1–D6 as in `880-resume-opus` §7, plus Codex's I3 (tap toggles
chrome without toggling playback), I8 (AirPlay row/hand-off; AirPlay availability needs a device
beyond the Simulator) and I9 (Escape ladder, focus return, guest Tab containment). S12 compares a
fresh load with post-compose bars and expects cream on a fresh load (lesson "Safari tints its
bars…" — parked, not a defect).
