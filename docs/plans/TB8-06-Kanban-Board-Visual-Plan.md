# TB8-06 — The Kanban Board: Visual Plan

**Status: REVISED after Sol round 1 (REVISE, 10 blocking / 5 should-fix — all addressed).**
Ranking candidate #6. Awaiting Sol round 2.

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafts, Sol reviews scope
(≤2 rounds), a Sonnet subagent builds, this session holds the visual gate.

**What round 1 changed.** Two of the draft's load-bearing claims were wrong and are corrected
below rather than quietly patched: the touch-target finding (§2.2) was **backwards**, and the
retirement range would have deleted a live rule belonging to another screen (§1.1). Both are
recorded because a plan that hides its own corrections teaches the next one nothing.

---

## 1. Scope

The roadmap names candidate #6 "board filters/card controls". That phrase does not survive contact
with the code, so the scope below is measured:

- **The filters are already converged.** TB8-01 ported the Dashboard's filter/sort controls and
  deleted `.plist`/`.prow*`. Exactly one selector from that family survives — `.prow__thumb`
  (`app.css:141`), retained deliberately for the unlayered-cascade reason TB8-01 §1.5 states. The
  `prow__*` strings still in `Dashboard.tsx` are non-styling hooks. Nothing to do.
- **The board is untouched.** `components/ProjectKanbanBoard.tsx` is 46 KB and adopts no shared
  primitive. It is the largest un-converged surface left in the app.

**TB8-06 is the Kanban board, whole:** columns, cards, card controls, the move-to popover, the drag
overlay and preview, and the drop indicator.

### 1.1 Exact CSS ranges — and the rule that must NOT be touched

> **Round-1 blocking finding 1.** The draft cited `app.css:305–308` as a deletable block.
> **`app.css:306` is `.wsbar`**, a live rule consumed by `ProjectWorkspace.tsx:488`. A range-based
> deletion would have broken the Project Workspace. Ranges are now per-selector, never contiguous.

| Range | Contents |
|---|---|
| `:129` | `.kcard__media .project-cover-placeholder` |
| `:305`, `:307`, `:308` | `.board`, `.boardnote`, `.boardnote svg` — **skipping `:306` `.wsbar`** |
| `:378–379` | `.kanban`, `.kanban:focus-visible` |
| `:471–534` | columns, cards, controls, popover, overlay, preview |
| `:536–542` | `@media (pointer: coarse), (max-width: 640px)` — **the responsive block the draft missed** |
| `:544–547` | `@media (max-width: 640px)` — `.kanban` column width |
| `:794` | `.kanban-move-popover__actions .button` 44px, inside a shared `max-width` block |

**`.wsbar` (`:306`) is out of scope and must not be modified.** The build's first gate asserts it
is byte-identical.

### 1.2 Files

`components/ProjectKanbanBoard.tsx` · `components/KanbanCardPreview.dom.test.tsx` ·
`components/ProjectKanbanBoard.dom.test.tsx` · `screens/Dashboard-stage-interactions.dom.test.tsx` ·
`screens/Dashboard-kanban-sort.dom.test.tsx` *(added in round 1 — it holds the two `.kcard__foot`
queries)* · `styles/app.css`.

### 1.3 The constraint that shapes this release

Board selectors queried by DOM tests, **recounted in round 1**:

| Selector | Queries | Selector | Queries |
|---|---|---|---|
| `.kcol` | 21 | `.kcard-wrap--drop-indicator` | 3 |
| `.kcard__addr` | 21 | `.kcard__foot` | 2 *(`Dashboard-kanban-sort:95,107`)* |
| `.kcard` | 13 | `.kanban-overlay`, `.kanban-move-popover`, `.kanban` | 2 each |
| `.kcard-drag-handle` | 5 | `.kcard-wrap` | 1 |
| `.kcard-move-to`, `.kcard-controls__arrow` | 4 each | `.kcol__head` | 3 |

Corrections from the draft: **`.board` has 0 queries, not 1**, and **`.kcard-controls` is not
queried at all**.

Most class names must therefore survive as **non-styling hooks** while their CSS retires — the
inverse of TB8-01/04, where most were deleted. Deleting them breaks the TB5A/TB5B drag suites and
the shipped cross-column white-screen regression test.

