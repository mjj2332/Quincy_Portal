# Settled plan — PR 3b of the revamp fix: notes filter head and ⋯ sheets

Synthesis of two blind plans from `revamp-fix-pr3b-brief.md`: Opus (deep-reasoner, base for
file:line, recorded in this session's transcript) and `revamp-fix-pr3b-codex.md`. They agree on every
mechanism; where this file and a raw plan differ, this file wins. Base `68c584ed` (PR 3a merged).
Paths under `portal/apps/web/src/`. Visual changes are phone-only (`< 721px`); the model, the
clipboard lift and the vendored variants are every-width code with no desktop-visible change.

## Frame → component map

| Frame · part | Staff | Guest |
|---|---|---|
| P1/P2 notes head (inside the list scroll, `data-sheet-part="body"`) | new `quincy/NotesFilterHead.tsx`, in place of `VideoNotesPanel` `headerRow` + `filtersBlock` on the phone | same component as `GuestNotesPanel`'s `header`, in place of `deliveryRow` on the phone |
| "Open · N ⌄" menu | `reui/button size="chip"` + `reui/dropdown-menu` radio: Open / Resolved / All (counts), separator, All / Client-visible / Internal (C9) | status group only |
| "Everyone ⌄" menu | radio: Everyone + root authors of loaded threads (key `staff:<id>` / `guest:<id>`) | same, key `kind:name` from `guest/guest-notes-filter.ts` |
| Search → field + X | ghost icon `reui/button` → `reui/input-group` default variant (`InputGroupInput type="search"`, Search addon, `InputGroupButton` X), replaces the chips in place | same |
| P2 decision in the Approve slot | — | `DecisionBadge` split out of `GuestDeliveryChips` into `ReviewPhoneBar`'s `approve` once decided |
| P2 quiet line (end of notes scroll) | — | `GuestNotesPanel` `footer`: Released, hints, decision / paste notices, downloads-off, then identity and email rows |
| P8 Versions | `VideoVersionsSheet` | same |
| P9 ⋯ | `VideoReviewHeaderMenu` → `quincy/ReviewActionSheet` | — |
| P10 ⋯ | — | `GuestVideoScreen` → `ReviewActionSheet` |
| Version details (C12, no frame) | new `video/VideoDetailsSheet.tsx`: `reui/sheet` bottom of existing `detailsRows` | — |

## Commits, in order

1. **Model** (`lib/video-note-view.ts`): `NoteFilters` gains `author: string | null` and
   `query: string | null` (`null` = search closed). `authorKey`, `matchesQuery` (trimmed,
   case-insensitive literal over root body, live reply bodies, author names; deleted bodies
   contribute nothing), `noteAuthors` (live roots only, sorted). `visibleThreads` honours both;
   `noteCounts` counts each axis under the others; `totals` ignore all four (tab count unchanged).
   Hidden tombstones stay excluded. Desktop always holds `null`/`null`.
2. **Resets** (`use-video-notes.ts`, takes `phone`): in render (lesson "Escape needs an order…"),
   clear author/query on Version change and when `phone` turns false; status/visibility persist as
   today. A chosen author with no roots left reads as Everyone. Linked-note landing opens every
   filter. Successful `post` clears author/query (C7: the sent note is listed).
3. **`video/use-notes-clipboard.tsx`** (staff only, called once in `VideoNotesHost`): moves
   `canCopy`, clipboard / `pasteFrom`, paste open / result, the timed status (keyed by `assetId`),
   `copyShown` (copies `session.shown`, not pinned extras), `openPaste`, and renders
   `VideoNotePasteDialog` above the panel and sheet lifetime; `finalFocus` is the header ⋯ on the
   phone and the notes ⋯ on desktop. `NotesSlots` gains `clipboard`. Desktop menu calls the same
   controller. Gates unchanged: `annotateVideo`, archived, preview/CAS, `VIDEO_NOTE_PASTE_MAX`.
4. **`NotesFilterHead` + variants**: `reui/button` `size="chip"` (adaptation note): `h-7`, pill
   radius, `normal-case tracking-normal [font:var(--type-label)]`, `gap-[var(--space-1)]`, 44px
   vertical `after:` hit area inside the row's `py-[var(--space-2)]`; used `variant="outline"`,
   chevron `size-3`. Menus portal through `OverlayContainerContext`; items `max-[721px]:min-h-11`;
   counts in `DropdownMenuShortcut`; author list scrolls past `max-h-[min(50dvh,…)]`. Search: X and
   Escape clear and close and return focus to the Search icon; Escape is consumed before the
   viewer's handler (`data-notes-search`). Search focus never enters compose mode (field is outside
   `[data-sheet-part="composer"]`); player keys skip it. Controlled, staff-free, imports only
   `reui/*` + lucide. Empty state while filtered: "No notes match." + Reset filters action.
