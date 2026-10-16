# Plan brief — bring the shipped phone review (#879) and tiles (#884) to the prototype

You are planning, not building. Return a plan only.

## Context

Quincy Portal (`portal/`, React 19 + Vite SPA, Hono on Workers). The owner made the Claude design
prototype in `design/prototypes/video-review-revamp/project/` the spec for the video review revamp
(AGENTS.md, "Prototype as spec"). Its frames govern layout, hierarchy, copy and behaviour; the
token set in `portal/apps/web/src/styles/` still governs colour, type and spacing values.

Read first:
- `docs/plans/video-revamp-prototype-audit.md` — the deviation list (rows 1–11) and the owner's
  decisions Q1 and Q2. **This is the scope.**
- Prototype source: `design/prototypes/video-review-revamp/project/mobile.jsx` (MobileReview: split, compose,
  draw modes; MobileHeader; ControlBar; ActionSheet use), `kit.jsx` (Composer, NotesFilter,
  NoteItem, ActionSheet, Scrubber), `tiles.jsx`, `quincy.css`, and `Video Review Revamp.html`
  for the frame list and decision numbers (D1–D37).
- Shipped code: `portal/apps/web/src/components/video/VideoReviewViewer.tsx`,
  `VideoNoteComposer.tsx`, `components/quincy/ReviewSheet.tsx`, `ReviewPane.tsx`,
  `lib/use-visual-viewport.ts`, the tiles in `components/video/` (find them), and their tests.
- `docs/lessons.md` entries on the review sheet ("A collapsed or mode-hidden pane must stay
  mounted", "Escape needs an order…"), `docs/reui-reuse.md`, AGENTS.md ReUI rules and the
  primitive ratchet (`config/ui-primitive-ratchet.guard.test.ts`).

## The bug that matters most

On iOS Safari (iPhone 18 Pro Simulator), tapping "Add a note…" grows the composer to ~385 px and
the on-screen keyboard covers the editor: typed text is never visible. After the keyboard is
dismissed the composer stays over the player controls and the tab row sits under the play bar
until Cancel. The viewer sizes its root to `visualViewport` while composing
(`VideoReviewViewer.tsx` ~line 383/533). P6 avoids this by making the compose strip ~100 px:
hint line, one-line pill, Cancel, with the film flexing above it.

## Owner decisions to honour

- Q1: compose extras (Internal/Client-visible, Set in/out, frame step, formatting B/I/U, image,
  video) go behind a **+** at the start of the pill, opening a small sheet. The strip otherwise
  matches P6.
- Q2: the notes head becomes P1's chips: "Open · N ⌄", "Everyone ⌄", search icon. Version details
  moves into the ⋯ sheet.

## What the plan must contain

1. **Frame → component map**: for P1, P3, P6, P7, P9, T1, T3 (and the P2/P10 guest variants the
   same components render), which component renders it and what changes.
2. Per audit row 1–11: the change, files, and the existing behaviour it must preserve (drafts
   surviving mode switches, stamping the frame on focus, upload abort on Cancel, Escape order,
   author-only rules, keyboard shortcuts on desktop). Desktop must not regress: say what is
   phone-only.
3. **The keyboard fix's mechanism**, concretely: what is sized to what in compose mode, how the
   strip stays above the iOS keyboard, how the layout recovers when the keyboard is dismissed
   without Cancel (blur), and how the + sheet coexists with the keyboard.
4. Reuse ledger lines: for each new or changed element, the ReUI / base-nova item or Quincy
   component it uses, or why it is hand-built.
5. Conflicts: anywhere the prototype conflicts with a ReUI component, a token/guard rule, or a
   product capability it doesn't show. **Do not resolve them silently — list them for the owner.**
6. Tests to change or add (unit/DOM), and the iOS Simulator rows the browser pass must run,
   including keyboard rows.
7. PR split, if more than one PR is better. #880 (full screen), #881 (desktop rail), #882
   (Delivery) are out of scope and will follow on top of this.
