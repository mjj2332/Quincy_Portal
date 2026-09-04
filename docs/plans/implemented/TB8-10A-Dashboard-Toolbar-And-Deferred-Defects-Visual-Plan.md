# TB8-10A — The Dashboard Toolbar, and the Deferred Defects That Do Not Wait

**Status: DEPLOYED TO PRODUCTION, 2026-09-04** — app Worker `e8825a98`, rollback target app
`7c7cdafe` (frontend/CSS only, no migration). Owner-requested 2026-09-04. Runs the frontend lane in
`docs/Subagent-Frontend-Orchestration.md`: this session drafts and holds the visual gate, Sol
reviews scope only, a Sonnet subagent builds the slices.

**Ranking position.** This is the first half of candidate **#10** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md`, the last non-gated TB8 candidate. Candidates
#1–#9 are all shipped.

---

## §0 — Why TB8-10 splits, and what this half is

`TB8-10-Deferred-Defects-And-Cleanup-Sweep-Plan.md` is a register of eleven items (D-01…D-11)
accumulated across nine releases. It was written as one sweep. Re-measuring it today, after #6–#9
converged their surfaces, shows it is really two releases with almost nothing in common:

| | Items | Character |
|---|---|---|
| **TB8-10A** (this plan) | D-01, D-02, D-03, D-04, D-09, D-10, D-11 + the toolbar change | Bounded defects. Each is one component, one rule, or one token. Every one is verifiable on its own. |
| **TB8-10B** (later) | D-05, D-06, D-07 | Interlocking migration. Retiring `.button` removes `--text-muted` paint sites; only once `app.css` stops carrying a button family can the Preflight question (D-07) be answered at all. |

Splitting is not a convenience. D-06 requires converging the **Production Calendar**, a surface
that was never on the TB8 list — it runs on `production-calendar.css` from TB5C. That is a
visual-convergence release needing its own evidence and its own gate. Holding seven small,
already-evidenced defects hostage to it is what produced a register in the first place.

### Re-measurement (2026-09-04) — the register's numbers are stale

The register's own instruction was to re-measure D-06 "once #7–#9 are done". Doing so:

| Item | Register (2026-09-03) | Measured now | Why it moved |
|---|---|---|---|
| D-06 `.button` class tokens | 51 across **36 files** | **50 across 14 files** | TB8-07/08/09 converged subtasks, notice board, discussion, Lightbox. **8 of the 14 survivors are Production Calendar files** — one subsystem, not a scatter. |
| D-05 `var(--text-muted)` in `app.css` | 41 sites | **19 sites** | Same three releases. |
| `app.css` | ~800 lines | **679 lines** | TB8-09 retired ~120. |

(50 counted by Sol with `@babel/parser` over every non-test JSX `className`; this session's
regex-based first pass said 48. The parser count is the one to trust.)

So TB8-10B is now "converge the Production Calendar's buttons, plus six stragglers" — a real
release with a real shape, and a much better one than the 36-file sprawl the register feared.

### Explicitly out of scope

- **D-05, D-06, D-07** — TB8-10B.
- **D-08** (the annotation toolbar covers the filmstrip on phone). Still blocked on the owner:
  the fix requires deciding *where* the toolbar lives on a phone. Unchanged by this plan.

---

## §0a — Sol round 1 (2026-09-04): 3 blocking, 5 non-blocking, all resolved

`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`, read-only, scope and correctness only.
Every finding was independently re-verified by this session before being accepted — two of the
three blocking ones were **this session's own errors of reasoning**, not misreadings, and both are
recorded in place rather than quietly patched.

| # | Finding | Resolution |
|---|---|---|
| **B1** | §2's `mr-auto` cannot work. Auto margins resolve *after* flex line breaking, so they cannot keep an item off a second line — and the row *does* now wrap (~1,130px of content in ~928px at 1024px), orphaning the `View` label from its own control. | §2.3 rewritten: two explicit group wrappers, `ml-auto` on the right one. The first draft's "do not restructure" instruction was the error and is now recorded as such. |
| **B2** | §5's inset ring is `--ink-900` `#0a0a0a` on the tile's `#141414` ground — **1.07:1** — so the fix cannot satisfy its own criterion 5-1. The clipping rationale was also false: an element's own `overflow: hidden` does not clip its own outline, and no ancestor clips it. | §5.1 rewritten to restore the app-wide **outline** at `outline-offset: 2px`, drawn outside the tile on paper. Better indicator, and it composes with the selection ring instead of fighting it. |
| **B3** | §9 said `npm run test -w @quincy/web`, skipping every other workspace; and §3 added a public prop to a shared primitive with no test coverage specified. | §9 corrected to `npm run test --workspaces` plus the separate `packages/shared` run. New **§8a** specifies the five tests slice 5 owes. |
| NB1 | `.button` is **50** tokens across 14 files, not 48 (Sol parsed with `@babel/parser`; this session used a regex). | §0 corrected; the parser count is authoritative. |
| NB2 | §6's heading said "five" against a four-row table. | Corrected to four. The fifth was the `before:`-variant false positive removed from the guard earlier the same day. |
| NB3 | `--dur-reveal` is used at `app.css:160` **and `:276`**; `--scrim-bottom` is `:166`, not `:167`. | §7 corrected; the second `--dur-reveal` site is called out explicitly, since missing it leaves the guard red. |
| NB4 | §1.1 claimed `index.css` imports `production-calendar.css`. It does not — the calendar component imports it into its own chunk. | §1.1 corrected. The cascade conclusion (both are unlayered) was right and stands. |
| NB5 | Two instructions did not prescribe a unique output: the `typography.css` comment update, and what happens to the phantom guard's constant. | Both now give exact text. |

