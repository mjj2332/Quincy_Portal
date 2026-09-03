# TB8-06 — The Kanban Board: Visual Plan

**Status: DRAFTED, not yet reviewed.** Ranking candidate #6. Awaiting Sol scope review (round 1).

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafted it, Sol reviews scope
(≤2 rounds), a Sonnet subagent builds, this session holds the visual gate.

---

## 1. Scope, and how it was determined

The roadmap names candidate #6 "board filters/card controls" in five words. That phrase does not
survive contact with the code, so the scope below is **measured, not inherited**:

- **The filters are already converged.** TB8-01 ported the Dashboard's filter/sort/segment controls
  and deleted `.plist`/`.prow*`. Exactly **one** selector from that family survives in `app.css` —
  `.prow__thumb` (`:141`) — retained deliberately, for the unlayered-cascade reason TB8-01 states
  in its own §1.5. The `prow__*` strings still in `Dashboard.tsx` are **non-styling hooks** (tests,
  plus that one rule). Nothing to do.
- **The board is untouched.** `components/ProjectKanbanBoard.tsx` is 46 KB and contains **zero**
  `cn(`, `buttonClasses`, or Tailwind utilities. Every one of its ~60 selectors lives in unlayered
  `app.css`. It is the largest single un-converged surface left in the app.

**So TB8-06 is the Kanban board, whole.** Columns, cards, card controls, the move-to popover, the
drag overlay and preview, the drop indicator, and the board note. The "card controls" half of the
roadmap phrase is real and central; the "filters" half is already done.

### 1.1 Files

| File | Role |
|---|---|
| `components/ProjectKanbanBoard.tsx` | The whole surface — `KanbanCard`, `KanbanCardPreview`, `SortableKanbanCard`, `KanbanColumn`, `MoveToControl`, `ProjectKanbanBoard` |
| `components/KanbanCardPreview.dom.test.tsx` | Preview-specific tests |
| `components/ProjectKanbanBoard.dom.test.tsx` | Board tests |
| `screens/Dashboard-stage-interactions.dom.test.tsx` | Drag/keyboard-move interaction tests |
| `styles/app.css` | The selectors being retired — `:129`, `:305–308`, `:378–379`, `:471–534` |

### 1.2 The constraint that shapes this release

**14 distinct board selectors are queried by DOM tests**, several heavily:

| Selector | Test queries | Selector | Test queries |
|---|---|---|---|
| `.kcol` | 21 | `.kcard-controls__arrow` | 4 |
| `.kcard__addr` | 21 | `.kcol__head` | 3 |
| `.kcard` | 13 | `.kcard-wrap--drop-indicator` | 3 |
| `.kcard-drag-handle` | 5 | `.kcard__foot`, `.kanban-overlay`, `.kanban-move-popover`, `.kanban` | 2 each |
| `.kcard-move-to` | 4 | `.kcard-wrap`, `.board` | 1 each |

This inverts the disposition profile of TB8-01 and TB8-04, where most legacy classes were deleted
outright. **Here most class names must survive as non-styling hooks** while their CSS is retired.
A plan that deletes them breaks the drag-and-drop and keyboard-move suites that TB5A/TB5B/TB6 built
— the most behaviour-dense tests in the repo, and the ones guarding a shipped white-screen fix.

Every selector therefore gets one of three dispositions, stated per row in §4:

- **R (retire CSS, keep hook)** — delete the rule, keep the `className` string. The default here.
- **D (delete)** — no consumer, no test query. Delete rule and string.
- **K (keep as CSS)** — the rule must stay unlayered to win the cascade. Requires a stated reason.

---

## 2. Evidence — the defects this release fixes

Measured against the live `app.css` at `569ed69`, not inferred. WCAG contrast computed from the
token hexes in `styles/tokens/colors.css`.

### 2.1 Contrast

| Role | Colour on ground | Ratio | Verdict |
|---|---|---|---|
| `.kcol__empty` em-dash | `--greige-300` `#b3aa97` on `--paper-050` | **2.17:1** | fails 4.5:1 **and** 3:1 |
| `.kcol__ordinal`, `.kcol__head .cnt` | `--text-muted` `#8f8775` on `--paper-050` | **3.36:1** | fails 4.5:1 |
| `.kcard-move-to:disabled` | `--text-muted` on `--paper-000` | **3.57:1**, then `opacity: .48` | fails, compounded |
| `.kcard-move-to` rest | `--text-secondary` `#4d473c` on `--paper-000` | 9.20:1 | passes |
| `.kcard-wrap--drop-indicator` | `--signal-positive` on `--paper-050` | 7.14:1 | passes |

