# PR 3 plan — phone chrome, notes head, collection header

## Baseline and design contract

- Checked `HEAD` and `origin/main` at `d1e12da1`, including PRs #892/#895. Local `main` is behind. No files changed; no tests or browser passes run.
- ReUI plan: **operational / record detail / Frame-led / dense**; regions: header → film → transport → sheet tabs → filters and notes → composer. Preserve loading/error/empty states; add Skeleton loading and Clear filters actions where changed. Keep existing motion.
- All viewer layout changes below are **phone-only, `(width < 721px)`**. Explicit desktop change: collection header. Keep desktop viewer headers, transport, notes controls, details popover and clipboard menu unchanged.

## Frame → component map

| Frame | Visible parts → current implementation |
|---|---|
| **P1 staff half** | Header: `VideoReviewViewer.phoneHeader` → `ReviewPhoneBar`, `VersionChip`, `VideoPhoneApprove`, `VideoReviewHeaderMenu`. Film/transport: `VideoPlayer` → `VideoStage`. Sheet: `ReviewSplit`, `ReviewSheet`; tabs: viewer `layout`; notes/composer: `VideoNotesHost` → `VideoNotesPanel`, `VideoNoteComposer`. |
| **P2 guest half** | `GuestVideoScreen.phoneBar` → shared header/chip/action sheet; guest Approve remains locally gated. Shared player/split/sheet; local Notes tab; `GuestNotesPanel`, `GuestNoteComposer`; `openThreadCount` supplies the count. |
| **P3 peek / P4 full** | Both roles: `useReviewSheet`, `useSheetPane`, `sheetStops`, `ReviewSplit.collapsedHeight`; existing head/body/composer markers control visibility without unmounting editors. |
| **P5 portrait film** | Both roles: stored Version dimensions → `VideoStage`; `filmAspect` → `sheetStops` sets the 65% film-area cap. |
| **P8 Versions** | Both roles: `VersionChip` → `VideoVersionsSheet`, `withSummaries`; staff query versus guest `api.versionSummaries`. |
| **P9 staff ⋯** | `VideoReviewHeaderMenu` → `ReviewActionSheet`, `ActionRow`; existing export submenu and removal confirmation. |
| **P10 guest ⋯** | `GuestVideoScreen` → `ReviewActionSheet`, gated Social/Download/Copy-my-notes rows. |
| **T3 collection** | `VideoCollectionPanel`’s `video-films-header`; Upload, `ReviewLinksOpenButton`, Trash; `VideoGridToolbar` and `VideoCard`/`VideoTile` below. |

## 1. Recover the notes window at rest

Measure each band separately before changing it; the supplied ~116pt/212pt figures are baseline evidence, not measurements made during this plan.

| Band | Source of excess | Planned change and reference |
|---|---|---|
| Header ~85 → **56pt** | `VersionChip` reserves `min-h-11` **under** a body-height title; `ReviewPhoneBar` adds `py-space-1` and has no height ceiling. The source-derived stack is already ≥77px. | Give the phone bar `space-7 + space-2` height; compact the Version chip’s visible box and retain a 44px hit extension. Use defined label/type tokens: `--type-body-sm` currently has no CSS definition. Tighten horizontal gutters/gaps to `space-1`; keep title truncation. |
| Transport ~100 → **78pt** | `VideoPlayer`: 44px Slider control + `gap-space-3` + 44px controls; nonempty marker lane adds another 12px. Player root adds a separate 12px film/transport gap. | Phone root gap 0; scoped compact Slider with a `space-5` visible slot and 44px hit region extending upward; overlay markers within that slot. Controls retain 44px allocation with plain 32px icons. Top `border-width-bold`, gap/bottom `space-1` gives 78px. Verify hit regions do not overlap other actions. |
| Grabber + tabs ~85 → **67pt** | Guest: 24px grabber + 44px tabs + wrapper `py-space-2` + border = ~85px. Staff’s tabbed path is already nearer 69px. | Remove guest tab-wrapper vertical padding; grabber `space-5 − border-width-bold` = 22px; 44px tabs + hairline. Left-align staff tabs, removing trigger `flex-1`; use count chips beside Notes. |
| Composer ~76 → **60–61pt** | Both roles retain list/composer gaps, `pt-space-3`, and outer `p-space-4`; these surround an already compact 44px pill/Send. | Phone browse wrappers: no duplicated vertical padding/gap; composer owns `py-space-2`, one border and the existing 44px controls. Preserve side gutter `space-4`, compose-mode clamps, uploads and notices. |
| Notes viewport ~116 → **~212pt** | Remaining space after these bands; guest delivery controls and staff’s old head also occupy its scroll content. | Measure viewport separately from filter-head and card heights. Match P1/P2 at equivalent usable viewport, without assigning the notes list a fixed height. |

