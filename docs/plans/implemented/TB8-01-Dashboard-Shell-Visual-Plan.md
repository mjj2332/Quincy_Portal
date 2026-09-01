# TB8-01 — Dashboard Shell: Visual Plan

**Status: DEPLOYED TO PRODUCTION 2026-09-01** (commit `af4d833`,
`feat(tb8): TB8-01 Dashboard shell design convergence on Tailwind/shadcn`; app Worker
`0b31144d-7617-4010-85ef-13baa0fd4a46`; rollback target app `8fd42378-4e77-41b3-b816-c5f78851b42a`,
the prior deploy, Project-Navigation-And-External-Editor-Collections). Candidate release #1
of [TB8 — Surface-by-Surface Design Convergence and Cleanup](../revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md).
Pipeline per [Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md](../Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md).
History: drafted 2026-09-01; revised onto the Tailwind v4 + shadcn foundation; revised for two
fresh-Sol review rounds (the pipeline's ≤2-round cap) and three owner decisions; self-edited past
the cap per the standing §2.1 rule; built, verified, committed, and deployed. Its own commit
predates TB8-02's branch/merge workflow — it landed on `main` directly and reached production via
a separate `wrangler deploy` (app Worker `0b31144d`) the same day, not recorded in `docs/todo.md`'s
running deploy list at the time; that gap was closed 2026-09-02 alongside the TB8-02 deploy.

> **Final Opus self-review — APPROVED, 2026-09-01.** Independent terminal-gate review with no
> drafting context, per the standing "past the ≤2-round cap Opus edits the plan itself and a fresh
> Opus self-review approves it" rule (pipeline step 3).
>
> Verified against the TB8 pipeline plan and its Tailwind-scope decision, the TB8 roadmap's rules,
> TB1's deployed foundation, the design-system readme + `portal/apps/web/src/styles/tokens/`,
> Drift-Register row `TB0-VIS-01`, and `docs/lessons.md`. Every `file:line` citation in this plan
> was checked against live source and found accurate, with the two exceptions corrected below.
> Specifically confirmed real: all ten `Dashboard.tsx` citations; `app.css:462/780/922/924/1021`;
> `ProjectKanbanBoard.tsx:296/308/557`; `NoticeBoard.tsx:125/128/145`; `colors.css:33/52`;
> `spacing.css:44`; `lessons.md:864–901`; `.toasts`' three non-Dashboard consumers
> (`Admin.tsx:466`, `ProjectWorkspace.tsx:317/341`); every token, type role, and utility cited in
> §§1.1–1.4; `cn()` in `lib/utils.ts` with `clsx`/`tailwind-merge` declared and **no `cva`
> anywhere** in either `package.json`; and zero raw Tailwind-palette utilities in `apps/web/src`.
> The four previously-flagged failure modes are absent: no `border-*-solid`, no self-referential
> `--ease-*` theme alias, no raw-ramp promotion, no withdrawn `Input` edit.
>
> **Fixes applied at this gate** (small and clearly correct; nothing blocking was found):
> 1. §2.1 — the accepted List-vs-Kanban retry-button inconsistency is now stated and classified,
>    with its closure condition, rather than left implicit.
> 2. §2.1 — `text` variant `py-[var(--space-2)]` → `py-[6px]`, matching `.button--text`
>    (`app.css:936`) as the section's own geometry-matching principle requires.
> 3. §7.3 — corrected `app.css:857` → `:865`, and corrected the claim that
>    `.stat:nth-child(3) { border-left: 0 }` (`app.css:840`) is dead; it is live, and the plan's
>    Tailwind form already reimplements it.
> 4. §7.4 — `--text-muted` on `--bg-sunken` recomputed, 2.6:1 → **2.9:1** (conclusion unchanged:
>    it fails 4.5:1, so `disabled:text-foreground-secondary` at 7.4:1 stands).
> 5. §8.2 — `stageIndex` is not in `KanbanColumn`'s scope today; the three mechanical edits that
>    put it there are now spelled out, closing an ambiguity the pipeline forbids deferring.
> 6. §12.12/§12.13 — a `querySelector` in a test file is now explicitly a consumer under the
>    grep rule, with the six `.dashboard-search input` queries in `Dashboard-calendar.dom.test.tsx`
>    (previously unlisted) and the `.dashboard-sort` / `.prow*` queries enumerated.
>
> **The two hardest-look seams both hold.** `buttonClasses()` cleanly resolves the anchor-vs-button
> problem: both anchor consumers stay real `<a href>` `InternalLink`s with the class string applied,
> no element is wrapped or converted, no `asChild`/Slot indirection and no new dependency is
> introduced, and the acceptance check is concrete and testable. The `.kcard__retry` exclusion is
> the right call under the roadmap's *no whole-app rewrite* rule and the carve-out's release-
> ownership rationale — those controls belong to the *board filters/card controls* candidate — and
> its residual cost is now recorded per fix 1.

**Styling-owner authority.** See
[Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md § "Decision: Tailwind adoption scope for TB8
(2026-09-01)"](../Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md#decision-tailwind-adoption-scope-for-tb8-2026-09-01).
**TB8 extends Tailwind v4 + shadcn to the Dashboard shell as its second bounded consumer**, on the
foundation TB1 deployed 2026-08-25 (`components.json`: style `base-sera`, `cssVariables: true`,
baseColor `neutral`, Lucide, no prefix; `src/styles/index.css` importing `tailwindcss/theme.css` +
`tailwindcss/utilities.css` as layers; Preflight disabled; no dark mode — per D-16/A8). This is an
extension of TB1's setup, never a parallel one.

**Scope.** Page masthead, search, summary ledger, view/scope control bar and its sort control, List
view, Kanban view chrome, board-unavailable/empty/loading/error states, toasts, and — narrowly —
the Notice Board unread indicator's paint plus two Notice Board wrap fixes.

**Explicitly out of scope** (owner decisions and deferrals recorded in §11):

- **The app top bar, nav, notification menu, and mobile menu.** Owner decision 2026-09-01: the top
  bar is a single app-wide shared shell component and Dashboard-only changes would split visual
  ownership. Left exactly as it currently renders. §11.1 carries the findings forward.
- **The Notice Board's broader visual redesign.** Owner decision: only the unread indicator's paint
  changes here; the panel belongs to the later *notice board* TB8 candidate. §9 and §11.2.
- **Sticky List header.** Owner decision: dropped, no demonstrated baseline pain.
- Production Calendar internals (TB5C), Kanban drag mechanics and the TB5B state machine
  (§1.4), Project Workspace, the rich-text editor surface.

---

## 1. Styling foundation and ownership

### 1.1 What the foundation already gives us

`src/styles/tokens/tailwind.css` declares the shadcn semantic variables against Quincy tokens and
re-exports them through `@theme inline`. These utilities are **live now** and are the required form
wherever a role fits:

| Utility | shadcn var | Quincy token |
| --- | --- | --- |
| `bg-background` / `text-foreground` | `--bg-canvas` / `--text-primary` | `--paper-050` / `--ink-900` |
| `bg-card`, `bg-popover` | `--bg-surface` | `--paper-000` |
| `bg-secondary`, `bg-muted` | `--bg-raised` | `--paper-100` |
| `text-muted-foreground` | `--text-muted` | `--greige-400` |
| `bg-primary` / `text-primary-foreground` | `--accent` / `--accent-on` | `--ink-900` / `--paper-050` |
| `border-border`, `border-input` | `--border-hairline` | `--greige-200` |
| `outline-ring` | `--focus-ring` | `--ink-900` |
| `bg-destructive` / `text-destructive` / `text-destructive-foreground` | `--signal-critical` / `--paper-050` | oxblood / paper |
| `text-signal-positive` / `-caution` / `-critical` / `-info` | the four signals | muted olive/ochre/oxblood/slate |

### 1.2 Convention for values the theme does not name

TB1's shipped source is the precedent: values with no theme entry are written as **arbitrary values
bound to the Quincy variable**, never as a literal. From `ui/field.tsx` as deployed:

```
[font:var(--type-eyebrow)]  uppercase  tracking-[var(--tracking-wide)]  text-[var(--text-secondary)]
```

TB8-01 follows it. Spacing `p-[var(--space-4)]`, type roles `[font:var(--type-h2)]`, sizes
`text-[length:var(--text-sm)]`, border widths `border-[length:var(--border-width-hair)]`, motion
`duration-[var(--dur-fast)] ease-[var(--ease-standard)]`.

**Eases stay in arbitrary form.** The first revision proposed `@theme` entries named
`--ease-standard: var(--ease-standard)` — self-referential, since that property already holds the
real value at `tokens/spacing.css:44`. Tailwind would emit a circular reference and every
`ease-standard` utility would silently lose its timing function. Writing
`ease-[var(--ease-standard)]` at each site avoids the problem with no theme delta at all.

### 1.3 Directional borders — `border-*-solid` does not exist

**Preflight is disabled, so nothing sets a global `border-style`.** The CSS initial value is `none`,
which means a directional width utility alone renders no border. The first revision wrote
`border-t-solid` / `border-b-solid` / `border-l-solid` / `border-y-solid`; **those are not Tailwind
4.3.3 utilities** and compile to nothing.

The naive repair is also wrong: `border-solid` sets the style on all four sides, and with the
initial `border-width: medium` the three unstyled sides would render at **3px**. Two correct forms:

| Case | Form |
| --- | --- |
| One or two sides bordered | arbitrary style property per side: `[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border` |
| All four sides bordered | `border-solid border-[length:var(--border-width-hair)] border-border` |

Every directional border in §§5–10 uses the first form. This is mechanical and easy to get wrong at
review time — Sol and the builder should grep the diff for `border-t-solid`, `border-b-solid`,
`border-l-solid`, `border-r-solid`, `border-x-solid`, `border-y-solid` and treat any hit as a defect.

### 1.4 Theme extension — narrow semantic roles only, never the raw ramp

`colors.css:33` is explicit: *"SEMANTIC ALIASES — reference these in components, not the raw
scale,"* and the Design Convergence contract's per-surface definition of done requires *semantic
Quincy tokens used* with *no raw palette as feature contract*. The first revision promoted the whole
`paper-*`/`ink-*`/`greige-*` ramp into `@theme` and then used `bg-paper-100`, `border-greige-300`,
`bg-ink-700` throughout — which is exactly the raw-scale drift both documents forbid. Withdrawn.

Instead, reuse the existing roles (§1.1) and add only the roles that genuinely do not exist. Seven,
each named for what it *means*:

```css
@theme inline {
  /* ---- existing --color-* block unchanged ---- */

  /* Mid-tone body text: darker than muted-foreground, lighter than foreground.
     shadcn's variable set has no slot for it; Quincy uses it constantly. */
  --color-foreground-secondary: var(--text-secondary);

  /* Recessed surface for disabled controls and skeleton fills. */
  --color-surface-sunken: var(--bg-sunken);

  /* Ink surface for inverse elements (toasts). */
  --color-surface-inverse: var(--bg-inverse);
  --color-on-inverse:       var(--text-on-inverse);
  --color-on-inverse-muted: var(--text-on-inverse-muted);

  /* The border a control takes on hover — one step up from the hairline. */
  --color-border-hover: var(--greige-300);

  /* The ink surface a primary control takes on hover. */
  --color-primary-hover: var(--ink-700);
}
```

Yields `text-foreground-secondary`, `bg-surface-sunken`, `bg-surface-inverse`, `text-on-inverse`,
`text-on-inverse-muted`, `border-border-hover`, `bg-primary-hover`. Everything else the Dashboard
needs already has a role: paper-100 hover is `bg-secondary`, paper-000 surfaces are `bg-card`,
ink-900 is `bg-primary`, paper-050 on ink is `text-primary-foreground` /
`text-destructive-foreground`.

**Hard non-goal — do not map `--spacing-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--tracking-*`,
`--leading-*`, or `--font-*`.** Each collides with a Tailwind default scale whose values differ from
Quincy's, and a collision silently restyles TB1's *live production* `ProjectFields` Client section.
Concretely: Tailwind v4 computes `p-5` as `calc(var(--spacing) * 5)` = **20px** where Quincy's
`--space-5` is **24px**. Spacing and type therefore stay in arbitrary-value form for the whole
surface. Sol should treat any builder attempt to "simplify" `p-[var(--space-5)]` into `p-5` as a
defect, not a cleanup.

**One policy, applied uniformly: no bare Tailwind spacing/sizing-scale utility appears anywhere on
this surface** — not even where its pixel value happens to coincide with a Quincy token. An earlier
draft mixed the two forms (`size-3`, `min-w-32`, `h-12`, `size-4`, `min-h-11`) against this very
rule. Four of those five do coincide exactly, and coincidence is precisely the hazard: `size-3`
reads as "Tailwind step 3", not as `--space-3`, and it silently stops being correct if either scale
moves. Converted:

| Was | Px | Becomes |
| --- | --- | --- |
| `size-3` (Select chevron) | 12 | `size-[var(--space-3)]` |
| `min-w-32` (Select trigger) | 128 | `min-w-[var(--space-10)]` |
| `h-12` (skeleton thumb bar) | 48 | `h-[var(--space-7)]` |
| `size-4` (toast mark) | 16 | `size-[var(--space-4)]` |
| `min-h-11` (touch targets) | 44 | `min-h-[44px]` — **no Quincy token is 44px** (`--space-6` is 32, `--space-7` is 48). 44px is the WCAG 2.5.8 target-size minimum, not a spacing value, so it stays an explicit literal and must carry the comment `/* WCAG 2.5.8 minimum target, not a spacing token */` at each site. |

Layout utilities that are not spacing-scale values — `basis-full`, `min-w-0`, `mx-auto`,
`grid-cols-4`, `w-2/5`, `size-px`, `shrink-0`, `z-*` — are unaffected by this rule and stay as-is.

### 1.5 Which selectors move, and which stay

TB1's rule carries forward verbatim: **repeat the repo-wide consumer grep immediately before
removing any legacy selector; only a selector with zero remaining source consumer may be removed.**
Applying it — grep run 2026-09-01, to be re-run at build time:

| Legacy selector | Consumers outside the Dashboard | Disposition |
| --- | --- | --- |
| `.dashboard-search`, `.dashboard-viewbar`, `.dashboard-sort` | none | → Tailwind; **delete** |
| `.stats`, `.stat` | none | → Tailwind; **delete** |
| `.plist`, `.prow*` | none | → Tailwind; **delete** — except `.prow__thumb`, which **stays as CSS**: `app.css` is imported unlayered in `index.css` (`@import "./app.css"` with no `layer()`), so it always outranks Tailwind's `layer(utilities)` regardless of source order, and only an unlayered rule can reliably override `.project-cover-placeholder`'s unlayered background — verified as built |
| `.toasts`, `.toast`, `.toast--error` | **yes — `Admin.tsx:466`, `ProjectWorkspace.tsx:317`, `ProjectWorkspace.tsx:341`** | Dashboard drops the classes and goes Tailwind; **`app.css:780`/`:1021` rules STAY** until those consumers migrate in their own candidates |
| `.pagehead`, `.toolbar` | **yes** — other screens | Dashboard drops the classes; **rules stay** |
| `.empty`, `.empty .serif` | **yes** — workspace, client gallery, calendar fallback | Dashboard drops the class; **rules stay** |
| `.button`, `.button--*` | **yes** — app-wide | Dashboard uses the new `Button`; **rules stay** |
| `.segment` | grep at build time; Dashboard is the main consumer | Dashboard goes Tailwind; **rule stays unless the grep returns zero** |
| `.ey`, `.serif`, `.muted`, `.sdot`, `.row`, `.gap*` | **yes** — everywhere | **stay**; Dashboard stops using them (§2.3) |
| `.notice-board*` | none, but owner-deferred | **stay** — only the indicator's paint and two wrap fixes change (§9) |
| `.topbar*`, `.topnav*` | app-wide shell | **stay, untouched** — owner decision (§11.1) |
| `.kanban`, `.kcol*`, `.kcard*`, `.kanban-move-popover*` | TB5B-owned | **stay as CSS**; only the §8.2–8.4 token corrections, applied in place |

The first revision listed `.toasts`/`.toast*` as "Dashboard only" and marked them for deletion. That
was wrong — three other call sites render them — and it is exactly the failure the grep rule exists
to prevent. Recorded here so the review trail shows the rule working.

**Kanban carve-out — corrected rationale.** The first revision justified the carve-out by claiming a
class-name/portal rewrite caused the white-screen in `docs/lessons.md:864–900`. That is not what
that entry says: the documented cause was DOM-order rewrites during `onDragOver`,
`MeasuringStrategy.Always`, and unstable floating-reference callbacks. The carve-out is still
correct, but for the honest reason: **release ownership and regression risk.** Kanban card and
column controls belong to the roadmap's later *board filters/card controls* candidate, converting
them here would breach *no whole-app rewrite*, and any change touching `ProjectKanbanBoard` carries
the drag-regression cost recorded at `docs/lessons.md:901` — which §12.11 now prices in explicitly.

---

## 2. New and extended primitives

All generated shadcn source is reviewed application source. A stock dependency aesthetic is a
failure, not a shortcut (D-16/A8, restated by TB1). Generate with the pinned `shadcn` CLI at
`base-sera`, then strip every stock default and rebind to Quincy tokens before first use.

### 2.1 `Button` — new, and TB1's explicitly-deferred primitive

TB1 declined `Button` because its bounded consumer had no button. The Dashboard shell now has
**four** in-scope consumers — and, critically, **two of them are anchors, not buttons**:

| # | Call site | Element today | Kind |
| --- | --- | --- | --- |
| 1 | `Dashboard.tsx:873` — New shoot, masthead toolbar | `<InternalLink className="button" to="/projects/new">` | **anchor** |
| 2 | `Dashboard.tsx:948` — New shoot, empty state | `<InternalLink className="button" to="/projects/new">` | **anchor** |
| 3 | `Dashboard.tsx:940` — Try again, error state | `<button className="button button--secondary" type="button">` | button |
| 4 | `Dashboard.tsx:106` — Retry cover image, list row | `<button className="prow__retry button button--secondary" type="button">` | button |

Two groups of call sites an earlier draft listed are **excluded**:

- **Notice Board Post / Save / Cancel** (`NoticeBoard.tsx:125,145`) — removed. The owner-approved
  Notice Board scope is *the unread indicator only* (§9). Converting these three buttons would
  restyle their disabled, hover, press, geometry, and busy presentation, which is out of scope. They
  keep `.button`/`.button--secondary` and render exactly as they do today.
- **Kanban cover Retry** (`ProjectKanbanBoard.tsx:308`, `.kcard__retry`) — removed. It is inside the
  Kanban carve-out (§1.5) and keeps its current classes.

**Accepted visual inconsistency, classified (roadmap: "every material difference classified").**
Consumer 4 (the List row's `Retry cover image`) migrates to `Button variant="secondary"` while its
Kanban twin at `ProjectKanbanBoard.tsx:308` stays on `.button--secondary`. The two are the same
control on two views of the same data, so the delta is stated rather than discovered later. It is
deliberately small: the `secondary` variant reproduces `app.css:924`'s geometry exactly
(`min-height: 38px; padding: 9px 14px`) and `app.css:933`'s hover pair exactly (`--paper-100`
background = `bg-secondary`, `--greige-300` border = `border-border-hover`). The only residual
differences are the disabled presentation (`opacity: .62` → tokens) and the explicit transition
property list — and neither retry button is ever rendered disabled. **Accepted for this release**;
it closes when the *board filters/card controls* candidate (§11.3) migrates `.kcard*`, or when the
release that retires `.button` itself lands, whichever comes first.

#### Anchor safety — the primitive must not wrap a link in a `<button>`

Consumers 1 and 2 are real navigations. Nesting an `<a>` inside a `<button>` is invalid HTML, and
replacing the anchor with a `<button onClick={navigate}>` would break middle-click, ⌘/Ctrl-click,
open-in-new-tab, and right-click → copy link address — an accessibility and behavior regression this
plan has no authority to make. `InternalLink` also owns the router-push semantics the shell depends
on.

**The resolution is to export the class string, not to wrap the element.** `button.tsx` exports both:

```tsx
export function buttonClasses(
  variant: ButtonVariant = "primary",
  opts: { busy?: boolean; className?: string } = {},
) {
  return cn(BASE, VARIANT[variant], opts.busy && "cursor-wait", opts.className);
}

export function Button({ variant = "primary", busy = false, className, ...props }: ButtonProps) {
  return <button className={buttonClasses(variant, { busy, className })} {...props} />;
}
```

The four call sites then render as:

```jsx
// 1 — Dashboard.tsx:873, masthead. Stays an anchor; only the class source changes.
{canCreateProject && <InternalLink className={buttonClasses()} to="/projects/new">New shoot</InternalLink>}

// 2 — Dashboard.tsx:948, empty state. Stays an anchor; the inline style={{marginTop:16}} wrapper
//     div is removed in favour of the margin utility (§10.3).
{!query && !viewingArchived && canCreateProject &&
  <InternalLink className={buttonClasses("primary", { className: "mt-[var(--space-4)]" })}
                to="/projects/new">New shoot</InternalLink>}

// 3 — Dashboard.tsx:940, error state.
<Button variant="secondary" className="mt-[var(--space-4)]"
        onClick={() => void projectsQuery.refetch()}>Try again</Button>

// 4 — Dashboard.tsx:106, list-row cover retry.
<Button variant="secondary" onClick={…}>Retry cover image</Button>
```

`buttonClasses()` is the seam that keeps one token owner without forcing one element type. No
`asChild`/Slot indirection is introduced — it would add a dependency and a render-prop layer for two
call sites that only need a string. The two anchors keep their `<a>` semantics, their href, and
every native link affordance; `InternalLink`'s props are untouched.

**Acceptance:** the diff contains no `<button>` wrapping an `InternalLink` or `<a>`, and both New
shoot controls are still anchors with a real `href` — verified in the DOM snapshot (§12.14) and by
a middle-click/⌘-click check in the Agy pass.

**No new dependency.** The first revision wrote the variants with `cva`, which is in neither
`portal/package.json` nor `portal/apps/web/package.json` — TB1 deliberately removed it as unused,
and silently reintroducing a dependency is not this plan's call to make. The implementation is
`cn()`-only, using plain records, which is sufficient for four variants and one boolean:

```tsx
const BASE = "inline-flex items-center justify-center gap-[var(--space-2)] min-h-[38px] " +
  "px-[14px] py-[9px] rounded-[var(--radius-sm)] border-solid " +
  "border-[length:var(--border-width-hair)] [font:var(--type-label)] " +
  "text-[length:var(--text-xs)] uppercase tracking-[var(--tracking-wide)] no-underline " +
  "cursor-pointer transition-[background-color,color,border-color] " +
  "duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "active:not-disabled:translate-y-px " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:border-border " +
  "disabled:cursor-not-allowed disabled:translate-y-0";

const VARIANT = {
  primary:   "bg-primary text-primary-foreground border-primary " +
             "hover:not-disabled:bg-primary-hover hover:not-disabled:border-primary-hover",
  secondary: "bg-card text-foreground border-border " +
             "hover:not-disabled:bg-secondary hover:not-disabled:border-border-hover",
  danger:    "bg-card text-destructive border-destructive " +
             "hover:not-disabled:bg-destructive hover:not-disabled:text-destructive-foreground",
  text:      "min-h-[32px] px-0 py-[6px] bg-transparent border-transparent " +
             "text-foreground-secondary hover:not-disabled:text-foreground",
} as const;

// <button className={cn(BASE, VARIANT[variant], busy && "cursor-wait", className)} …>
```

**Geometry is matched to the legacy button, deliberately.** `app.css:924` is `min-height: 38px;
padding: 9px 14px`. The first revision proposed on-grid `px-[var(--space-4)] py-[var(--space-2)]`
(16px/8px) while claiming the geometry was unchanged — it was not. Because `.button` still styles
every un-migrated screen, a Dashboard button that differs by 2px in either axis would read as a bug
against the rest of the app. So `px-[14px] py-[9px]` is retained as **inherited off-grid debt**,
carried forward on purpose and to be normalised to `--space-*` in the release that finally retires
`.button` itself. The same reasoning fixes the `text` variant at `py-[6px]`, matching
`.button--text`'s `padding: 6px 0` (`app.css:936`) rather than the nearest token (`--space-2`, 8px)
— that variant has no in-scope consumer here, but it must not drift from the legacy rule that still
styles its consumers elsewhere. These literals are the one place in the plan where a literal beats a
token, and they are a migration-consistency decision, not an oversight.

Three deliberate departures from `.button`, all fixing §10 D-3: `cursor: wait` moves from
`:disabled` to an explicit `busy` prop (a capability-disabled control is not pending); the disabled
state stops being `opacity: .62` and becomes real tokens; and `transition: all` becomes an explicit
property list so the 1px press nudge stays instant instead of sliding for 120ms.

`active:not-disabled:translate-y-px` is the system's press behavior — **1px nudge, no scale**.
Never `active:scale-95`, the stock reflex.

### 2.2 `Select` — replacing the surface's clearest stock-default drift

`.dashboard-sort select` is a bare native `<select>`: UA font, UA chevron, OS-blue focus and
highlight. It is the only place on the Dashboard where a non-Quincy colour reaches the screen and is
precisely the *stock appearance / raw framework palette* the roadmap forbids.

`src/components/ui/select.tsx` from `base-sera`, restyled: trigger takes the same geometry and state
set as `Button variant="secondary"`; content panel `bg-popover border-solid
border-[length:var(--border-width-hair)] border-border rounded-none shadow-[var(--shadow-md)]`
(square, because `--radius-card: 0`; `--shadow-md` because a dropdown is a menu — the system reserves
`--shadow-lg` for true dialog overlays); items `data-[highlighted]:bg-secondary
data-[selected]:bg-primary data-[selected]:text-primary-foreground`.

Strip on generation: every `rounded-md`, `shadow-sm`, `ring-offset-background`, `animate-in`,
`fade-in-0`, `zoom-in-95`, `slide-in-from-*`, `active:scale-*`, and every `dark:` branch. The
chevron may be Lucide `ChevronDown` at `stroke-[1.5] size-[var(--space-3)]` — `components.json` sets
`iconLibrary: "lucide"` and the design system readme names Lucide at 1.5px stroke as the sanctioned
substitute when a genuine utilitarian affordance is needed.

**Applied to the Dashboard sort control only.** The Kanban card priority `<select>`
(`ProjectKanbanBoard.tsx:296`) keeps its native element — it belongs to the board candidate (§1.5).

**Required accessibility tests.** A custom listbox replacing a native control must prove parity, not
assume it. All of the following are release-blocking, in `Dashboard-kanban-sort.dom.test.tsx` (and
sibling `Dashboard-kanban-sort-priority-*.dom.test.tsx` files for item 8's three halves) plus a
real-browser Agy pass — not only for the pointer/touch items (10), but also for two keyboard items
that happy-dom cannot reproduce and are tracked as their own acceptance-criterion-18 checklist
lines: Space-to-open the popup (part of item 2) and Escape's focus-return to the trigger (part of
item 5).

1. Trigger exposes an accessible name equivalent to today's `sr-only` "Sort Kanban board" label.
2. Opens on click and on `Enter`/`Space`/`ArrowDown` from the focused trigger.
3. `ArrowUp`/`ArrowDown` move the highlighted option; `Home`/`End` jump to first/last.
4. `Enter` selects the highlighted option and fires the same `selectKanbanSort` transition the
   native `onChange` fires today, with the identical `KanbanSortMode` value.
5. `Escape` closes without selecting **and returns focus to the trigger**.
6. Outside click (and outside tap) dismisses without selecting.
7. Disabled state (`interactionBlocked`) blocks opening entirely — no popover, no focus trap.
8. **Priority gate preserved exactly:** the `Priority` option is rendered only when
   `canPrioritize && hasAuthorizedBoardMap`, and `selectKanbanSort` still refuses a `priority` value
   when that condition is false (`Dashboard.tsx:636`). Both the render gate and the guard must be
   asserted — the guard is the security-relevant half and must not be dropped because the option is
   now merely un-rendered.
9. Selected value is announced/exposed on the trigger (the current native select shows it inline).
10. Touch reachability at 390×844: trigger ≥44px, popover fully within the viewport, options tappable.

Update the existing tests to assert the same *behavior* through listbox roles — never to loosen them.

### 2.3 Retiring the legacy helper classes on this surface

`.ey`, `.serif`, `.muted` are ported prototype helpers, not design-system API:

| Legacy | Tailwind |
| --- | --- |
| `.ey` | `[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary` |
| `.serif` | `font-[family-name:var(--font-display)] tracking-[var(--tracking-tight)]` |
| `.muted` | `text-muted-foreground` |
| `.sdot` | `size-[7px] rounded-[var(--radius-pill)] shrink-0 self-center bg-signal-*` |

The eyebrow string recurs enough to earn one shared component rather than a repeated literal:
`src/components/ui/eyebrow.tsx` exporting `<Eyebrow>` with `cn()` passthrough. This is the reuse
value the TB8 selection order asks each candidate to create. The legacy classes remain in `app.css`
for every non-Dashboard consumer.

---

## 3. Design direction: the running sheet

The Quincy design system is authoritative and this plan does not reinvent it — ink/paper duotone,
warm greige ramp, Mazius Review display serif, Apfel Grotezk workhorse sans, hairline rules, the
signature 3px ink rule, square corners, borders over shadow, calm 120–420ms ease-out motion,
letterform iconography.

The organising idea: **the Dashboard is the studio's running sheet for the day** — a production desk
ledger, not a SaaS dashboard. Today it reads as floating bordered boxes on paper with nothing tying
them together, and a control row pinned right with a negative margin. The system's own answer is
*structure drawn with rules, not cards-with-gaps*.

Three structural moves:

1. **The 3px ink rule becomes the spine.** `--border-width-rule` is the system's declared signature
   device and appears nowhere on the Dashboard today. It goes under the masthead at full content
   width and nowhere else on the page — so the masthead reads as letterhead and everything below as
   the sheet. It is reused at leading-edge scale for exactly one other job: marking "unread"
   (§9), giving that state one vocabulary.
2. **The summary strip becomes a ledger, not tiles.** Hairline-divided columns, no outer box, Mazius
   numerals at `--text-2xl`, eyebrow labels beneath. Same four numbers, same DOM order.
3. **Pipeline stages are numbered.** Kanban column heads carry `01`–`0n` ordinals — the one added
   device, and it earns its place: the Stage list *is* an ordered pipeline, so the ordinal encodes
   information a reader needs rather than decorating, and it derives from the live `activeStages`
   index so a Stage configuration change cannot make it lie.

No new colour, no gradient, no shadow on a non-overlay, no motion beyond `--dur-fast` tints and one
`--dur-slow` entrance.

---

## 4. Viewport, state and evidence matrix

Fixed viewports, matching both the TB0 baseline manifest and TB1's matched-evidence contract:
**1440×900**, **1024×768**, **390×844**. Fourteen states:

| # | State | 1440 | 1024 | 390 |
| --- | --- | --- | --- | --- |
| 1 | List, Notice Board open, populated | ✓ | ✓ | ✓ |
| 2 | List, Notice Board collapsed | ✓ | — | ✓ |
| 3 | Kanban, Notice Board open, populated | ✓ | ✓ | ✓ |
| 4 | Kanban, board-unavailable message shown | ✓ | — | ✓ |
| 5 | Loading (skeleton) | ✓ | — | ✓ |
| 6 | Error (`role="alert"`) | ✓ | — | ✓ |
| 7 | Empty — no projects | ✓ | — | ✓ |
| 8 | Empty — search matched nothing | ✓ | — | ✓ |
| 9 | Archived scope (Admin, no ledger) | ✓ | — | ✓ |
| 10 | Toast visible (success + error) | ✓ | — | ✓ |
| 11 | Sort `Select` — closed / open / highlighted / Priority gated off | ✓ | — | ✓ |
| 12 | Disabled segment buttons (`interactionBlocked`) | ✓ | — | — |
| 13 | Keyboard focus ring on every control in §12.3 | ✓ | — | ✓ |
| 14 | Notice Board unread indicator — present and absent | ✓ | — | ✓ |

Baselines to diff: `current-dashboard-1440-list-notice-open.png`,
`current-dashboard-1440-kanban-notice-open.png`, `current-dashboard-1024-*`,
`current-dashboard-390-list-notice-open.png`, `current-dashboard-390-kanban-notice-open.png`.

**TB1-inherited evidence:** a built-CSS check that `tailwindcss/preflight.css` is still absent, a
before/after CSS-size record, and a regression capture proving TB1's live `ProjectFields` Client
section renders byte-identically at all three viewports.

---

## 5. TB0-VIS-01 and the layout defects found alongside it

Drift register row TB0-VIS-01 records: *"responsive 390 capture exposes horizontal overflow/clipping
in the current notice/board composition."*

**One evidenced cause, four latent defects.** The first revision framed all five as "independently
proven causes" of the recorded drift. That was overstated. Only §5.1 is directly evidenced by the
TB0 390 capture; §§5.2–5.5 are defects found by reading the source during this pass, which the
capture does not by itself prove. They are worth fixing and are fixed here, but the plan should not
claim the baseline evidence supports more than it does. §5.2 in particular is a **vertical overlap**
bug and does not belong in a "horizontal overflow" framing at all.

### 5.1 EVIDENCED — the view/scope bar cannot wrap

```css
/* current — app.css:462, rendered by Dashboard.tsx:886 */
.dashboard-viewbar { display: flex; align-items: center; justify-content: flex-end; gap: 10px;
                     margin: calc(var(--space-7) * -1) 0 var(--space-4); }
```

At 390 the page content box is `390 − 2×var(--space-4)` = **358px**. For an Admin the row holds:
`Projects` eyebrow + a 2-button segment + `View` eyebrow + a 3-button segment + a 128px-min sort
control — ≈640px with `flex-wrap` unset. Roughly 280px of overflow, which is the clipping the
capture shows. **This is TB0-VIS-01's cause.**

Wrapper:
```
flex flex-wrap items-center justify-end
gap-x-[var(--space-3)] gap-y-[var(--space-2)]
mb-[var(--space-4)] pt-[var(--space-4)]
[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border
max-[720px]:justify-start
```
Segments `max-[720px]:flex-auto` with their buttons `max-[720px]:flex-auto`; sort wrapper
`max-[720px]:basis-full`, trigger `max-[720px]:w-full max-[720px]:min-w-0`.

At 390 this produces three wrapped full-width rows, each control ≥44px tall (§7.6), zero overflow.

### 5.2 LATENT (vertical overlap, not overflow) — the `-48px` negative top margin

`margin-top: calc(var(--space-7) * -1)` exists only to eat `.stats { margin-bottom: var(--space-7) }`.
When `viewingArchived` is true `.stats` is not rendered at all (`Dashboard.tsx:879`), so the bar is
pulled 48px up — through the Notice Board's 32px bottom margin and 16px into the Notice Board
itself. A **vertical** overlap, at every viewport, worst at 390 where the notice card is tallest.
The negative margin is removed in §5.1's replacement; the ledger's bottom margin drops to
`--space-6` so the two blocks are spaced by tokens rather than cancelling.

### 5.3 LATENT — toasts are wider than a 390 viewport

`right: 22px` + `max-width: 380px` = **402 > 390**; `slidein` then translates a further 20px out.

Container: `fixed z-95 flex flex-col items-end gap-[var(--space-3)] pointer-events-none
right-[max(var(--space-5),env(safe-area-inset-right))]
bottom-[max(var(--space-5),env(safe-area-inset-bottom))]
left-[max(var(--space-5),env(safe-area-inset-left))]`; toast
`max-w-[min(380px,100%)] pointer-events-auto`.

`pointer-events-none` on the container is **required** once `left` is set — otherwise the
now-full-width invisible container swallows clicks on the page beneath at every viewport. The
Dashboard drops `.toasts`/`.toast`; the `app.css` rules stay for the three other consumers (§1.5).

### 5.4 LATENT — `.notice-board__post-head` has no wrap and no `min-width: 0`

*Owner-approved as TB0-VIS-01 layout repair, not Notice Board redesign — see §13.*

Row: author + `<time>` (`flex:1`) + `edited` + `Edit` + `Delete`. With a realistic author name plus
a relative timestamp plus three controls it exceeds the 310px inner width at 390, and the author
span has no `min-width: 0`, so the flex item refuses to shrink.

Fixed **in `app.css`, in place** (the panel stays CSS-owned per the owner decision — see §9):
```css
.notice-board__post-head { flex-wrap: wrap; align-items: baseline;
                           gap: var(--space-1) var(--space-3); }
.notice-board__author { min-width: 0; overflow-wrap: anywhere; }
.notice-board__post-head time { flex: 1 1 auto; min-width: 0; }
```

### 5.5 LATENT — `.notice-board__composer-foot` has no wrap

"Use @ to mention active staff" (≈195px) + Post notice (≈118px) + 12px gap = 325px inside a 310px
box. In place: `.notice-board__composer-foot { flex-wrap: wrap; }` and
`.notice-board__composer-foot > span { flex: 1 1 12rem; min-width: 0; }`.

### 5.6 Verification gate

`scrollWidth === clientWidth` alone cannot catch vertical overlap (§5.2) or clipping internal to a
scroll container, so the gate is three-part. All at 390×844 unless stated, on states 1–10 of §4:

1. **No document overflow.**
   `document.documentElement.scrollWidth === document.documentElement.clientWidth`, verified with
   the `[overflow-x:clip]` net (below) temporarily removed.
2. **No element escapes the viewport.** For the view bar, each segment, the sort trigger, the notice
   header row, the notice composer foot, and any visible toast:
   `el.getBoundingClientRect().right <= window.innerWidth + 0.5` and `.left >= -0.5`.
3. **No vertical overlap between the shell's stacked blocks** — the §5.2 check, and the one the
   first revision's gate would have missed. In **archived scope** specifically (where the ledger is
   absent), assert
   `noticeBoard.getBoundingClientRect().bottom <= viewBar.getBoundingClientRect().top + 0.5`,
   at all three viewports.

Plus a visual pass on the §4 captures — the assertions catch geometry, not a control that has
wrapped into something unreadable.

The net, a safety measure and **not** the fix (every §5.1–5.5 change ships regardless), on the
`<main>` page wrapper: `[overflow-x:clip]`. `clip`, never `hidden` — `hidden` creates a scroll
container that breaks `position: sticky` on the top bar and would silently regress the shell.

---

## 6. *(Section withdrawn — shell navigation)*

The first revision redesigned the top bar, nav, notification bell/menu, and mobile menu. **Owner
decision 2026-09-01: dropped from TB8-01 entirely.** The top bar is a single app-wide shared shell
component; changing it for the Dashboard alone would split visual ownership across surfaces. It is
left exactly as it currently renders. The findings are preserved as a handoff inventory in §11.1 so
the analysis is not lost.

---

## 7. Page masthead, ledger, control bar

### 7.1 Masthead

Wrapper: `flex flex-wrap items-end justify-between gap-x-[var(--space-6)] gap-y-[var(--space-5)]
pb-[var(--space-4)]`

- The inline `style={{ marginBottom: 14 }}` on the eyebrow is deleted (off the 4px grid *and* an
  inline styling owner): `<Eyebrow className="mb-[var(--space-3)]">`.
- `<h1>`: `[font:var(--type-h1)] tracking-[var(--tracking-tight)]
  max-[720px]:[font:var(--type-h2)]` — a scale step down at 720 rather than an awkward reflow.
- **New:** `<hr className="basis-full m-0 mb-[var(--space-6)] border-0 [border-top-style:solid]
  border-t-[length:var(--border-width-rule)] border-t-primary
  max-[720px]:mb-[var(--space-5)]" />` — the §3 signature. (`border-t-primary` = `--accent` =
  `--ink-900`.)

### 7.2 Search field

The current field kills its own focus ring: the inner input sets `outline: 0` and the wrapper only
shifts a 1px border colour on `:focus-within`. That is weaker than the system's declared treatment
(*"a 2px solid ink outline, offset 2px"*) and an accessibility regression against
`base.css :focus-visible`.

Wrapper (add `group`): `flex items-center min-w-[min(100%,300px)] px-[var(--space-3)] bg-card
border-solid border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-sm)]
transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
hover:border-border-hover focus-within:border-primary
focus-within:outline-[length:var(--border-width-bold)] focus-within:outline-solid
focus-within:outline-ring focus-within:outline-offset-2
max-[720px]:basis-full max-[720px]:min-w-0`

Icon: `size-[15px] shrink-0 text-muted-foreground transition-colors duration-[var(--dur-fast)]
ease-[var(--ease-standard)] group-focus-within:text-foreground-secondary`
Input: `min-w-0 w-full py-[var(--space-2)] px-[var(--space-3)] border-0 outline-0 bg-transparent
text-foreground [font:var(--type-body)] text-[length:var(--text-sm)]
placeholder:text-muted-foreground max-[720px]:py-[var(--space-3)]`

The ring is drawn by the wrapper so it encloses the icon; the input keeps `outline-0` deliberately.
The search input is never disabled — do not add a disabled style.

### 7.3 Summary ledger

Markup: the two inline `style={{ background: "var(--signal-…)" }}` props on the dots become
`bg-signal-caution` / `bg-signal-positive`. `<div aria-label="Project summary">` becomes
`<section aria-label="Project summary">` — `aria-label` on a generic `div` is not exposed by any AT;
a `section` with an accessible name is a landmark, so the label becomes real. (Verify no test
asserts the tag; the `Dashboard-*.dom.test.tsx` suites query by text/role.)

Container: `grid grid-cols-4 [border-block-style:solid]
border-y-[length:var(--border-width-hair)] border-y-border bg-transparent mb-[var(--space-6)]
max-[1080px]:grid-cols-2` — the `border: 1px` box and `bg-card` are dropped; the ledger is not a card.

Cell: `py-[var(--space-5)] pr-[var(--space-5)]`, and from the second onward
`pl-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-hair)]
border-l-border`. At ≤1080 odd cells reset to `pl-0 border-l-0` and cells 3–4 gain a top hairline.

Value: `[font:var(--type-h2)] tracking-[var(--tracking-tight)] flex items-baseline
gap-[var(--space-2)] tabular-nums max-[390px]:[font:var(--type-h3)]`
Label: `[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)]
text-foreground-secondary mt-[var(--space-2)]`

`font-size: 34px` was off the type scale; `--type-h2` (`--text-2xl`, 36px) is the scale value.
`tabular-nums` is new and necessary — four counts that re-render on every refetch must not jitter.
The ledger is not interactive and takes no hover, focus, or press state.

Two legacy rules, distinguished — they are not the same case:

- `@media (max-width: 720px) { .stats { grid-template-columns: 1fr 1fr } }` at **app.css:865** is
  genuinely **dead**: the `max-width: 1080px` block at **app.css:839** already sets
  `repeat(2, 1fr)`, so the 720px rule restates a value that is unconditionally in force below 1080.
  Deleted.
- `.stat:nth-child(3) { border-left: 0 }` at **app.css:840** is **live and load-bearing** — at two
  columns, cell 3 opens a new row and must not carry a left rule. It is not dead; it goes only
  because the whole `.stats`/`.stat` block goes (§1.5), and its behavior is **reimplemented** in the
  Tailwind form above ("at ≤1080 odd cells reset to `pl-0 border-l-0`"). Do not drop that reset.

### 7.4 Segment control — the control that motivated this candidate

`.segment button` has **no disabled styling whatsoever**, yet `Dashboard.tsx:898–900` disables all
three View buttons while `interactionBlocked || calendarInteractionBlocked`. A user sees an
enabled-looking control that silently does nothing. That is the most operationally painful defect on
this surface and the reason TB8-01 ranks first.

Group: `inline-flex border-solid border-[length:var(--border-width-hair)] border-border
rounded-[var(--radius-sm)] overflow-hidden bg-card has-[button:focus-visible]:overflow-visible`

| State | Classes |
| --- | --- |
| base | `[font:var(--type-label)] text-[length:var(--text-xs)] uppercase tracking-[var(--tracking-wide)] min-h-[38px] px-[var(--space-4)] py-[var(--space-2)] bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border text-foreground-secondary cursor-pointer transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] first:border-l-0` |
| hover | `not-[.is-active]:not-disabled:hover:bg-secondary not-[.is-active]:not-disabled:hover:text-foreground` |
| selected | `[&.is-active]:bg-primary [&.is-active]:text-primary-foreground` |
| selected + hover | unchanged — the system forbids a colour flip on a selected control |
| press | `not-disabled:active:translate-y-px` |
| focus | `focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:relative focus-visible:z-10` |
| disabled | `disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:cursor-not-allowed disabled:translate-y-0` |
| disabled + selected | `[&.is-active]:disabled:bg-surface-sunken [&.is-active]:disabled:text-foreground-secondary [&.is-active]:disabled:border-border-hover` |

`focus-visible:z-10` plus the group's `has-[…]:overflow-visible` is what lets the 2px ring escape
`overflow-hidden`; without both, the ring is clipped on the first and last buttons.

**Contrast, checked.** `--text-muted #8f8775` on `--bg-sunken #ece6d8` is **2.9:1**. WCAG 1.4.3
exempts disabled controls, but the system can do better without inventing a value:
`--text-secondary` (`--greige-600 #4d473c`) on `--bg-sunken` measures **7.4:1**. Hence
`disabled:text-foreground-secondary`, never `disabled:text-muted-foreground`. Disabled-and-selected
keeps the same pair and marks selection with `border-border-hover` rather than a low-contrast fill —
selection stays legible while the board is blocked, with no new token.

`transition: all` is replaced by an explicit property list — `all` also animates `transform`,
turning the instant 1px press nudge into a 120ms slide.

### 7.5 Sort control

`<Select>` per §2.2, wrapper `max-[720px]:basis-full`, trigger `min-w-[var(--space-10)] max-[720px]:w-full
max-[720px]:min-w-0`. Options unchanged: Board order, Priority (gated), Shoot date ↑, Shoot date ↓.

### 7.6 Eyebrows and touch targets

`<Eyebrow>` for `Projects` and `View`; at ≤720 they head the wrapped rows:
`max-[720px]:basis-full max-[720px]:-mb-[var(--space-1)]`.

`min-h-[44px]` (the WCAG 2.5.8 target minimum; no Quincy token is 44px) under `max-[720px]:` on:
segment buttons and the Select trigger. List rows get
`max-[720px]:py-[var(--space-4)]`. The existing `@media (pointer: coarse), (max-width: 640px)` block
for `.kcard-*` stays as-is — TB5B's matched evidence is bound to that exact query; **do not merge
the breakpoints.**

---

## 8. Content views

### 8.1 List view

`.plist` → `border-solid border-[length:var(--border-width-hair)] border-border bg-card`

Row: `w-full grid grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_96px]
items-center gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-3)] border-0
[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border
first:border-t-0 text-inherit text-left font-inherit bg-transparent cursor-pointer no-underline
transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary
active:bg-surface-sunken focus-visible:outline-[length:var(--border-width-bold)]
focus-visible:outline-solid focus-visible:outline-ring focus-visible:-outline-offset-2
max-[720px]:grid-cols-[56px_1fr_84px] max-[720px]:py-[var(--space-4)]`

`minmax(0, …)` on every fractional track is the fix for long addresses forcing the grid wider than
its container at 1024 — `1.6fr` alone cannot shrink below its content's min-content width.

Focus offset is **inset** because rows sit flush inside the list border. Rows take no `translate-y`
— the 1px nudge is a *button* affordance; a row is a link.

Address: `font-[family-name:var(--font-display)] text-[length:var(--text-md)]
tracking-[var(--tracking-tight)] block`. Off-scale sizes replaced: `18px → --text-md`,
`14px → --text-sm`, `12.5px → --text-xs`, `12px padding → --space-3`.

Header row: `bg-secondary cursor-default` with cells `[font:var(--type-eyebrow)] uppercase
tracking-[var(--tracking-widest)] text-foreground-secondary`. **The sticky-header proposal is
dropped per owner decision** — the header row scrolls with the list exactly as it does today.

### 8.2 Kanban column heads and the stage ordinal

`ProjectKanbanBoard.tsx:557` wraps `<StatusBadge>` in a `.row.gap2` span, and `StatusBadge` already
returns `<span className="row gap2">`. Remove the outer wrapper from `ProjectKanbanBoard.tsx` only;
`StatusBadge` keeps its own for the `.prow__c-status` consumer.

```jsx
<div className="kcol__head" data-focus-key={`stage-heading:${semanticKey}`} tabIndex={-1}>
  <span className="kcol__ordinal" aria-hidden="true">{String(stageIndex + 1).padStart(2, "0")}</span>
  <StatusBadge stageKey={stage.key} />
  <span className="cnt">{displayedProjects.length}</span>
</div>
```

`stageIndex` is this stage's index in the `activeStages` array already passed to the board — no new
data, no new query, and it cannot desync from Stage configuration. `aria-hidden` because the stage
label already names the column and the existing `announce()` strings must not change.

**Plumbing, spelled out** — `stageIndex` is *not* in `KanbanColumn`'s scope today, so the builder
must not improvise it. Three mechanical edits, all in `ProjectKanbanBoard.tsx`, and nothing else:

1. `:500` — add `stageIndex: number;` to `KanbanColumnProps`.
2. `:525` — destructure `stageIndex` in `KanbanColumn`'s parameter list.
3. `:896` — `activeStages.map((stage) => {` becomes `activeStages.map((stage, stageIndex) => {`,
   and the `<KanbanColumn>` element gains `stageIndex={stageIndex}`.

Derive it from `activeStages` this way rather than with a `findIndex` inside the column: the map
index is the array position by construction, so it cannot disagree with the `activeStages` order the
board already renders and `BoardCollisionDetection` (`:452`) already indexes by. This adds a prop and
touches no render order, no `SortableContext` `items`, and no dnd-kit configuration — but it is still
a `ProjectKanbanBoard` edit, so §12.11's real-browser drag verification covers it.

Per §1.5 these stay CSS, edited in place:

```css
.kcol__head { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4);
              background: var(--bg-canvas);
              border-bottom: var(--border-width-hair) solid var(--border-hairline); }
.kcol__ordinal { flex: none; font: var(--type-eyebrow); text-transform: uppercase;
                 letter-spacing: var(--tracking-wide); color: var(--text-muted);
                 font-variant-numeric: tabular-nums; }
.kcol__head > .row { flex: 1 1 auto; min-width: 0; }
.kcol__head .cnt { flex: none; font-variant-numeric: tabular-nums; font-size: var(--text-sm);
                   color: var(--text-muted); }
.kcol__head:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring);
                            outline-offset: -2px; }
```

The `:focus-visible` rule is not cosmetic: `.kcol__head` is a `tabIndex={-1}` **programmatic focus
target** that TB5B's recovery path focuses after a failed move (`Dashboard.tsx:390–393`) and today
shows the browser default or nothing. A keyboard user recovering from a failed drag needs to see
where focus landed.

### 8.3 Board and column shell (CSS, in place)

```css
.kanban { gap: var(--border-width-hair); background: var(--border-hairline);
          border: var(--border-width-hair) solid var(--border-hairline);
          overscroll-behavior-x: contain; scrollbar-gutter: stable; }
.kanban:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring);
                        outline-offset: 2px; }
.kcol__empty { padding: var(--space-5) 0; font-family: var(--font-display);
               font-size: var(--text-lg); }
```

`--greige-300` as a full-bleed 1px grid line against `--paper-050` reads as a hard cage;
`--border-hairline` is the system's divider token and what every other rule uses.
`overscroll-behavior-x: contain` stops the board hijacking the page's back-swipe at 390.

### 8.4 Kanban card corrections (CSS, in place — the only card work in this release)

```css
.kcard__addr  { font-size: var(--text-base); line-height: var(--leading-snug); }
.kcard__meta  { font-size: var(--text-xs); margin-top: var(--space-1); }
.kcard__foot  { flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin-top: var(--space-3); }
.kcard-controls__arrow {
  border: var(--border-width-hair) solid var(--border-hairline);
  border-radius: var(--radius-sm); background: var(--bg-surface);
  color: var(--text-secondary); font: var(--type-label); font-size: var(--text-sm);
  line-height: 1; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-standard),
              color var(--dur-fast) var(--ease-standard);
}
.kcard-controls__arrow:hover:not(:disabled) { background: var(--bg-raised); color: var(--text-primary); }
.kcard-controls__arrow:active:not(:disabled) { transform: translateY(1px); }
.kcard-controls__arrow:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring);
                                       outline-offset: 2px; }
.kcard-controls__arrow:disabled { color: var(--text-secondary); background: var(--bg-sunken);
                                  cursor: not-allowed; }
```

`flex-wrap` on `.kcard__foot` prevents the deadline `<time>` plus priority eyebrow overflowing a
244px column — visible today on an overdue project with a long stage label. The arrow buttons had
**no** styling beyond width/height and inherited nothing.

`.kcard-wrap`, `.kcard-drag-handle`, `.kcard-move-to`, `.kanban-move-popover`, and
`.kcard-wrap--drop-indicator` are TB5B-owned and state-complete. **Leave them**, including
`.kcard-drag-handle`'s ad-hoc `color-mix` (D-5) — changing it would alter TB5B's matched captures
and it belongs to the board candidate.

**Because these edits touch `ProjectKanbanBoard.tsx` and the board's CSS, §12.11's real-browser drag
verification is mandatory for this release**, not optional.

---

## 9. Notice Board — indicator paint only

**Owner decision 2026-09-01: TB8-01 restyles the unread indicator and nothing else on this panel.**
TB7's badge/disclosure/drafts/author-rules/role-exclusion **behavior stays fully intact** (per
`Revamp-TB7-Notice-Board-Migration-Plan.md:439–458`); only paint changes. The panel's broader visual
redesign — post borders, error rule, edit/delete underline growth, composer, empty state, chevron —
is withdrawn from this plan and belongs to the later *notice board* TB8 candidate (§11.2).

