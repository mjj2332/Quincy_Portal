# Video review revamp — audit against the prototype

Owner decision, 2026-10-15: the Claude design prototype in `quincy-video-review-revamp/project/`
is the spec for the revamp (#879–#884). This audits what shipped in #888 (#884, tiles) and #889
(#879, phone review) against its frames, at `main` 983a08d6.

How it was checked: the prototype served statically and the app served from `main` through
`scripts/agents/serve-branch.sh`, captured at the same sizes (390 × 844 phone, 1280 × 800 desktop),
and the phone review re-run in Safari on the iOS Simulator (iPhone 18 Pro) with the on-screen
keyboard up. Frame ids are the prototype's (`Video Review Revamp.html`).

## Phone review (#879) — P1, P3, P6, P7, P9

| # | Area | Prototype | Shipped | Fix |
|---|---|---|---|---|
| 1 | **Writing a note (P6, D10)** | Header, film (flex), then one strip: hint line, one-line pill (timecode chip · input · pen) with round Send, Cancel. ~100 px on the keyboard. | Stacked panel ~385 px: hint + Cancel, timecode, frame step + Set in/out, formatting toolbar, tall editor, Post, Internal/Client-visible. **On iOS the keyboard covers the editor: typed text is never visible.** After the keyboard is dismissed the composer stays over the player controls and the tab row sits under the play bar until Cancel. | Rebuild the phone compose mode to P6. Owner decision needed on where the extras go (Q1). |
| 2 | Composer at rest (P1) | One pill: timecode chip, "Add a note…", pen inside, round Send. | Boxed textarea, pen outside it, "POST" button. | Pill + round Send. |
| 3 | Header | Back · title / "● v3 · latest ⌄" · **Approve (internal)** (staff) / Approve (guest), sentence case · ⋯ plain icon. | "APPROVE" in capitals for both roles; ⋯ in a bordered box. | Labels and casing per P1/P2; ⋯ as a plain icon button. |
| 4 | Control bar | Scrubber over a row: plain play icon, current timecode only, mute, **⤢ Full screen**. | Large cream-filled play button, "current / total" readout, no Full screen. | Plain icon, current time only. ⤢ arrives with #880. |
| 5 | Film | Edge to edge under the header, centred play badge when paused. | Inset with a light border. | Edge to edge. |
| 6 | Sheet tabs | Left-aligned, count chip beside "Notes". | Stretched 50/50. | Left-aligned. |
| 7 | Notes head | Filter chips "Open · N ⌄", "Everyone ⌄", search icon. | "0 open · 0 resolved", "VERSION DETAILS", ⋯. | Owner decision (Q2). |
| 8 | ⋯ sheet (P9) | Rows only: Social preview, Download v3, Marker export…, Copy link, Create Review link, Open in iPhone player, —, Remove v3…. | Large serif "Video actions" heading with ✕; no version numbers; a focus ring on the first row on open. | Rows only, version numbers in labels, no initial ring. |
| 9 | Draw (P7, D11) | Film outlined, top bar "Drawing on <tc>" · Undo · Done; composer below with the pen on. | Not re-checked in this pass. | Check on the Simulator in the fix PR. |

## Tiles (#884) — T1, T3

Close to the prototype. Two deviations:

| # | Area | Prototype | Shipped |
|---|---|---|---|
| 10 | Status pill | Sentence case ("In review"). | Capitals ("IN REVIEW"). |
| 11 | Desktop header (T3) | "Video · N films". | "Films" with Review links and Trash. |

## Desktop review — W1

The notes rail is #881, and D29 keeps today's staff header, so most of the gap is expected. The
composer has the same weight problem as the phone (row 2).

## Not yet audited

Guest phone review (P2, P10), the Delivery screens (V1–V6) and full screen (F1–F4) ship in
#880–#882 and get their side-by-side when they are built.

## Owner questions

- **Q1.** P6 shows only the pill, Send and Cancel. Today's composer also has Set in / Set out,
  frame step, the formatting toolbar (image, video, B/I/U) and Internal / Client-visible. Where do
  they go on a phone?
- **Q2.** The notes head: P1's filter chips, or keep today's counts and Version details?

## Process

Why this shipped: builders worked from text plans that cited the prototype only to correct it, QA
briefs never mentioned it, the design reviewer judged against the tokens only, and the phone pass
ran in a narrow desktop Chrome that cannot raise the iOS keyboard. AGENTS.md ("Prototype as spec")
and `docs/subagents/Subagent-Orchestration.md` §2a now cover each of those.