Sol confirmed correct, and this session did not re-litigate: §2.4's DOM-only claim (traced through
`query`, the filter, and the calendar debounce), §3.0's Base UI finding, §4's two deletions
(identical SHA-256 hashes; zero `acc-olive` consumers including tests), and §8's slice ordering.

---

## §1 — The shared constraints every slice must hold

Read these before any slice.

### 1.1 The unlayered-cascade rule

`index.css` declares `@layer theme, base, components, utilities` and then imports `app.css`
**outside every layer** (`styles/index.css:1-11`). `production-calendar.css` reaches the page by a
different route — `ProductionCalendarSurface.tsx` imports it, so it lands in that component's own
CSS chunk — but it is equally **unlayered**, which is what actually matters here. An unlayered rule
beats any Tailwind utility regardless of specificity, and on a specificity tie it also beats the global
`:focus-visible` in `tokens/base.css`, because that file is imported first and equal specificity
resolves by source order. Consequences that bind this plan:

- Deleting an unlayered rule can *reveal* a utility that was always losing. That is the intended
  outcome in §5, but it must be checked, never assumed.
- Adding a rule to `app.css` to beat a utility is not a fix. It is the trap. §5's tile fix is
  deliberately expressed in `app.css` because the mechanic it reuses (`--ring`) already lives
  there — it is repairing an unlayered rule, not adding a new override.

### 1.2 Class names that carry no CSS may still be load-bearing

`.dashboard-search`, `.dashboard-viewbar` and `.dashboard-sort` have **no CSS** — grep
`styles/*.css` returns nothing. They are **test hooks**: `Dashboard-calendar.dom.test.tsx` selects
`.dashboard-search input` six times. Every one of them survives §2 unchanged. This is the same
pattern TB8-06 established when its classes outlived their CSS.

### 1.3 Design-system source

Every value below traces to `styles/tokens/*.css`. Invent nothing. Spacing is `--space-*`, type is
the `--type-*` composites or a merged `[font:]` shorthand, colour is a role
(`text-foreground-secondary`, `bg-card`, `border-border`), never a ramp alias.

### 1.4 The merged-shorthand rule

Tailwind emits `[font:…]` arbitrary-property rules **after** `text-[length:…]` utilities at equal
specificity, so the shorthand always wins and any bare `text-[length:…]` beside it is dead code
that silently changes the rendered size. Express a size *inside* one shorthand:

```
[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]
```

This is enforced by `styles/design-system-guards.test.ts`. §6 is the work of clearing its baseline.

### 1.5 Viewports

1440×900, 1024×768, 390×844. Every acceptance criterion below is checked at all three unless it
names one.

---

## §2 — The toolbar: search and New shoot move onto the board's control strip

**Owner request, 2026-09-04**, with a marked-up screenshot: move the search field and the
**New shoot** button from the page header down to the row directly above the Kanban board.

### 2.1 Why this is right, and not merely requested

The two controls currently sit in the page-title block, opposite the `Projects` `<h1>`. Neither
belongs there. Search *filters what the board shows*; New shoot *creates what the board holds*.
Both are operations on the collection, and the collection's control strip is the `.dashboard-viewbar`
row — which today holds Active/Archived, List/Kanban/Calendar and Board order, and is **right-aligned
with an empty left half**. The change puts the collection's controls in one place and leaves the
header as a pure title block.

It also fixes a tab-order/visual-order mismatch: today a keyboard user reaches search *before* the
Staff Notice Board and the summary figures, then has to travel back down past both to reach the
view controls that search interacts with. After the move, tab order follows reading order.

### 2.2 The current markup (`screens/Dashboard.tsx`)

- **Header block**, line ~909: `<div className="flex flex-wrap items-end justify-between gap-x-[var(--space-6)] gap-y-[var(--space-5)] pb-[var(--space-4)]">` containing the eyebrow + `<h1>`, then the search `<label>` + New shoot group at line 914, then the `<hr>` rule.
- **Viewbar**, line ~944: `<div className={cn("dashboard-viewbar", "flex flex-wrap items-center justify-end gap-x-[var(--space-3)] gap-y-[var(--space-2)] mb-[var(--space-4)] pt-[var(--space-4)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border max-[721px]:justify-start")}>`

### 2.3 The change — exact

**Sol r1 B1 — the first draft of this section was wrong, and the record matters.** It moved the
group in as a sixth flat child with `mr-auto`, and asserted that wrapping was unchanged. Auto
margins are resolved *after* flex line breaking, so `mr-auto` can never keep an item off a second
line — it only absorbs free space on whichever line the item already landed on. And the row does
now wrap: adding a `min-w-[min(100%,300px)]` field plus a button to a control strip that was
already near-full leaves ~1,130px of content in ~928px of usable width at 1024px. The wrap that
follows lands mid-group and **orphans the `View` label from its own segmented control.**

