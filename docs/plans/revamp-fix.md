# Settled plan — bring the phone review and tiles to the prototype

Synthesis of `revamp-fix-opus.md` (base: it carries the frame map, mechanism, ledger and tests in
detail) and `revamp-fix-codex.md`, planned blind from `revamp-fix-brief.md`. Scope and audit rows:
`video-revamp-prototype-audit.md`. Where this file and a raw plan differ, this file wins.

## Root cause (verified at e33c7d7a)

1. `components/quincy/ReviewPane.tsx:209` caps the compose-mode sheet at `max-h-[60%]` with
   `overflow-hidden`; the ~385 px composer is clipped behind the keyboard.
2. Two sources of truth: the sheet's mode follows editor focus, the composer's tall layout follows
   its own `engaged` flag (`VideoNoteComposer.tsx:82`). After the keyboard is dismissed the sheet is
   back in browse while the composer stays tall, so the stops collapse onto the play bar.
3. `onSubmitCapture` ends compose while the keyboard may still be up.

## Mechanism

Opus plan §3, with Codex's additions:
- The sheet's mode is the only switch for the composer layout (focus, or a hold: tray open, post in
  flight, file picker open). Remove the 60% cap and the `engaged` layout switch.
- In compose mode the root takes the visual viewport (height and offsetTop, once — never a second
  keyboard inset); the transport hides, the film flexes, the strip (hint, pill, Cancel, ~100 px) is
  fixed and only the + tray shrinks and scrolls.
- Blur returns to browse without discarding the draft or remounting the editor; keep measuring the
  viewport while the keyboard animates away; fallback blur when the viewport grows back by ≥150 px
  while focus is kept. Cancel stays the only discard (and still aborts uploads).
- Codex: an explicit focus-stamp command, so stepping frames before typing cannot move the anchor.

## Owner decisions (2026-10-15)

- **+ is an inline tray** above the pill (`reui/collapsible`); its controls don't take focus, so the
  keyboard stays up (C1).
- **Casing stays Portal uppercase** on buttons and badges (C8). Copy follows the prototype
  ("Approve (internal)" for staff, "Approve" for guests). **Audit row 10 is dropped.**
- **Pill input and round Send get scoped component variants** (an InputGroup `pill` and a Button
  round icon size, existing tokens, used only by the composer) (C5). Send is icon-only, its phase
  shown as a spinner and in its aria-label.
- **"Everyone ⌄" filters by author** (Everyone / a person), for staff and guests. The staff
  Internal / Client-visible filter stays, inside the Open chip's menu (C9).

## Defaults taken (from the Opus plan; flag in the PR, change only on the owner's word)

C2 whole toolbar in the tray · C3 visibility on the hint line ("Internal · paused at <tc>") ·
C4 one line at rest, up to 4 lines in compose then scroll, upload cards under the pill · C6 short
range in the chip · C7 after Send return to browse with the note listed · C10 client-side search of
loaded threads · C11 Copy / Paste notes as ⋯ rows · C12 Version details after Create Review link ·
C13 sr-only sheet title and a visually hidden Close · C14 frame step stays in the control bar where
no composer carries it · C15 in-picture timecode stays · C16 draw: verify only, tools stay ·
C17 short tile label · C18 header "Video · N films", keep Review links and Trash · C19 guest per PR 2,
count becomes open notes · C20 Approve keeps its status menu.

## PRs (each built by an Opus agent reading the prototype source; session runs the browser pass on
the iOS Simulator; design-reviewer compares with the prototype frames)

1. **Staff compose** — rows 1, 2, 9 check. Keyboard fix, pill composer, + tray. First.
2. **Guest compose** — same strip for guests; guest count = open notes.
3. **Phone chrome, notes head, collection header** — rows 3–8 and 11.

#880–#882 resume on top of these.