**TB8-04 §2.1/E-16 already ruled on this family**: every muted *text* role becomes
`text-foreground-secondary`. That precedent decides the first three rows; this plan applies it
rather than re-litigating it. Note the distinction TB8-10/D-05 draws — icon fills and decorative
`::before` marks are not bound by 4.5:1. The em-dash at `.kcol__empty` **is** bound, because it is
the column's empty-state message, not an ornament.

### 2.2 Touch targets — the component contradicts itself

`.kanban-move-popover__option` is `min-height: 44px` and carries an explicit source comment citing
*WCAG 2.5.5 Enhanced / HIG*. Three sibling controls in the same component ignore that bar:

| Control | Size | 2.5.8 AA (24px) | 2.5.5 AAA (44px) |
|---|---|---|---|
| `.kcard-drag-handle` | 36 × 36 | passes | fails |
| `.kcard-controls__arrow` | 28 × 26 | passes | fails |
| `.kcard-move-to` | `min-height: 30px` | passes | fails |
| `.kanban-move-popover__option` | `min-height: 44px` | passes | **passes** |

The board's primary reorder affordances are its *smallest* targets, and they are the ones used on a
phone. This is the release's main ergonomic finding.

### 2.3 Values off the token scales

Raw px where a token exists — the drift this whole TB8 series exists to retire:

| Site | Raw value | Token |
|---|---|---|
| `.kcard__b` | `padding: 11px 12px 12px` | `--space-3` |
| `.kcol__body` | `gap: 10px; padding: 12px` | `--space-3` |
| `.kcard-move-to` | `font-size: 11px` | `--text-2xs` |
| `.kcard-drag-handle` | `36px`, `8px`, `20px` | `--space-2`, scale |
| `.kanban-move-popover__actions .button` | `min-height: 38px; padding: 9px 14px` | scale |
| `.boardnote` | `font-size: 13.5px`, `gap: 12px`, `padding: 12px` | `--text-sm`, `--space-3` |
| `.kcard__retry` | consumes `.button button--secondary` | `buttonClasses()` |
| `.kcard-controls select` | `min-width: 48px`, else unstyled | `NativeSelect` (§2.5) |

`.kcard__retry` is worth calling out: it is a live consumer of the legacy `.button` family, which
TB8-10/D-06 lists as *not* dead. Converging the board **retires one of the four remaining
consumers**, moving that eventual cleanup closer without doing it here.

### 2.5 The Priority select has no design treatment at all

`KanbanCard` renders a live `<select>` (`:296`) — the project's Priority, `—` plus 1–10, with an
`sr-only` label. Its **entire** styling is `.kcard-controls select { min-width: 48px }`. It is a
bare OS-chrome control sitting inside an otherwise-designed card: rounded on macOS, square on
Windows, and matching neither the Quincy field treatment nor anything else on the board.

This is the sharpest visual defect on the surface, and it is the one the roadmap phrase "card
controls" most directly names. TB8-04 already built the fix: `components/ui/native-select.tsx`
wraps a native `<select>` in the shared `FIELD_BOX`. **Adopt it here** — no new primitive, and the
control inherits the field treatment every other converged surface uses.

Keep the native element. A `<select>` is the correct control for a 1–10 ordinal on a touch device,
and `ui/select.tsx` (the Base UI listbox) would trade the OS picker for a custom popover inside a
draggable card — a behaviour change this release is not making.

### 2.4 One question this plan does not decide alone

`.kanban-card-preview` carries `box-shadow: 0 18px 36px color-mix(in srgb, var(--ink-900) 22%, transparent)`.
The design system is explicitly **no-shadow elevation** (`prototype/_ds/…/readme.md`, restated in
`Subagent-Frontend-Orchestration.md`). But this is the *drag preview*: the shadow is the only cue
that the card has left the plane of the board, and TB5B shipped it deliberately.

**Owner decision needed.** Three options, in the order this session recommends them:

1. **Keep it, and record it as a sanctioned exception** — elevation carries real state here, and
   the drag preview is the one surface where the flat rule costs information. *(Recommended.)*
2. Replace it with a non-shadow cue — a `--border-width-bold` `--ink-900` outline plus a slight
   scale — keeping the system literally flat.
3. Delete it, accepting that a dragged card reads as flat against the column beneath it.

The build does **not** proceed on this row until it is answered; nothing else in the plan depends
on it.

---

## 3. The cascade rule — how the board's CSS is actually beaten