- Files: `ReviewPhoneBar.tsx`, `VideoPlayer.tsx`, scoped `reui/slider.tsx` variant, `ReviewSheet.tsx`, `ReviewPane.tsx`, both viewer screens and notes panels.
- Replace `collapsedHeight`’s hard-coded 24px grabber allowance with its measured height. Recheck `review-pane-geometry.ts`: prototype landscape film area is **308px**, whereas today it uses `width / aspect + transport`; full reserves 200px and portrait uses 65%. Reconcile the reference-size mismatch before declaring height parity.
- Preserve 44px targets using `PILL_ICON` or equivalent scoped extensions into noninteractive space. Measure hit coverage as well as visible rectangles; grabber extensions must avoid transport buttons.

## 2. Fresh-load Safari tint

- **Staff is confirmed** by PR 1’s round-11 ledger: cream persists despite the ink canvas. **Guest shares the mechanism**, but its current reload result needs measurement; the brief’s guest observation should be reproduced.
- `index.html` has no `theme-color`; initially `body` uses cream `--bg-canvas`. `useInkCanvas(phone)` runs only after the lazy staff viewer/guest video screen mounts; it then paints html/body `--ink-800`. A layout effect precedes that component’s paint, not the document’s earlier boot paint.
- The lesson **“Safari tints its bars from the page's edges only after the document scrolls”** records the tint changing after keyboard-induced document scroll. WebKit also describes viewport-edge extension from fixed/sticky content. [WebKit explanation](https://bugs.webkit.org/show_bug.cgi?id=301756#c2)
- First implementation experiment: establish a phone review **boot canvas before deferred application startup**, then hand ownership to `useInkCanvas`; clear it on list/passcode/error/auth outcomes, viewer close and desktop crossing. Candidate files: `index.html`, `main.tsx`, `use-ink-canvas.ts`, `styles/app.css`, guest boot/screen ownership.
- Use existing strict route predicates; preserve fragment scrubbing and the guest boundary. Generate early canvas colour from the Quincy token source, avoiding an independent colour literal.
- Compare early canvas alone with a scoped, restored `theme-color` hint. Safari historically supports that hint, but this does **not** establish its effect on the iOS 27 runtime. [WebKit support documentation](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)
- Gate the fix on untouched fresh-load screenshots, computed html/body colours, runtime version and `scrollY=0`. If correct prepaint ink still leaves cream until scrolling, document the Safari limitation; do not claim success from after-interaction shots or introduce a scroll nudge without owner approval.

## 3. Remaining audit work at the checked base

