# PR 3 plan — Opus (deep-reasoner), blind

## PR 3 plan: phone chrome, notes head, collection header

Paths are under `portal/apps/web/src/`. Every line number below is at `d1e12da1` and comes from reading the code. Every pt figure on the Simulator is the brief's measurement or my arithmetic from the classes, and needs re-measuring.

### 1. Frame → component map (staff | guest)
| Frame · part | Staff | Guest |
|---|---|---|
| P1/P2 header: back, title, chip, Approve, ⋯ | `quincy/ReviewPhoneBar.tsx:11` (`VersionChip` :31) from `VideoReviewViewer.tsx:452-471`; Approve `VideoPhoneApprove.tsx:17-21`; ⋯ `VideoReviewHeaderMenu.tsx` → `quincy/ReviewActionSheet.tsx` | same bar from `GuestVideoScreen.tsx:~460-475`; Approve inline at :465; ⋯ `ReviewActionSheet` at :466-473 |
| Film + control bar | `quincy/VideoPlayer.tsx:177-253`, `VideoStage.tsx:85-101` | same player, `GuestVideoScreen.tsx:523` |
| Sheet, grabber, stops | `quincy/ReviewPane.tsx:185-231`, `ReviewSheet.tsx:139-216`, `lib/review-pane-geometry.ts:16-24` | same |
| Tab row and count | `VideoReviewViewer.tsx:488-499` | `GuestVideoScreen.tsx:525` (head div + Tabs) |
| Notes head (P1 `NotesFilter`) | `VideoNotesPanel.tsx:177-205`, placed in the list on a phone at :230-231 | today the delivery row sits there (`GuestVideoScreen.tsx:442-453`, rendered by `GuestNotesPanel.tsx:52`) |
| Composer band | `VideoNotesPanel.tsx:212,258` | `GuestNotesPanel.tsx:47` + wrapper padding `GuestVideoScreen.tsx:525` |
| P3/P4/P5 stops | `sheetStops` (geometry :16), `useSheetPane` (`ReviewSheet.tsx:81`) | same |
| P8 Versions | `VideoVersionsSheet.tsx:32-75` | same |
| P9 / P10 ⋯ | `VideoReviewHeaderMenu.tsx:33-51` | `GuestVideoScreen.tsx:466-473` |
| T3 header | `VideoCollectionPanel.tsx:206-214` | n/a |

### 2. Scope 1: where the extra height comes from, per band (all phone-only, `< 721px`)
The half stop is `available − (width/aspect + transport)` (geometry :22), with `available` = row height under the header. Extra height in the header or transport therefore comes straight off the list, and so does anything else in the sheet.