Dispositions: **R** retire CSS, keep the class as a hook · **D** delete rule *and* string ·
**K** keep as CSS, with a stated cascade reason.

---

## 2. Evidence

### 2.1 Contrast — the real defect

Computed from `styles/tokens/colors.css`.

| Role | Colour on ground | Ratio | Verdict |
|---|---|---|---|
| `.kcol__empty` placeholder | `--greige-300` `#b3aa97` on `--paper-050` | **2.17:1** | fails 4.5:1 **and** 3:1 |
| `.kcol__ordinal`, `.kcol__head .cnt` | `--text-muted` `#8f8775` on `--paper-050` | **3.36:1** | fails 4.5:1 |
| `.kcard-move-to:disabled`, `.kcard-drag-handle:disabled` | `--text-muted` on `--paper-000`, plus `opacity: .48` | **3.57:1** compounded | fails |
| `.kcard-move-to` rest | `--text-secondary` `#4d473c` on `--paper-000` | 9.20:1 | passes |
| `.kcard-wrap--drop-indicator` | `--signal-positive` on `--paper-050` | 7.14:1 | passes |

TB8-04 §2.1/E-16 already ruled on this family: every muted **text** role becomes
`text-foreground-secondary`. This plan applies that precedent. Per TB8-10/D-05, icon fills and
decorative marks are not bound by 4.5:1 — but `.kcol__empty` **is**, being the column's empty-state
message rather than an ornament.

### 2.2a The `pointer: coarse` variant must be proved before it is used

The ledger writes the responsive rules as `pointer-coarse:` variants. Tailwind 4.3.3 ships that
variant, but **no file in this repo uses it** — verified — so it is unproven here, and this repo's
recorded convention (`docs/lessons.md`, TB8-04) is the complementary `max-[721px]`/`min-[721px]`
pair, not a media-feature variant.

**Slice 5 proves it first**: render one control with `pointer-coarse:size-11`, confirm in a coarse-
pointer emulation that it applies, and only then use it across rows 21, 26, 27, 28 and 34. If it
does not apply, fall back to the arbitrary variant `[@media(pointer:coarse)]:size-11`, which needs
no plugin support. **`max-[640px]:` alone is not a substitute** — the source rule is
`(pointer: coarse), (max-width: 640px)`, an *or*, and dropping the first half would regress a
touch-screen laptop at desktop width.

### 2.2 Touch targets — RETRACTED

> **Round-1 blocking finding 3.** The draft claimed the board's reorder affordances "are its
> smallest targets, and they are the ones used on a phone." **That is backwards.** `app.css:536–542`
> already sets the drag handle, both arrows, the Priority select and move-to to **44 px** under
> `@media (pointer: coarse), (max-width: 640px)`, and `:794` does the same for the popover's action
> buttons. The draft asserted this from `:471–534` alone, having never read past `:534`.

The corrected position: the small geometry (`28×26`, `36×36`, `min-height: 30px`) applies **only to
fine-pointer desktop**, where WCAG 2.5.5 Enhanced is not the operative bar and 2.5.8 AA (24 px) is
comfortably met. **There is no touch-target defect on this surface.** The build must **preserve**
the responsive block, not "fix" it — §4 marks each of those rules **R** with its 44 px value
carried into a `max-[640px]:`/`pointer-coarse` variant, byte-equivalent in effect.

This retraction is the release's main lesson so far and belongs in `docs/lessons.md` at slice 7:
*a media query outside the range you read will invert your finding.*

### 2.3 Values off the token scales

| Site | Raw value | Token |
|---|---|---|
| `.kcard__b` | `padding: 11px 12px 12px` | `--space-3` |
| `.kcol__body` | `gap: 10px; padding: 12px` | `--space-3` |
| `.kcard-move-to` | `font-size: 11px`, `padding: 7px 9px` | `--text-2xs` |
| `.kcard-drag-handle` | `top/right: 8px`, `36px`, `font-size: 20px` | `--space-2` |
| `.kcard-controls` | `gap: 4px; padding: 0 12px 10px` | `--space-1`, `--space-3` |
| `.kcard-stage-control` | `padding: 0 12px 10px` | `--space-3` |
| `.kcard__retry` | `margin: 8px 12px 10px` | `--space-2`, `--space-3` |
| `.kanban-move-popover__actions .button` | `min-height: 38px; padding: 9px 14px` | scale |
| `.kanban-card-preview` | `calc(100vw - 24px)` | `--space-5` |
| `.boardnote` | `13.5px`, `gap/padding: 12px` | `--text-sm`, `--space-3` — moot, see §2.6 |

