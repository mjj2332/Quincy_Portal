# Plan brief — PR 3b of the revamp fix: notes filter head and ⋯ sheets

You are planning ONE PR for the Quincy Portal repo. Read-only: do not edit files. Code is in
`portal/`; paths below are under `portal/apps/web/src/` unless stated. Never read `.dev.vars`,
`.env*` or `.mcp.json`. Another planner answers this same brief blind; the session synthesizes
both. Return a build plan of AT MOST ~120 lines, no preamble.

Base: `origin/main` at `68c584ed` (PR 3a, #896, merged: phone header 56pt, transport, sheet head,
composer band, T3). Other open work on the same files: none.

## What is already settled — do not re-litigate

`docs/plans/revamp-fix-pr3.md` § "PR 3b" is the settled scope; read it and its parent
`docs/plans/revamp-fix.md` (owner decisions C8–C13, Q2). Frame map at the PR 3 level is
`docs/plans/revamp-fix-pr3-opus.md` §1 (line numbers there are at `d1e12da1`; 3a moved code —
re-read current files). Owner decisions that bind this PR:

- Notes head (P1 `NotesFilter`), staff and guest, phone only (`< 721px`): "Open · N ⌄" chip menu
  (Open / Resolved / All with counts; staff also All / Client-visible / Internal, C9), "Everyone ⌄"
  author menu (Everyone + root authors of loaded threads), search icon that replaces the chip row in
  place with a search field + clear X (C10: client-side over loaded threads, root and reply bodies
  and author names). Search focus must not enter compose mode. **Chips are sentence case** (C8 —
  Portal uppercase — still holds for buttons and badges). On the phone this head replaces today's
  counts / Version details row, the ToggleGroups and the notes ⋯. **Desktop unchanged.**
- New `components/quincy/NotesFilterHead.tsx`, staff-free (guest-boundary guard). Staff model:
  extend `NoteFilters` in `lib/video-note-view.ts` with `author`, `query`; `visibleThreads` /
  `noteCounts` honour them; reset on Version change and at the desktop crossing. Guest model: a pure
  `guest/guest-notes-filter.ts`. **Guest authors key on kind + name** (same-name guests merge; no
  API change).
- ⋯ sheet (P9 staff, P10 guest; C11–C13): sr-only title, visually hidden but focusable Close,
  `initialFocus` on the popup (no ring on the first row at open), labels "Download vN" and
  "Remove vN…", a Version details row after Create Review link (opens a Sheet of the existing
  `detailsRows`), "Copy shown notes" and "Paste N notes from vX…" rows — the clipboard lifted out of
  `VideoNotesPanel` into a staff-only `useNotesClipboard` hook in `VideoNotesHost`, exposed through
  `NotesSlots`. Keep paste preview / CAS, capability and archive gates, and status notices.
- **Guest delivery (owner):** Request changes… and Download all become ⋯ rows; the decision badge
  takes the Approve slot once decided; hints and notices become a quiet line at the end of the notes
  scroll (with the identity / email rows).
- P8 Versions sheet polish: label-type title, hidden Close, one-line rows.

## Read

- Prototype `design/prototypes/video-review-revamp/project/`: `mobile.jsx` (`MobileReview`,
  `openMenu="version" | "more"`), `kit.jsx` (`NotesFilter`, `openCount`, `visibleNotes`),
  `quincy.css`, `Video Review Revamp.html` (frames P1, P2, P8, P9, P10; decisions D1–D37).
- Staff: `components/video/VideoReviewViewer.tsx`, `VideoReviewHeaderMenu.tsx`,
  `VideoNotesPanel.tsx`, `VideoNotesHost.tsx`, `VideoVersionsSheet.tsx`, `lib/video-note-view.ts`,
  `use-video-notes.ts`, `components/quincy/ReviewActionSheet.tsx`, `ReviewPhoneBar.tsx`.
- Guest: `guest/GuestVideoScreen.tsx`, `guest/GuestNotesPanel.tsx`, `guest/guest-compose.ts`,
  `guest-boundary.guard.test.ts`.
- `docs/lessons.md` (`node scripts/lessons-index.mjs 879`, and entries on Base UI focus / dialogs),
  `docs/maps/README.md` (Base UI map), `config/ui-primitive-ratchet.guard.test.ts`,
  `styles/design-system-guards.test.ts`, `docs/reui-reuse.md`, AGENTS.md ReUI rules, and
  `.claude/skills/reui/SKILL.md`.

## The plan must contain

1. **Frame → component map** for P1 notes head, P2 notes head, P8, P9, P10: each visible part →
   the component rendering it after this PR, staff and guest.
2. Files and functions changed, in build order as commits; for each, phone-only vs every width.
   Exactly what stays on desktop.
3. Reuse: the installed `components/reui/` / `components/quincy/` item each new element starts from
   (chip trigger, radio menu, search field, clear X, details Sheet, ⋯ rows) and how it is adapted
   (scoped variant + adaptation note); `config/ui-primitive-allowlist.ts` impact (it may only
   shrink).
4. State: filter state ownership, reset rules (Version change, desktop crossing, landing on a
   linked note whose filter would hide it), pinned active edit/reply, tab count independent of
   search, tombstones excluded; how the guest filter stays staff-free.
5. Clipboard hook: what moves, what the desktop clipboard menu keeps calling, and how the ⋯ rows get
   counts/labels ("Paste N notes from vX…").
6. Conflicts with a ReUI component, a guard or a capability the frames don't show — list for the
   owner, don't resolve silently.
7. Tests: DOM/unit tests to add or change (named files, key cases), guards that must stay green, and
   the iOS Simulator rows (iPhone 18 Pro Safari, staff and guest): ⋯ open (P9/P10), Versions (P8),
   Open menu, Everyone menu, search open keyboard down, search typing keyboard up, desktop W1
   regression at 721 / 768 / 1280 — each naming its frame and what is measured.