- **Header (77 measured for staff, 85 for guest; P1 is 56).** `ReviewPhoneBar.tsx:12` has `min-h-12 py-1`. Its title column stacks a 24px `--type-body` line on `VersionChip`'s `min-h-11` (:32): 24+44+8+1 = 77.
  - Fix: the bar is `h-14` (56) with `py-0 px-[var(--space-1)] gap-x-[var(--space-1)]` (P1's 0 4px).
  - The chip is drawn 20px tall (`h-5`) with an `after:` hit area that is 44px tall, extends up over the title (which is not interactive) and is clipped to the bar's bottom edge. This is the `PILL_ICON` / `STRIP_TEXT_BUTTON` pattern (`VideoPlayer.tsx:48`, `compose-strip.tsx:41`).
  - Approve is drawn at `min-h-8` with the same vertical `after:` hit area.
  - The guest's extra 8pt is not in the shared bar (same component). Measure it with `getBoundingClientRect` before assuming: it may be the `h1` or a GuestApp notice.
- **Transport (about 100 measured; P1 is 78).** Three sources:
  - the section's `gap-3` between stage and transport (`VideoPlayer.tsx:183`);
  - the transport's own `gap-3` (:190);
  - the slider control's phone `min-h-11` (`reui/slider.tsx:49`) plus a separate 12px marker lane (`VideoTimelineMarkers.tsx` `h-3`) above a 44px row.

  Fix, on the phone only (`max-[721px]:`):
  - Section and transport gaps go to 0.
  - The scrubber band is `--space-6` (32px). The slider control gets a transparent `after:` that extends its touch band to 44px.
  - The marker lane sits absolutely inside that band (P1 puts the marks inside the 28px `.scrub`).
  - The row stays 44px, with `pb-[var(--space-1)]`. Total is about 80.
  - Set `STAGE_GAP` to 0 (geometry :11). It is phone-only geometry, and today the stops leave out the 12px gap, which squeezes the picture.
- **Grabber + tab row (staff 70, guest 85; P1/P2 is 67).** Grabber `h-6` (`ReviewSheet.tsx:214`) + tabs `!h-11` + two hairlines. The guest head also adds `py-[var(--space-2)]` (`GuestVideoScreen.tsx:525`). Drop that padding on the phone; the result is about 70 for both.
- **Composer band (76 measured; P2 is 60).** Staff: panel `p-[var(--space-4)]` (`VideoNotesPanel.tsx:212`) + composer `pt-[var(--space-3)]` (:258) + the panel's `gap-3`. Guest: the same through `GuestNotesPanel.tsx:46-47` and the wrapper `max-[721px]:p-[var(--space-4)]`.
  - Fix, in browse mode only: `pt-[var(--space-2)]` above the pill, `pb-[var(--space-2)]` below it, `pt-0` above the list, and `gap-0` between list and composer (the composer's top border is the divider). That gives 1+8+44+8 = 61.
  - Compose mode keeps PR 1's and PR 2's `in-data-[mode=compose]` classes.
- **Notes head.** The staff head is a 44px counts/Version details row, then two 44px ToggleGroups, in the list (:177-205). It becomes one row of about 45px; see row 7. Expected list window is roughly 212 at P2; re-measure.

### 3. Scope 2: status bar stays cream after a load
- **Staff:** measured. Cream on a fresh load or reload, ink after the first compose and Cancel (lessons, "Safari tints its bars…", r9).
- **Guest:** predicted to behave the same on a link's first open, but not measured. A guest reload does not reach the video screen, because the token is scrubbed from the fragment (`link-fragment.ts:20-27`).
- **Mechanism (from that lesson and ledger round 11):** Safari takes its tint once at load, from the page canvas and the fixed elements at the screen's edges, and takes it again only when the document scrolls.
  - Ledger round 11 put `html[data-ink-canvas]` on ink (`app.css:14`, `use-ink-canvas.ts:11-17`) and the bars stayed cream. So a canvas change after load is not re-sampled. That attribute is set in a layout effect only once the viewer mounts, which is after the boot screen and the cream Project page have painted.
  - There is no `theme-color` meta tag (`index.html`).
  - The staff viewer is a fixed dialog that mounts after load. Only the keyboard's document scroll (`scrollY` 330) makes Safari sample it.
- **Root-cause options:**
  1. **Ink canvas from the first byte.** A render-blocking classic script in `<head>` sets `data-ink-canvas` when `matchMedia("(width < 721px)")` matches and the path is `/d/review`, or the URL names a film. Release it when the route settles with no phone review open.
  2. **`theme-color` meta.** I believe Safari 26+ no longer tints from it; unverified, so test it.
  3. **One document scroll after the viewer's first paint.** This needs the document made 1px taller for one frame. The lesson reserves this for an owner decision.
- **Spike first (half a day, no merge):** a temporary `?tintdebug=1` build trying options 1, 2 and 3 on the iPhone 18 Pro Simulator, staff and guest, fresh load versus after Cancel.
- **My expectation:** option 1 fixes the guest (an in-flow screen with no fixed header) but not staff, because the fixed cream Project overlay is what gets sampled at load. If so, the staff case is not fixable in-page without option 3. Take that to the owner with the screenshots.
- **The reverse also exists today:** after closing the viewer, the bars stay ink over the cream Project page until a scroll.

### 4. Scope 3: audit rows against `main` (what is left)
- **Row 3 (header).**
  - The bar's structure is already done (`ReviewPhoneBar.tsx`).
  - Staff shows "Approve" with only an aria-label "Approve (internal)" (`VideoPhoneApprove.tsx:18`). It should show "Approve (internal)" (C8 uppercase, so "APPROVE (INTERNAL)").
  - The guest Approve is the solid default variant (`GuestVideoScreen.tsx:465`); it should be `variant="outline"` per P2.
  - ⋯ is bordered with a text "⋯" glyph (`ReviewActionSheet.tsx:27`). Make it a plain `reui/button` ghost icon with lucide `Ellipsis` and the 44px `COARSE` target.
  - The 56px height is covered in §2.
- **Row 4 (control bar).**
  - Play is `variant="default"`, the cream fill (`VideoPlayer.tsx:216`). On the phone it should be `ghost` `size-8` with `COARSE`, like mute.
  - The readout shows "current / total" whenever `phoneFrameStep` is false (:222), which is the staff default. The phone should show the current time only.
  - The guest passes a literal `phoneFrameStep` (`GuestVideoScreen.tsx:523`) although PR 2's tray carries frame step. Gate it like staff (C14): true only when no composer is mounted.
  - The ⤢ button renders only when `document.fullscreenEnabled` (:132,245), which is false on iPhone. It stays for #880.
- **Row 5 (film).**
  - The phone player cell is already `p-0` (`ReviewPane.tsx:191`). I found no border on the stage (`VideoStage.tsx:89`); verify on the Simulator.
  - Left: the stage gap (§2) and P1's centred play badge when paused (none today).
- **Row 6 (tabs).**
  - Staff: `TabsList flex-1` (`VideoReviewViewer.tsx:491`) plus reui triggers that are `flex-1` (`reui/tabs.tsx:88`) give a 50/50 stretch. The guest's single trigger is centred across the whole row.
  - Fix at the call sites, phone only: `justify-start` on the list, `flex-none` on the triggers.
  - The count becomes a chip (start from `reui/badge` `variant="secondary"`; fall back to a token-styled span if Badge makes the 44px row taller).
  - Staff `openCount` (`VideoNotesHost.tsx:40`) counts hidden tombstones. Use `noteCounts(...).totals.open`.
- **Row 7 (notes head).** Not started on either role. See §5.
- **Row 8 (⋯ sheet).**
  - Remaining defects: visible serif title and a visible ✕ (`ReviewActionSheet.tsx:30,32`); labels "Download" and "Remove version…" (`VideoReviewHeaderMenu.tsx:36,48`); no `initialFocus`, so the first row gets the focus ring.
  - Fixes:
    - Title `sr-only` and Close visually hidden but focusable (`sr-only focus-visible:not-sr-only`) (C13).
    - `initialFocus` on the popup.
    - Labels "Download v3" and "Remove v3…".
    - "Version details" row after Create Review link (C12), opening a bottom sheet of `detailsRows`; only when notes are on.
    - "Copy shown notes" and "Paste N notes from vX…" rows (C11).
  - Copy and paste live in the panel (`VideoNotesPanel.tsx:63-87,188-192`). Lift them into a `useNotesClipboard` hook in `VideoNotesHost` and expose it as a `NotesSlots` field, as `markerExport` is. The paste dialog's `finalFocus` (:267) goes to `video-header-menu` on a phone.
  - Guest P10 order: Social preview, Download vN, then PR 2's Copy my notes.
  - P8: title in `[font:var(--type-label)] text-foreground-secondary`, Close visually hidden, one-line rows with the date, count and status on the right, then the check.
- **Row 11 (T3).** `VideoCollectionPanel.tsx:208` shows the eyebrow "Video review" and an `h1` "Films". Make the `h1` "Video", followed by "N films" ("1 film"; nothing while loading). Keep Review links and Trash (C18). This applies at every width.

### 5. Row 7 design and the minor fix
- **New `components/quincy/NotesFilterHead.tsx`.** Staff-free and data-agnostic, so `guest-boundary.guard` holds. It is one row: `py-[var(--space-2)]`, a hairline under it, inside the list's scroll as in P1.
  - **"Open · N ⌄":** `reui/dropdown-menu` with `DropdownMenuRadioGroup` for Open/Resolved/All (with counts). Staff also get a separator and a second radio group for All/Client-visible/Internal (C9).
  - **"Everyone ⌄":** radio items for Everyone plus each root author in the loaded threads.
  - **Search icon:** opens an inline `reui/input-group` with `InputGroupInput type="search"`, a Search addon and a clear X, replacing the chips. Escape or X closes and clears it. It filters loaded threads on root and reply bodies and author names (C10).
  - **Trigger chips:** a new scoped `reui/button` `size="chip"`: `h-7`, `--radius-pill`, an `after:` 44px hit area, adaptation note 8.
- **Staff model.** Extend `NoteFilters` (`lib/video-note-view.ts:5`) with `author: string | null` and `query: ""`. `visibleThreads` and `noteCounts` honour them, and the markers follow as today. Reset both when crossing to desktop. The phone loses `headerRow`, the ToggleGroups and the notes ⋯ menu (desktop keeps all of them unchanged).
- **Guest model.** New pure `guest/guest-notes-filter.ts` (status from `resolved`, author key `kind:name`, query). The guest's markers follow it too.
- **Reuse and allowlist.** Everything is reui or quincy, and no raw primitive lands in `video/` or `guest/`, so `ui-primitive-allowlist.ts` is unchanged.
- **Scope 4 (the placeholder ellipsis).** `REST_CLAMP` (`compose-strip.tsx:31`) clips the `::before` placeholder with `text-overflow: ellipsis`. That cuts at a character, so when the edge falls just after a space, Safari draws "with …".
  - The long copy "Add a note with this drawing…" (`VideoNoteComposer.tsx:204`, `GuestNoteComposer.tsx:140`) cannot fit beside +, the chip and the pen at 390pt.
  - Fix: a pure `fitAtWord(text, fits)` that drops whole words and appends "…", with the measure done by a ResizeObserver on the pill's text box (canvas `measureText` with the computed font). Apply it only to `data-placeholder`; a typed draft keeps the CSS ellipsis.

### 6. Conflicts for the owner
1. C8 says uppercase on buttons, but P1's chips are sentence case. `VersionChip` already uses `normal-case`. I recommend sentence case for the chips.
2. The guest delivery row (decision and Released badges, Request changes, Download all, hints, paste status) has no place in P2/P10. Proposal: Request changes… and Download all as ⋯ rows, and the decision badge shown in the Approve slot.
3. Search with the keyboard up has no frame. Proposal: search focus snaps the sheet to full and the pill stays.
4. A guest's author filter can only key on `kind` plus name (`guest-review.ts:170-174`), so two guests with the same name merge.
5. "Everyone" and search have no desktop control until #881, so the plan resets them at 721px.
6. P1's paused play badge or tap-the-film-to-play is not a Portal capability today. Proposal: the badge is a real `reui/button` that plays.
7. Staff status bar: allow a one-frame document scroll (option 3), or accept the cream bars.
8. P7's draw placeholder copy will always shorten at 390pt.
9. T3 has no eyebrow and no upload help paragraph. Drop them or keep them?
10. "APPROVE (INTERNAL)" at 375pt leaves the title about 90px (`TITLE_FLOOR` 10ch); measure it.

### 7. Split, in order
- **PR 3a, phone chrome bands:** §2, rows 3–6, scope 4; plus row 11 as its own commit (a desktop pass). It changes no data model, so the heights land first.
- **PR 3b, notes head and sheets:** rows 7–8, C11–C13. It sits on 3a's head height.
- **Status-bar spike:** runs in parallel. A small PR follows only after the owner picks.

### 8. Tests
- **DOM tests:**
  - `VideoReviewViewer.phone.dom.test.tsx`: header classes, staff label, plain ⋯, tab alignment and count, ⋯ rows and order, sr-only title, focusable Close, popup focus on open, Version details sheet, copy and paste rows.
  - `VideoReviewViewer.header.dom.test.tsx`: unchanged, as the desktop regression proof.
  - `VideoPlayer.dom.test.tsx`: on a phone, current time only and the ghost play button; desktop still shows the default play and "/ total".
  - `review-pane-geometry.test.ts`: `STAGE_GAP` at 0.
  - `VideoNotes.dom.test.tsx`: phone head with chips, both radio groups, the author menu and search; the desktop head and filters unchanged.
  - New `video-note-view` cases for author and query.
  - `GuestVideoScreen.phone.dom.test.tsx`: outline Approve, ⋯ order and "Download vN", tab head without padding, filters, `phoneFrameStep` false for a writer.
  - New `guest-notes-filter.test.ts`.
  - `fitAtWord` unit test, plus `GuestNotesWrite.dom.test.tsx` (~1535) and `VideoNoteComposer.phone.dom.test.tsx` updated for the placeholder.
  - `ProjectWorkspace.video.dom.test.tsx:229` ("Films" becomes "Video") and `VideoCollectionPanel.dom.test.tsx` for the count.
  - Guards stay green: `ui-primitive-ratchet`, `design-system-guards`, `guest-boundary`, `guest-inverse-contrast`.
- **iOS Simulator rows (iPhone 18 Pro), staff and guest each, every row with its measurement and a screenshot:**

| Row | State | Frame | Measure / check |
|---|---|---|---|
| S1 | Rest, half stop | P1 / P2 | header 56±2, transport ≤80, grabber+tabs ≤70, head about 45–49, composer about 61, list window ≥200 (P2 is 212) |
| S2 | Peek | P3 | collapsed height ≈127 |
| S3 | Full | P4 | film at least the floor |
| S4 | 9:16 film | P5 | film area 65% |
| S5 | ⋯ open | P9 / P10 | no visible title or ✕, no ring, labels carry the Version |
| S6 | Versions open | P8 | — |
| S7 | Open-chip menu open | P1 chip (otherwise the Portal's menus) | — |
| S8 | Everyone menu open | P1 chip | — |
| S9 | Search open | none | — |
| S10 | Search with the keyboard up | none | at least one note row visible, search field above the keyboard |
| S11 | Compose regression | P6 | PR 1/PR 2 strip rows unchanged |
| S12 | Draw | P7 | placeholder never ends "word …" |
| S13 | Bars | — | fresh load versus after Cancel |

  Desktop and tablet: T3 at 1280×800, plus W1 regression at 1280 and 768.
