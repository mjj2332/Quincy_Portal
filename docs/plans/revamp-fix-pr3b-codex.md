1. **Contract and frame map**

   Base: `68c584ed`. Implementation paths below are under `portal/apps/web/src/`. Visual changes apply only below 721px; shared model and clipboard refactors serve every width.

   ReUI plan: operational surface; record-detail archetype; existing Frame-led viewer; compact controls; notes filter → threads → composer, with action/Versions/details Sheets; loading Skeleton, actionable empty state, inline error/Retry; installed motion only.

   | Frame / visible part | Staff renderer after PR | Guest renderer after PR |
   |---|---|---|
   | P1 / P2 status chip, author chip, search | `VideoNotesPanel` → `quincy/NotesFilterHead` inside notes scroll | `GuestVideoScreen` supplies `NotesFilterHead` as `GuestNotesPanel.header` |
   | P1 / P2 menus and inline search replacement | `NotesFilterHead`, controlled by notes session | Same component, controlled by guest screen |
   | P1 / P2 remaining chrome | Existing `ReviewPhoneBar`, player, tabs, `ReviewSplit`, composer | Same existing shared chrome; decision badge replaces Approve after either decision |
   | P8 title, Version rows, metadata, current check, hidden Close | `VideoVersionsSheet` | Same component, granted Versions only; no staff status |
   | P9 sheet shell, hidden title/Close | `ReviewActionSheet` | — |
   | P9 Social, Download vN, marker export, Copy link, Create Review link, Version details, Copy/Paste, Remove vN… | `VideoReviewHeaderMenu`; existing export submenu; details Sheet owned above menu; clipboard from `NotesSlots` | — |
   | P10 shell; Social, Download vN, Copy my notes, Request changes…, Download all | — | `ReviewActionSheet` / `ActionRow`, composed by `GuestVideoScreen`; existing guest controllers own verification/dialogs |
   | P2 quiet trailing notices, identity/email | — | `GuestNotesPanel.footer`, inside phone notes scroll |

2. **Commit 1 — pure filtering and state ownership**

   - `lib/video-note-view.ts`: extend `NoteFilters` / defaults with `author: string | null`, `query: string`; add author-key/options and search helpers; extend `visibleThreads` and `noteCounts`.
   - Staff author keys use kind plus stable identity: staff person ID or guest ID. Author options come from roots of all loaded, listable threads, independently of current filters; reply-only authors are searchable but are not author-menu options.
   - Query matching is trimmed, case-insensitive literal matching across root/reply bodies and author names; retain matching threads with their replies. Deleted bodies contribute no searchable text.
   - Status counts apply visibility + author + query; visibility counts apply status + author + query. `totals` remain independent of every filter, preserving the Notes tab’s open count.
   - Continue excluding hidden tombstones: deleted roots without replies. Tombstones retaining replies keep existing list/count semantics; replies never increase root counts.
   - `components/video/use-video-notes.ts`: retain filter ownership here, tag filters by Asset ID, reset on Version change before deriving `shown`; reset at phone→desktop crossing so invisible phone filters cannot affect desktop.
   - Extend linked-note landing: if hidden by any filter, reveal it with status/visibility All, author Everyone and empty query before selection/scroll. Preserve once-per-Version/note landing and drawing locks.
   - `guest/guest-notes-filter.ts`: pure guest DTO helpers for defaults, status/author/query matching, counts and root-author options; no staff session, API, query cache or store imports.
   - Guest author keys encode `[kind, name]`; same-name guests merge, studio and guest names remain distinct. No DTO/API change.
   - `GuestVideoScreen`: own Version-tagged guest filters; reset on effective Version/Video change and desktop crossing. Apply filtering on phone only; desktop retains today’s unfiltered guest list.
   - Staff markers continue following `shown`; guest markers follow the filtered set on phone while preserving existing marker eligibility.
   - Preserve staff edit/reply pinning in `VideoNotesPanel.listed`. Guest pin membership reacts to `drafts.subscribe/get` for `edit:<root>` / `reply:<root>` plus `compose.editingId`; retain roots in original order without remounting their forms. Pins do not alter counts or markers.