| Row | Already present | Work left |
|---|---|---|
| **3 header** | Shared two-line header; role gating; guest Approve; approved staff status menu. | Draw **“Approve (internal)”** visibly in `VideoPhoneApprove`, retain uppercase transformation/C20; plain ⋯; compact geometry; align guest Approve treatment to P2. |
| **4 transport** | Single phone control row; guest already hides total through `phoneFrameStep`. | Plain Play; hide total on **every** phone path; compact bands. Full screen/native-player functionality remains #880’s dependency. |
| **5 film** | Phone `ReviewSplit` already uses `p-0`; `VideoStage` has no frame border. | Verify edge-to-edge result; add P1/P2’s centred paused Play affordance, connected to the existing clock, phone-only. |
| **6 tabs** | Correct staff Notes/Delivery and guest Notes-only structure; guest open count fixed by PR 2. | Staff left alignment/count-chip styling; compact guest wrapper; correct staff count for hidden tombstones. |
| **7 notes head** | Staff status/visibility filters and clipboard operations exist. | Phone chips, author filter and search for both roles; move staff details/clipboard actions out of the phone head. |
| **8 ⋯** | Shared action rows, permissions, export and removal flows; guest Copy-my-notes already moved. | C13 rows-only layout, quiet initial focus, version-number labels, staff Copy/Paste rows, Version details after Create Review link. |
| **11 collection** | Short tile status labels already use `REVIEW_STATUS_SHORT` (**C17 done**). | Replace the stacked Films introduction with **Video · N films**, preserving Upload, Review links and Trash. |

- **C14/C15:** retain frame-step fallback when no composer supplies it, and retain the existing picture-timecode policy. Do not remove either while simplifying transport.
- **Notes state:** add phone author/query projection in `use-video-notes.ts`/`video-note-view.ts`; guest equivalent in a guest-safe helper. Keep desktop projection unchanged. Filters operate on root threads; replies remain attached; preserve staff’s pinned active edit/reply.
- Proposed search: case-insensitive matching of loaded root/reply text; no requests or fuzzy ranking. Clear author/query on Version change; clear excluding filters when landing on a linked note. Counts exclude hidden tombstones; tab count stays independent of search.
- **Phone actions:** extract staff clipboard state/actions into a staff-only hook shared by `VideoNotesHost`/`VideoNotesPanel`; expose callbacks through `NotesSlots`. Preserve shown-note copying, paste preview/CAS, capability/archive gates and status notices. Details opens a Sheet using existing `detailsRows`, with explicit focus handoff/return.
- **Collection:** use total live query rows, not filtered `arranged.length`; singular/plural copy; Skeleton while unresolved, no invented zero on error. Match T3’s title/count/actions hierarchy; move upload guidance into the uploader.

## Reuse and guard impact

- Open chip: installed `quincy/Menu` + Base UI radio groups, following `VideoReviewStatusPill`; labelled status group and staff-only visibility group. Everyone: installed `reui/Select`, adapted as a chip. No new segmented toggle row.
- Search: installed `reui/Input` (`type="search"`) plus ghost icon Buttons; replace the filter row while open. Its focus must **not** enter composer mode or hide the notes body.
- Count chip: installed `Badge variant="secondary"`; preserve default size and ≥12px type. Actions/Versions/details: installed Sheet, Item, Button and existing Quincy wrappers.
- `ReviewActionSheet`: sr-only title, visually hidden Close, popup initial focus with the approved container-focus treatment; retain keyboard row focus and Escape/backdrop/return-focus behaviour. P8 keeps its modest visible **Version** heading.
- No new raw controls/widget roles outside the component layers; **`ui-primitive-allowlist.ts` should remain unchanged**. Shared primitive changes require scoped variants/adaptation notes. ReUI MCP was unavailable; installed APIs and the permitted local reference were inspected.

## Owner gates — settle before dependent build

- **Guest author identity:** public DTOs expose `{kind,name,self}`, not stable person IDs. Recommend opaque guest-safe author keys through a compatible read; alternatively explicitly accept same-name grouping. Do not silently equate names with people or add fields to strict deployed payloads.
- **Guest delivery capabilities:** P2 omits Request changes, delivery badges, Download all and their notices. Recommend action rows for Request changes/Download all and quiet status content after notes; owner chooses placement before removing today’s delivery row.
- **Geometry/accessibility:** approve compact Slider/grabber hit extensions and responsive extrapolation of the prototype’s fixed 308px landscape reference. Keep guards intact.
- **Boot canvas:** review URLs may initially show passcode/list/auth/error screens. Approve the provisional dark boot treatment and restoration rules; actual Safari tint remains a measured gate.
- Prototype `visibleNotes` still renders resolved notes beneath the inert Open chip. Confirm functional Open-default filtering for guests. Search-open layout is also an extension: recommend replacing the chip row in place.