`.kcard__retry` consumes the legacy `.button` family, which TB8-10/D-06 lists as **not** dead.
Converging the board retires one of its four consumers.

### 2.4 The drag preview's shadow — sanctioned exception

**Owner decision, 2026-09-03: keep it.** Elevation here carries state, not decoration — it is the
only cue that a dragged card has left the plane of the board, and TB5B shipped it deliberately.
The exception is **scoped to `.kanban-card-preview`**; it does not licence shadow on any resting
element, and a later plan citing it for one is misreading it. The value still converges: it keeps
its `color-mix` on `--ink-900`, and its `calc(100vw - 24px)` becomes `--space-5` (§2.3).

### 2.5 The Priority select has no field treatment

`KanbanCard:296` renders a live `<select>` — Priority, `—` plus 1–10, with an `sr-only` label. Its
only styling is `.kcard-controls select { min-width: 48px }` plus `min-height: 44px` on coarse
pointers *(corrected in round 1 — the draft omitted the second)*. So it is sized, but carries **no
field treatment at all**: bare OS chrome inside an otherwise-designed card, rounded on macOS and
square on Windows.

TB8-04 already built the fix — `components/ui/native-select.tsx` wraps a native `<select>` in the
shared `FIELD_BOX`. Adopt it. Keep the native element: a `<select>` is right for a 1–10 ordinal on
touch, and `ui/select.tsx`'s custom listbox inside a draggable card would be a behaviour change.

### 2.6 `.board` and `.boardnote` are dead

> **Round-1 blocking finding 2.** The draft wrote replacement utilities for them. Neither has any
> `.tsx` consumer; `ProjectKanbanBoard.tsx` renders neither, and `.board` has zero test queries.

Both are **D** — delete rule and string. There is no "board note" on this surface.

---

## 3. Cascade — corrected, and inverted from the draft

`index.css` declares `@layer theme, base, components, utilities`, then imports the five token
files, `fonts.css` and `app.css` **outside any layer**. Any unlayered rule beats an ordinary
Tailwind utility regardless of specificity.

> **Round-1 blocking finding 5.** The draft said a retired selector's replacement "needs no `!`".
> For **colour and geometry** that is right. For **focus rings it is wrong**, and dangerously so:
> the competitor is not `app.css` but **`tokens/base.css:25–28`**, which is also unlayered and sets
> `outline:` as a **shorthand**, resetting `outline-offset` along with it. This is exactly TB8-05's
> "second door."

**Rules for this build:**

1. Retiring an `app.css` rule → the Tailwind replacement needs **no `!`** for background, border,
   colour, spacing, type, and layout.
2. **Every one of the board's five focus rings needs `!`** on `outline-*`, because `base.css` wins
   otherwise. Rows 5, 15, 22, 29, 34 and 47. Without it the **inward** offsets on `.kcol__head`
   (`-2px`) and the popover's buttons (`-2px`) silently become the base rule's outward `2px` — and
   the popover's comment at `:530` says an outward ring **clips** inside its overflow-auto panel.
3. **Row 11 (`.kcol__head .ey`) also needs `!`.** `.ey` at `app.css:20` sets `font:` — a shorthand
   that resets `line-height` — and `.ey` is out of this release's scope, so it survives. A layered
   `leading-[1.25]` loses to it.
4. Do **not** add `!` anywhere else. TB8-05's gate caught prophylactic `!` as drift of its own.

---

## 4. Selector disposition ledger

Every selector in the §1.1 ranges. Each **R** row must reproduce **all** declarations of the rule
it replaces — round-1 finding 7 flagged seven rows that dropped some.

### 4.1 Frame

