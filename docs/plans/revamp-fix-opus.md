# Plan (Opus) — bring the phone review (#879) and tiles (#884) to the prototype

Checkout read: `/Users/tingruilee/quincy-wt/revamp-spec` at e33c7d7a. Paths below are under `portal/apps/web/src/` unless noted.
Prototype read in full: `mobile.jsx`, `kit.jsx`, `tiles.jsx`, `quincy.css`, `Video Review Revamp.html` (frames + D1–D37).
Plan only; nothing built.

---

## 0. Root cause of the keyboard bug (what the fix must remove, not paper over)

Three things combine. All three are fixed; the first is the one that hides typed text.

1. **The compose sheet clips the editor.** `ReviewSplit` gives the phone sheet `data-[mode=compose]:max-h-[60%]` with `overflow-hidden`
   (`components/quincy/ReviewPane.tsx` ~209). The engaged phone composer (`VideoNoteComposer.tsx`) is ~385 px: stamp line + Cancel,
   anchor chip, frame step + Set in/out, formatting toolbar, editor, Post, Internal/Client-visible. With the keyboard up the root is
   ~430 px (visual viewport), so 60 % ≈ 260 px and the editor row (grid row 3, after the marks block) is cut off below the strip,
   i.e. behind the keyboard. Typed text is never visible.