## Verification

- Change `VideoReviewViewer.phone.dom.test.tsx`, `.header.dom.test.tsx`, `.review-status.dom.test.tsx`: labels, plain trigger, action order/gates, details/clipboard handoffs, approved-menu preservation.
- Change `VideoPlayer.dom.test.tsx`—including its current “without frame steps … keeps its total” test—and `ReviewSheet.dom.test.tsx`; add `ReviewPhoneBar.dom.test.tsx`/`ReviewActionSheet.dom.test.tsx` for focus, close and shared structure.
- Extend `VideoNotes.dom.test.tsx`, `video-note-view.test.ts`, `GuestNotesWrite.dom.test.tsx`, `GuestVideoScreen.phone.dom.test.tsx`, `guest-compose.test.ts`: status/author/search combinations, zero/tombstones, pinned edits, counts, Version changes, keyboard ownership and duplicate-name gate.
- Extend `VideoCollectionPanel.dom.test.tsx`/`.grid-toolbar.dom.test.tsx`: total versus filtered count, singular/zero/loading/error, preserved actions.
- **Minor placeholder:** `REST_CLAMP` applies CSS ellipsis to the pseudo-element’s original placeholder, so clipping can leave whitespace before an inserted ellipsis. For rest placeholders only, render a measured fitted string with `trimEnd()` before one ellipsis; retain the full compose placeholder and untouched draft. Share through `compose-strip.tsx`/`QuincyRichTextEditorBase.tsx`; test space-boundary widths, drawing copy and font/width changes in editor DOM tests plus Simulator screenshots.
- Add ink-canvas boot/handoff/cleanup tests. Run guest-boundary, primitive-ratchet, design-system/container-focus guards; ReUI self-checks; relevant DOM/unit suites; then `npm run verify`. DOM tests prove behaviour, not pixel heights or Safari chrome.

## Browser-pass matrix

Run **each row for staff and guest**, using iPhone 18 Pro Safari through `serve-branch.sh`/`ios-pass.sh`; save role/state/frame-named screenshots in one folder. Record usable viewport and actual band heights beside every PASS/FAIL.

| State | Frame | Height measurement |
|---|---|---|
| Fresh reload, untouched rest | P1 / P2 | Header 56; transport 78; grabber/tabs 67; composer ~60–61; notes ~212 at reference viewport; bar colours before scroll. |
| Peek | P3, guest role adaptation | Collapsed sheet = measured grabber + tabs + composer (~127–128); body hidden. |
| Full sheet | P4, guest adaptation | Sheet height; film-area reserve ~200; controls remain visible. |
| Portrait film at half | P5, guest adaptation | Film area 65% of available space; notes/composer heights. |
| ⋯ open | P9 / P10 | Sheet/row heights, no visible title/Close; long action list scrolls above safe area. |
| Versions open | P8, guest adaptation | Heading/row/sheet heights; date/count/status and focus return. |
| Open and Everyone menus | P1 / P2 extensions | Filter-head height, popup bounds, ≥44px choices; no added permanent band. |
| Search open, keyboard down | P1 / P2 extension | Replacement-head height and remaining list viewport. |
| Search typing, keyboard up | P1 / P2 extension | Root equals visual viewport; search/results visible; composer mode unchanged; no overlap. |
| Compose → Cancel | P6 → P1/P2 | Existing strip/film floor preserved; restored bands, draft policy and Safari tint recorded. |

Desktop/tablet browser rows: 721, 768 and 1280px, including boundary crossing and T3 header height/actions; compare viewer against the unchanged baseline. Session judges screenshots first; blind design-reviewer judges the same evidence next.

## Suggested delivery order

1. Commit: compact phone bands, tabs, transport, header copy and paused Play; collection header.
2. Commit: staff notes chips/search and action relocation; guest counterpart after identity/delivery decisions.
3. Commit: placeholder correction and approved Safari boot experiment, with measured results and lesson update.
4. If split into PRs, ship geometry/header/T3 first; notes/actions second; keep Safari isolated until its fresh-load gate passes.