| # | Selector | Disposition |
|---|---|---|
| 1 | `.board` `:305` | **D** — dead (§2.6) |
| 2 | `.boardnote` `:307` | **D** — dead |
| 3 | `.boardnote svg` `:308` | **D** — dead |
| — | `.wsbar` `:306` | **OUT OF SCOPE — do not touch** (§1.1) |
| 4 | `.kanban` `:378` | **R** — `grid grid-flow-col auto-cols-[minmax(244px,1fr)] max-[640px]:auto-cols-[minmax(240px,1fr)] gap-[var(--border-width-hair)] bg-border border border-[length:var(--border-width-hair)] border-border overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]` — folds in `:545` |
| 5 | `.kanban:focus-visible` `:379` | **R** — `focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2` (§3.2) |
| 6 | `.kcard__media .project-cover-placeholder` `:129` | **R**, not **K** — round-1 finding 6: `.project-cover-placeholder` (`:125`) sets **no** width or height, so there is nothing to out-rank. `size-full` on the placeholder's own consumer suffices |

### 4.2 Column

| # | Selector | Disposition |
|---|---|---|
| 7 | `.kcol` | **R** — `bg-[var(--paper-050)] flex flex-col min-w-0 transition-[background-color] duration-[var(--dur-fast)]` |
| 8 | `.kcol.is-over` | **R** — `data-[over=true]:bg-[var(--paper-100)]` |
| 9 | `.kcol__head` | **R** — `flex items-center gap-[var(--space-3)] p-[var(--space-4)] border-b border-b-border bg-[var(--bg-canvas)]` |
| 10 | `.kcol.is-over .kcol__head` | **R** — round-1 finding 7: `.kcol__head` sets its **own** background, so a parent change does not inherit. The head needs its own `group-data-[over=true]:bg-[var(--paper-100)]`, with `.kcol` carrying `group` |
| 11 | `.kcol__head .ey` | **R** — `!leading-[1.25]` (§3.3) |
| 12 | `.kcol__ordinal` | **R** — **contrast fix** + full coverage: `flex-none font-[var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] tabular-nums text-foreground-secondary` |
| 13 | `.kcol__head > .row` | **R** — round-1 finding 6: `.row` is rendered **inside `StatusBadge`**, not by this component. Do not target it from outside. Pass the utility through `StatusBadge`'s own `className` prop, or leave the rule as a scoped **K** and say so. Builder must pick one and record it |
| 14 | `.kcol__head .cnt` | **R** — **contrast fix** + coverage: `flex-none tabular-nums text-sm text-foreground-secondary` |
| 15 | `.kcol__head:focus-visible` | **R** — outline utilities with `!`, `!outline-offset-[-2px]` (§3.2) |
| 16 | `.kcol__body` | **R** — `flex flex-col gap-[var(--space-3)] p-[var(--space-3)] min-h-[120px] flex-1`; **carry the `:472` comment across** — `flex-1` makes the drop target fill the column |
| 17 | `.kcol__empty` | **R** — **contrast fix**: `py-[var(--space-5)] font-[var(--font-display)] text-lg text-center text-foreground-secondary` |

### 4.3 Card and controls