`styles/index.css` declares `@layer theme, base, components, utilities` and then imports five token
files, `fonts.css` and `app.css` **outside any layer**. An unlayered rule therefore beats an
ordinary Tailwind utility regardless of specificity.

TB8-05 found the **second door**: `tokens/base.css` is unlayered too, and a *shorthand* there
(`outline:`) resets longhands rather than merely outranking them, which is why that release needed
`!` on `focus-visible:outline-*`. Both doors matter here — the board defines its own
`:focus-visible` outlines in four places (`.kanban:focus-visible`, `.kcol__head:focus-visible`,
`.kcard-drag-handle:focus-visible`, `.kcard-controls__arrow:focus-visible`,
`.kcard-move-to:focus-visible`).

**Rule for this build:** once a selector's rule is retired from `app.css`, its Tailwind replacement
needs no `!`. Where a rule is kept (**K**), any Tailwind utility targeting the same property on the
same element **does** need `!`, and the plan says so at that row. Do not add `!` prophylactically —
TB8-05's gate caught exactly that, and an unnecessary `!` is drift of its own.

---

## 4. Selector disposition ledger

Every selector in the five `app.css` ranges, with its disposition. `T` = test-queried (§1.2).

### 4.1 Board frame — `:129`, `:305–308`, `:378–379`

| # | Selector | Line | T | Disposition |
|---|---|---|---|---|
| 1 | `.board` | 305 | ✓ | **R** — `flex flex-col min-w-0` |
| 2 | `.boardnote` | 307 | | **R** — `flex items-center gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-3)] bg-[var(--paper-100)] border-b border-b-border text-sm text-foreground-secondary`; retires `13.5px` |
| 3 | `.boardnote svg` | 308 | | **R** — `shrink-0 text-foreground-secondary` on the icon; **not** `text-muted` (§2.1) |
| 4 | `.kanban` | 378 | ✓ | **R** — grid, `grid-flow-col auto-cols-[minmax(244px,1fr)] gap-[var(--border-width-hair)] bg-border border border-border overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]` |
| 5 | `.kanban:focus-visible` | 379 | | **R** — `focus-visible:outline focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2` |
| 6 | `.kcard__media .project-cover-placeholder` | 129 | | **K** — the placeholder's own background is unlayered; only an unlayered rule reliably sizes it. Same reasoning TB8-01 used to keep `.prow__thumb`. Verify at build; if it now sits in a layer, downgrade to **R** |

### 4.2 Column — `:471–482`

| # | Selector | T | Disposition |
|---|---|---|---|
| 7 | `.kcol` | ✓ | **R** — `bg-[var(--paper-050)] flex flex-col min-w-0 transition-colors duration-[var(--dur-fast)]` |
| 8 | `.kcol.is-over` | | **R** — `data-[over=true]:bg-[var(--paper-100)]`; move the state to a data attribute |
| 9 | `.kcol__head` | ✓ | **R** — `flex items-center gap-[var(--space-3)] p-[var(--space-4)] border-b border-b-border bg-[var(--bg-canvas)]` |
| 10 | `.kcol.is-over .kcol__head` | | **R** — sibling of #8 |
| 11 | `.kcol__head .ey` | | **R** — `leading-[1.25]` |
| 12 | `.kcol__ordinal` | | **R** — **contrast fix**: `text-foreground-secondary`, not `--text-muted` (§2.1) |
| 13 | `.kcol__head > .row` | | **R** — `flex-1 min-w-0` |
| 14 | `.kcol__head .cnt` | | **R** — **contrast fix**, as #12 |
| 15 | `.kcol__head:focus-visible` | | **R** — outline utilities, `outline-offset-[-2px]` |
| 16 | `.kcol__body` | | **R** — `flex flex-col gap-[var(--space-3)] p-[var(--space-3)] min-h-[120px] flex-1`; retires `10px`/`12px` |
| 17 | `.kcol__empty` | | **R** — **contrast fix**: `text-foreground-secondary`; keeps the display face and `text-lg` |

### 4.3 Card and controls — `:483–531`