5. **Staff phone head**: `VideoNotesPanel` phone renders `NotesFilterHead`; drops `headerRow`,
   ToggleGroups and notes ⋯ on the phone only. Rebind `useHairlineWithHead` to the head element.
6. **Guest filter**: pure `guest/guest-notes-filter.ts` (`@quincy/shared` types only):
   `{status, author, query}`, `kind:name` keys (same-name guests merge), pinned ids (compose
   `editingId` ∪ `edit:`/`reply:` drafts via `useSyncExternalStore`) survive every filter,
   tombstones excluded. `GuestVideoScreen` owns it, resets on Version change and desktop crossing;
   filtering and markers follow it on the phone only. Desktop guest list unchanged.
7. **Sheet chrome** (`ReviewActionSheet`, `VideoVersionsSheet`, `VideoDetailsSheet`): bare
   `SheetTitle className="sr-only"`, no header clearance; `initialFocus={popupRef}`;
   `focus-visible:!outline-none` on the popup + `container-focus.guard.test.ts` entries;
   `SheetCloseButton` gains opt-in `visuallyHidden` (`sr-only`, shown on `focus-visible`). Other
   callers unchanged.
8. **P9 rows** (`VideoReviewHeaderMenu`): Social preview, Download vN, Marker export…, Copy link,
   Create Review link, Version details, Copy shown notes, Paste N notes from vX…, rule,
   Remove vN…. Visible label is the accessible name (drop the `aria-label` override). Version
   details exists only when notes slots exist and closes on Version change; focus returns to ⋯.
9. **P10 + guest delivery**: phone drops `deliveryRow`; desktop keeps it. Request changes… row
   (`close(true)` then `startDecision`), Download all row via a `use-guest-download-all` controller
   extracted from `GuestDownloadAll.tsx` (wrapper kept for desktop), its dialog mounted outside the
   sheet. Decision badge in the Approve slot. Quiet line as mapped.
10. **P8 polish**: "Version" in `type-label` `text-foreground-secondary`; hidden Close; one-line
    rows (`ItemTitle` left; "date · N open[ · status]" + check right in `ItemActions`).

Allowlist unchanged (no raw primitives). Desktop proof: `.header.dom.test.tsx`,
`VideoNotes.dom.test.tsx` desktop cases, `GuestDelivery.dom.test.tsx` unchanged.

## Owner decisions

Asked 2026-10-16:

- **Guest approve after Changes requested:** the header shows the "Changes requested" badge; the
  ⋯ sheet carries an **Approve** row whenever the decision is not Approved (under `canDecide`).
- **Search with the keyboard up:** opening search snaps the sheet to **full**; closing search
  restores the previous stop (an `onSearchOpen`/`onSearchClose` from the viewer through the host;
  guest the same through `GuestVideoScreen`).
- **Staff chip names a visibility filter:** "Open · Internal · N" / "Open · Client-visible · N"
  when one is set; "Open · N" otherwise. Same pattern for Resolved / All.
- **Guest phone default is Open** (resolved hidden until chosen); desktop guests unchanged.

Session defaults (no frame; flagged in the PR): Released is the first item of the quiet line.
Guest ⋯ order: Social preview, Download vN, Download all…, Copy my notes…, rule, Approve,
Request changes…. ⋯ rows follow P9's `.arow` (50pt, body type) through a scoped
`ReviewActionSheet` row size in tokens; the builder stops if no token fits.

## Tests

Unit: `video-note-view.test.ts`, new `guest-notes-filter.test.ts`. DOM: new
`NotesFilterHead.dom.test.tsx`, `VideoNotes.dom.test.tsx` (phone head, resets, pinned reply under
search, search stays browse, I/O/Space in search don't mark), `VideoReviewViewer.phone.dom.test.tsx`
(P9 rows/order/labels, hidden title/Close, popup initial focus, details and paste focus return,
Escape in search), `.deep-link` (landing through every filter), `.trash` / `.download` (new
names), `GuestVideoScreen.phone.dom.test.tsx`, `GuestDelivery`, `GuestPaste`, `GuestNotesWrite`.
Guards green: ui-primitive-ratchet, design-system, guest-boundary, guest-inverse-contrast,
reui-registry, container-focus, quincy `Button.dom.test.tsx`.

## Browser pass (staff and guest; iPhone 18 Pro Safari via `ios-pass.sh`)

⋯ open (P9/P10) · Versions (P8) · Open menu (P1/P2: chip 28 drawn / 44 hit, head 45±2, items ≥44)
· Everyone menu · search open keyboard down (head ±2, browse kept) · search typing keyboard up
(field + ≥1 row visible, no compose strip) · search dismissal (X / Escape, draft kept) · rest
regression of 3a bands. Desktop W1 at 721 / 768 / 1280 in the built-in browser, against `main`.