| # | Selector | Disposition |
|---|---|---|
| 18 | `.kcard-wrap` | **R** — `relative bg-card border border-border transition-[background-color,border-color] duration-[var(--dur-fast)]` |
| 19 | `.kcard-wrap:hover` | **R** — `hover:bg-[var(--paper-100)] hover:border-[var(--greige-300)]` |
| 20 | `.kcard-wrap.is-dragging` | **R** — `data-[dragging=true]:opacity-40` |
| 21 | `.kcard-drag-handle` | **R** — full coverage: `absolute top-[var(--space-2)] right-[var(--space-2)] z-[2] size-9 max-[640px]:size-11 pointer-coarse:size-11 inline-grid place-items-center border border-[color-mix(in_srgb,var(--ink-900)_18%,transparent)] rounded-[var(--radius-sm)] bg-[color-mix(in_srgb,var(--paper-000)_88%,transparent)] text-foreground-secondary cursor-grab text-[20px] leading-none [touch-action:none]`. **`touch-action: none` is behavioural** (round-1 finding 8) — it keeps touch scrolling off the dnd-kit activator. Losing it changes TouchSensor activation |
| 22 | `.kcard-drag-handle:focus-visible` | **R** — `!outline-2 !outline-[var(--ink-900)] !outline-offset-2` |
| 23 | `.kcard-drag-handle:hover:not(:disabled)` | **R** |
| 24 | `.kcard-drag-handle:active:not(:disabled)` | **R** — `active:not-disabled:cursor-grabbing` |
| 25 | `.kcard-drag-handle:disabled` | **R** — `disabled:text-foreground-secondary disabled:cursor-not-allowed` (§2.1: drop `opacity-[.48]`) |
| 26 | `.kcard-controls` | **R** — `flex items-center gap-[var(--space-1)] px-[var(--space-3)] pb-[var(--space-3)] max-[640px]:flex-wrap pointer-coarse:flex-wrap` — folds in `:538` |
| 27 | `.kcard-controls select` | **R** + **adopt `NativeSelect`** (§2.5) — `min-w-12`, plus the 44 px coarse min-height from `:539` |
| 28 | `.kcard-controls__arrow` | **R** — full coverage: `w-7 h-[26px] max-[640px]:size-11 pointer-coarse:size-11 p-0 border border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-foreground-secondary font-[var(--type-label)] text-sm leading-none cursor-pointer transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]` — folds in `:540` |
| 29 | `.kcard-controls__arrow:focus-visible` | **R** — outline utilities with `!` |
| 30 | `.kcard-controls__arrow:hover:not(:disabled)` | **R** |
| 31 | `.kcard-controls__arrow:active:not(:disabled)` | **R** — `active:not-disabled:translate-y-px` |
| 32 | `.kcard-controls__arrow:disabled` | **R** — `disabled:text-foreground-secondary disabled:bg-[var(--bg-sunken)] disabled:cursor-not-allowed` |
| 33 | `.kcard-stage-control` | **R** — `px-[var(--space-3)] pb-[var(--space-3)]` |
| 34 | `.kcard-move-to` | **R** — full coverage: `w-full min-h-[30px] max-[640px]:min-h-11 pointer-coarse:min-h-11 px-[9px] py-[7px] border border-border bg-card text-foreground-secondary font-inherit text-2xs text-left cursor-pointer` — folds in `:541` |
| 35 | `.kcard-move-to:focus-visible` | **R** — `!outline-2 !outline-[var(--ink-900)] !outline-offset-2` |
| 36 | `.kcard-move-to:hover:not(:disabled)` | **R** |
| 37 | `.kcard-move-to:disabled` | **R** — `disabled:text-foreground-secondary disabled:cursor-not-allowed`; drop `opacity-[.48]` (§2.1) |
| 38 | `.kcard-wrap--drop-indicator` | **R** — `min-h-[3px] rounded-[2px] bg-[var(--signal-positive)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--signal-positive)_20%,transparent)]` |
| 39 | `.kcard` | **R** — link reset, full coverage |
| 40 | `.kcard__media` | **R** — `aspect-[16/9] overflow-hidden bg-[var(--ink-800)]` |
| 41 | `.kcard__media img` | **R** — `size-full object-cover` |
| 42 | `.kcard__b` | **R** — `p-[var(--space-3)]` |
| 43 | `.kcard__addr` | **R** — `text-base tracking-tight leading-snug [text-wrap:pretty]` |
| 44 | `.kcard__meta` | **R** — `text-xs text-foreground-secondary mt-[var(--space-1)]` |
| 45 | `.kcard__foot` | **R** — `flex items-center flex-wrap gap-[var(--space-1)_var(--space-3)] mt-[var(--space-3)]` |
| 46 | `.kcard__retry` | **R** — `buttonClasses("secondary")` **plus its margins**, which round-1 finding 7 caught the draft dropping: `mt-[var(--space-2)] mx-[var(--space-3)] mb-[var(--space-3)]` |

### 4.4 Popover, overlay, preview