The indicator today is a caution-ochre dot with a `box-shadow: 0 0 0 3px` halo. Two problems: the
halo is a soft glow, which the system explicitly rejects (*"borders over shadow … shadows are
whisper-quiet and reserved for true overlays"*); and ochre mis-signals — unread notices are not a
*caution* state. It becomes a 3px ink rule on the panel's leading edge, reusing
`--border-width-rule`, the same device as the masthead:

```css
.notice-board__toggle { border-left: var(--border-width-rule) solid transparent;
                        transition: background var(--dur-fast) var(--ease-standard),
                                    border-color var(--dur-fast) var(--ease-standard); }
.notice-board__toggle.is-unread { border-left-color: var(--border-strong); }
.notice-board__badge { width: 7px; height: 7px; flex: none; border-radius: var(--radius-pill);
                       background: var(--accent); box-shadow: none; }
```

Gated on the existing `hasUnread` boolean (`NoticeBoard.tsx:128`) passed as the `is-unread` class —
**not** a `:has()` selector, and **not** a change to how `hasUnread` is computed. The
`<span aria-label="New notice">` node stays in the DOM unchanged; it is the accessible name for the
unread state and TB7's behavior contract depends on it.

Plus the two wrap fixes at §5.4 and §5.5. Those are **owner-approved TB0-VIS-01 layout repairs**,
not visual redesign — three declarations adding `flex-wrap` and `min-width: 0`, with no change to
paint, spacing, type, or behavior — kept here so the drift row's "notice/board composition" wording
is fully addressed. See §13.

---

## 10. Non-content states

### 10.1 Loading

Today: `.empty` at `padding: var(--space-9)` — 96px of dead space that collapses when content
arrives, so every dashboard load ends with a layout jump. Replace the paint (not the markup order,
not `role="status"`, not the copy) with a hairline skeleton occupying the shape the content will.

The `role="status"` wrapper's text node becomes visually hidden but AT-present:
`absolute size-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap` — **not**
`display:none`, which would remove it from the accessibility tree.

Skeleton: `border-solid border-[length:var(--border-width-hair)] border-border bg-card
motion-safe:animate-[fade_var(--dur-slow)_var(--ease-entrance)]`
Row (×5): `grid grid-cols-[72px_minmax(0,1fr)_96px] gap-[var(--space-4)] items-center
px-[var(--space-5)] py-[var(--space-3)] [border-top-style:solid]
border-t-[length:var(--border-width-hair)] border-t-border first:border-t-0`
Bars: `h-[10px] bg-surface-sunken`, thumb `h-[var(--space-7)]`, short `w-2/5`.

**No shimmer, no pulse, no infinite loop** — the system forbids infinite animation on content. A
single `fade` entrance at `--dur-slow` (420ms), with `motion-safe:` and the existing global
`prefers-reduced-motion` clamp.

### 10.2 Error

Today the error state is pixel-identical to the empty state — a genuine comprehension failure: a
user cannot tell "nothing here" from "we could not load this."

`role="alert"` block: `border-solid border-[length:var(--border-width-hair)] border-border
[border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive
bg-card px-[var(--space-6)] py-[var(--space-7)] text-left`, heading `text-foreground`. The oxblood
leading rule makes the error distinguishable from body text without relying on colour alone
(WCAG 1.4.1). `Try again` becomes `<Button variant="secondary" className="mt-[var(--space-4)]">`,
replacing the inline `style={{ marginTop: 16 }}`.

### 10.3 Empty

`px-[var(--space-6)] py-[var(--space-8)] text-center text-muted-foreground
max-[720px]:px-[var(--space-4)] max-[720px]:py-[var(--space-7)]`; heading `[font:var(--type-h2)]
text-foreground-secondary block mb-[var(--space-3)] max-w-[34ch] mx-auto
max-[720px]:[font:var(--type-h3)]`; action `mt-[var(--space-4)]`.

`--space-9` (96px) → `--space-8` (64px). Copy unchanged — already correct per CONTENT FUNDAMENTALS
(sentence case, no hype, an empty screen that invites an action: *"No shoots yet — create the first
one."*). Both inline `style={{ marginTop: 16 }}` props go. `.empty` stays in `app.css` for the
workspace, client gallery, and Calendar fallback; the Dashboard stops using the class.

### 10.4 Board-unavailable notice

`Dashboard.tsx:916` renders this as `<div className="muted" style={{marginBottom:16}}>` — plain grey
caption text for a message telling the user their board is read-only. The one place on this surface
where `--signal-caution` is genuinely earned (a muted system state, exactly as prescribed):

`flex items-baseline gap-[var(--space-3)] mb-[var(--space-4)] px-[var(--space-4)]
py-[var(--space-3)] [border-left-style:solid] border-l-[length:var(--border-width-rule)]
border-l-signal-caution bg-[color-mix(in_srgb,var(--signal-caution)_7%,var(--bg-surface))]
text-foreground text-[length:var(--text-sm)] leading-[var(--leading-normal)]
before:content-['Board'] before:shrink-0 before:[font:var(--type-eyebrow)] before:uppercase
before:tracking-[var(--tracking-widest)] before:text-signal-caution`

`role="status"` and the message text are unchanged.

### 10.5 Toasts

Beyond §5.3's geometry: `flex items-center gap-[var(--space-3)] bg-surface-inverse text-on-inverse
px-[var(--space-5)] py-[var(--space-3)] rounded-[var(--radius-sm)] shadow-[var(--shadow-md)]
text-[length:var(--text-sm)] leading-[var(--leading-normal)]
motion-safe:animate-[slidein_var(--dur-base)_var(--ease-entrance)]`; error variant `bg-destructive`.

`--shadow-lg` → `--shadow-md` (a toast is not a dialog); `--dur-slow` → `--dur-base` for the
entrance. `Dashboard.tsx:984` inlines `✓` and `!` as bare text nodes; wrap them in
`<span aria-hidden="true" className="shrink-0 inline-grid place-items-center size-[var(--space-4)]
[font:var(--type-mono)] text-[length:var(--text-xs)]">` — decorative (the message carries the
meaning, the container is `aria-live="polite"`), and unwrapped they inherit 14px and sit off the
baseline. `✓` is a typographic mark, not an emoji; do not substitute an icon.

---

## 11. Deferrals recorded for later candidates

### 11.1 Shared shell — top bar, nav, notification menu, mobile menu

Dropped per owner decision. Findings preserved verbatim for whoever owns the shared shell next:

- `.topbar` uses `color-mix(… 88%, transparent)` + `backdrop-filter: saturate(1.1) blur(10px)` — a
  stock app-shell glassmorphism idiom where the system says *"mostly flat paper or flat ink … no
  gradients."* It also forces a compositor layer on a sticky element above a horizontally scrolling
  board.
- `.topnav` hover changes `color` only and reserves the underline for `.is-active`, so hover and
  selection signal on two unrelated channels. The readme specifies *"nav items grow a 1.5px
  underline"*; `--border-width-mid` exists for exactly this.
- `.topbar__notification-badge` uses `color: #fff` — a raw literal where `--paper-050` is the
  system's on-ink token, and the last hard-coded colour in the bar.
- `.topbar__notification-menu` uses `--shadow-lg`, the system's *dialog* elevation, for a dropdown
  anchored to its trigger.
- `.topbar__notification-row` shares `background: var(--paper-100)` between `:hover` and
  `.is-unread`, so hovering a read row makes it indistinguishable from an unread one.
- `.topbar__notification-item strong { font-weight: 500 }` is an invented weight — `fonts.css` ships
  Apfel Grotezk at 400 and 700 only, so it renders as synthesised faux-bold. The same appears on
  four Project Workspace selectors.
- `.topbar__mobile-menu` has `min-width: min(290px, …)` but **no `max-width`**, and its trigger is
  34px tall (below the 44px touch target). Its `:hover` and `.is-active` also share one background.

### 11.2 Notice Board panel

Dropped per owner decision beyond the indicator. Findings: `.notice-board__post` uses
`border-bottom` so the last post double-rules against the composer; the error strip relies on colour
alone; Edit/Delete toggle `text-decoration` rather than growing an underline; the empty state and
composer carry off-scale `12px`/`13px`/`14px` sizes; the chevron has no hover response.

### 11.3 Board filters and card controls

`.kcard-drag-handle`'s ad-hoc `color-mix` (D-5); the Kanban priority `<select>` still native; the
full Tailwind conversion of `.kcard*`/`.kcol*`/`.kanban*`.

### 11.4 Other surfaces

`.chip` uses `transition: all` (D-7). `font-weight: 500` on four Project Workspace selectors.

---

## 12. Stock-default drift catalogue and acceptance criteria

### Drift found on this surface

The roadmap forbids *stock shadcn appearance* and *raw framework palette contract*. Audit: **no raw
Tailwind palette class (`bg-gray-*`, `text-slate-*`, …) exists anywhere in `portal/apps/web/src`** —
grep-verified. The contract is clean and must stay clean while the Tailwind surface area grows.

| # | Drift | Where | Replacement |
| --- | --- | --- | --- |
| D-1 | Bare native `<select>` — UA font, UA chevron, OS-blue focus/highlight; the only non-Quincy colour on the Dashboard | `.dashboard-sort select` | Quincy-wrapped shadcn `Select` — §2.2 |
| D-2 | Glassmorphism top bar | `.topbar` | **Deferred** — §11.1, owner decision |
| D-3 | Opacity-as-disabled + `cursor: wait` on a capability-disabled control | `.button:disabled` | `Button`'s token disabled set + explicit `busy` prop — §2.1 |
| D-4 | *(withdrawn)* | — | The `Input` primitive is **out of scope**. TB1 chose the hairline border deliberately to preserve the live form contract; that is settled TB1 authority, not open drift. The first revision also mis-stated `bg-[var(--paper-050)] → bg-[var(--field-bg)]` as pixel-identical — `--field-bg` is `--paper-000` (`colors.css:52`), so it would have visibly changed every live TB1 field. |
| D-5 | Ad-hoc `color-mix` where a token exists | `.kcard-drag-handle` | **Deferred** — §11.3 |
| D-6 | Off-scale type / off-grid spacing; four inline `style` props in `Dashboard.tsx` | §§7–10 | Every value tokenised; inline props removed. One deliberate exception: `Button`'s `px-[14px] py-[9px]`, matched to the un-migrated `.button` (§2.1). |
| D-7 | `transition: all` animating `transform`, turning the 1px press nudge into a 120ms slide | `.segment button` | Explicit property list — §7.4. `.chip` deferred (§11.4). |
| D-8 | Stock shadcn classes arriving with generated source | `button.tsx`, `select.tsx` | Strip on sight: `rounded-md`, `shadow-sm`, `ring-offset-background`, `focus:ring-2`, `animate-in`/`fade-in-0`/`zoom-in-95`/`slide-in-from-*`, `active:scale-*`, `hover:bg-accent/50`, every `dark:` branch. **A stock aesthetic surviving into the diff is a review failure, not a nit.** |
| D-9 | Theme-namespace collision | `tokens/tailwind.css` | Forbidden — §1.4 |
| D-10 | Raw-scale colour utilities | plan-wide | Forbidden — §1.4. `colors.css:33` requires semantic aliases; only the seven narrow roles are added. |
| D-11 | Non-existent `border-*-solid` utilities compiling to nothing with Preflight off | §§5–10 | Arbitrary per-side style property — §1.3 |

Dead selectors retired: the duplicate 720px `.stats` rule, `.stat:nth-child(3)`, and — after the
§1.5 grep confirms zero consumers — the `.dashboard-*`, `.stats`/`.stat`, and `.plist`/`.prow*`
blocks, **except `.prow__thumb`** (§1.5's table), which stays as CSS because `app.css` is imported
unlayered in `index.css` and must stay unlayered itself to reliably outrank
`.project-cover-placeholder`'s unlayered background. **Not** `.toasts`/`.toast*`, `.empty`,
`.button`, `.pagehead`, `.toolbar`, or the helpers.

### Acceptance criteria

1. All fourteen states in §4 captured before and after at their marked viewports, matched pairs.
2. The three-part §5.6 gate passes: no document overflow, no element escaping the viewport, and no
   vertical overlap between Notice Board and view bar in archived scope at all three viewports —
   with the `[overflow-x:clip]` net temporarily removed. **This is the TB0-VIS-01 closure gate.**
3. Every interactive element on the surface shows the 2px ink focus ring at offset 2 (or inset −2
   where specified) under keyboard navigation: search field, both segments' buttons, the Select
   trigger and its options, New shoot, list rows, list retry, Kanban card link, drag handle,
   priority select, arrows, Move-to, popover options, error Try again, empty-state action, notice
   toggle.
4. All ten `Select` accessibility tests in §2.2 pass, including the Priority-gate guard.
5. Disabled segment buttons and disabled `Button`s are visibly disabled at ≥4.5:1 label contrast,
   with `cursor-not-allowed` and no hover response; `cursor-wait` appears **only** where `busy`.
6. No `opacity`-only disabled state, no `transition-all`, no non-overlay shadow, no gradient, no
   infinite animation, no `active:scale-*`, no `dark:` utility on this surface.
7. **No raw Tailwind palette utility and no raw Quincy-ramp utility** (`bg-gray-*`, `text-slate-*`,
   `bg-paper-*`, `border-greige-*`, `bg-ink-*`) anywhere in the diff — grep-verified — and no bare
   numeric spacing/type utility (`p-5`, `text-sm`, `rounded-md`) standing in for a Quincy token.
8. **No `border-t-solid`/`border-b-solid`/`border-l-solid`/`border-r-solid`/`border-x-solid`/
   `border-y-solid` anywhere in the diff** — grep-verified (§1.3).
9. `@theme inline` gains only the seven roles in §1.4; `--spacing-*`, `--text-*`, `--radius-*`,
   `--shadow-*`, `--tracking-*`, `--leading-*`, `--font-*`, `--ease-*` untouched. TB1's live
   `ProjectFields` Client section renders byte-identically, captured at all three viewports.
10. No new runtime dependency. `cva` is not introduced (§2.1). `tailwindcss/preflight.css` still
    absent from the built CSS; built-CSS size delta recorded.
11. **Real-browser drag verification, mandatory because §8.2/§8.4 touch `ProjectKanbanBoard`**
    (`docs/lessons.md:901`): pointer **and** keyboard cross-column drag, on a column holding **≥2
    cards**, in a real browser — not a mocked `DndContext` and not a generic Agy pass. Card lands in
    the target column, no white screen, no lost focus, announcements fire.
12. No legacy selector deleted without a fresh repo-wide consumer grep showing zero consumers.
    **A `querySelector` in a test file is a consumer.** The §1.5 grep must cover `*.test.tsx`, not
    only rendering source. Already known to hit this release (verified 2026-09-01):
    `.dashboard-search input` — `Dashboard-calendar.dom.test.tsx:100,228,233,238,241,264`;
    `.dashboard-sort select` — `Dashboard-kanban-sort.dom.test.tsx:67`,
    `Dashboard-stage-interactions.dom.test.tsx:553,657,717`; `.prow-wrap .prow` / `.prow__raw` —
    `Dashboard-kanban-sort.dom.test.tsx:108`. For each, either keep the class attribute on the
    element as a test hook after its CSS rule is deleted, or update the query to a role/text
    selector — **never** loosen or delete the assertion. `.dashboard-live-region` and `.kcol__head`
    (also queried by `Dashboard-stage-interactions.dom.test.tsx`) are preserved by this plan and
    need no change; `.empty` is queried by `ProjectWorkspace.dom.test.tsx` and its rule stays (§1.5).
13. `npm run typecheck` and `npm run build -w @quincy/web` green; `npm run test --workspaces` plus
    `npx vitest run --config packages/shared/vitest.config.ts` green — attention to
    `Dashboard-notice-board.dom.test.tsx`, `Dashboard-stage-interactions.dom.test.tsx`,
    `Dashboard-kanban-sort.dom.test.tsx` (**updated for the `Select` migration — same assertions,
    listbox roles**), `Dashboard-calendar.dom.test.tsx` (**six `.dashboard-search input` queries —
    see criterion 12**), `Dashboard-priority-coordinator.dom.test.tsx`,
    `KanbanCardPreview.dom.test.tsx`.
14. Every `data-focus-key`, `aria-*`, `role`, and `sr-only` node present before is present after,
    verified by diffing a DOM snapshot in List and Kanban, notice open and closed. The TB5B
    focus-restoration selectors are load-bearing.
15. TB7's Notice Board behavior contract (`Revamp-TB7-Notice-Board-Migration-Plan.md:439–458`) is
    unchanged — badge computation, disclosure, drafts, author rules, role exclusion. Only paint.
16. TB0-VIS-01's Drift-Register row updated to record the overflow as **resolved**, with evidence
    filenames and a note distinguishing the evidenced cause (§5.1) from the latent fixes (§§5.2–5.5).
17. Agy QA pass per `docs/Subagent-Orchestration.md` §2.8–§2.10 covering the §4 matrix.
18. **Two Select keyboard behaviors need real-browser verification, not just the happy-dom suite**
    (`Dashboard-kanban-sort.dom.test.tsx`, `Sort Select accessibility contract`): (a) **Escape
    returns focus to the trigger** — closing without selecting is unit-tested, but happy-dom does
    not reproduce Base UI's floating-ui focus-management moving `document.activeElement` back to
    the trigger (verified directly: multiple flush strategies, including `vi.advanceTimersByTimeAsync`
    and raw microtask draining, all left focus on an unrelated ancestor element); (b) **Space opens
    the popup from a focused trigger** — ArrowDown-to-open and Enter-to-commit are both unit-tested
    and confirmed to work under direct synthetic dispatch, but Space-to-open consistently did not
    across four separate dispatch strategies (keydown alone, keydown+keyup, with/without an explicit
    `code: "Space"`), plausibly because Base UI's Popup depends on `@base-ui/utils/useEnhancedClickHandler`'s
    pointer/keyboard timing heuristic for this specific path, which happy-dom's synthetic events
    don't reproduce. Both are release-blocking per §2.2 items 2 and 5 and must be confirmed working
    in the Agy real-browser pass (item 17) before this candidate ships — track them as their own
    checklist lines in that pass, not folded silently into the general matrix.

---

## 13. Open questions — none

Every question raised across both revisions is resolved, and the final Opus self-review (see the
status block) opened none. The plan is approved and ready for build.

All five questions from the first Tailwind revision:

| Was | Resolution |
| --- | --- |
| Q1 — top-bar glassmorphism blast radius | **Resolved: dropped.** Owner decision — the top bar is a shared app-wide shell component; Dashboard-only flattening would split visual ownership. Findings preserved in §11.1. |
| Q2 — Kanban carve-out | **Resolved: carve-out kept**, with the rationale corrected to release ownership and regression risk (§1.5). §12.11 adds mandatory real-browser pointer and keyboard drag verification. |
| Q3 — `Input` `--field-border` vs `--border-hairline` | **Resolved: no change.** TB1 chose the hairline deliberately to preserve the live form contract — settled authority. The primitive leaves TB8-01's scope entirely (D-4). |
| Q4 — sticky List header | **Resolved: dropped.** Owner decision — no demonstrated baseline pain, and the roadmap requires owner approval for intentional evolution. |
| Q5 — Notice Board unread indicator | **Resolved: approved, paint only**, within TB8-01. TB7's behavior contract stays fully intact; the rest of the panel defers to the notice board candidate (§11.2). |

### Notice Board scope boundary — resolved, recorded here for the trail

A previous revision raised this as an open question: TB0-VIS-01's wording is *"horizontal
overflow/clipping in the current **notice**/board composition,"* while the owner's Notice Board
decision limits TB8-01 to the unread indicator. **Owner confirmed 2026-09-01: §§5.4–5.5 stay in
scope.** Those two wrap fixes are TB0-VIS-01 bug repair — fixing the flagged overflow/clipping
defect — not Notice Board visual redesign, which remains reserved for its own later TB8 candidate
per the roadmap. No other Notice Board change is proposed.