2. **Two sources of truth for "engaged".** The sheet's mode follows editor focus (`useReviewSheet.composing`, set in the pane's
   focus/blur capture), but the composer's tall layout follows its own `engaged` (`focused || body !== "" || marks || drawing ||
   problem || otherForm`). Dismissing the keyboard returns the sheet to browse while the composer stays engaged and tall
   (there is text). `collapsedHeight()` then measures a ~385 px composer, every stop inflates, the player cell is squeezed below
   its content, and the player's transport paints over the sheet: "tab row under the play bar until Cancel". Cancel empties the
   body, `engaged` goes false, everything snaps back.
3. **Compose mode ends on submit while the field may still hold focus** (`onSubmitCapture → onComposing(false)` in `ReviewPane.tsx`),
   which drops the visual-viewport sizing while the keyboard can still be up.

The fix: (a) the phone composer is P6's ~100 px strip and P1's one-line pill, so there is nothing to clip; (b) the sheet's mode is the
**only** source of truth for which composer layout shows; (c) nothing in compose mode is capped by a percentage: the film flexes and
only the + tray may shrink/scroll; (d) the compose layout is valid at any visual-viewport height, so a missed or late keyboard event
can never produce overlap.

---

## 1. Frame → component map

| Frame | Renders it | What changes |
|---|---|---|
| **P1** staff, half | `VideoReviewViewer` (phone branch): `phoneHeader` → `quincy/ReviewPhoneBar` + `VersionChip` + `video/VideoPhoneApprove` + `video/VideoReviewHeaderMenu` (→ `quincy/ReviewActionSheet`); `quincy/ReviewPane` `ReviewSplit` + `quincy/ReviewSheet` (sheet, grabber, stops); `quincy/VideoPlayer` (+ `VideoStage`) for film and control bar; `reui/tabs` sheet head (in the viewer's `sidePane`); `video/VideoNotesPanel` (notes head, list) → `VideoNoteThread`; `video/VideoNoteComposer` (pill) | Header labels/casing, ⋯ plain icon (row 3); control bar (row 4); film edge-to-edge + play badge (row 5); tabs left + count chip (row 6); notes head chips (row 7); pill at rest (row 2) |
| **P3** collapsed | same, stop `collapsed` | Collapsed stop = grabber + tab row + pill ≈ 127–132 px (prototype 127). Falls out of the pill; no code of its own. Verify. |
| **P6** writing | `ReviewSplit` compose mode + `VideoNoteComposer` compose strip + new + tray + `lib/use-visual-viewport.ts`; `VideoPlayer` transport hidden | Rebuilt (row 1, Q1). §3. |
| **P7** drawing | `VideoNotesHost` → `useVideoMarkup` (`VideoMarkupOverlay.tsx`: overlay, `transportReplacement`), composer with pen pressed | Verify on the Simulator (row 9); known deviations listed as conflict C16. Only the placeholder ("Add a note with this drawing…") and the pen's pressed state are planned changes. |
| **P9** ⋯ staff | `VideoReviewHeaderMenu` → `ReviewActionSheet` (`reui/sheet` bottom + `reui/item` rows) | Rows only, version numbers in labels, no initial ring; + Version details row (Q2) (row 8) |
| **P2** guest, half | `guest/GuestVideoScreen` (phone branch) using the same `ReviewPhoneBar`, `VersionChip`, `ReviewActionSheet`, `ReviewSplit`/`ReviewSheet`, `VideoPlayer`, `use-visual-viewport`; its own `GuestNotesPanel` and `use-guest-compose` form | Shared parts change for free (header casing, ⋯ icon, control bar, film, sheet mechanism). Guest composer → pill/strip and guest count = open notes are their own PR (§7, PR 2). |
| **P10** ⋯ guest | `GuestVideoScreen` `ReviewActionSheet` rows | Rows-only sheet (shared), "Download v3" label |
| **T1** staff phone tiles | `video/VideoCollectionPanel` header + `video/VideoCard` → `quincy/VideoTile` | Status chip sentence case (row 10); header "Video · N films" (row 11) |
| **T3** staff desktop tiles | same | same (desktop intended) |

Not audited and unchanged in this plan: NoteItem layout (P1 rows), Versions sheet (P8), P4/P5 stops, Full screen (#880), desktop rail (#881), Delivery (#882).

---

## 2. Per audit row: change, files, what must be preserved. (Phone-only unless stated.)

Gate for every phone-only change: the existing `PHONE_QUERY` (`(width < 721px)`) via `useMediaQuery`, or the sheet's `phoneSheet`
(`stacked && sheet`). Desktop (≥ 721 px) renders exactly today's DOM except where a row says "desktop too".

### Row 1 — Writing a note (P6, D10, Q1). PR 1.
Change:
- `VideoNoteComposer.tsx`: split render into the **desktop form (unchanged)** and the **phone pill/strip**, sharing one editor node (see
  "node identity" below). Phone strip in compose mode, top to bottom:
  1. Hint line: `Paused at <tc> · the note is stamped here` (today's `video-note-stamp` text), `text-xs`, fg-secondary. A post
     problem / over-length message replaces the hint line (role=alert, max 2 lines) instead of adding rows.
  2. **+ tray** (Q1), only when open (§3.4).
  3. Pill row: `[ + | tc chip | editor | pen ]` + round **Send**.
  4. Cancel, right-aligned (`Button variant="text"`), as today's `video-note-cancel`.
- `ReviewPane.tsx` / `ReviewSheet.tsx`: compose mode = field focused **or** a hold (tray open, post in flight, file picker open);
  drop `data-[mode=compose]:max-h-[60%]`; strip sizing per §3.
- `VideoPlayer.tsx`: new prop `transportHidden` (phone compose) — transport block gets `hidden` (stays mounted), so P6 is header,
  film (flex), strip. The sheet's `transportHeld` keeps the last measured transport height, so stops do not jump on return.
- `lib/use-visual-viewport.ts`: §3.2.
- `lib/video-note-form-store.ts`: add `extras: boolean` to `Slot` (not part of the draft; `hasUnsent` ignores it) with
  `setExtras(assetId, open)`; `escape()` closes it right after draw / confirming (§ Escape below); `leave()`, `discardComposer()` and a
  successful post reset it.
- `components/QuincyRichTextEditorBase.tsx` (+ `QuincyRichTextEditor.tsx`, `video/VideoNoteEditor.tsx` pass-through), opt-in props,
  default behaviour byte-identical for every other caller:
  - `toolbarContainer?: HTMLElement | null` — `undefined` (default): toolbar inline as today. Element: the same `RichTextToolbar` is
    rendered through `createPortal` into it and the block-start `InputGroupAddon` is not rendered. `null`: not rendered yet.
  - `inlineStart?: ReactNode`, `inlineEnd?: ReactNode` — rendered as `InputGroupAddon align="inline-start" | "inline-end"`, so the
    pill **is** the editor's own `InputGroup` (+ and chip at the start, pen at the end).
  - `contentClassName?: string` — line clamp: 1 line at rest, max 4 lines then internal scroll in compose.
- `video/VideoNotesPanel.tsx`: the `data-sheet-part="composer"` wrapper loses its `border-t pt-3` and the aside's `p-4` on phone
  (the strip carries P6's own padding), so the strip is ~100 px, not ~140.

Preserve (each has a test in §6):
- **Drafts survive mode switches.** browse ↔ compose ↔ tray ↔ draw ↔ Social ↔ sheet stops ↔ the 721 px crossing: the editor is the
  same DOM node throughout (lesson "A collapsed or mode-hidden pane must stay mounted…"). The draft, marks, visibility and drawing
  stay in the form store as today.
- **Node identity rule for the split render:** the editor wrapper `<div data-testid="video-note-editor">` keeps the same parent chain
  and child index in both layouts; layout-specific pieces are `{cond && <X/>}` siblings in fixed slots (a `false` child still holds
  its index). The toolbar may remount across the crossing (it moves between inline and portal); the editor may not.
- **Stamping on focus:** focusing the field on a phone pauses the clock (`onFocusCapture` → `clock.pause()`), and the first keystroke
  freezes `anchorFrame` (`setContent(..., frameOnScreen)`) — unchanged. The chip shows `composer.anchorFrame ?? liveFrame`, the range,
  or the drawing frame, as `anchorText` does today.
- **Upload abort on Cancel:** Cancel = `store.discardComposer` + `editorKey++` (remount aborts pending uploads, drops their cards) +
  blur — unchanged, plus closes the tray.
- **Posting rules:** `canPost` unchanged (clock, no op, no other form, non-empty, not too long, not uploading). Send shows the phase:
  spinner + `aria-label` "Confirming…/Posting…/Retry" (the visible "POST" text goes; see C5).
- **Visibility starts Internal every time the composer is empty, never sticky** — unchanged (store rule).
- **Lock while an edit/reply is open:** composer `opacity-60`, + and Send disabled, the hint line reads "Finish or cancel the open
  edit first." (today that text is `sr-only` on a phone).
- **Loading the film…:** shown as the hint line while `clock === null`.

### Row 2 — Composer at rest (P1). PR 1.
Change: phone at rest (sheet mode `browse`) renders only the pill row: `[ tc chip | editor (1-line clamp) | pen ]` + round Send.
No +, no hint, no Cancel, no marks, no visibility, no toolbar. A draft left after the keyboard was dismissed shows clamped to its
first line; Send is enabled when `canPost` and posts without entering compose (Send prevents pointerdown default, so the field is
not focused). The pen (`transportActions` handed in as `pen`, today) sits inside the pill.
Preserve: the at-rest height is fixed (one line), so `collapsedHeight()` is stable whatever the draft — this is what removes
symptom 2. Desktop composer unchanged (W1's weight problem is #881's).

### Row 3 — Header. PR 3.
- `VideoPhoneApprove.tsx`: visible label "Approve (internal)" (today "Approve" + aria-label), `normal-case` (C8). Approved state stays
  the compact status pill reading "✓ Approved" (its status menu stays; C21).
- `GuestVideoScreen.tsx` phone Approve: "Approve", `normal-case`; approved reads "✓ Approved" (today has the check icon).
- `ReviewActionSheet.tsx` trigger: `quincy/IconButton` with lucide `Ellipsis`, no border/background (today a bordered box with the
  "⋯" glyph). Shared, so guest gets it too.
Preserve: role gating (staff only when the role may set `approved_internal`; hidden when read-only/published; disabled with spoken
hint while an older Version or Compare is on show), focus return to the trigger, `data-testid`s.

### Row 4 — Control bar. PR 3.
`VideoPlayer.tsx`, phone branch only: Play/Pause `variant="ghost" size="icon"` (plain icon, not the cream filled button); readout is
the current timecode only on a phone, always (drop `video-readout-total` on phone). Frame step keeps today's rule (only where no
composer carries it: guest, or an edit/reply open — C14). ⤢ Full screen is #880 (and `document.fullscreenEnabled` is false on
iPhone, so the current button is already absent there).
Preserve: desktop transport, legend, time-format menu, range button, keyboard handling (`usePlayerKeys`) byte-identical.

### Row 5 — Film. PR 3.
`VideoStage`/`VideoPlayer` phone classes: no section `gap`/padding around the stage on a phone, black letterbox (the inverse
background token, not `bg-invert`, which reads light on the inverse surface — confirm on the Simulator which of the two draws the
"light border"), film edge-to-edge under the header. Add P1's tap-to-toggle on the picture and the centred play badge when paused
(phone, browse mode only; the badge is `aria-hidden`, `pointer-events-none`; the tap is ignored while drawing or with a markup
overlay active). In-picture timecode chip stays (C15).

### Row 6 — Sheet tabs. PR 3.
Viewer `sidePane`: `TabsList` not stretched (`w-fit justify-start`, triggers `flex-none`); the open count beside "Notes" as
`reui/badge` `variant="secondary"` (digits, default size). Guest already left-aligned; its count becomes the open count (PR 2).
Preserve: tabs stay mounted (`keepMounted`), choosing a tab from collapsed opens half (D6), 44 px row.

### Row 7 — Notes head (Q2). PR 3.
`VideoNotesPanel.tsx`, phone only (desktop keeps `headerRow` + `filtersBlock`):
- **"Open · N ⌄"**: `quincy/menu` radio group over the existing status filter (Open / Resolved / All with `noteCounts` numbers); the
  chip reads the current choice and its count ("Open · 4", "All · 6").
- **"Everyone ⌄"**: meaning undecided — C9. Default if unanswered: staff-only visibility filter menu (All / Client-visible / Internal),
  label "Everyone" for All.
- **Search icon**: new capability — C10. Default if unanswered: client-side filter of the loaded threads by body and author name,
  opened as an inline `reui/input-group` row replacing the chips, Escape/✕ clears; markers and counts keep following the filters only.
- **Version details** leaves the head → a row in the ⋯ sheet (row 8). **Copy shown notes / Paste…** (today the notes ⋯ on phone)
  need a home — C11; default: rows in the ⋯ sheet.
Preserve: filters live in the session (`setFilters`), the pinned open-form thread stays listed, marker export notices.

### Row 8 — ⋯ sheet (P9). PR 3.
`ReviewActionSheet.tsx`: no visible heading, no ✕; `SheetTitle` kept `sr-only` and a visually hidden "Close" button kept for
assistive tech (C13); `initialFocus` = the popup itself (no ring on the first row); scrim tap and Escape close.
`VideoReviewHeaderMenu.tsx`: labels "Download v3", "Remove v3…"; new "Version details" row opening a bottom `reui/sheet` with the
viewer's `detailsRows`; (if C11 = yes) "Copy shown notes", "Paste N notes from vX…". Order: Social preview, Download vN, Marker
export…, Copy link, Create Review link, [Open in iPhone player — #880], Version details, [Copy/Paste], —, Remove vN….
Guest P10: "Download vN".
Preserve: each row exists only when its desktop control would (gates unchanged), Download is a real anchor, Create Review link and
Remove hand focus on (`close(true)`), Escape closes only the sheet and returns focus to ⋯ (existing tests).

### Row 9 — Draw (P7). PR 1 checks, no planned behaviour change.
Simulator rows K11 below. Planned: placeholder "Add a note with this drawing…" while drawing, pen `aria-pressed`. Known deviations
(top bar vs markup toolbar under the film; outline) go to the owner (C16), not fixed silently.

### Row 10 — Tile status pill. PR 4. Desktop too.
`quincy/VideoTile.tsx`: status `Badge` gets `normal-case` (Badge is uppercase by house style — C8). Label stays `status.short` unless
C17 says full label.

### Row 11 — Collection header (T1/T3). PR 4. Desktop too.
`VideoCollectionPanel.tsx`: heading "Video" (display face) + "N films" (meta, from `videos.data.length`; "1 film"), Upload button.
Eyebrow "Video review", the description paragraph, Review links and Trash: C18 — default keep Review links and Trash as today's
buttons beside Upload (capabilities the frame does not show stay, per the prototype's "unchanged from today" rule), drop the
eyebrow and description per the frame.
Preserve: `aria-labelledby="video-films-heading"`, `TRASH_OPEN_ID` focus return, upload drop zones.

### Escape order (all phone changes)
Unchanged owners and order (lesson "Escape needs an order…"): open layer → form store → Social → Compare → viewer. Inside the form
store: draw → frame confirmation → **tray (new: `extras` → close, focus stays in the editor)** → clean edit/reply closes → dirty keeps
text once → composer focus → dialog. The tray is inline (not a popup), so it must be in the store's order, not `hasOpenFloatingPopup`.

### Author-only, impersonation, desktop shortcuts
No change to thread actions, `isOwnNote`, impersonation or audit paths. Desktop: player keys (Space, J/K/L, ←/→, I/O via `onMark`),
composer ⌘↵, `aria-keyshortcuts` on Set in/out — the desktop composer branch is the current JSX, untouched;
`VideoNoteComposer.dom.test.tsx` must pass with **no assertion edits**.

---

## 3. The keyboard fix — mechanism

### 3.1 What is sized to what (compose mode, phone)
- **Root** (staff: `DialogContent`, already `position: fixed; top: 0`; guest: `guest-video-screen`, made `fixed inset-x-0 top-0`
  while composing so both use one rule): `height = visualViewport.height`, `transform: translateY(visualViewport.offsetTop)`.
  The root therefore *is* the area above the keyboard.
- Inside the root, a column: **header** (`flex: none`, ~48–56 px) → **split row** (`flex: 1; min-height: 0`).
- Split row in compose: **player cell** `flex: 1 1 0; min-height: 0; overflow: hidden` (film only; transport `hidden`; the stage
  letterboxes into whatever is left) → **strip** (`flex: none; max-height: calc(100% - 96px)`; flex column).
- Strip parts: hint, pill row, Cancel = `flex-shrink: 0`; the **tray** = `min-height: 0; overflow-y: auto` and is the only part that
  shrinks. The editor's own `max-height` (4 lines ≈ 112 px) bounds the pill.
- Budget check (iPhone 18 Pro, keyboard + accessory bar up, vv ≈ 430 px): header 56 + strip ≈ 100–170 → film ≈ 200–270 px; with the
  tray (≈ 150) the film is ≥ 96 px, the tray scrolls beyond that. iPhone SE (3rd gen) vv ≈ 340: header 48 + strip ≤ 192 + film 96 =
  336 → fits. No percentage caps anywhere: nothing can be clipped.
- The pane `overflow-hidden` + `[&_[data-sheet-part][inert]]:hidden` stay; head/body/grabber are inert-hidden in compose (as today).
- The editor keeps `font-size: var(--text-base)` (16 px) on phone, so Safari never zooms on focus (a zoom would make vv.height wrong).

### 3.2 How the strip stays above the iOS keyboard
`useVisualViewport(enabled)` (rename to `useComposeViewport`, same file) while `enabled = phone && sheet.mode === "compose"`:
- on enable: record `window.scrollY`, read `vv.height`/`vv.offsetTop` once synchronously, subscribe to `vv` `resize` and `scroll`;
  each event sets the box (no-op if unchanged). The root re-renders to the new box; the strip is the root's last child, so its
  bottom edge is the keyboard's top edge.
- iOS sequence it relies on: focus → iOS pans the visual viewport (offsetTop > 0) to reveal the caret → keyboard animates → `resize`
  → root shrinks to vv and translates by offsetTop → caret already inside the strip, no further pan.
- on disable: unsubscribe, clear the box, and if `vv.offsetTop !== 0 || window.scrollY !== recorded` call
  `window.scrollTo(0, recorded)` — iOS sometimes leaves the layout viewport panned after the keyboard closes (K15).
- Ignore events while `vv.scale > 1.01` (pinch zoom): keep the last box.

### 3.3 Recovery when the keyboard is dismissed without Cancel
Compose mode is computed in one place, `useReviewSheet`/`useSheetPane`: `mode = drawing ? "draw" : (fieldFocused || holds > 0) ?
"compose" : "browse"`. Both the layout and the composer read it (via a `SheetModeContext` that `ReviewSplit` provides around the
pane; the composer shows strip parts only when `mode === "compose"`) — the composer no longer has its own `engaged`.
- **Blur** (keyboard Done/chevron, tap on the film or header): the pane's `onBlurCapture` stays in compose if `relatedTarget` is
  inside the composer part; otherwise it re-checks on the next animation frame (iOS often reports `relatedTarget = null`): if
  `document.activeElement` is not the composer field and there are no holds → `browse`. The sheet returns to its stop, the pill
  clamps to one line with the draft, the transport reappears, the root drops the vv box and restores scroll. Draft, marks,
  visibility, drawing and uploads stay (store + same editor node).
- **Keyboard gone but focus kept** (fallback; some iOS paths and hardware-keyboard toggles do not blur): while compose is on, if vv
  height was observed ≥ 150 px below the layout height and then returns to within 1 px of it, and no hold is active, blur the field →
  the blur path above. Never fires with a hardware keyboard (the software keyboard was never observed up).
- **Even if neither fires**, the compose layout at full height is header + film + strip at the bottom with Cancel: coherent, no
  overlap. The overlap symptom cannot recur because nothing in browse or compose depends on the composer's content height except the
  bounded pill.
- **Send:** `pointerdown`/`mousedown` default prevented (layout must not jump between press and click). Submit takes a hold while
  `op !== null` (the editor is disabled during confirm/post and iOS drops the keyboard; the hold keeps the strip showing
  "Posting…"). On success the hold is released, the field blurred → browse with the new note listed. On failure the hold is released
  and the problem line stays visible (also shown above the pill in browse). (Prototype stays in compose after Send — C7.)
- **Pen:** blurs first (today), mode → draw; Done refocuses the editor inside the tap (user gesture, so iOS raises the keyboard) →
  compose.
- **Cancel:** discard + remount editor + blur + close tray → browse.

### 3.4 How the + tray coexists with the keyboard
- **The tray is inline, not modal**: a `reui/collapsible` panel docked above the pill *inside the strip*, so it is inside the root
  that is sized to the visual viewport — always above the keyboard. Opening it never moves focus: the + trigger, every tray control and
  Send prevent `pointerdown`/`mousedown` default, so the editor keeps focus and the keyboard stays up; the film shrinks to make room.
  Formatting buttons already run `editor.chain().focus()…`, so they act on the live selection.
- Contents (staff): row A `reui/toggle-group` Internal | Client-visible + its hint; row B frame step ◀ ▶, Set in, Set out, Clear marks
  (+ Remove drawing when one is attached); row C the editor's own toolbar, portalled in via `toolbarContainer` (scrolls sideways as
  on phone today; whether it is trimmed to B/I/U/image/video is C2).
- The tray panel is mounted for the whole phone layout (`keepMounted`, `hidden` + `inert` when closed) so the portal target is stable.
- The tray is a **hold**: while open, compose stays on even if the field blurs. That covers Insert image/video: the OS picker hides
  the keyboard; the layout stays header + film + tray + strip at full height; the upload card appears; tapping the pill brings the
  keyboard back. Closing the tray (tap +, Escape) while the field is not focused → browse.
- Closes on: + again, Escape (store order), Cancel, Send success, pen, Version switch (`leave`).
- `aria-expanded`/`aria-controls` on +, tray is a `region` labelled "Note options".

---

## 4. Reuse ledger (new or changed elements)

| Element | Uses | Note |
|---|---|---|
| Compose pill (field) | `reui/input-group` — the editor's own `InputGroup` with `InputGroupAddon` inline-start / inline-end | Pill radius conflicts with the field's `--radius-sm` (C5) |
| + button | `quincy/IconButton` + lucide `Plus`, as `reui/collapsible` `CollapsibleTrigger` render | |
| + tray | `reui/collapsible` `CollapsibleContent` (keepMounted) | Searched: `reui/sheet` (modal, takes focus, would drop the keyboard), `reui/popover` (takes focus, outside-press closes on typing), `reui/drawer` (not installed; modal). Collapsible is the non-modal fit. |
| Visibility choice | `reui/toggle-group` (existing `ToggleGroup` usage moved) | |
| Frame step, Set in/out, Clear marks, Remove drawing | `quincy/Button` (existing buttons moved) | |
| Formatting row | existing `reui/rich-text-editor/rich-text-toolbar` portalled | |
| Timecode chip | existing `ANCHOR_CHIP` span (quincy) | |
| Pen in pill | existing `transportActions` Draw button (`reui/button` ghost icon) | |
| Send | `reui/button` `size="icon"` + lucide `Send`, `Spinner` while posting | Round shape conflicts with button radius (C5) |
| Hint line / Cancel | text span; `quincy/Button variant="text"` | |
| Compose-mode context | Quincy-owned (`ReviewSheet.tsx`) | no UI |
| Approve label | `reui/button` outline (existing) + `normal-case` | C8 |
| ⋯ trigger | `quincy/IconButton` + lucide `Ellipsis` | |
| ⋯ sheet rows / Version details row | `quincy/ReviewActionSheet` (`reui/sheet` + `reui/item`), `ActionRow` | |
| Version details sheet | `reui/sheet` bottom + `reui/item` group (existing `detailsFor` rows) | same pattern as `VideoVersionsSheet` |
| Control bar play | `reui/button` ghost icon (existing button, variant change) | |
| Play badge | decorative `span` + lucide `Play`, aria-hidden | hand-built: nothing in ReUI is a non-interactive media glyph; not a widget, no ratchet entry |
| Sheet tab count | `reui/badge` secondary | |
| "Open · N ⌄", "Everyone ⌄" chips | `quincy/menu` (Base UI) radio items; trigger `reui/button` outline sm | ReUI `filters` searched: a field/operator/value builder, not a single-select chip; rejected. Pill radius: C5. |
| Notes search | `quincy/IconButton` + lucide `Search`; field `reui/input-group` | |
| Tile status chip | existing `reui/badge` invert + `normal-case` | C8 |
| Collection header | existing `workspace-intro` markup + `reui/button` Upload (existing `NewFilmPickButton`) | C18 |

No new raw `<button>/<input>/<select>/<textarea>/<dialog>` or widget `role` → `ui-primitive-allowlist.ts` unchanged. No new ReUI
installs (everything above is in `components/reui/`).

---

## 5. Conflicts for the owner (not resolved silently; each has the default the build will use if unanswered)

- **C1 "small sheet" vs the keyboard (Q1).** A modal bottom sheet takes focus and sits where the keyboard is: opening it drops the
  keyboard and the caret, and B/I/U then act on nothing. Recommend the inline tray docked above the pill (§3.4). Default: inline tray.
- **C2 Formatting set.** Q1 names B/I/U, image, video. The composer toolbar today also has S, heading, link, lists, checklist,
  undo/redo. Trim (loses capability on phone) or keep the whole toolbar in the tray? Default: whole toolbar.
- **C3 Visibility hidden behind +.** Internal/Client-visible becomes invisible at the moment of posting. Recommend the hint line says
  it: "Internal · paused at <tc>". Default: append the visibility to the hint line.
- **C4 "One-line pill" vs rich notes.** Notes hold lists, images, videos and upload cards. Default: one line at rest, grows to 4 lines
  in compose then scrolls; upload cards under the pill.
- **C5 Pill and round Send vs tokens/ReUI.** `InputGroup` is `--radius-sm`, buttons `rounded-lg`; ReUI rule 1 forbids overriding
  radius on installed components. Pill/circle need an owner exception (or square-ish fidelity). Also Send is icon-only where Quincy
  shows "Post" with phase text. Default: keep the token radii; icon Send with phase as spinner + aria-label.
- **C6 Range in the chip.** "In 00:00:12:08 → Out 00:00:18:10" does not fit the pill. Default: prototype NoteItem's short range form
  (`tc – tc.slice(3)`) in the chip.
- **C7 After Send.** Prototype stays in compose (keyboard up, empty pill). The editor locks while the frame is confirmed and posted
  (up to 10 s) and iOS drops the keyboard when it locks. Default: return to browse with the note listed.
- **C8 Sentence case vs Quincy's uppercase Button/Badge.** Approve, tile status, chips. Default: scoped `normal-case` on these
  review/tile controls (precedent: `VersionChip`), not a global button change.
- **C9 "Everyone ⌄" meaning (Q2).** Author filter (new) or the visibility filter? Guests see it too in P2, where visibility means
  nothing. Default: staff = visibility filter labelled Everyone/Client-visible/Internal; guests: no Everyone chip.
- **C10 Search icon.** No note search exists. Default: client-side search of loaded threads (body + author), list only.
- **C11 Copy/Paste notes on phone.** Not in P1/P9. Default: ⋯ sheet rows.
- **C12 Version details placement in ⋯.** Not in P9's row list. Default: after Create Review link, opening a details sheet.
- **C13 ⋯ sheet with no title or ✕.** A dialog needs a name and a reachable close for VoiceOver. Default: sr-only title + visually
  hidden Close.
- **C14 Frame step in the control bar.** P1 has none; shipped keeps it where no composer carries it (guest; staff with an edit/reply
  open). Default: keep.
- **C15 In-picture timecode chip.** Not in the prototype film. Default: keep.
- **C16 Draw (P7).** Prototype: film outlined, top bar "Drawing on <tc> · Undo · Done", no tools. Shipped: markup toolbar (tools,
  colours, widths, undo/redo/clear, Done) under the film. Default: verify only; owner picks whether tools stay.
- **C17 Tile status label.** Prototype poster shows the full label ("Approved (internal)"); shipped the short ("Approved").
  Default: short (row 10 only asks for case).
- **C18 Collection header.** Frame shows "Video · N films" + Upload only; today's eyebrow + description match every other Project
  tab's `workspace-intro`, and Review links + Trash are capabilities the frame does not show. Default: keep Review links and Trash
  buttons; drop eyebrow and description.
- **C19 Guest composer (P2).** Not shown by the prototype: email verification before writing, guest edit happening in the composer,
  "Request changes" and delivery chips, guest Download hint. Also the guest tab count is all threads, not open notes (D22 says open).
  Default: PR 2 plan below; count → open.
- **C20 Approve as a toggle.** Prototype un-approves on a second tap; shipped opens the status menu. Default: keep the menu.

---

## 6. Tests

### Change or add (unit / DOM, happy-dom)
PR 1
- `lib/use-visual-viewport.dom.test.ts` (new): fake `visualViewport` with events; box follows resize/scroll; ignored at scale > 1;
  disable restores the recorded scroll; disabled returns null.
- `components/quincy/ReviewSheet.dom.test.tsx`: replace "moving focus from the editor to Post ends compose mode, and so does a
  submit" with: focus in field → compose; blur to a node inside the composer part → stays; blur to outside → browse after rAF;
  tray hold keeps compose after blur; post hold keeps compose until the op settles; keyboard-dismiss fallback (vv shrinks by ≥150 then
  restores) blurs and exits; no `max-h-[60%]` on the compose pane; phone player cell has `overflow-hidden`; existing node-identity and
  inert tests kept.
- `components/video/VideoNoteComposer.phone.dom.test.tsx`: rewrite "rests as one row…", "focusing the editor…", "at rest the field is
  one line…" to the pill/strip contract: at rest chip + editor + pen + Send, no +/hint/Cancel/marks/visibility/toolbar, even with a
  draft after blur; in compose hint + pill + Cancel + +; + toggles the tray (`aria-expanded`), editor keeps focus (`pointerdown`
  `defaultPrevented`), toolbar portalled into the tray and Bold applies; Set in/out and frame step from the tray; Escape with the tray
  open closes only the tray; Cancel discards, closes the tray and aborts an upload in flight; editor node identical across browse →
  compose → tray → draw → compose and across the 721 px crossing; locked hint visible on phone with an edit open; hint line shows the
  problem text on failure.
- `lib/video-note-form-store.test.ts`: `extras` set/reset (`leave`, `discardComposer`, post success); `escape` order with extras;
  `hasUnsent` ignores extras.
- `components/QuincyRichTextEditorBase.dom.test.tsx`: `toolbarContainer` portals the same toolbar and omits the block-start addon;
  `inlineStart`/`inlineEnd` render as addons; with neither prop the DOM is unchanged (snapshot of the addon structure).
- `components/video/VideoReviewViewer.phone.dom.test.tsx`: compose sets the vv box on the dialog and hides the transport; blur clears
  both; "the player keeps its frame steps…" unchanged.
- `components/video/VideoNoteComposer.dom.test.tsx` (desktop), `VideoNoteComposer.rich.dom.test.tsx`, `VideoNotes.dom.test.tsx`
  ("Escape order"), `VideoNotes.markup.dom.test.tsx`, `GuestSocial.dom.test.tsx`: must pass unedited.
PR 2 (guest)
- `guest/GuestNotesWrite.dom.test.tsx`, `GuestApp.dom.test.tsx`: guest pill at rest; unverified tap asks for verification and does
  not focus; compose strip; edit flow per C19 decision; tab count = open notes; node identity.
PR 3
- `VideoReviewViewer.header.dom.test.tsx`: "gives the phone ⋯ trigger the outline treatment…" → plain icon; labels "Download v3",
  "Remove v3…"; no visible heading; popup takes initial focus.
- `VideoReviewViewer.phone.dom.test.tsx`: Approve reads "Approve (internal)" (normal-case); Version details row opens the details
  sheet; tabs not stretched; count badge; notes chips filter the list; search filters the list (if C10).
- `VideoPlayer.dom.test.tsx`: phone play is ghost; phone readout has no total; desktop unchanged.
- `VideoNotesPanel` coverage inside `VideoNotes.dom.test.tsx`: desktop head unchanged.
PR 4
- `VideoCard.tile.dom.test.tsx`: status chip `normal-case`; `VideoCollectionPanel.dom.test.tsx`: heading "Video", "N films" / "1 film".
Every PR: `npm run verify` (includes `ui-primitive-ratchet.guard`, `design-system-guards`, `reui-registry.guard`).

### iOS Simulator rows (browser pass; iPhone 18 Pro Safari unless noted; one screenshot per row, named `<device>-<row>-<state>.png`)
Keyboard rows (PR 1; K14 after PR 2):
- K1 Tap "Add a note…": keyboard up; strip bottom = keyboard top (±1 px: `vv.offsetTop + vv.height` vs strip `getBoundingClientRect().bottom`);
  film height > 96 px; hint, pill, Cancel visible.
- K2 Type three lines: every line visible as typed; pill grows to 4 lines then scrolls; caret visible.
- K3 Tap +: tray opens above the pill; `document.activeElement` is still the editor; `vv.height` unchanged (keyboard did not drop);
  film ≥ 96 px.
- K4 Tray Bold then type: bold text; tray ▶: hint timecode advances one frame; keyboard still up.
- K5 Set in, ▶ ×5, Set out: chip shows the range; keyboard still up.
- K6 Client-visible: chosen state shown (and on the hint line if C3); keyboard still up.
- K7 Tray Insert image → picker → pick: layout header + film + tray + strip, no overlap; upload card visible; tap pill → keyboard back.
- K8 With a draft, dismiss the keyboard (accessory Done / chevron), no Cancel: browse layout; controls bottom ≤ sheet top (no
  overlap); tab row fully visible; pill shows the draft's first line.
- K9 Tap the pill again: compose, same draft and anchor; Cancel: draft gone, browse layout.
- K10 Send with the keyboard up: no layout jump between press and post; note posts; browse; note in the list; pill empty.
- K11 Pen while composing: keyboard drops; P7 state; draw a stroke; Done → compose with keyboard up (record vs P7: C16).
- K12 Rotate to landscape and back while composing: no overlap, strip above keyboard.
- K13 iPhone SE (3rd gen): K1, K2, K3 measurements.
- K14 Guest Review link (after PR 2): K1, K2, K8, K10.
- K15 After K8 and K10: `window.scrollY === 0`, `vv.offsetTop === 0`, header at the top edge.
- K16 Hardware keyboard on (I/O → Keyboard → Connect Hardware Keyboard): focus the pill; strip at the bottom of the full viewport; ⌘↵
  posts.
- K17 Focusing the pill does not zoom (`vv.scale === 1`).
Chrome rows (PR 3): P1 side-by-side with the prototype at 390 × 844 and on the Simulator (header labels and casing, ⋯ plain icon,
control bar, film edge-to-edge + play badge, tabs left + count, notes chips); P3 collapsed stop height; P9 rows, no ring on open;
P2/P10 guest. Tile rows (PR 4): T1 phone, T3 1280 × 800 desktop (status case, header).
Desktop regression rows (every PR): W1 at 1280 × 800 — composer, header, transport unchanged vs `main` screenshots.

---

## 7. PR split

1. **PR 1 — compose fix (rows 1, 2, 9-check).** The bug. `VideoNoteComposer` pill/strip/tray, `ReviewSheet`/`ReviewPane` single
   compose-mode source + holds + no % cap, `use-visual-viewport` recovery, `VideoPlayer.transportHidden`, form store `extras`, editor
   base opt-in props. Staff only. Ships first; small enough to review against K1–K13/K15–K17.
2. **PR 2 — guest phone (P2/P10 composer and count).** `use-guest-compose` form re-laid as the same pill/strip (shared shell from
   PR 1 lifted to `components/quincy/ComposeStrip.tsx` so the guest tree can import it without staff modules —
   `guest-boundary.guard.test.ts`), verification-on-tap, edit flow per C19, open count. Until PR 2 the guest keeps today's form but
   gets PR 1's sheet/viewport mechanism (no % cap, film flexes), which is enough for its form to scroll rather than clip — K14 checks it.
3. **PR 3 — phone chrome (rows 3–8).** Header, ⋯ sheet, control bar, film, tabs, notes head (needs C9–C13 answers).
4. **PR 4 — tiles (rows 10–11).** Independent; can go in parallel with PR 1.

#880, #881, #882 build on top of PR 1 + PR 3 (the "Open in iPhone player" row slot is left between Create Review link and the rule).