| # | Selector | Disposition |
|---|---|---|
| 47 | `.kanban-move-popover button:focus-visible` `:530` | **R** — `!outline-[length:var(--border-width-bold)] !outline-[var(--ink-900)] !outline-offset-[-2px]`. **Carry the `:529` comment**: an outward ring clips inside the overflow-auto panel |
| 48 | `.kanban-move-popover` | **HOOK ONLY** — round-1 finding 9: there is **no standalone rule** to retire. `AnchoredPopover.tsx:138` already applies `cn(className, PANEL)`, and `app.css:532–533` says so in a comment. `ui/menu.tsx` does **not** export `PANEL`, so the draft's "reuse it" would fail typecheck, and duplicating it would create a second styling owner. Keep the class as a test/descendant hook; change nothing |
| 49 | `.kanban-move-popover__option:active` | **R** — `active:bg-[var(--bg-sunken)]` |
| 50 | `.kanban-move-popover__content` | **R** — `grid gap-[var(--space-3)] p-[var(--space-3)]` |
| 51 | `.kanban-move-popover__stages`, `__positions` | **R** — `grid gap-[2px]` |
| 52 | `.kanban-move-popover__option` | **R** — full coverage; **keep `min-h-11` and carry its WCAG 2.5.5 comment across** |
| 53 | `.kanban-move-popover__option:hover` | **R** |
| 54 | `.kanban-move-popover__option[aria-selected="true"]` | **R** — `aria-selected:border-l-[var(--border-strong)]` |
| 55 | `.kanban-move-popover__actions` | **R** — `flex justify-end gap-[var(--space-2)]` |
| 56 | `.kanban-move-popover__actions .button` `:521` + `:794` | **R** — to `buttonClasses()` sized `min-h-[38px] px-[14px] py-[9px] text-xs`, plus `max-[640px]:min-h-11` from `:794`. **See §5.4 — this row changes two tests** |
| 57 | `.kanban-overlay` | **R** — `pointer-events-none z-10` |
| 58 | `.kanban-card-preview` | **R** — `w-[min(320px,calc(100vw-var(--space-5)))] max-w-[calc(100vw-var(--space-5))] box-border shadow-[0_18px_36px_color-mix(in_srgb,var(--ink-900)_22%,transparent)] pointer-events-none` — shadow retained per §2.4 |
| 59 | `.kanban-card-preview .kcard__media` | **R** — `pointer-events-none` |

---

## 5. Behaviour that must not change

1. **dnd-kit** — sensors, `BoardCollisionDetection`, the `data-droppable-id` contract,
   `restoreBoardScroll`. Row 21's `touch-action: none` is part of this.
2. **The TB5A board contract** — gap-1024 ranks, `board_revision`, `moveProjectStage`'s fixed
   semantic Stage identities.
3. **`data-focus-key`** (`arrow-up:`, `arrow-down:`, `stage-heading:`) and `focusHandle` — focus
   restoration anchors, not styling hooks. **Byte-identical**, asserted by gate 4.
4. **The move-to popover** — `data-step`, the `radiogroup`/`listbox` roles, `aria-checked`,
   `aria-selected`.
5. **The cross-column white-screen hotfix** (2026-08-31) stays fixed.
6. **Capability gating** — `canMoveStages`, `canPrioritize`, `canDragThisCard`, `movementDisabled`.

### 5.1 The two structural changes, each isolated

- **`is-over` / `is-dragging` → `data-*`** (rows 8, 10, 20) touches drag code, and row 10 adds
  `group` to `.kcol`. **Slice 1, alone, no visual change.**
- **Row 56 breaks two tests** (round-1 finding 4). `ProjectKanbanBoard.dom.test.tsx:357` and
  `Dashboard-stage-interactions.dom.test.tsx:914` both query
  `.button:not(.button--secondary)` to find the popover's submit. Adopting `buttonClasses()`
  removes those classes. **Replace both queries with a role/name query**
  (`getByRole("button", { name: … })`) in the same slice as row 56 — never by retaining the legacy
  classes, which would retain their CSS and defeat the row.

---

## 6. Slicing

Bottom-up; each slice ends green on `npm run typecheck` and `npm run build -w @quincy/web`.

| Slice | Content | Rows |
|---|---|---|
| 1 | `is-over`/`is-dragging` → `data-*`, `.kcol` gains `group`. No visual change | 8, 10, 20 |
| 2 | Frame: delete the three dead rules; `.kanban` + its focus ring + `:545` | 1–6 |
| 3 | Column, incl. the three contrast fixes and row 13's recorded decision | 7, 9, 11–17 |
| 4 | Card body | 39–46 |
| 5 | Card controls: handle, arrows, `NativeSelect`, move-to; folds in `:536–542` | 18–19, 21–38 |
| 6 | Popover, overlay, preview; **row 56 + its two test rewrites** | 47–59 |
| 7 | Delete retired `app.css` ranges; drift-register rows; `docs/lessons.md` §2.2 entry; todo | — |

