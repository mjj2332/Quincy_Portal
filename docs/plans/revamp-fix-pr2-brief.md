# Plan brief — PR 2 of the revamp fix: the guest phone composer

You are planning, not building. Return a plan only. Another planner is answering the same brief
blind; the session synthesizes both.

## Context

Quincy Portal (`portal/`, React 19 + Vite SPA). The Claude design prototype in
`design/prototypes/video-review-revamp/project/` is the spec (AGENTS.md, "Design: the prototype
decides, the tokens express it"). Settled plan for the whole fix: `docs/plans/revamp-fix.md`
(PR 2 = guest compose: "same strip for guests; guest count = open notes", default C19).
PR 1 (#892, staff phone composer) shipped to production after 12 rounds and is the reference
implementation; its decisions are in `docs/plans/revamp-fix-pr1-ledger.md`.

Paths below are under `portal/apps/web/src/` unless stated.

Read first:
- Prototype: `mobile.jsx` (`MobileReview` with `role="guest"`: split and `mode="compose"` /
  `"draw"`; frames P2 "Guest · opens at half", P6 "Writing a note" — the compose layout is the same
  component for both roles), `kit.jsx` (`Composer`, `NotesFilter`, `openCount`, `visibleNotes`),
  `quincy.css` (`.composer`, `.composer-input`, `.tc-chip`, `.send`, `.ibtn.sm`), and
  `Video Review Revamp.html` (frame list, decisions D1–D37; D10 compose, D11 draw, D22 counts).
- Staff reference: `components/video/VideoNoteComposer.tsx`, `VideoNotesPanel.tsx`,
  `VideoNoteEditor.tsx`, `components/QuincyRichTextEditorBase.tsx` (pill, pillWrap, inlineStart,
  inlineEnd, toolbarContainer, contentAttributes), `components/quincy/ReviewSheet.tsx`
  (mode, holds, `useSheetTextRoom`, `blurComposerField`), `components/quincy/ReviewPane.tsx`,
  `lib/use-visual-viewport.ts` (`track` / `root`), `components/video/VideoReviewViewer.tsx` (how
  the staff viewer drives the visual-viewport box for as long as the phone dialog is open), and
  `components/video/VideoMarkupOverlay.tsx` (the pill's pen).
- Guest code: `guest/GuestVideoScreen.tsx` (phone sheet, `addNote`, `useVisualViewport(phone &&
  composing)` — a compose-only box PR 1 deliberately left), `guest/use-guest-compose.tsx` (draft,
  marks, drawing, post / edit, `form`), `guest/GuestNotesPanel.tsx` (`top` slot, sheet parts),
  `guest/GuestNoteEditor.tsx` / `GuestNoteField.tsx` (lazy editor chunk), `guest/GuestNoteItem.tsx`
  (edit root → composer), the guest DOM tests beside them, and
  `guest-boundary.guard.test.ts` (the guest bundle may not import staff stores or `lib/api`).
- `docs/lessons.md`: run `node scripts/lessons-index.mjs 879` and read every hit (keyboard,
  visual viewport, Safari bar tint, DialogContent `duration-100` flash, pill focus).
- `config/ui-primitive-ratchet.guard.test.ts`, `styles/design-system-guards.test.ts`,
  `docs/reui-reuse.md`, AGENTS.md ReUI rules.

## What exists today on the guest phone

At rest the sheet's foot is an outline "Add a note" button (plus "Copy my notes from another
version" and a paste status line); unverified guests are sent to the email-code verify dialog
first (`requestVerify("compose")`). Pressing it opens `compose.form`: a stacked form (anchor text,
Mark in / Mark out / Draw buttons, hints, the rich field, Cancel / "Post note"). The same form is
used to edit the guest's own root note (`beginEdit`, "Save"). The screen sizes itself to the
visual viewport only while `sheetControl.composing`. The Notes tab count is `threads.length`.

## Settled owner decisions from PR 1 (carry over unless a guest frame differs)

Pill composer at the sheet's foot (+ · timecode chip · input · pen, round icon Send), hint line
above, Cancel below (P6); film floor 96px (`--space-9`); pill radius `--radius-pill` on one line,
`--radius-lg` once wrapped; focus hairline `--border-hover`; wrap only while composing, one line
with ellipsis at rest; Cancel discards the whole draft; an open + tray counts as a compose hold;
+ is an inline tray (`reui/collapsible`) whose controls do not take focus; scoped `pill` InputGroup
variant and `icon-round` Button size (existing, reuse them); Portal uppercase casing on buttons;
copy "Approve" for guests. The root follows the visual viewport for as long as the phone view is
open and sets `transition: none` on it. The cream iOS status bar after a reload is out of scope (PR 3).

## What the plan must contain

1. **Frame → component map** for P2 (rest), P6-as-guest (compose, keyboard up), P7-as-guest
   (draw), and the guest's edit-own-note flow, naming the component that renders each part.
2. **Reuse vs. fork**: how much of the staff composer the guest can share given the guest boundary
   guard. Options range from a shared presentational strip component (in `components/quincy/` or
   `components/video/` with no staff-store imports) to a guest twin in `use-guest-compose.tsx`.
   Recommend one, with the files it touches.
3. The guest specifics: where "Add a note" / verify / "Copy my notes from another version" / the
   paste status go once the foot is a pill; what the + tray holds for a guest (Mark in / Mark out,
   formatting toolbar; no visibility toggle; frame step?); the hint line copy (no "Internal");
   Send vs "Post note" / "Save" in edit mode; how the edit flow enters the strip; the email-updates
   and identity footer rows; the lazy editor chunk (what the pill shows while it loads).
4. **The keyboard mechanism** for the guest screen: switching to the staff viewer's `track`
   behaviour (follow the visual viewport whenever the phone screen is mounted), what that means
   for the guest page being a document (not a dialog) — scroll, `min-h-dvh`, the delivery row —
   and recovery when the keyboard is dismissed without Cancel.
5. Open-note count on the Notes tab (C19 / D22): open public root threads; how a tombstone that
   kept replies and resolved threads count.
6. Desktop must not regress: say exactly what is phone-only.
7. Reuse ledger lines for every new or changed element; `ui-primitive-allowlist.ts` impact.
8. Conflicts with a ReUI component, a guard, or a product capability the frames do not show —
   **list them for the owner, do not resolve them silently.**
9. Tests to change or add (DOM tests named), and the iOS Simulator rows the session's browser pass
   must run (keyboard up, typed text visible, wrap, tray open, draw, edit, Cancel, blur recovery,
   verify-then-compose), each with the prototype frame it is checked against.