| # | Selector | T | Disposition |
|---|---|---|---|
| 18 | `.kcard-wrap` | ✓ | **R** — `relative bg-card border border-border transition-[background-color,border-color] duration-[var(--dur-fast)]` |
| 19 | `.kcard-wrap:hover` | | **R** — `hover:bg-[var(--paper-100)] hover:border-[var(--greige-300)]` |
| 20 | `.kcard-wrap.is-dragging` | | **R** — `data-[dragging=true]:opacity-40` |
| 21 | `.kcard-drag-handle` | ✓ | **R** + **target fix** — 44 × 44 (§2.2), tokenised inset, `--space-2` |
| 22–25 | `.kcard-drag-handle` `:hover` / `:focus-visible` / `:active` / `:disabled` | | **R** — variants on #21; `disabled:text-foreground-secondary` per §2.1 |
| 26 | `.kcard-controls` | ✓ | **R** — `flex items-center gap-[var(--space-1)] px-[var(--space-3)] pb-[var(--space-3)]` |
| 27 | `.kcard-controls select` | | **R** + **adopt `NativeSelect`** — see §2.5. Not dead: this styles the live Priority control |
| 28 | `.kcard-controls__arrow` | ✓ | **R** + **target fix** — 44 × 44 (§2.2) |
| 29–31 | `.kcard-controls__arrow` `:hover` / `:active` / `:focus-visible` / `:disabled` | | **R** — variants; `disabled:text-foreground-secondary` |
| 32 | `.kcard-stage-control` | | **R** — `px-[var(--space-3)] pb-[var(--space-3)]` |
| 33 | `.kcard-move-to` | ✓ | **R** + **target fix** — `min-h-[44px]`, `text-2xs` for the `11px` |
| 34–36 | `.kcard-move-to` `:hover` / `:focus-visible` / `:disabled` | | **R**; drop the compounded `opacity: .48` (§2.1) |
| 37 | `.kcard-wrap--drop-indicator` | ✓ | **R** — `min-h-[3px] rounded-[2px] bg-[var(--signal-positive)]` + ring |
| 38 | `.kcard` | ✓ | **R** — the link reset |
| 39 | `.kcard__media` | | **R** — `aspect-[16/9] overflow-hidden bg-[var(--ink-800)]` |
| 40 | `.kcard__media img` | | **R** — `size-full object-cover` |
| 41 | `.kcard__b` | | **R** — `p-[var(--space-3)]`; retires `11px 12px 12px` |
| 42 | `.kcard__addr` | ✓ | **R** — display face, `text-base`, `tracking-tight`, `leading-snug`, `[text-wrap:pretty]` |
| 43 | `.kcard__meta` | | **R** — `text-xs text-foreground-secondary mt-[var(--space-1)]` |
| 44 | `.kcard__foot` | ✓ | **R** — `flex items-center flex-wrap gap-[var(--space-1)_var(--space-3)] mt-[var(--space-3)]` |
| 45 | `.kcard__retry` | | **R** — to `buttonClasses("secondary")`; **retires a TB8-10/D-06 consumer** (§2.3) |

### 4.4 Move-to popover and drag overlay — `:511–522`, `:532–534`

| # | Selector | T | Disposition |
|---|---|---|---|
| 46 | `.kanban-move-popover` | ✓ | **R** — panel; reuse the shared `PANEL` const from `ui/menu.tsx` if it fits, else state why not |
| 47 | `.kanban-move-popover button:focus-visible` | | **R** |
| 48 | `.kanban-move-popover__option:active` | | **R** — `active:bg-[var(--bg-sunken)]` |
| 49 | `.kanban-move-popover__content` | | **R** — `grid gap-[var(--space-3)] p-[var(--space-3)]` |
| 50 | `.kanban-move-popover__stages`, `__positions` | | **R** — `grid gap-[2px]` |
| 51 | `.kanban-move-popover__option` | | **R** — **keep `min-h-[44px]` and carry its WCAG comment across** |
| 52–53 | `__option:hover`, `[aria-selected="true"]` | | **R** |
| 54 | `.kanban-move-popover__actions` | | **R** — `flex justify-end gap-[var(--space-2)]` |
| 55 | `.kanban-move-popover__actions .button` | | **R** — to `buttonClasses()`; retires `38px`/`9px 14px` |
| 56 | `.kanban-overlay` | ✓ | **R** — `pointer-events-none z-10` |
| 57 | `.kanban-card-preview` | | **BLOCKED on §2.4** — everything but the shadow is **R** |
| 58 | `.kanban-card-preview .kcard__media` | | **R** — `pointer-events-none` |

---

## 5. Behaviour that must not change

The board is the most behaviour-dense surface in the app; this is a **visual** convergence.

1. **dnd-kit drag and drop** — sensors, collision detection (`BoardCollisionDetection`), the
   `data-droppable-id` contract, and `restoreBoardScroll`'s snapshot behaviour.
2. **The TB5A board contract** — gap-1024 ranks, `board_revision`, `moveProjectStage`'s fixed
   semantic Stage identities.