Slice 7 carries the full §5 gate.

---

## 7. Acceptance — real browser, three viewports

1440×900, 1024×768, 390×844, local dev, signed in as Admin:

1. Board renders; columns `minmax(244px,1fr)`, and `minmax(240px,1fr)` at ≤640px.
2. Column head shows ordinal, `StatusBadge`, count; **ordinal and count ≥ 4.5:1**.
3. An empty column's placeholder measures **≥ 4.5:1** (was 2.17:1).
4. Card hover changes background and border.
5. **At 390×844 the handle, both arrows, the Priority select and move-to each measure ≥ 44×44** —
   a *preservation* check, not a fix (§2.2).
6. All five focus rings visible; `.kcol__head`'s and the popover buttons' offsets are **inward**.
7. Drag within a column: indicator appears, card lands, order persists.
8. Drag across columns: Stage changes, **no white screen**.
9. Popover: stage → position step, Escape closes, focus returns to trigger, no ring clipping.
10. Keyboard: arrows move a card; focus lands on the same control.
11. Priority select renders in the Quincy field treatment and still opens the native picker.
12. Disabled controls are visibly disabled and not activatable.
13. Project Workspace still renders correctly — `.wsbar` untouched (§1.1).
14. Zero console errors, zero failed requests.

### 7.1 Declared limit

Whether a screen reader announces the popover's step change needs assistive technology this
pipeline cannot drive. Items 1–14 verify structure. Recorded on the TB5C/TB8-04/TB8-05 precedent,
**not** a pass, and registered in TB8-10's verification-debt table.

---

## 8. Gates — executable, and proved fail-able

Round-1 finding 10 rejected the draft's gates as unrunnable. Each below is a command. **Run against
`main` first (must fail), then the branch (must pass).** A gate that cannot fail is not a gate.

`ifne` (moreutils) is **not installed on this machine** — verified — so every gate below is plain
POSIX shell. Each exits non-zero on failure.

```bash
W=portal/apps/web/src
# 1 — .wsbar untouched (§1.1)
git diff main -- $W/styles/app.css | grep -q '^[-+].*\.wsbar' && echo FAIL || echo PASS
# 2 — every retired selector gone, at any indent, including media blocks
! grep -nE '^[[:space:]]*\.(board|boardnote|kanban|kcol|kcard)[a-zA-Z0-9_-]*[[:space:]]*[,{:]' \
    $W/styles/app.css | grep -v 'kcard__media .project-cover-placeholder' | grep -q .
# 3 — the component adopts the shared primitives
grep -q 'buttonClasses' $W/components/ProjectKanbanBoard.tsx \
  && grep -q 'NativeSelect' $W/components/ProjectKanbanBoard.tsx
# 4 — focus-restoration anchors byte-identical
diff <(git show main:$W/components/ProjectKanbanBoard.tsx | grep -o 'data-focus-key={`[^`]*`}' | sort) \
     <(grep -o 'data-focus-key={`[^`]*`}' $W/components/ProjectKanbanBoard.tsx | sort)
# 5 — every test-queried hook (§1.3) still present in the component
for c in kcol kcard__addr kcard kcard-drag-handle kcard-move-to kcard-controls__arrow \
         kcol__head kcard-wrap--drop-indicator kcard__foot kanban-overlay \
         kanban-move-popover kanban kcard-wrap; do
  grep -q "\"$c\|$c " $W/components/ProjectKanbanBoard.tsx || echo "MISSING: $c"
done
# 6 — the legacy .button queries are gone from both suites (§5.1)
! grep -rqn 'button:not(.button--secondary)' $W/components $W/screens
```

Gate 5 drops `.board` — it is deleted by row 1, and the draft's version asserted a string that
never existed in this component.

## 9. Artefacts

1. `components/ProjectKanbanBoard.tsx` — converged
2. `styles/app.css` — retired ranges deleted, `.wsbar` untouched
3. Two test files — `.button` queries → role/name (§5.1)
4. Evidence images, three viewports, before/after
5. `Drift-Register.md` — `TB0-VIS-**` rows for the three contrast findings
6. `docs/lessons.md` — the §2.2 retraction
7. `docs/todo.md` — the TB8-06 bullet
8. `TB8-10-…` — D-06's consumer count down by one; the §7.1 debt row