The fix is the restructure the first draft explicitly forbade. Forbidding it was the error: re-flow
is not the risk here, it is the requirement — what matters is that the row wraps between *groups*
rather than through the middle of one.

**(a)** Change the viewbar's own class string to:

```
cn("dashboard-viewbar",
   "flex flex-wrap items-center gap-x-[var(--space-6)] gap-y-[var(--space-3)] " +
   "mb-[var(--space-4)] pt-[var(--space-4)] [border-top-style:solid] " +
   "border-t-[length:var(--border-width-hair)] border-t-border")
```

Changed from the current string: **`justify-end` is dropped** (alignment moves to an auto margin in
(c)); `gap-x-[var(--space-3)]` → `gap-x-[var(--space-6)]`, because the two groups are now distinct
regions and need the wider separation the header block already uses between its own two halves;
`gap-y-[var(--space-2)]` → `gap-y-[var(--space-3)]`, because a wrapped row is now two full control
groups rather than a stray chip. **`max-[721px]:justify-start` is removed from the parent** — it
moves onto the right group in (c).

`justify-between` is deliberately **not** used. With `flex-wrap`, `space-between` places a lone item
at the *start* of its line, so the moment the row wraps the segments would jump from their present
right alignment to the left. The auto margin in (c) gives the correct behaviour in both states.

**(b)** Insert the moved group as the viewbar's **first child**, before the `canViewArchived`
fragment, wrapped as:

```
<div className="flex items-center gap-[var(--space-3)] flex-wrap max-[721px]:basis-full">
```