3. **Keyboard move** — `data-focus-key` values (`arrow-up:`, `arrow-down:`, `stage-heading:`) and
   `focusHandle`. These are focus-restoration anchors, not styling hooks; **do not touch**.
4. **The move-to popover's two-step dialog** — `data-step="stage" | "position"`, the
   `radiogroup`/`listbox` roles, `aria-checked`/`aria-selected`.
5. **The cross-column white-screen hotfix** (deployed 2026-08-31) must stay fixed. Its regression
   test lives in `Dashboard-stage-interactions.dom.test.tsx`.
6. **Capability gating** — `canMoveStages`, `canPrioritize`, `canDragThisCard`, `movementDisabled`.
   No visual change may make a disabled control appear enabled.

**`is-over` / `is-dragging` → `data-*`.** Rows #8 and #20 move state from a class to a data
attribute. That is the only structural change in this plan, and it touches drag code — so it is
**one slice of its own**, landed and green before any other row.

---

## 6. Slicing

Bottom-up, per the lane. Each slice ends green on `npm run typecheck` and `npm run build -w @quincy/web`.

| Slice | Content | Rows |
|---|---|---|
| 1 | `is-over` / `is-dragging` → `data-*`, no visual change | 8, 20 |
| 2 | Board frame — `.board`, `.boardnote`, `.kanban` | 1–6 |
| 3 | Column — `.kcol*`, incl. the three contrast fixes | 7, 9–17 |
| 4 | Card body — `.kcard`, `.kcard__*` | 38–45 |
| 5 | Card controls — drag handle, arrows, Priority select, move-to; the three target fixes and §2.5 | 18–19, 21–37 |
| 6 | Popover + overlay + preview | 46–58 (57 pending §2.4) |
| 7 | Delete the retired `app.css` ranges; tests; docs; drift-register rows | — |

Slice 7 carries the full §5 gate.

---

## 7. Acceptance — real browser, three viewports

At 1440×900, 1024×768, 390×844, on local dev, signed in as Admin:

1. Board renders; columns are `minmax(244px, 1fr)`; horizontal scroll works and the scrollbar
   gutter is stable.
2. Column head shows ordinal, `StatusBadge`, and count; **ordinal and count measure ≥ 4.5:1**.
3. An empty column's placeholder measures **≥ 4.5:1** (was 2.17:1).
4. Card hover changes background and border.
5. Drag handle, both arrows, and move-to each measure **≥ 44 × 44 CSS px**.
6. Every one of the five focus rings is visible and is `--focus-ring` at `--border-width-bold`.
7. Drag a card within a column: the drop indicator appears, the card lands, order persists.
8. Drag a card across columns: Stage changes, **no white screen**.
9. Move-to popover: stage step → position step, Escape closes, focus returns to the trigger.
10. Keyboard: arrows move a card; focus lands on the same control afterward.
11. The Priority select renders in the Quincy field treatment, not OS chrome, and still opens the
    native picker on touch (§2.5).
12. A disabled control is visibly disabled and not activatable.
13. Zero console errors and zero failed requests across the whole walkthrough.

### 7.1 Declared limits

Whether a screen reader *announces* the popover's step change is verifiable only with assistive
technology this pipeline cannot drive. Items 1–13 verify structure. Recorded as a known limit on
the TB5C/TB8-04/TB8-05 precedent, **not** claimed as a pass — and registered against TB8-10's
verification-debt table rather than left in this document alone.

---

## 8. Gates

Grep gates must be **proved fail-able before they are trusted** — TB8-05 shipped five gates that
matched their own explanatory comments, and TB8-04 shipped one before that. For each gate: run it
against `main` (must match), then against the branch (must not).

1. No retired selector remains in `app.css`: `grep -nE '^\.(board|boardnote|kanban|kcol|kcard)' portal/apps/web/src/styles/app.css` → only `K` rows.
2. `ProjectKanbanBoard.tsx` imports `cn`, `buttonClasses`, and `NativeSelect`.
3. No raw `px` from §2.3 survives in the component's `className` strings.
4. `data-focus-key` values are byte-identical to `main` (§5.3).
5. Every §1.2 test-queried class string still appears in the component.

## 9. Artefacts

1. `components/ProjectKanbanBoard.tsx` — converged
2. `styles/app.css` — retired ranges deleted
3. Evidence images, three viewports, before/after
4. `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` — new `TB0-VIS-**` rows for the
   contrast and touch-target findings
5. `docs/lessons.md` — only if this build finds something new
6. `docs/todo.md` — the TB8-06 bullet
7. `docs/plans/TB8-10-…` — tick D-06's consumer count down by one; add the §7.1 debt row
