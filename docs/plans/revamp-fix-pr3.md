# Settled plan — PR 3 of the revamp fix: phone chrome, notes head, collection header

Synthesis of `revamp-fix-pr3-opus.md` (base: frame map, per-band arithmetic, file:line) and
`revamp-fix-pr3-codex.md`, planned blind from `revamp-fix-pr3-brief.md`. The two agree on every
mechanism; where this file and a raw plan differ, this file wins. Paths are under
`portal/apps/web/src/`. Every viewer change is phone-only (`< 721px`); the T3 header is the one
change at every width. Desktop viewer, transport, notes controls, details popover and clipboard
menu must not change.

## Split

- **PR 3a — phone chrome** (this branch): scope 1 bands, rows 3–6, the paused play badge, the
  placeholder fix, row 11 (T3) as its own commit. No data-model change.
- **PR 3b — notes head and sheets**, on 3a: row 7 (chips, author filter, search), row 8 (⋯ sheet
  rows-only, Version details, Copy/Paste rows, guest delivery rows), P8 polish.
- **Status-bar spike** in parallel, no merge: measured on the Simulator, then a small PR only after
  the owner picks.

Frame → component map: Opus §1 (staff | guest columns), Codex's table agrees.

## PR 3a

**Header (P1/P2, ~77–85 → 56pt)** — `quincy/ReviewPhoneBar.tsx`: bar height `--space-7 + --space-2`
(56), no vertical padding, `--space-1` gutters and gaps, title truncates. `VersionChip` drawn compact
(`h-5`) with an `after:` 44px hit area into the non-interactive title/bar (the `PILL_ICON` /
`STRIP_TEXT_BUTTON` pattern), clipped to the bar. Approve drawn `min-h-8` with the same vertical hit
extension. Staff label visibly "Approve (internal)" (uppercase per C8, keep C20 status menu); guest
Approve `variant="outline"` per P2. ⋯ (`quincy/ReviewActionSheet.tsx` trigger) becomes a plain
`reui/button` ghost icon, lucide `Ellipsis`, 44px target. Measure the guest's extra 8pt with
`getBoundingClientRect` before assuming its source. Measure the title room at 375pt with the long
staff label; report if under ~90px rather than shortening copy silently.

**Transport (~100 → ~78pt)** — `quincy/VideoPlayer.tsx`: phone section gap and transport gap 0;
scrubber band `--space-6` with a scoped slider (`reui/slider.tsx` variant + adaptation note) whose
touch band extends to 44px via `after:`; marker lane (`VideoTimelineMarkers`) absolutely inside the
band; control row 44px allocation with plain 32px icons; `--space-1` bottom. Play: `ghost`, not the
cream default fill. Readout: current time only on every phone path. Guest `phoneFrameStep` gated as
staff (C14: true only when no composer carries frame step). `STAGE_GAP` in
`lib/review-pane-geometry.ts` to 0 (phone geometry). ⤢ stays #880's. Check hit areas do not overlap
the grabber.

**Sheet head (~85 → ~67–70pt)** — drop the guest tab wrapper's `py-[var(--space-2)]`
(`guest/GuestVideoScreen.tsx`); grabber per Codex (`--space-5 − --border-width-bold`) if it holds
the drag target, and `collapsedHeight` uses the measured grabber, not a hard-coded 24. Staff tabs
left-aligned (`justify-start`, triggers `flex-none` at the call site); count chip beside Notes
(`reui/badge` secondary default size; fall back to a token span only if Badge grows the row). Staff
tab count = `noteCounts(...).totals.open` (excludes hidden tombstones).

**Composer band (~76 → ~61pt)** — browse mode only: composer `py-[var(--space-2)]` owning one
border; list `pt-0`, list/composer gap 0; side gutter `--space-4` kept. PR 1/2's
`in-data-[mode=compose]` classes untouched.

**Film (row 5)** — verify edge to edge on the Simulator. **Owner: add P1's centred play badge on
the paused film, phone only**: a real `reui/button` that plays, hidden while playing, drawing or
composing.

**Placeholder (scope 4)** — rest placeholder only: a pure `fitAtWord(text, fits)` drops whole
words, `trimEnd()`, appends one "…"; measured by a ResizeObserver on the pill's text box with the
computed font. Typed drafts keep the CSS ellipsis; compose placeholder unchanged. Shared through
`components/quincy/compose-strip.tsx`.