(The moved group's own class string, minus the `mr-auto` the first draft proposed.)

**(c)** Wrap **all** the viewbar's existing children — the `canViewArchived` fragment, the
`viewingArchived` Eyebrow, the `!viewingArchived` fragment containing the View label, the view
segments and the Kanban sort `Select` — in a second sibling `<div>`:

```
<div className="flex items-center flex-wrap justify-end gap-x-[var(--space-3)] gap-y-[var(--space-2)] ml-auto max-[721px]:basis-full max-[721px]:justify-start">
```

`ml-auto` is what keeps the segments right-aligned in **both** states, and it is a legitimate use of
an auto margin where B1's was not: B1 tried to use one to stop a wrap, which is impossible, whereas
this one aligns the group on whatever line it lands on — which is exactly what auto margins do.
Unwrapped, it absorbs the free space between the two groups and pins the segments right, as today.
Wrapped, the group is alone on its line and it pins them right there too. At ≤721px
`basis-full` makes the group full-width, so the auto margin resolves to zero and the group's own
`max-[721px]:justify-start` governs — the present phone behaviour, unchanged.

This preserves the existing inner gaps exactly, and it is what makes the wrap safe: at 1024px the
right group alone is ~657px inside ~928px, so it never has to wrap internally, and the `View` label
stays beside its control. **Move the conditionals wholesale — do not unwrap, re-order or re-gate
any of them.**

**(c)** The search `<label>`, its icon `<svg>`, its `sr-only` span, the `.dashboard-search` hook and
the New shoot `InternalLink` all move **verbatim**, except for the one class fix in §6 item 1.

**(d)** The header block keeps the eyebrow, the `<h1>` and the `<hr>`, and loses nothing else. Its
own class string stays exactly as it is: `justify-between` with a single flex child is a no-op, and
`gap-y-[var(--space-5)]` still separates the title from the rule when they wrap.

### 2.4 Behaviour that must not change

1. `query` state, `setQuery`, `sanitizeDashboardCalendarSearch` on change, and the debounced
   calendar route sync (`calendarSearchTimerRef`, lines ~382–400) are untouched. This is a DOM move,
   not a state change.
2. The group renders in **both** project scopes. It sits outside the `canViewArchived` and
   `!viewingArchived` conditionals, so search stays available on archived projects exactly as it is
   today. Placing it inside either gate is a regression.
3. New shoot stays gated on `canCreateProject`.
4. `.dashboard-search` survives (§1.2).

### 2.5 Acceptance

| # | Criterion | Where |
|---|---|---|
| 2-1 | At 1440, the viewbar reads: search, New shoot — gap — Projects Active/Archived, View List/Kanban/Calendar, Board order. The header shows only the eyebrow, `Projects`, and the rule. | 1440 |
| 2-2 | At 1024 the viewbar wraps **between the two groups** — search + New shoot on the first line, the whole segment block right-aligned on the second. The `View` label is never separated from its segmented control, and nothing overflows the page horizontally. This is the case Sol r1 B1 caught; check it before anything else. | 1024 |
| 2-3 | At 390 the search group occupies its own full-width row above the segments; the input is full width; New shoot is a full-height target beside it or wrapped below it, never clipped. | 390 |
| 2-4 | Typing in the field still filters List and Kanban, and still debounce-syncs the Calendar route. | 1440 |
| 2-5 | Tab order runs: brand/nav → notice board → summary → **search → New shoot** → Active/Archived → view segments → Board order → board. | 1440 |
| 2-6 | The field keeps its focus-within treatment: `border-primary` plus the 2px `outline-ring` at `outline-offset-2`. | all |
| 2-7 | Switching to Archived leaves search and New shoot visible and working. | 1440 |

---

## §3 — D-01: the mobile menu has no scrim

**Evidence.** At 390×844 the open account/navigation menu panel is opaque, but nothing dims the page
behind it, so the page `<h1>` runs up to the panel's left edge and is sliced mid-word. It reads as a
rendering bug even though the panel paints correctly.

**Root cause, confirmed.** `components/ui/menu.tsx:89–102` renders `MenuPrimitive.Portal` →
`Positioner` → `Popup` with **no `MenuPrimitive.Backdrop`**. Base UI supplies one; the TB8-02 port
never adopted it.

### 3.0 The Backdrop does render under `modal={false}` — verified in the installed package

The obvious way for this fix to be inert is for Base UI to suppress the backdrop when the menu is
non-modal, which this one deliberately is. It does not.
`portal/node_modules/@base-ui/react/menu/backdrop/MenuBackdrop.js` reads only `open`, `mounted` and
`transitionStatus` from the menu store — **`modal` is never consulted**. Two further details the
builder should not have to rediscover:

- Closed, the element carries the `hidden` attribute (`hidden: !mounted`), so it is `display: none`
  between openings. Do not add a `display` utility, which would defeat that.
- `pointer-events: none` is applied only when the menu was opened by `triggerHover`. A click-opened
  menu's backdrop therefore does capture the press, and Base UI's own outside-press logic dismisses
  the menu — which is the behaviour we want on a phone, and criterion 3-5 checks it.

### 3.1 The design decision this plan closes

A backdrop must **not** be added unconditionally. `Menu` has exactly two consumers
(`components/Topbar.tsx:194` and `:256`) and they want opposite things:

- **The notification bell** (`:194`) is a dropdown list under an icon in a sticky bar. Dimming the
  whole page behind a notification list is wrong, and `modal={false}` was chosen deliberately
  (documented at `menu.tsx:59–62`) so the page is not `aria-hidden` behind it.
- **The mobile account/navigation menu** (`:256`, `panelClassName="topbar__mobile-menu"`) is a
  full-height navigation surface on a phone. It is the one that needs the scrim.

So: **opt-in, per consumer.**

### 3.2 The change — exact

**(a)** `components/ui/menu.tsx` — add to `MenuProps`:

```ts
/**
 * Dim the page behind the open menu. Off by default: a dropdown list under an icon (the
 * notification bell) should not dim the page, while a full-height phone navigation surface must,
 * or the page shows through beside the panel and reads as a rendering fault (D-01).
 */
backdrop?: boolean;
```

Destructure `backdrop = false`, and render inside `MenuPrimitive.Portal`, **before** `Positioner`:

```tsx
{backdrop && (
  <MenuPrimitive.Backdrop className={cn(
    // Same z-index as the Positioner below, deliberately: the Backdrop is rendered first, and
    // equal z-index resolves by DOM order, so the panel paints above its own scrim without a
    // new stacking token. `tokens/spacing.css:58-63` defines only --z-popover (90), --z-dialog
    // (95) and --z-toast (98) — there is nothing below 90, and inventing one for a single
    // sibling pair would be a token with no second consumer.
    "fixed inset-0 z-[var(--z-popover)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
    "motion-safe:[transition:opacity_var(--overlay-exit)]",
    "data-open:motion-safe:[transition:opacity_var(--overlay-enter)]",
    "opacity-0 data-open:opacity-100",
  )} />
)}
```

Every value here is cited, not chosen: `bg-[var(--scrim-overlay)]` + `backdrop-blur-[3px]` is
**exactly** `Modal.tsx`'s `SCRIM` paint (`components/Modal.tsx:46-53`), so the app has one scrim
appearance rather than two; `--overlay-enter` / `--overlay-exit` are TB8-02 §4.3's named composites,
already used by `PANEL` three lines above, so the scrim and the panel share one motion contract.
Do **not** add Modal's `"scrim"` class — it carries no CSS but is another component's hook.

Ordering is load-bearing: `Backdrop` must be the **first** child of `Portal`, before `Positioner`.

**(b)** `components/Topbar.tsx:256` — add `backdrop` to the mobile menu's `<Menu>` props. Leave the
notification bell at `:194` untouched.

### 3.3 Acceptance

| # | Criterion | Where |
|---|---|---|
| 3-1 | Opening the hamburger menu dims the page behind it; no page text reads as sliced beside the panel. | 390 |
| 3-2 | The panel itself paints at full opacity above the scrim. | 390 |
| 3-3 | The scrim fades in and out with the panel, and does not animate under `prefers-reduced-motion: reduce`. | 390 |
| 3-4 | Opening the **notification bell** dims nothing — no scrim element in the DOM for it. | 1440, 390 |
| 3-5 | Escape, outside-click dismissal and focus return still work for both menus. | 390 |
| 3-6 | The page behind is still reachable to assistive tech (`modal={false}` semantics unchanged — the scrim is paint, not a focus trap). | 390 |

---

## §4 — D-02, D-03: two dead blocks in `app.css`

**D-02 — duplicate `.sr-only`.** `styles/app.css:641` and `:653` declare byte-identical rules.
Harmless in cascade terms, which is exactly why it survived. **Delete the second (`:653`); keep
`:641`.**

**D-03 — the dead olive-accent block.** `styles/app.css:494–501`, seven selectors:

```css
/* ---- tweak: olive accent variant ---- */
.app.acc-olive { --accent: var(--signal-positive); }
.app.acc-olive .chip.is-active,
.app.acc-olive .segment button.is-active { … }
.app.acc-olive .meter > i { … }
.app.acc-olive .topnav a.is-active,
.app.acc-olive .ctab.is-active { … }
.app.acc-olive .tile.is-selected { --ring: var(--signal-positive); }
```

`grep -rn "acc-olive" portal/apps/web/src --include='*.tsx' --include='*.ts'` returns **0**,
re-verified 2026-09-04. It descends from the prototype's accent switching, which the portal never
shipped. **Delete the comment and all seven selectors.** Re-run that grep at build time rather than
trusting this line — including test files.

**Acceptance:** `app.css` shrinks by the deleted lines; typecheck, build and the full suite stay
green; no visual diff at any viewport.

---

## §5 — D-09: the photo grid gives a keyboard user no focus indicator

**This is the highest-severity item in the plan.** It was found by
`design-system-guards.test.ts`, not by any review, and it is the same defect family as TB8-09's
headline (`.strip__button`) on a different surface — the fourth instance of the pattern.

**Evidence, `styles/app.css:154–158`:**

```css
.tile {
  position: relative; aspect-ratio: 3 / 2; overflow: hidden; background: var(--ink-800);
  cursor: pointer; outline: 0; --ring: transparent;
  box-shadow: inset 0 0 0 2px var(--ring);
  transition: box-shadow var(--dur-fast);
}
```

`--ring` is lit only by `.tile.is-selected` (`:173`), `.tile.st-approved` (`:174`) and
`.tile.st-flagged` (`:175`). There is **no `:focus-visible` rule at all**, and `outline: 0` in
unlayered CSS suppresses the global `:focus-visible` outline from `tokens/base.css:25`. The tile is
focusable. A keyboard user tabbing the grid therefore gets **nothing**.

### 5.1 The fix — restore the app's own focus outline, scoped past `outline: 0`

**Sol r1 B2 — the first draft of this section was wrong twice.** It proposed lighting the tile's
inset `--ring` with `var(--focus-ring)`, on the reasoning that an outline would be clipped. Both
halves fail:

1. **The contrast is not there.** `--focus-ring` is `--ink-900` `#0a0a0a` (`tokens/colors.css:74`);
   the tile's own ground is `--ink-800` `#141414` — **1.07:1** — and over a photograph the ring
   lands on whatever the image happens to be. An indicator that may or may not be visible does not
   satisfy this section's own acceptance criterion 5-1.
2. **The clipping premise is false.** An element's own `overflow: hidden` does not clip its own
   outline, and neither `.legacy-grid` (`app.css:149`) nor `.workgrid` (`:242`) establishes an
   overflow-clipping ancestor.

So the outline is available after all, and it is the better indicator: it is drawn **outside** the
tile, on the page's paper ground, where ink is high-contrast regardless of what the photograph
underneath looks like. Insert immediately **after** `.tile.st-flagged` (`:175`):

```css
/* D-09: `outline: 0` above suppresses the global :focus-visible ring from tokens/base.css:25, and
   --ring is lit only for selection/review state — so a keyboard user tabbing the grid got no
   indicator at all (WCAG 2.4.7). Restore exactly the app-wide focus treatment rather than lighting
   the inset ring: --focus-ring is ink, which is 1.07:1 on the tile's own ground and arbitrary over
   a photograph, whereas an outline at a positive offset is drawn outside the tile on paper. The
   tile's own `overflow: hidden` does not clip its own outline, and no ancestor clips it either. */
.tile:focus-visible {
  outline: var(--border-width-bold) solid var(--focus-ring);
  outline-offset: 2px;
}
```

Two consequences worth stating rather than discovering:

- Specificity `(0,2,0)` beats `.tile`'s `(0,1,0)`, so this needs no `!important` and no source-order
  argument against the base rule. It also does not compete with `.tile.is-selected` at all, because
  it sets `outline` while those rules set `--ring`: a tile that is both selected and focused
  correctly shows **both** the inset selection ring and the outer focus outline.
- `outline-offset: 2px` places the outline inside `.legacy-grid`'s `gap` (`var(--gap, 14px)`), so
  it is not overlapped by an adjacent tile.

### 5.2 The tile is definitely focusable — confirmed, not assumed

`components/PhotoGrid.tsx:173` renders the tile as:

```
role="button" tabIndex={previewPending ? -1 : 0}
onKeyDown={… Enter | " " → activate()}
```

So it is in the tab order and it is operable from the keyboard, with no indicator of any kind. That
makes D-09 a live **WCAG 2.4.7 (Focus Visible)** failure on the photo grid in production, not a
polish item — which is why it is ranked above the rest of this plan.

One thing to record rather than fix here: on a dark photograph an ink ring is low-contrast. It is
the same ring `.tile.is-selected` already uses, so this plan deliberately does not change the
value — but **note in the build report whether the ring is discernible on a dark tile at 1440**, as
evidence for whether TB8-10B should revisit the token.

### 5.3 Acceptance

| # | Criterion | Where |
|---|---|---|
| 5-1 | Tabbing into the photo grid shows a visible outline on the focused tile — **checked over a dark photograph, not only over the empty-tile ground**, since that is the case the first draft would have failed. | 1440, 390 |
| 5-2 | Clicking a tile with the mouse shows **no** focus outline (`:focus-visible`, not `:focus`). | 1440 |
| 5-3 | A tile that is both selected and focused shows **both** the inset ink selection ring and the outer focus outline. | 1440 |
| 5-4 | Approved and flagged tiles keep their green/red inset rings, focused or not. | 1440 |
| 5-4b | The outline is not overlapped by an adjacent tile at the grid's gap. | 1440 |
| 5-5 | `SUPPRESSED_FOCUS_BASELINE`'s `.tile` entry is **deleted**, and the guard is green. | test |

---

## §6 — D-11: four dead `text-[length:…]` declarations

Each renders a size nobody asked for (§1.4). Sizes computed from
`tokens/typography.css`: `--text-xs` 12px, `--text-sm` 14px, `--text-md` 18px, `--text-base` 16px;
`--type-body` = 16px/`--leading-normal` sans, `--type-label` = 14px/1.2 sans, `--type-mono` =
14px/1.4 mono.

| # | Site | Today | Author asked for | Replace with |
|---|---|---|---|---|
| 1 | `screens/Dashboard.tsx:918` — the search input (moves in §2) | `[font:var(--type-body)]` + dead `text-[length:var(--text-sm)]` → **16px** | 14px | `[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]`, dropping the `text-[length:…]` |
| 2 | `components/RichTextEditor.tsx:37` `FIELD_LABEL` | `[font:var(--type-label)]` + dead `text-[length:var(--text-xs)]` → **14px** | 12px | `[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]` |
| 3 | `components/RichTextEditor.tsx:39` | `[font:var(--type-body)]` + dead `text-[length:var(--text-sm)]` → **16px** | 14px | `[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]` |
| 4 | `components/Topbar.tsx:52` | `[font:var(--type-mono)]` + dead `text-[length:var(--text-md)]` → **14px** | 18px | `[font:var(--weight-regular)_var(--text-md)/1_var(--font-mono)]` |

Item 4 is the notification **dismiss glyph** and is the one that renders *smaller* than intended;
`/1` rather than `/1.4` because it is a single glyph in a square target and a 1.4 line-box would
push its optical centre. Verify it stays vertically centred in its button.

**These are real size changes, not refactors.** Each is a visible before/after and belongs in the
visual gate, not waved through as a cleanup.

**Acceptance:** all four render at the "author asked for" column, measured in the browser;
`FONT_SIZE_COLLISION_BASELINE` loses its `RichTextEditor.tsx` and `Topbar.tsx` entries entirely and
`screens/Dashboard.tsx` drops to 0 (delete the key); the guard is green.

---

## §7 — D-04 + D-10: the phantom custom properties

Five tokens are used in CSS and defined nowhere, so each renders through its `var()` fallback
rather than through the token system. Two of them are the calendar's serif/sans faces — this is
D-04 and D-10 turning out to be the same defect, which is why they are one slice.

| Token | Sites | Real token | Fix |
|---|---|---|---|
| `--font-serif` | `production-calendar.css:175` | `--font-body-serif` | See below |
| `--font-body` | `production-calendar.css:62, 142, 152, 204` | `--font-sans` | Replace the token name; keep each rule's own literal size/weight |
| `--dur-reveal` | `app.css:160` **and `:276`** (`.tile img`, `.vtile__media img`) | — | Define, or inline the literal (below) |
| `--scrim-bottom` | `app.css:166` `.tile__scrim` | — | Same |
| `--scrim-full` | `app.css:423` `.chero__scrim` | — | Same |

### 7.1 The two calendar faces

`production-calendar.css:175` is
`font: 14px/1.5 var(--font-serif, Athelas, Georgia, serif)`. It renders correctly *today* — the
face arrives through the fallback half. The defect is that it would keep rendering Athelas if the
design system's serif changed. Replace with `var(--font-body-serif)` (no fallback list: the token
carries its own stack, `tokens/typography.css:20`). Do the same at the four `--font-body` sites,
onto `var(--font-sans)`.