3. **Commit 2 — shared phone notes head**

   - Add staff-free `components/quincy/NotesFilterHead.tsx`: receive plain values, counts, author options and callbacks; optional visibility controls identify capability without importing staff modules.
   - Start chip triggers from installed `reui/button`: additive `size="chip"` with adaptation note, sentence case, normal tracking, token pill radius, 28px drawing and 44px pseudo-element hit target. Other Button sizes retain their casing and geometry.
   - Start menus from installed `reui/dropdown-menu`: named radio groups for status and author; staff status menu adds a separator and visibility radio group. Use touch-height rows and the viewer’s `OverlayContainerContext`.
   - Preserve Base UI keyboard/typeahead behavior; explicitly test synchronous trigger focus return when dismissing menus inside the viewer.
   - Start search from installed `InputGroup`, `InputGroupInput`, `InputGroupAddon`; Search/X from lucide and installed Button/InputGroupButton. Add only necessary scoped search/touch variants with adaptation notes; keep existing callers unchanged.
   - Search replaces the row in place. Focus the mounted input during the opening interaction; X or Escape clears query, closes search and returns focus to Search. Consume that Escape before the viewer handles it.
   - Keep the head under `data-sheet-part="body"`, outside the composer slot: `ReviewPane.isComposerField` already distinguishes them. Search must not stamp/pause a draft, set compose holds or hide transport.
   - `VideoNotesPanel`: phone renders the new head instead of counts/details, ToggleGroups and notes ⋯; desktop renders the existing controls. Rebind `useHairlineWithHead` from the removed counts span to a stable head measurement element across chips/search.
   - `GuestNotesPanel`: distinguish no loaded notes from no filter matches; provide Reset filters for the latter. Keep composer and footer placement; retain loading/error semantics with phone Skeletons and Retry.
   - `config/ui-primitive-allowlist.ts`: unchanged; all new controls compose installed primitives. No additions or increased allowances.

4. **Commit 3 — lift staff clipboard, preserve every-width behavior**

   - Add `components/video/useNotesClipboard.ts`, called once by `VideoNotesHost`.
   - Move `canCopy`, clipboard/paste subscriptions, `pasteFrom`, copy handler, paste opening, copy-result state and six-second notice timers from `VideoNotesPanel`; keep Version-scoped transient results from leaking across switches.
   - Extend `NotesSlots` with the clipboard controller: availability, disabled state, `copyShown`, paste label and opening callback. Pass the same controller to the panel and phone header.
   - Desktop Notes actions keep calling that controller through their existing menu; marker export stays on its existing controller.
   - Copy uses `session.shown`, excluding filter-pinned extras; retain store truncation at `VIDEO_NOTE_PASTE_MAX` and existing feedback.
   - Derive `Paste N note(s) from vX…` from the stored clipboard IDs/sourceVersion; offer it only for another Version of the same Video.
   - Host `VideoNotePasteDialog` above the panel/action-sheet lifetime, keyed by target Asset. Keep form-store preview, offsets, unticks, CAS revisions, operation ownership and stale-response handling intact.
   - Capture a stable return destination when opening: desktop notes ⋯ or phone header ⋯. Phone row uses `close(true)`; dialog dismissal returns to the header trigger.
   - Preserve annotate/archive gates and existing status notices; no guest import reaches this hook.

5. **Commit 4 — action sheets, Version details, P8**

   - `ReviewActionSheet`: sr-only title with no visible header gap; focus popup through `initialFocus={popupRef}`; add container-only `focus-visible:!outline-none`. Controls retain focus indicators.
   - Extend `SheetCloseButton` with an opt-in hidden presentation (`sr-only focus-visible:not-sr-only`); remove unused close clearance for these sheets. Other callers retain the visible default.
   - Preserve synchronous ordinary focus return, `close(true)` handoff, forced nested scrim and inverse portal container.
   - `VideoReviewViewer`: pass Version number, details content and clipboard slots through `phoneHeader`; own a sibling details Sheet using existing `detailsRows`, without new reads. Close stale details on Version change.
   - `VideoReviewHeaderMenu`: visible Download vN / Remove vN… labels; Version details immediately after Create Review link’s position, independently of permission to create links; Copy/Paste before the destructive separator. Retain export, removal and archive gates.
   - Details starts from installed `reui/sheet` and existing Item rows; close actions before opening details, then return to header ⋯. Existing desktop details Popover remains unchanged.
   - `VideoVersionsSheet`: label-token “Version” title, hidden focusable Close, one flex-nowrap row per Version: number/latest left; date, open count, staff latest status and check right. Reuse Item/ItemActions/Button; preserve selection, summary reads and chip focus return.
   - Shared Item adaptations, if required, are additive named variants with notes; do not globally change ItemTitle wrapping or typography.

6. **Commit 5 — guest delivery relocation**

   - `GuestVideoScreen`: phone removes `deliveryRow` from the head; desktop retains its current controls, badges, hints and placement.
   - Split decision rendering in `GuestDeliveryChips.tsx` so either recorded decision occupies the phone Approve slot once, including archived/approval-disabled states. Undecided Approve still follows `canDecide`.
   - P10 keeps Social → Download vN → Copy my notes ordering; add Request changes… under existing decision gates and Download all under existing multi-video/download gates. Sheet visibility includes these new eligible actions.
   - Reuse existing verification continuations, decision dialogs and download anchors; opening a dialog uses focus handoff.
   - Extract Download all’s controller from `GuestDownloadAll.tsx` into `use-guest-download-all.tsx`; keep the existing wrapper for other callers. Screen owns one controller, chooses desktop button or phone ActionRow, and mounts its dialog outside the closing action sheet.
   - Preserve manifest/retry/preparation polling, generation fences, disabled-download notice and explicit download click. Put phone download hints, decision/paste notices and disabled-download feedback at the scroll end with identity/email rows.