**T3 (row 11)** — `VideoCollectionPanel.tsx` header: title "Video", count "N films" / "1 film" from
the total live rows (not filtered), Skeleton while loading, nothing on error; keep Upload, Review
links, Trash (C18). Drop the eyebrow; move the upload help into the uploader if it has a home,
otherwise report.

**Tests (3a)**: `VideoReviewViewer.phone.dom.test.tsx` (header, label, plain ⋯, tabs, count),
`.header.dom.test.tsx` unchanged (desktop proof), `VideoPlayer.dom.test.tsx` (phone current-time
only, ghost play; desktop keeps "/ total" — update the "without frame steps keeps its total" case
for phone), `review-pane-geometry.test.ts`, `ReviewSheet.dom.test.tsx`,
`GuestVideoScreen.phone.dom.test.tsx` (outline Approve, head padding, `phoneFrameStep`),
`fitAtWord` unit + `GuestNotesWrite` / `VideoNoteComposer.phone` placeholder cases,
`ProjectWorkspace.video.dom.test.tsx` and `VideoCollectionPanel.dom.test.tsx` (T3). Guards green:
ui-primitive-ratchet, design-system, guest-boundary, guest-inverse-contrast. Allowlist unchanged.

## PR 3b (planned; build after 3a's pass)

- New `components/quincy/NotesFilterHead.tsx`, staff-free: one row inside the list's scroll.
  "Open · N ⌄" (`reui/dropdown-menu` radio: Open / Resolved / All with counts; staff adds
  All / Client-visible / Internal, C9). "Everyone ⌄" (radio: Everyone + root authors of loaded
  threads). Search icon replaces the chip row in place with a `reui/input-group` search field and a
  clear X (C10: client-side, root + reply bodies and author names); search focus must not enter
  compose mode. Chip triggers: scoped `reui/button` `size="chip"` with a 44px `after:` hit area.
  **Owner: chips are sentence case** (C8 still holds for buttons and badges).
- Staff model: `NoteFilters` gains `author`, `query`; `visibleThreads`/`noteCounts` honour them;
  reset on Version change and at the desktop crossing; phone drops the old head row, toggle groups
  and notes ⋯. Guest model: `guest/guest-notes-filter.ts`. **Owner: guest authors key on kind +
  name** (same-name guests merge; no API change).
- ⋯ sheet (C11–C13): sr-only title, visually hidden focusable Close, `initialFocus` on the popup,
  "Download vN", "Remove vN…", Version details row after Create Review link (Sheet of `detailsRows`),
  Copy / Paste notes rows (clipboard lifted into a staff-only hook exposed via `NotesSlots`).
- **Owner: guest delivery** — Request changes… and Download all become ⋯ rows; the decision badge
  takes the Approve slot once decided; hints and notices are a quiet line at the end of the notes
  scroll (with the identity / email rows).
- P8: label-type title, hidden Close, one-line rows.

## Status-bar spike

No `theme-color` in `index.html`; `data-ink-canvas` is set only once the viewer mounts, after the
cream boot paint; Safari re-samples only on a document scroll (lessons: "Safari tints its bars from
the page's edges only after the document scrolls"). Try, staff and guest, fresh load at `scrollY=0`:
(1) an ink boot canvas set before app start for phone review URLs, handed to `useInkCanvas`;
(2) a scoped `theme-color`; (3) a one-frame document scroll — owner approval needed before (3)
ships. Report with screenshots; if in-page cannot fix staff, say so.

## Simulator rows (iPhone 18 Pro Safari, staff and guest, measurement + screenshot each)

S1 rest/half (P1/P2): header 56±2, transport ≤80, grabber+tabs ≤70, composer ~61, list ≥200 ·
S2 peek (P3) · S3 full (P4) · S4 9:16 (P5) · S5 paused badge (P1) · S6 compose → Cancel regression
(P6) · S7 draw placeholder (P7) · S8 bars on fresh load (no frame). 3b adds ⋯ open (P9/P10),
Versions (P8), each menu open, search open and with the keyboard up. Desktop: T3 at 1280×800; W1
regression at 721, 768, 1280.