`tokens/typography.css:5–13` already routes this fix to "that surface's own candidate" — this one.
Replace the sentence that defers it with exactly:

> Done in TB8-10A: `production-calendar.css` now names `--font-sans` and `--font-body-serif`
> directly; no `var()` fallback carries a face any more.

Leave the rest of that comment block untouched.

### 7.2 The three `app.css` phantoms

Each has a literal fallback that is the value actually rendering today. **Prefer promoting the
literal into a real token where one belongs, and inlining it where one does not:**

- `--dur-reveal` (fallback `720ms`) is a duration. `tokens/` owns `--dur-fast` / `--dur-base`.
  A 720ms reveal is a deliberate, much slower curve than either. **Define
  `--dur-reveal: 720ms` at `tokens/spacing.css:49`**, immediately after `--dur-base` and in its
  comment style, so the value is owned. Then drop the fallback at **both** use sites — `:160`
  and `:276`. Missing the second leaves a phantom behind and the guard stays red.
- `--scrim-bottom` and `--scrim-full` are gradients, not scalars, and are each used by exactly one
  rule. A single-use gradient is not a design-system role. **Inline each literal at its use site
  and delete the `var()` indirection** — the token that never existed is not worth inventing.

Whichever way each goes, **the rendered result must be byte-identical to today.** This section is
visually inert by construction; if anything moves, the change is wrong.