7. **Owner conflicts to settle during synthesis**

   - Search keyboard-up has no prototype frame: choose stop behavior and restoration. Recommend full while searching, restore the previous stop on close; compose mode remains forbidden. Validate field, list and composer visibility on iOS before accepting it.
   - Removing the phone delivery row leaves the existing Released badge without a specified destination. Owner must choose its home; do not silently discard it or place it beside the new head.
   - D35/ADR 0025 describe no-code Delivery-link downloads; current `GuestVideoScreen` verifies unverified downloaders. This PR relocates existing behavior; implementing the missing capability requires explicit scope assignment.
   - “Open in iPhone player” belongs to #880. Record its absence from P9/P10 as the known deferred capability.
   - If full P8 metadata/status cannot fit one line at the tested phone width, report measured overflow for an owner truncation/format ruling; do not silently omit facts.

8. **Tests and completion gates**

   - `lib/video-note-view.test.ts`, new `guest/guest-notes-filter.test.ts`: combined axes, root-only author options, reply-body/name search, casing/whitespace, tombstones, counts independent of their own axis and unfiltered totals; guest name collisions/kind separation.
   - New `quincy/NotesFilterHead.dom.test.tsx`: both radio menus, optional visibility group, selected labels/counts, search replacement, X/Escape, focus return and no composer activation.
   - `VideoNotes.dom.test.tsx`: Version/crossing resets, pinned edit/reply under author/query changes, filtered copy, clipboard limit/labels, desktop menu, paste stale/CAS/remount/late-result cases.
   - `VideoReviewViewer.deep-link.dom.test.tsx`: landing through author/query/status/visibility exclusions; selection, scroll and seek occur correctly.
   - `VideoReviewViewer.phone.dom.test.tsx`, new `ReviewActionSheet.dom.test.tsx` / `VideoVersionsSheet.dom.test.tsx`: popup initial focus, named hidden title/Close, Tab/Escape, details/paste handoffs, Version labels/order/gates and P8 content.
   - `GuestVideoScreen.phone.dom.test.tsx`, `GuestNotesWrite.dom.test.tsx`, `GuestDelivery.dom.test.tsx`: filters/pins, decision-slot states, moved rows/footer, verification continuations, Download all surviving sheet close and desktop behavior.
   - Keep `VideoReviewViewer.header.dom.test.tsx` and marker-export regressions green; extend `container-focus.guard.test.ts` for focused review Sheet containers.
   - Guards: guest-boundary, guest-inverse-contrast, ui-primitive-ratchet, design-system, ReUI skin/registry, sheet-width, overlay-stacking, Base UI patch and test-seam. No weakened expectations.
   - Run focused unit/DOM tests, ReUI C1–C4 self-checks (maximum two repair rounds), then `npm run verify` from `portal/`. Planning session runs no tests or browser passes.

9. **Browser matrix — session measures, then blind design-reviewer judges**

   Serve through `serve-branch.sh`; launch iPhone 18 Pro Safari with `ios-pass.sh`. Use human-authenticated sessions; save every screenshot in one folder, named by role/viewport/state. Record server PID/cwd/HEAD/bundle before and after, measurements, frame and screenshot per PASS/FAIL row; focus captures require `document.hasFocus()`.
   
   | Rows, repeated for staff and guest | Frame / measurements |
   |---|---|
   | Rest, half stop | P1 / P2: one filter row ≈45–48px, sentence-case chips, 44px non-overlapping targets; old phone head absent; PR3a bands unchanged |
   | ⋯ open | P9 / P10: rows-only geometry, Version labels, permitted order, no initial row/container ring; hidden Close appears on keyboard focus; dialogs survive handoff |
   | Versions open | P8, guest equivalent: label title, single-line rows, metadata/check fit, no visible Close at rest, chip focus return |
   | Open menu | P1 / P2 extension: status counts/selection; staff visibility group; 44px rows, no clipping, dismissal focus |
   | Everyone menu | P1 / P2 extension: loaded root-author options, long-name fit, selected author and kind/name behavior |
   | Search open, keyboard down | P1 / P2 extension: chips replaced at the same position, field/X reachable, browse mode and transport retained |
   | Search typing, keyboard up | P1 / P2 extension, no dedicated frame: actual keyboard/visual-viewport bounds, visible field/X/results, agreed stop behavior, no compose transition or Safari zoom |
   | Search dismissal | P1 / P2: real keyboard dismissal, long query, X/Escape, restored row/stop, preserved draft and no stranded inert/focus state |
   | Desktop/tablet at 721 / 768 / 1280 | W1 staff and guest counterpart: no phone head/sheets; original status/visibility controls, counts, details Popover, clipboard/export, delivery controls, transport and pane behavior; no hidden author/query filter |