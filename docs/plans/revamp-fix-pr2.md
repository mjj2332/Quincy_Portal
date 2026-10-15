# Settled plan — PR 2 of the revamp fix: the guest phone composer

Synthesis of `revamp-fix-pr2-opus.md` (base: frame map, mechanism, tests and Simulator rows in
detail) and `revamp-fix-pr2-codex.md`, planned blind from `revamp-fix-pr2-brief.md`. Where this
file and a raw plan differ, this file wins. Paths are under `portal/apps/web/src/`.

## Frames

P2 (guest at rest, half stop), P6 as guest (compose, keyboard up), P7 as guest (draw), and the
guest's edit of their own root note in the same strip. Frame → component map: Opus §1.
Out of scope (PR 3): header, notes filter chips, ⋯ sheet layout, delivery row, Safari bar tint on
a fresh load.

## Structure

- **Shared staff-free pieces** move from `components/video/VideoNoteComposer.tsx` to a new
  `components/quincy/compose-strip.tsx` (class constants `PILL_CHIP`, `REST_CLAMP`,
  `COMPOSE_CLAMP`, `PHONE_LINE`, `STRIP_TEXT_BUTTON`, the strip grid; `keepFocus`, `shortRange`,
  the tray focus-keeping listener, `ComposeTray`, `PillPlus`, `PillSend`). The staff composer
  imports them; **its rendered DOM must not change** (staff phone tests green, and an outerHTML
  before/after check during the build). If a piece cannot move without changing the staff DOM,
  leave it and duplicate it in the guest strip instead.
- **Guest strip** in new `guest/GuestNoteComposer.tsx`, reading `SheetModeContext` inside
  `ReviewSplit` and setting holds. Draft state stays in `guest/use-guest-compose.tsx`, which
  exposes state/actions to it. Desktop keeps today's stacked form, unchanged.
- `guest-boundary.guard.test.ts` stays green; nothing imports `lib/api` or staff stores.

## Behaviour (phone, < 721px)

Opus §3 and §4, with these settlements:

- **Owner: the editor mounts at rest for a verified writer** (chunk loads when the phone video
  screen mounts), so the first tap raises the keyboard. While the chunk loads and for an unverified
  guest the pill is a same-size shell (InputGroup `pill`, chip, placeholder, disabled pen/Send).
  Unverified: tapping the shell asks for verification and continues into compose; record on the
  Simulator whether a second tap is needed after the code (do not change the policy silently).
  Replace the global 2 s polling `focusEditorWhenReady` with a scoped handoff where it is touched.
- Focus stamps a pristine point draft; once there is text the anchor is frozen; a pristine draft
  is released on blur (staff parity). Frame step in the tray moves only an empty draft's stamp.
- Tray: frame back/forward, Mark in / Mark out (guest copy kept), Clear marks, drawing chip and
  Remove drawing, separator, whole formatting toolbar. No visibility toggle. An open tray is a hold.
- Hint: "Paused at {tc} · the note is stamped here" / range / "Editing your note · …"; problem
  line replaces it. **Edit conflict "Latest saved version" stays fully readable** (Codex): a
  scrollable block above the pill, not a 2-line clamp.
- Send: `PillSend` (`icon-round`, lucide Send, Spinner while pending); aria-label "Post note" /
  "Posting…", edit "Save" / "Saving…"; enabled/disabled exactly as the staff phone Send.
- Cancel discards the whole draft and remounts the editor (aborts uploads). Success returns to
  browse with the note listed.
- Pen in the pill (`PILL_ICON`, pressed hairline); sheet mode is `draw` while the pen is
  confirming **or** drawing.
- Edit from ⋯ focuses the pill inside the menu click (Menu `finalFocus` false on the phone).
- **Owner: "Copy my notes from another version" is a guest ⋯ sheet row** (same `canPaste` gate
  and verify path); the paste status shows as a `role=status` line in the notes body.
- **Owner: identity and email-updates rows sit at the end of the notes list's scroll** on the phone.

## Keyboard mechanism

`useVisualViewport(phone && composing, onKeyboardGone, viewportRoot, phone)` with `viewportRoot`
= `GuestApp`'s outer guest column (element via callback ref into state), so notices above the
screen sit inside the measured box. The hook alone writes height, transform and `transition:none`;
drop the screen's inline style and the phone `min-h-dvh` floors (keep a `dvh` fallback). Track for
as long as the phone screen is mounted. Ink document canvas: move the staff viewer's effect to
`lib/use-ink-canvas.ts` and use it in both. Recovery without Cancel as staff (blur → browse, draft
kept; ≥150 px viewport growth with focus kept → blur unless held).

## Open-note count

**Owner: phone tab and desktop heading both show open notes**, shown at 0:
`!t.resolved && (!t.deleted || t.replies.length > 0)` (`openThreadCount` in `guest/guest-compose.ts`).

## Tests and pass

DOM tests: Opus §9 (rewrite the phone cases of `GuestNotesWrite.dom.test.tsx`, new
`GuestVideoScreen.phone.dom.test.tsx`, count cases, `openThreadCount` unit), plus Codex's
`GuestNoteField` loading/failure case. Staff phone tests, guards and `npm run verify` green.
Simulator rows R1–R16 (Opus §9) with the frame named per row.