**Acceptance:** all five entries leave `PHANTOM_TOKEN_BASELINE`, so the constant becomes `{}`.
**Keep the constant and both tests** — do not delete them. The first test then asserts that *no*
phantom exists, which is precisely the steady state this guard is for; the second (baseline-honesty)
test iterates an empty object and passes trivially, and stays so the next person to add a baseline
entry inherits the ratchet. Update the constant's doc comment to say the list was cleared by
TB8-10A rather than leaving prose that describes five entries that are gone.

No visual diff at any viewport — this section is inert by construction. The guard is green.

---

## §8 — Slices

Bottom-up, each ending green on `npm run typecheck` and `npm run build -w @quincy/web`. Only the
last must satisfy the full gate. Slice sizes are deliberately uneven — §2 is the only one that
changes a screen's layout.

| Slice | Sections | Files | Note |
|---|---|---|---|
| **1** | §7 | `styles/production-calendar.css`, `styles/app.css`, `styles/tokens/*`, guard baseline | Visually inert. Do it first so the guard's phantom list is clear before anything else moves. |
| **2** | §4 | `styles/app.css` | Two deletions. Re-run the `acc-olive` grep first. |
| **3** | §5 | `styles/app.css`, guard baseline; read `PhotoGrid.tsx` | Stop and report if the tile is not focusable. |
| **4** | §6 | `Dashboard.tsx`, `RichTextEditor.tsx`, `Topbar.tsx`, guard baseline | Four real size changes. |
| **5** | §3, §8a | `components/ui/menu.tsx`, `components/Topbar.tsx`, `ui/menu.dom.test.tsx`, `Topbar.dom.test.tsx` | The z-index question is closed in §3.2 — same token as the Positioner, DOM order decides. Slice is not done without §8a's five tests. |
| **6** | §2 | `screens/Dashboard.tsx` | The layout move. Run `Dashboard-calendar.dom.test.tsx` specifically. |

