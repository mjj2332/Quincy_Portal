# Plan brief — PR 3 of the revamp fix: phone chrome, notes head, collection header

You are planning, not building. Read-only: do not edit files. Return a plan only (at most ~120
lines). Another planner is answering the same brief blind; the session synthesizes both. Never
read `.dev.vars`, `.env*` or `.mcp.json`.

## Context

Quincy Portal (`portal/`, React 19 + Vite SPA). The Claude design prototype in
`design/prototypes/video-review-revamp/project/` is the spec (AGENTS.md, "Design: the prototype
decides, the tokens express it"). Settled plan for the whole fix: `docs/plans/revamp-fix.md`
(PR 3 = "Phone chrome, notes head, collection header — rows 3–8 and 11"). Audit rows:
`docs/plans/video-revamp-prototype-audit.md`. PR 1 (#892, staff phone composer) and PR 2 (#895,
guest phone composer) are on `main` (base `d1e12da1`); their decisions are in
`docs/plans/revamp-fix-pr1-ledger.md` and `docs/plans/revamp-fix-pr2.md`. PR 2 listed as out of
scope, for PR 3: header, notes filter chips, ⋯ sheet layout, delivery row, Safari bar tint on a
fresh load. Paths below are under `portal/apps/web/src/` unless stated.

Read first:
- Prototype: `mobile.jsx` (`MobileReview`: header, film, transport, sheet stops, tabs, notes head,
  `openMenu="version" | "more"`), `kit.jsx` (`NotesFilter`, `openCount`, `visibleNotes`,
  `Composer`), `tiles.jsx` (T3 header), `quincy.css`, and `Video Review Revamp.html` (frame list,
  decisions D1–D37). Frames: **P1** staff at half, **P2** guest at half, **P3** peek, **P4** full,
  **P5** 9:16 film, **P8** Versions sheet, **P9** ⋯ staff, **P10** ⋯ guest, **T3** desktop
  collection header.
- Staff: `components/video/VideoReviewViewer.tsx`, `VideoReviewHeaderMenu.tsx`,
  `VideoPhoneApprove.tsx`, `VideoNotesPanel.tsx` (head: totals, Version details popover, filters),
  `VideoNotesHost.tsx`, `components/quincy/VideoPlayer.tsx` (transport), `ReviewSheet.tsx`,
  `ReviewPane.tsx`, the video collection/tiles header (find it; T3 "Video · N films").
- Guest: `guest/GuestVideoScreen.tsx` (header, ⋯ `ActionRow`s, delivery row),
  `guest/GuestNotesPanel.tsx`, `guest/guest-compose.ts` (`openThreadCount`),
  `guest-boundary.guard.test.ts`.
- `docs/lessons.md`: `node scripts/lessons-index.mjs 879` and read every hit, especially "Safari
  tints its bars from the page's edges only after the document scrolls".
- `config/ui-primitive-ratchet.guard.test.ts`, `styles/design-system-guards.test.ts`,
  `docs/reui-reuse.md`, AGENTS.md ReUI rules.

## Scope

1. **Notes window height at rest** (owner, deferred from PR 2). Measured on the iOS Simulator
   (iPhone 18 Pro, guest phone): the notes list shows ~116pt against ~212pt in P2. Each band is
   taller than P2: header ~85pt vs 56, transport ~100pt vs 78, grabber + tab row ~85pt vs 67,
   composer band ~76pt vs 60. Header and transport are shared with staff: match them to P1/P2 for
   both roles. Say per band where the extra height comes from (component, class, token) and what
   brings it to the frame, in Quincy tokens. Keep 44px hit areas (PR 1 used a visible 32px control
   with an `after:` hit area — `PILL_ICON`).
2. **Status bar cream after a reload** until the first interaction (predates PR 1; staff and guest?
   say which). Diagnose the mechanism (theme-color meta, html/body background at first paint,
   `data-ink-canvas` set in a layout effect only after the viewer opens, Safari's edge sampling) and
   propose the root-cause fix. If it is not fixable in-page, say so with evidence.
3. **Audit rows 3–8 and 11** (owner decisions in the audit and `revamp-fix.md` apply: Portal
   uppercase casing stays on buttons and badges (C8), copy "Approve (internal)" staff / "Approve"
   guest; Q2 notes head chips "Open · N ⌄", "Everyone ⌄" (author filter, staff and guest), search
   icon (C10 client-side search of loaded threads); Version details moves into the ⋯ sheet (C12,
   after Create Review link); staff Internal / Client-visible filter lives in the Open chip's menu
   (C9); C11 Copy / Paste notes as ⋯ rows; C13 sr-only sheet title + visually hidden Close; C14,
   C15, C17, C18 "Video · N films" keeping Review links and Trash; C20 Approve keeps its status
   menu). Check each row against `main` today — PR 1/2 may have closed some — and list what is
   left.
4. **Minor**: the rest placeholder's ellipsis can land after a space ("with …"). Root cause and
   fix (`REST_CLAMP` / placeholder rendering in `compose-strip.tsx` / the editor).

## What the plan must contain

1. **Frame → component map**: every frame above, each visible part → the component rendering it,
   staff and guest.
2. Per scope item: files, functions, classes changed; phone-only vs desktop (desktop must not
   regress — say exactly what is phone-only, `< 721px`).
3. Reuse: the installed or ReUI item each new/changed element starts from (chips → which menu /
   select / toggle? search → which input?), and the `ui-primitive-allowlist.ts` impact.
4. Conflicts with a ReUI component, a guard, or a product capability the frames don't show — list
   them for the owner, don't resolve silently.
5. Suggested split if this is too big for one PR (commits or PRs), in order.
6. Tests: DOM tests to change or add (named files), and the iOS Simulator rows (staff and guest,
   rest / peek / full / ⋯ open / Versions open / filter menu open / search open / keyboard up for
   search), each naming the prototype frame it is checked against and the height measured.