Slice 4 touches `Dashboard.tsx:918` and slice 6 moves that same element. Slice 4 runs first and
changes only the class string; slice 6 then moves the element verbatim. **Slice 6 must not
reintroduce the `text-[length:…]`** — copy the element as slice 4 left it.

---

## §8a — The tests this plan owes

§3 adds a public prop to a shared primitive, and the pipeline requires the coverage to come with
it. Slice 5 is not done until these exist and pass. Two files:

**`components/ui/menu.dom.test.tsx`** — three cases, matching the three things §3 decides:

| Test | Assertion |
|---|---|
| renders a backdrop when asked | with `backdrop`, an element with `role="presentation"` exists in the portal while the menu is open |
| renders none by default | without the prop, no such element exists — this is what keeps the notification bell undimmed |
| the panel paints above its own scrim | the backdrop is an **earlier** sibling than the positioner in the portal's DOM order, which is the whole basis for them sharing one `z-index` (§3.2) |

**`components/Topbar.dom.test.tsx`** — two cases, wiring rather than mechanism:

| Test | Assertion |
|---|---|
| the mobile menu dims the page | opening the account/navigation menu puts the backdrop in the DOM |
| the notification menu does not | opening the bell does not |

Use the existing files' own open/query helpers; do not introduce a new testing utility. `Topbar.dom.test.tsx:402-420` already opens the mobile popup and asserts visibility — extend that path rather than building a second one.

**Every other slice is covered by tests that already exist**, and §9 item 2's count must move by
exactly the five added here. If a slice makes an existing test fail, that is a finding to report,
not a test to adjust.

---

## §9 — Gate

1. `npm run typecheck` — **check the exit code, not a grep of the output.** `tsc`'s ANSI colouring
   puts escape codes between `error` and `TS`, so `grep -c "error TS"` reports 0 on a failing run,
   and a pipe discards the exit status. This has produced a false green in this repo before.
2. `npm run test --workspaces` from `portal/` — **not** `-w @quincy/web`, which is what the first
   draft of this section said and which silently skips every other workspace's suite. `apps/web`
   is 948 tests today; the count moves only by the additions in §8a, and the report must say which.
3. `npx vitest run --config packages/shared/vitest.config.ts` from `portal/`. This is required
   separately: `packages/shared` has a vitest config but **no `test` script**, so
   `--workspaces` misses it (`CLAUDE.md`, "Verify before committing").
4. `npm run build -w @quincy/web`.
5. `design-system-guards.test.ts` green **with three baselines shrunk**: `PHANTOM_TOKEN_BASELINE`
   emptied, `FONT_SIZE_COLLISION_BASELINE` emptied, `SUPPRESSED_FOCUS_BASELINE` down to its two
   remaining entries (`.search input:focus`, `.copyinput:focus`). The baselines' "keeps the baseline
   honest" tests fail if an entry is fixed but left in the list, so this is enforced, not trusted.
6. The visual pass at 1440×900, 1024×768, 390×844 against every acceptance table above — this
   session's own gate, not delegated.

If this plan lands whole, TB8-10A **retires the guard file's entire reason for having baselines
except two entries**, both of which belong to TB8-10B's surfaces.

---

## §10 — Build record

Two Sonnet builders, sequential: slices 1–4 (the CSS/token/class work), then 5–6 (component, tests,
layout). Both reported green and both reports were checked against the diff rather than taken on
trust.

**Builder findings worth keeping:**

1. **Slice 3 removed `outline: 0` from `.tile`'s base rule**, which this plan's literal instruction
   ("insert after `.tile.st-flagged`") never asked for. It was right to: criterion 5-5 is otherwise
   unsatisfiable, because the guard flags the declaration unconditionally and knows nothing about a
   later override. Side effect, verified: with the suppression gone the global `:focus-visible` in
   `tokens/base.css` reaches the tile on its own, so `.tile:focus-visible` is now documentation
   rather than load-bearing. Kept anyway — the next reader needs the reason at the site.
2. **§8a's `role="presentation"` assertion was factually wrong.** Base UI's shared
   `usePositioner.js:33` stamps `role="presentation"` on the **Positioner**, unconditionally and
   independent of any Backdrop, so a bare `[role="presentation"]` selector is ambiguous whenever any
   menu is open — the "renders none by default" test failed on first run by matching the Positioner.
   Confirmed in the installed package. The builder disambiguated by the element that does **not**
   contain the `role="menu"` popup (the Backdrop is always empty, the Positioner always wraps the
   popup), in both test files, each with a comment. Sound, and it is what §3.2's z-index reasoning
   actually rests on.
3. **A guard defect, fixed at the root rather than worked around.** Guard 3 read raw CSS, so the
   comment *documenting* the `.tile` fix — which quotes `outline: 0` while explaining why the
   declaration was removed — was flagged as an instance of the thing it described, and the builder
   had to reword it. A guard that punishes you for documenting its own subject teaches people to
   stop writing the comment. `design-system-guards.test.ts` now strips CSS comments
   (line-preserving, since guard 3 reports line numbers) and the comment is back in its natural
   wording.

---

## §11 — Visual gate (this session, 2026-09-04) — **PASSED**

Chrome over CDP on the human-authenticated local-dev session, at 1440×900, 1024×768 and 390×844.

### One defect found and fixed at the gate

**The moved group wrapped internally at every desktop width**, stacking `New shoot` under the search
field and making the toolbar 89px tall where it should be 39px. The two groups were on one line
(`ml-auto` resolved to 403px, so the mechanism was working); the left group was simply being sized
to **338px when its content needs 416px**.

Cause: the search field carried `min-w-[min(100%,300px)]`, and once the group became a flex item in
a wrapping container that percentage is **circular** — `100%` resolves against the group whose width
depends on the field. During intrinsic sizing the percentage contributes nothing, the group is
measured at 338px, and then at layout the field takes its 300px and no longer fits beside the
button. `min-width: max-content` does not help: for a *wrapping* flex container that resolves to the
already-wrapped size.

This is a **pre-existing latent bug the move exposed, not one it introduced** — the circularity was
always in that class string; the header block's roomier context masked it. Fixed by de-circularising
to a plain `min-w-[300px]`; the field already carries `max-[721px]:min-w-0`, which is what actually
governs on a phone, so the percentage was doing no work there either.

### Measured results

| Criterion | 1440 | 1024 | 390 |
|---|---|---|---|
| Left group on one line, `New shoot` beside the field | 416×39 ✓ | 416×39 ✓ | n/a — full-width field, button below (by design) ✓ |
| Groups share a line / wrap **between** groups | same line ✓ | wraps between groups ✓ | stacked ✓ |
| `View` and `Projects` labels stay with their controls | ✓ | ✓ (**Sol B1's case**) | own line, by existing design ✓ |
| Segments right-aligned to the viewbar edge | ✓ | ✓ | ✓ |
| Horizontal overflow | none | none | none |

**§3 scrim:** mobile menu open → one `fixed` 390×844 backdrop, `ink/50%` + `blur(3px)`, `z-index: 90`
— identical to `Modal.tsx`'s SCRIM. Notification bell open → **no backdrop**. Closed → none. The
page behind now reads as dimmed background rather than a rendering fault.

**§5 D-09:** `.tile` computes `outline: none` normally and
`outline: solid 2px rgb(10,10,10)` at `outline-offset: 2px` under a forced `:focus-visible` (CDP
`CSS.forcePseudoState`; the local fixtures are `previewPending`, hence `tabindex="-1"`, so real Tab
focus was not available). Before the fix it was `none` in both states. Confirmed visually: the
focused tile carries a clear outline, the adjacent one none. **§5.2's dark-photograph concern is
resolved structurally rather than merely untested** — the outline is drawn outside the tile on the
paper ground, so the photograph beneath is irrelevant. That was the point of choosing it over the
inset ring.

**§6:** all four sizes correct — `FIELD_LABEL` 12px, `FIELD_INPUT` 14px, `DISMISS` 18px mono in its
44px box, search input 14px.

**§7:** inert as claimed. `--font-sans` leads with "Apfel Grotezk" and `--font-body-serif` with
"Athelas" — the exact faces the deleted `var()` fallbacks named, so the calendar renders unchanged.

### Gate

typecheck 0 · build 0 · `apps/web` **726** (721 + §8a's five) · 115 / 227 / 726 / 296+1skip / 253 /
13 · `packages/shared` 144 · guards 6/6. `--workspaces` exits 1 only for `@quincy/shared`'s missing
`test` script, verified identical on a stashed clean tree.

`PHANTOM_TOKEN_BASELINE` and `FONT_SIZE_COLLISION_BASELINE` are both `{}`.
`SUPPRESSED_FOCUS_BASELINE` holds two entries, both owned by TB8-10B.
