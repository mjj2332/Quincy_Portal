# TB8-09 — Review Lightbox: Visual Plan

**Status: DRAFTED, not yet reviewed.** Ranking candidate **#9** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("Lightbox controls, only if evidence
warrants") — the warrant is established in
`docs/plans/revamp_2026_portal/evidence/TB8-09/drift-register.md` and summarised in §1.2. Branch
`tb8-09-lightbox-controls`, cut from `main` at `7c9544f` (TB8-08 deployed).

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafts, Sol reviews scope and
correctness (≤2 rounds), a Sonnet subagent builds in slices, this session holds the final visual
gate. Matched-evidence viewports stay TB1's: `1440×900`, `1024×768`, `390×844` — plus `721px` and
`1080px`, because this surface switches bands at exactly those two widths and every band bug in
TB8 so far has lived on an edge.

---

## 0. Checks already run against the repo

Recorded so neither Sol nor the builder repeats them, and so a later reader can see which of this
plan's claims are verified rather than reasoned. Each says how it was checked.

| # | Claim | How checked | Result |
|---|---|---|---|
| 0.1 | `@theme inline` makes the role layer scopeable | `grep` the built `dist/assets/index-*.css` for the emitted utilities | **Holds.** `.text-foreground{color:var(--foreground)}`, `.outline-ring{outline-color:var(--ring)}`, `.border-border{border-color:var(--border)}`. |
| 0.2 | §2.2's list of raw-ramp roles is **complete** | Enumerated all 18 roles §2.3 sets, resolved each through `tokens/tailwind.css`'s `@theme inline` block | **Holds, exactly four.** `--foreground-secondary`→`--text-secondary`, `--border-hover`→`--greige-300`, `--surface-sunken`→`--bg-sunken`, `--primary-hover`→`--ink-700`. The other 14 read a proper role name. `--on-inverse`/`--on-inverse-muted` read raw aliases and are correctly left unscoped. |
| 0.3 | Scoping `--ring` alone is insufficient | Read `tokens/base.css:25` and `index.css`'s import order | **Confirmed — this was a defect in the first draft.** See §2.3a; the scope now sets `--focus-ring` too. |
| 0.4 | Scoping `--focus-ring` per surface is an established pattern here | `styles/production-calendar.css:18` | **Holds.** `.production-calendar { --focus-ring: var(--signal-info, #2f3b4d) }`. |
| 0.5 | No **R** selector has a consumer outside `Lightbox.tsx` | Grepped each retired class as a real class token in `className=` / `querySelector` across `apps/web/src` | **Holds** for every selector in §4 except `.barbtn` / `.icbtn--ondark` / `.icbtn`, which are shared with `PhotoGrid.tsx` and are marked conditional or **K** accordingly (§1.4). Earlier broad greps hit `decide`, `strip`, `pin`, `thread`, `cmt` in unrelated files — all substring matches in prose or identifiers, not class tokens. |
| 0.6 | `--focus-ring` is named directly by more than one primitive | `grep -rn -- "--focus-ring" apps/web/src` | **Nine call sites**: `icon-button.tsx`, `AnchoredPopover.tsx`, `NoticeBoard.tsx`, `SubtaskChecklist.tsx` ×2, `ProjectKanbanBoard.tsx` ×4. This is *why* §2.3a's scope-don't-edit approach is right: none of them needs touching. |
| 0.7 | `ui/textarea.tsx` exists with the assumed API | Read it | **Holds.** `Textarea` wraps `FIELD_BOX` with `min-h-[96px] resize-y`; `cn` is twMerge-backed, so §5.7's `className` composes as written. |
| 0.8 | The four brand signal tones fail on ink | Composited each over `--ink-900` and `--ink-800` | **Confirmed**, 1.75:1–4.20:1. See §2.4 — the scope must not redefine them. |
| 0.9 | `box-sizing: border-box` is global | `tokens/base.css:6` and `app.css:10` | **Holds**, so §4's stated pixel sizes are whole targets, not content boxes. |

## 1. What this release is

### 1.1 The surface

The review Lightbox: the stage, the image and its zoom frame, the markup layer and toolbar, the
filmstrip, compare mode, and the review side panel (decision, rating, label, annotations). One
component, `components/Lightbox.tsx` (506 lines). One CSS block, `styles/app.css` **255–507**,
plus the band overrides at **622–631** / **659–690** and the compare grid at **753–755**.

### 1.2 Why it earns a release

From the drift register, all measured from source:

- **The focus ring is invisible on the entire dark stage — 1.00:1.** `--focus-ring` is
  `--ink-900`; `.viewer`'s background is `--ink-900`. Nothing focusable on the dark half of the
  lightbox shows focus: close, prev/next, zoom, nine markup-toolbar buttons, every filmstrip
  thumbnail. WCAG 2.4.7 and 2.4.11.
- **Nine buttons in one toolbar have no accessible name at all** — six `.swatch`, three `.wbtn`.
  Five more (`.starpick`) all compute the same name, `"★"`.
- **Six measured contrast failures**, plus a `.vpanel` border at 1.01:1 that is simply invisible.
- **Nine sub-44px targets**, concentrated in the 721–1080px band, which has no override at all.
- `--signal-warm` and `--panel` are used and **defined nowhere**; a label palette is duplicated
  verbatim across two components; four scrim literals sit at three alphas while `--scrim-overlay`
  goes unadopted since TB8-02 deferred it here by name.

### 1.3 The one architectural decision

**The lightbox is the app's only dark surface, and that is why it never converged.** Every shadcn
semantic role in `tokens/tailwind.css` is defined for the light paper canvas — `--foreground` is
ink, `--card` is white, `--ring` is ink. A Tailwind utility written inside `.viewer` resolves
against the *light* palette and produces ink-on-ink. That is exactly how the focus ring got to
1.00:1: `IconButton` already does the right thing, `focus-visible:!outline-[var(--focus-ring)]`,
and the token it names is wrong for this one ground.

So the answer is not to write dark variants of every control. **It is to invert the role layer for
the duration of the surface** — §2. Every existing primitive (`Button`, `buttonClasses`,
`IconButton`, `Notice`, `Eyebrow`) then works inside the lightbox unchanged, with no new variant,
no `!important`, and no duplicated class list. This is the release's signature move and everything
in §5 depends on it.

### 1.4 Scope extension the owner should see

`.barbtn` and `.icbtn--ondark` are **shared with `PhotoGrid.tsx`** — they style the selection
action bar (`.actionbar`), which is not this candidate's surface. They are the same problem in a
different place: ink chrome floating on the light app. Retiring them only inside the lightbox
would leave two orphaned legacy rules alive for one consumer.

**Proposal: apply the §2 inverse scope to `.actionbar` as well**, and retire `.barbtn` /
`.icbtn--ondark` completely. It is three added lines and it is the difference between retiring the
selectors and merely half-retiring them. The orchestration doc's "full UI rescue, not just the
named control" rule supports this; it is called out here because it reaches a surface outside the
candidate's name. **If the owner declines, the fallback is stated in §4** — keep both selectors,
scope the retirement to the lightbox's own call sites, and hand the remainder to TB8-10.

### 1.5 Explicitly not in scope

- **`.pin`, `.markup-svg`, `.canvasframe*` stay CSS.** These are annotation geometry: an SVG
  overlay positioned by JS-computed transforms, with `vector-effect="non-scaling-stroke"` and a
  zoom transform origin. The roadmap says specialized CSS remains where evidence shows it is
  clearer, and this is the clearest case in the app. They keep their rules and gain a comment
  saying why — the same disposition TB8-07 gave its 24 rich-text prose rules.
- **The six markup pen colours** (`#e64b3c #f0a020 #3f8f5a #2f6df0 #ffffff #0a0a0a`) stay
  literals. They are pen ink applied *to the photograph*, not interface chrome; they must stay
  legible over arbitrary image content, not over a brand ground. §9.2 records this as a decision
  rather than leaving it an accident.
- **`LazyImage`** is untouched. It is shared with `PhotoGrid` and the Dashboard.
- **Compare mode carries no phone criteria.** `Lightbox.tsx:111` disables it below 721px.

---

## 2. The inverse surface — the mechanism, verified

### 2.1 Why it works

`tokens/tailwind.css` declares its theme with `@theme inline`. That is the whole reason this is
possible: with `inline`, Tailwind emits the *variable reference* into the utility rather than
resolving it at build time. **Verified by reading the built CSS, not assumed:**

```
.text-foreground          { color: var(--foreground) }
.outline-ring             { outline-color: var(--ring) }
.border-border            { border-color: var(--border) }
.bg-card                  { background-color: var(--card) }
.text-foreground-secondary{ color: var(--text-secondary) }     ← note this one
```

Redefining `--foreground` on a descendant therefore re-themes `text-foreground` inside that
subtree, with no new utility and no specificity fight.

### 2.2 The one indirection that has to be added first

Four of the TB8-01 narrow roles read a **raw ramp alias** instead of a shadcn role — the last line
above is the example. Those bypass the layer we want to scope, so scoping them would mean
redefining `--text-secondary` itself inside the lightbox, which is a global ramp name and the
wrong thing to shadow.

**Fix, in `tokens/tailwind.css` and `tokens/colors.css`** — add the missing indirection so these
match the pattern every other role in the file already follows:

```css
/* tokens/colors.css — alongside the existing semantic aliases */
--foreground-secondary: var(--text-secondary);
--surface-sunken:       var(--bg-sunken);
--border-hover:         var(--greige-300);
--primary-hover:        var(--ink-700);

/* tokens/tailwind.css — @theme inline, replacing the direct raw-alias reads */
--color-foreground-secondary: var(--foreground-secondary);
--color-surface-sunken:       var(--surface-sunken);
--color-border-hover:         var(--border-hover);
--color-primary-hover:        var(--primary-hover);
```

**Verify the list is complete before writing `inverse.css`, do not trust this table.** The check
is mechanical: for every role the scope intends to set, grep the built CSS for the utility that
consumes it and confirm it emits `var(--<role>)` and not a raw ramp name. Four roles needed the
indirection precisely because they failed that check —

```
.text-foreground-secondary{color:var(--text-secondary)}      ← raw, needed fixing
hover:…bg-primary-hover   → background-color:var(--ink-700)  ← raw, needed fixing
hover:…border-border-hover→ border-color:var(--greige-300)   ← raw, needed fixing
.bg-surface-sunken        {background-color:var(--bg-sunken)}← raw, needed fixing
.text-foreground          {color:var(--foreground)}          ← role, fine
.outline-ring             {outline-color:var(--ring)}        ← role, fine
```

A role that silently reads the raw ramp is **inert inside the scope** — it will not error, it will
simply keep its light value on a dark ground. That failure is invisible in review and obvious only
in the browser, which is why slice 1 ends with a before/after CSS diff (§8).

This changes **no rendered value anywhere** — each new role's `:root` value is exactly what the
theme read before. It only makes the roles scopeable. `--color-on-inverse` and
`--color-on-inverse-muted` are deliberately left reading their raw aliases: they are *already*
the inverse pair and must not flip inside an inverse scope.

### 2.3 The scope itself

A new file, `styles/tokens/inverse.css`, imported from `index.css` immediately after
`tokens/tailwind.css` and before `tokens/base.css`:

```css
/* The app is a light surface. Two places are not: the review Lightbox and the selection
   action bar. Rather than dark variants of every control, invert the role layer for the
   subtree — every primitive then works unchanged. See TB8-09 §2. */
[data-surface="inverse"] {
  --background:            var(--ink-900);
  --foreground:            var(--paper-050);      /* 18.64:1 on the stage */
  --foreground-secondary:  var(--greige-200);     /* 11.78:1 */
  --muted-foreground:      var(--greige-300);     /*  8.59:1 */
  --card:                  var(--ink-800);        /* raised chrome: toolbar, pills */
  --card-foreground:       var(--paper-050);
  --popover:               var(--ink-800);
  --popover-foreground:    var(--paper-050);
  --secondary:             var(--ink-700);        /* the hover lift */
  --secondary-foreground:  var(--paper-050);
  --border:                var(--greige-500);     /*  3.48:1 vs ink-900, 3.24:1 vs ink-800 */
  --border-hover:          var(--greige-400);     /*  5.55:1 / 5.17:1 */
  --input:                 var(--greige-500);
  --surface-sunken:        var(--ink-700);
  --primary:               var(--paper-050);      /* inverted: a solid button is paper on ink */
  --primary-foreground:    var(--ink-900);
  --primary-hover:         var(--greige-100);   /* only works because of §2.2 */
  --ring:                  var(--paper-050);      /* 18.64:1 — the §1.2 fix, utilities half */
  --focus-ring:            var(--paper-050);      /* 18.64:1 — the §1.2 fix, global-rule half */
}
```

Applied as `data-surface="inverse"` on `.viewer`, on `.compare`, and (per §1.4) on `.actionbar`.
`.vpanel` is a **light** panel inside a dark stage, so it carries `data-surface="default"`, which
resets the same properties to their `:root` values — declared in the same file so the pair is
read in one place.

### 2.3a Why the scope sets **both** `--ring` and `--focus-ring`

This is the single easiest thing to get wrong here, and setting only `--ring` would leave the
§1.2 defect half-fixed in a way that looks fixed.

There are **two independent paths** by which a focus ring gets painted in this app:

1. **Tailwind utilities** — `focus-visible:outline-ring` (in `buttonClasses`) reads `--ring`.
2. **A global rule** — `tokens/base.css:25` declares an unlayered
   `:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring); outline-offset: 2px }`
   that applies to **every focusable element in the app**, including every one inside the
   lightbox, and it names `--focus-ring` directly. Being unlayered, it also *beats* an ordinary
   layered `outline-*` utility — which is why `ICON_BUTTON_BASE` and `ImpersonationBanner`'s
   `EXIT` both carry `!`-prefixed focus utilities today.

Scoping only `--ring` therefore fixes path 1 and leaves path 2 painting ink-on-ink at 1.00:1 for
every control that does not carry its own `!`-prefixed override. Scoping both closes it once, for
every element in the subtree, whether or not it opts in.

**This is the codebase's own established pattern, not an invention.**
`styles/production-calendar.css:18` already does exactly this — `.production-calendar
{ --focus-ring: var(--signal-info, #2f3b4d) }` — scoping the focus ring to a surface that needs a
different one. TB8-09 uses the same mechanism for the same reason.

**Consequence: `ICON_BUTTON_BASE` is NOT edited.** An earlier draft of this plan proposed changing
its `focus-visible:!outline-[var(--focus-ring)]` to name `--ring`. That edit is now unnecessary
and is **withdrawn** — with `--focus-ring` scoped, `IconButton` is already correct on both
grounds, and the primitive is shared with nine other call sites
(`NoticeBoard`, `ProjectKanbanBoard` ×4, `MentionAutocomplete`, `AnchoredPopover`,
`SubtaskChecklist` ×2). **Do not touch `ui/icon-button.tsx`.** Not touching a shared primitive is
strictly better than touching it and re-verifying nine surfaces.

`--focus-ring` is deliberately *not* given a `@theme inline` role in §2.2: it is consumed by a
plain CSS rule, not by a utility, so it is already scopeable as-is.

### 2.4 What this does not solve, and must not be asked to

**The four brand signal tones do not survive on ink**, measured:

| | vs `--ink-900` | vs `--ink-800` |
|---|---|---|
| `--signal-positive` | **2.61:1** | 2.43:1 |
| `--signal-critical` | **1.98:1** | 1.84:1 |
| `--signal-info` | **1.75:1** | 1.63:1 |
| `--signal-caution` | 4.20:1 | 3.91:1 |

The scope deliberately does **not** redefine them. **Rule for this surface: a signal tone is never
a foreground on the dark stage.** Today nothing violates this — every signal use (`.dbtn`,
`.labelpick`) lives in the light panel, and the label swatches are backgrounds carrying no text.
If a later change wants a signal on ink it needs a lightened pair, the mirror of what
`--signal-caution-text` does for light grounds. That is out of scope here; this note exists so the
next person does not discover it by shipping it.

---

## 3. Cascade discipline

`index.css` imports `app.css` **outside any layer**, so every legacy rule there beats an ordinary
Tailwind utility regardless of specificity. Two further facts this surface has already been bitten
by, both of which the builder must treat as invariants rather than rediscover:

1. **Equal specificity → later source wins.** `:focus-visible` (0,1,0) in `tokens/base.css` loses
   to `.strip__button` (0,1,0) in `app.css`, because `app.css` is imported later. This is TB8's
   **third** sighting of this exact trap (TB8-02 round 3, TB8-05's B4). Never "out-specify" a
   legacy rule from a later file — **delete it**.
2. **`tokens/base.css`'s unlayered `:focus-visible` uses the `outline` shorthand**, which resets
   `outline-offset`. Any per-control focus utility must therefore be `!`-prefixed, exactly as
   `ICON_BUTTON_BASE` already does. Copy that pattern; do not invent a second one.

---

## 4. Per-selector disposition

Required by the orchestration doc: every touched legacy selector gets an explicit disposition.
**R** = retire the rule, keep the class only as a non-styling test/query hook. **D** = delete the
rule and the class. **K** = keep, with a comment saying why.

| Selector | Disposition | Note |
|---|---|---|
| `.viewer`, `.viewer.no-panel` | **R** | Grid geometry → utilities on the root element; the element gains `data-surface="inverse"`. `--panel`'s phantom (K-6) dies with it — the 380px becomes a literal in one place. |
| `.viewer__stage`, `__imgwrap`, `__img` | **R** | Layout only. |
| `.viewer__nav`, `__close` | **R** | Become `IconButton` + positioning utilities. |
| `.viewer__panel-trigger` | **R** | Becomes `buttonClasses("secondary")` inside the inverse scope; fixes C-5 (2.33:1 border) for free via `--border`. |
| `.viewer__meta`, `.a`, `.b` | **R** | `.a` → display face utility; `.b` → `Eyebrow`. |
| `.viewer__shortcuts`, `.is-drawing`, `span`, `i` | **R** | Pill → utilities; `--scrim-overlay` replaces `rgba(10,10,10,.6)`. |
| `.kbd` | **R** | Fixes C-6. |
| `.canvasframe*`, `.markup-svg*`, `.pin` | **K** | §1.5. Add the "why kept" comment. |
| `.drawbar`, `__lbl`, `__grp` | **R** | `bg-card` inside the scope = `--ink-800`, the same value. |
| `.swatch`, `.wbtn` | **R** | Geometry moves to `ICON_BUTTON`; fixes T-1, T-2 in **all** bands. |
| `.vpanel`, `__head`, `__addr`, `__scroll` | **R** | Panel takes `data-surface="default"`. C-7's 1.01:1 border-left becomes `border-border` resolved against the *stage*. |
| `.vpanel__collapse` | **R** | → `IconButton`; fixes T-6 (36px in the 721–1080 band). |
| `.vpanel__peek*` (7 rules) | **K, with edits** | The phone peek bar is the surface's **correct** implementation (§2 of the register). Keep its structure; only replace `var(--signal-warm, #9a6a1f)` with `text-signal-caution-text` and the two `#fff` with `--primary-foreground`. **Do not rebuild it.** |
| `.decide`, `.dbtn`, `.dbtn.on-*` | **R** | → `Button` variants; adds the missing `aria-pressed`. |
| `.starpick`, `button`, `.on` | **R** | Rebuilt as a radio group, §5.4. |
| `.labels`, `.labelpick`, `.is-on` | **R** | Rebuilt as a radio group, §5.5. |
| `.thread`, `.cmt`, `.cmt--highlighted`, `.cmt__*` | **R** | Fixes C-1, C-2. |
| `.annotation-note`, `:focus` | **R** | → `Textarea` (`ui/textarea.tsx`). |
| `.comment-reply` | **R** | → `buttonClasses("text")`, which carries `max-[721px]:min-h-[44px]`; fixes T-7. |
| `.strip`, `.strip.full`, `.strip__button`, `.strip__t` | **R** | **`.strip__button`'s `outline: 2px solid transparent` must be deleted, not overridden** (§3.1). Fixes T-5 (48×32 on phone) and C-8. |
| `.compare`, `__pair`, `__cell`, `__tag`, `__pickbtn` | **R** | Takes `data-surface="inverse"`. |
| `.viewer--compare` and its two children | **R** | Grid geometry. |
| `.viewer__panel-scrim` | **D** | Adopts `--scrim-overlay`, closing TB8-02-E-1. |
| `.barbtn`, `.barbtn--solid`, `.icbtn--ondark` | **R if §1.4 approved, else K** | Shared with `PhotoGrid.tsx`. Under the extension they retire entirely; without it they keep their rules and only the lightbox's call sites move. |
| `.icbtn`, `.icbtn--lg`, `.icbtn--ghost`, `.icbtn.is-on` | **K** | Light-surface variants with consumers outside this candidate. TB8-10's D-06 territory. |

**Ledger requirement:** the final slice reports retired-vs-kept counts and `grep -c` for each
retired class name across `src/`, the way TB8-07 and TB8-08 both did. A kept rule without a
comment saying why is a defect.

---

## 5. Exact specification

Shared constants, in a new `components/lightbox/lightbox-tokens.ts` so the two bands cannot drift
apart again (the register's §2 finding was precisely that they had):

```ts
export const STAGE_CHROME = "absolute z-[5]";
export const PANEL_SECTION = "flex flex-col gap-[var(--space-3)]";
export const SECTION_LABEL = "[font:var(--type-eyebrow)] uppercase " +
  "tracking-[var(--tracking-widest)] text-foreground-secondary";
```

`SECTION_LABEL` is the existing `.vpanel__sec .eylab` expressed as utilities; it is `Eyebrow`'s
class list with `--tracking-widest`, so use `<Eyebrow>` itself wherever the element can be a
`<span>` and this constant only where it cannot.

### 5.1 The root and the stage

| Element | Classes |
|---|---|
| `.viewer` root | `data-surface="inverse"` · `fixed inset-0 z-[80] bg-background grid grid-rows-[1fr_auto] grid-cols-[1fr_380px] max-[1080px]:grid-cols-[1fr]` |
| — no panel | add `grid-cols-[1fr]` conditionally; do not keep a `.no-panel` class |
| — impersonating | `.app--impersonating .viewer { inset: 42px 0 0 }` is a **K** — it is the impersonation banner's offset, owned by that feature, and reaching into it from here would split its ownership |
| `.viewer__stage` | `row-start-1 row-end-2 relative grid place-items-center overflow-hidden min-w-0` |
| `.viewer__imgwrap` | `relative w-full h-full grid place-items-center overflow-hidden p-[28px] pb-[84px] max-[721px]:pt-[calc(28px+env(safe-area-inset-top))] max-[721px]:pb-[118px]` |

`bg-background` inside the inverse scope resolves to `--ink-900` — the same value the literal had,
now named.

### 5.2 Stage controls

All four are `IconButton`, used **unmodified**. Its `focus-visible:!outline-[var(--focus-ring)]`
resolves to `--paper-050` inside the scope because §2.3 sets `--focus-ring` there — see §2.3a.
No primitive is edited by this release.

| Control | Classes | State |
|---|---|---|
| Close | `IconButton` + `absolute top-[16px] left-[16px] z-[5] max-[721px]:top-[calc(16px+env(safe-area-inset-top))] max-[721px]:left-[max(16px,env(safe-area-inset-left))]` | keeps `aria-label="Close"` |
| Prev / Next | `IconButton` + `absolute top-1/2 -translate-y-1/2 z-[3]` + `left-[18px]` / `right-[18px]`, `max-[721px]:left-[10px]` / `max-[721px]:right-[10px]` | keeps its `aria-label` |
| Zoom in / out | `IconButton` | keeps its `aria-label` |
| Panel trigger | `buttonClasses("secondary", { className: "absolute top-[16px] right-[16px] z-[5] hidden max-[1080px]:inline-flex max-[721px]:!hidden" })` | `aria-expanded` + `aria-controls`, already present |

The phone sizes (48px) that `app.css` currently sets for close/nav are **dropped**: `IconButton`
gives 44px at ≤721px, which is the repo's stated contract. Going from 48 to 44 is a deliberate
convergence, not a regression — record it in the gate.

### 5.3 Markup toolbar — the nine unnamed buttons

Container: `absolute left-1/2 bottom-[18px] -translate-x-1/2 z-[6] flex items-center flex-wrap
gap-[var(--space-3)] py-[var(--space-2)] pr-[var(--space-2)] pl-[var(--space-4)] bg-card border
border-solid border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-pill)]
shadow-[var(--shadow-lg)] text-foreground max-w-[calc(100vw-32px)]
max-[721px]:bottom-[calc(18px+env(safe-area-inset-bottom))] max-[721px]:max-w-[calc(100vw-16px)]
max-[721px]:gap-[var(--space-2)]`

`border-border` in scope = `--greige-500` = 3.24:1 on `--ink-800`, clearing C-9's 1.67:1.

**Colour swatches** — the group is a radio group, not six toggles. `role="radiogroup"` with
`aria-label="Pen colour"`; each button `role="radio"` with `aria-checked`, and a **real accessible
name**: `aria-label={PEN_COLOUR_NAMES[color]}`, a new exported map —

```ts
export const PEN_COLOUR_NAMES = {
  "#e64b3c": "Red", "#f0a020": "Amber", "#3f8f5a": "Green",
  "#2f6df0": "Blue", "#ffffff": "White", "#0a0a0a": "Black",
} as const;
```

Classes: `ICON_BUTTON_BASE` + `w-[28px] max-[721px]:w-[44px] rounded-full border
border-[length:var(--border-width-hair)] border-solid border-border` with the colour as an inline
`background`. Selected: `outline outline-[length:var(--border-width-bold)] outline-solid
outline-[var(--ring)] outline-offset-2` — the ring shape the surface already uses for selection,
now at 18.64:1 rather than a hand-rolled double `box-shadow`.

`ICON_BUTTON_BASE` gives 28px desktop and 44px at ≤721px, so **T-1 is fixed in the 721–1080 band
too** — which the old rule never covered. The visible swatch stays 19px by insetting the colour:
the button is the target, a `::before`-free inner `<span aria-hidden>` of `w-[19px] h-[19px]
rounded-full` carries the paint. **Do not shrink the button to fit the dot.**

**Stroke widths** — same treatment: `role="radiogroup"` `aria-label="Stroke width"`, each
`role="radio"` `aria-checked`, `aria-label={`${width} pixels`}`. Classes `ICON_BUTTON` + selection
`bg-secondary` (the `--ink-700` lift) — which also replaces the current `rgba(246,244,239,.16)`.
The inner dot span keeps its inline `width`/`height`.

**Undo / Clear / Cancel / Save** — `buttonClasses("secondary")`, and Save `buttonClasses("primary")`.
In the inverse scope `primary` is paper-on-ink, which is exactly what `.barbtn--solid` painted.
`disabled` states come from `BASE`'s `disabled:` utilities and must not be re-expressed.

### 5.4 Rating

A radio group, replacing five identically-named buttons:

```
<div role="radiogroup" aria-label="Rating" class="flex gap-[var(--space-1)]">
  <button role="radio" aria-checked={n === stars} aria-label={`${n} star${n === 1 ? "" : "s"}`} …>
```

Button classes: `ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px] text-[length:var(--text-lg)]
leading-none"` — `--text-lg` is 22px, the size the rule already used, now on the scale. This fixes
**T-4 at every width**, which no override ever covered.

Colour: **on** → `text-signal-caution-text` (**6.27:1**, up from the hardcoded `#9a6a1f`'s
4.44:1). This is the token file's own stated rule for caution *text*, and it kills K-2's literal.
**off** → `text-muted-foreground`. On the light panel that is `--text-muted` at 3.36:1 — see §9.1,
this is an owner decision, and the star is only the *indicator*; the accessible name and
`aria-checked` now carry the state independent of colour, so §9.1 is a polish question rather than
a blocker.

### 5.5 Colour label

Also a radio group — `role="radiogroup"` `aria-label="Colour label"`, each `role="radio"`
`aria-checked` with `aria-label={label.name}` (a real name, not the `title` fallback; keep `title`
as well for the pointer tooltip).

Classes: `ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px] rounded-full border
border-[length:var(--border-width-hair)] border-solid border-border"`, inner painted span
`w-[26px] h-[26px] rounded-full`, selected ring as §5.3. Fixes **T-3 at every width**.

**K-3 — the duplicated palette.** `labels` is declared identically in `Lightbox.tsx:12` and
`PhotoGrid.tsx:12`. Move it to `@quincy/shared`? **No** — it is presentation, and `shared` is the
contract package for capabilities and pipeline keys. Move it to
`components/lightbox/review-labels.ts` and import from both. One owner, no new package boundary.

### 5.6 Decision buttons

`.decide` → `grid grid-cols-2 gap-[var(--space-2)]`. Each button:

| | Classes | ARIA |
|---|---|---|
| Approve | `buttonClasses(decision === "approved" ? "primary" : "secondary", { className: "w-full" })` | `aria-pressed={decision === "approved"}` |
| Flag | `buttonClasses(decision === "flagged" ? "danger" : "secondary", { className: "w-full" })` | `aria-pressed={decision === "flagged"}` |

The `aria-pressed` is **new on this path** and is the register's §2 asymmetry closed: the phone
peek bar has had it all along. `danger`'s hover already flips to `!text-destructive-foreground`
(= `--paper-050`) on a `--signal-critical` ground, 10.0:1 — the same pair the old `.on-flag.is-on`
painted with a hardcoded `#fff`, so K-5 dies here too.

Recommend and Compare-with-RAW: `buttonClasses(active ? "primary" : "secondary", { className:
"w-full" })`, `aria-pressed` on Recommend. Compare is a mode switch, not a toggle state —
`aria-pressed` there too, since it is a button that stays pressed.

### 5.7 Annotation thread

| Element | Classes |
|---|---|
| `.thread` | `flex flex-col gap-[var(--space-4)]` |
| `.cmt` | `flex gap-[var(--space-3)] rounded-[var(--radius-sm)] transition-[background-color] duration-[1600ms] ease-[var(--ease-standard)]` |
| `.cmt--highlighted` | `bg-surface-sunken` |
| `.cmt__pin` | `flex-none w-[22px] h-[22px] rounded-full bg-primary text-primary-foreground grid place-items-center [font:var(--type-mono)] text-[length:var(--text-2xs)] mt-[2px]` + **`aria-hidden="true"`** (A-6: the `✎` is decoration) |
| `.cmt__pin.unpinned` | `bg-surface-sunken text-foreground-secondary` — **C-2 fixed**, 2.87:1 → 8.66:1 |
| `.cmt__who` | `[font:var(--type-label)]` |
| `.cmt__who span` | `META_TEXT ml-[var(--space-2)]` — **C-1 fixed**, 3.36:1 → 8.66:1, and 11.5px → 12px onto the scale |
| `.cmt__txt` | `text-[length:var(--text-sm)] leading-[var(--leading-normal)] mt-[3px] text-foreground-secondary` — 14.5px → 14px |
| `.annotation-note` | `<Textarea>` from `ui/textarea.tsx`, `className="mt-[var(--space-3)]"` — **keep its default `min-h-[96px]`**, do not restore the legacy 56px. 96px is the system's textarea contract and the panel scrolls, so there is no reason to invent a second height. The legacy `:focus` rule (a bare `border-color` swap with `outline: none`) dies with it; `FIELD_BOX` carries the real focus treatment. |
| `.comment-reply` | `buttonClasses("text", { className: "underline" })` — **T-7 fixed**: `text` carries `max-[721px]:min-h-[44px]` |

Note the `.comment-reply` group is `Edit note · Edit drawing · Delete`, separated by literal `·`
text nodes. Those separators are `aria-hidden` decoration between three buttons; wrap them.

### 5.8 Filmstrip

| Element | Classes |
|---|---|
| `.strip` | `col-start-1 col-end-2 row-start-2 row-end-3 flex min-w-0 gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] overflow-x-auto bg-[var(--scrim-overlay)] border-t border-solid border-[length:var(--border-width-hair)] border-border` |
| `.strip.full` | `col-start-1 col-end-[-1]` |
| `.strip__button` | `flex-none w-[84px] h-[56px] p-0 border-0 bg-transparent leading-none cursor-pointer` + the `!`-prefixed focus utilities from §3.2 — **and no `outline: … transparent`, ever** |
| `.strip__t` | `w-[84px] h-[56px] object-cover bg-[var(--ink-700)] opacity-50 transition-opacity duration-[var(--dur-fast)]`; hover `opacity-85`; active `opacity-100 outline outline-[length:var(--border-width-bold)] outline-solid outline-[var(--ring)]` |
| phone | `max-[721px]:w-[60px] max-[721px]:h-[44px]` on **both** button and thumb |

The phone size is **60×44, not the current 48×32** — T-5. 44px is the contract floor and the
32px the current rule sets is the surface's only *self-inflicted* touch failure. The width goes to
60 to hold the 84:56 aspect ratio rather than distorting the thumbnail.

`bg-[var(--scrim-overlay)]` is 50%, replacing `rgba(10,10,10,.6)`. A 10% shift on a scrim behind a
row of thumbnails is not a visual regression; it is the point of having one token (K-7).

### 5.9 Side panel and compare

`.vpanel` takes `data-surface="default"`, restoring the light palette for its subtree.

| Element | Classes |
|---|---|
| `.vpanel` | `row-start-1 row-end-3 bg-background text-foreground border-l border-solid border-[length:var(--border-width-hair)] flex flex-col min-h-0` |
| — its border | `border-l-[var(--greige-500)]` set **explicitly**, not `border-border`. C-7: the seam divides a light panel from a dark stage, so it must be legible against the *stage*. `--greige-500` is 3.48:1 against the stage and 5.36:1 against `--paper-050` — the darkest ramp step that still clears 3:1 on the *ink* side of the seam. |
| `.vpanel__head` | `relative p-[var(--space-6)] pb-[var(--space-5)] border-b border-solid border-[length:var(--border-width-hair)] border-border` |
| `.vpanel__addr` | `[font:var(--type-h3)] tracking-[var(--tracking-tight)] leading-[1.15]` — drops the 20px override onto `--type-h3` |
| `.vpanel__scroll` | `overflow-auto flex-1 px-[var(--space-6)] py-[var(--space-5)] flex flex-col gap-[var(--space-5)]` |
| `.vpanel__collapse` | `IconButton` + `absolute top-[var(--space-4)] right-[var(--space-4)]` — T-6 fixed by `IconButton`'s own 44px rule |
| `.compare` | `data-surface="inverse"` · `fixed inset-0 z-[85] bg-background flex flex-col` |
| `.compare__tag` | `absolute top-[16px] left-[16px]` + `<Eyebrow className="text-foreground">` |

The ≤720px bottom-sheet block (`.vpanel` fixed/translate/`max-height`, `__head::before`'s grab
handle, the seven `__peek*` rules) is a **K** in full, per §4 — eight interacting
`env(safe-area-inset-*)` declarations and a transform-driven sheet, the same class of geometry
TB8-07 kept for the same reason. Two edits only: `var(--signal-warm, #9a6a1f)` →
`var(--signal-caution-text)` (killing K-1's phantom token), and the two `#fff` →
`var(--primary-foreground)`.

---

## 6. Tests

New `components/Lightbox.a11y.dom.test.tsx`:

1. Every button inside the markup toolbar has a non-empty accessible name (asserts on the computed
   name, not on the presence of an attribute). **This is the A-1/A-2 regression lock.**
2. The five rating radios have five *distinct* names.
3. Each radio group exposes exactly one `aria-checked="true"` when a value is set, none when null.
4. Approve/Flag/Recommend carry `aria-pressed` matching the review state — asserted in **both**
   bands, since the register's finding was that the two bands disagreed.
5. `.strip__button` has no `outline-color: transparent` in its computed style — the §3.1 lock.

Extend `components/tb8-07-regressions.dom.test.tsx` (it already owns the phantom-token pattern) to
assert `--signal-warm` and `--panel` are absent from `tokens/` **and** from `app.css`, alongside
the existing `--signal-warning` check. Generalise it to a list so the fifth one is a one-line
addition rather than a new test.

Existing `Lightbox.dom.test.tsx` (647 lines) and `ProjectWorkspace.dom.test.tsx` both query these
class names. **Migrate every query; delete none.** TB8-08 moved 61 sites and kept all 61 — same
bar here. Where a query needs a stable hook, use `data-slot`, not a retired class name.

---

## 7. Acceptance criteria

Measured in a real browser at `1440×900`, `1024×768`, `390×844`, `721px`, `1080px`.

1. **The focus ring is visible on every focusable control on the dark stage.** Tab from Close
   through to the last filmstrip thumbnail; every stop shows a 2px `--paper-050` ring at
   `offset 2px`, measured ≥ 3:1 against its own ground. Check a control that carries its own
   `!`-prefixed focus utility (any `IconButton`) **and** one that relies on the global
   `:focus-visible` rule alone — §2.3a's two paths must both be closed, and only one of them is
   visible in a class list.
   The filmstrip specifically — it had two independent causes and both must be gone.
2. Every button in the markup toolbar reports a non-empty accessible name. Nine, none anonymous.
3. The rating group reports five distinct names and exactly one `aria-checked="true"`.
4. `.swatch`, `.wbtn`, `.labelpick`, `.starpick button`, `.vpanel__collapse` and `.strip__button`
   each measure **≥ 44 × 44** at ≤721px and **≥ 28 × 28** above it. The 721–1080 band is checked
   explicitly, not inferred from 1440.
5. Contrast, measured, no regressions from the register's §3.3 pass list, and:
   `.cmt__who span` ≥ 8:1 (was 3.36) · `.cmt__pin.unpinned` ≥ 8:1 (was 2.87) ·
   `.starpick.on` ≥ 6:1 (was 4.44) · toolbar and `.kbd` borders ≥ 3:1 (were 1.93 / 2.12) ·
   `.vpanel`'s left seam ≥ 3:1 **against the stage** (was 1.01).
6. Zero horizontal overflow at all five widths, and zero elements overflowing their own box.
7. The drawbar does not collide with `.viewer__shortcuts` at any width, wrapped or not (R-1/R-2).
8. `grep -c` returns **0** for every selector marked **R** or **D** in §4; every **K** carries a
   comment saying why.
9. Full suite green: `npm run typecheck` (6/6), `npm run build -w @quincy/web`,
   `npm run test --workspaces`, and `packages/shared`'s standalone vitest config.
10. Zero console errors and zero failed requests throughout.

---

## 8. Slices

Bottom-up, so nothing is ever half-wired. Each ends green on typecheck and build; only slice 5
must satisfy §7 in full.

| # | Scope | Reads in full |
|---|---|---|
| **1** | The role-layer indirection (§2.2) and `tokens/inverse.css` (§2.3, §2.3a). Touches no component. **Visually inert by construction** — every value is identical at `:root`, and nothing yet carries `data-surface`. Prove it: build before and after, diff the emitted CSS, and state what changed. | §2, §3 |
| **2** | Stage: root, `__stage`, `__imgwrap`, the four `IconButton` controls, `__meta`, `__shortcuts`, `.kbd`, `__panel-trigger`, `__panel-scrim`. | §2, §3, §5.1, §5.2 |
| **3** | Markup toolbar — the nine unnamed buttons, both radio groups, `PEN_COLOUR_NAMES`, the four text buttons. **The highest-value slice; do not merge it with another.** | §2, §3, §5.3 |
| **4** | Side panel: decision, rating, label, thread, textarea, `review-labels.ts`, and the two peek-bar edits. | §2, §3, §5.4–§5.7, §5.9 |
| **5** | Filmstrip, compare, the ≤720 band audit, the §4 retirement ledger, all tests, and the docs. | all |

Slice 1 is the one to get exactly right — every later slice assumes the inverse scope resolves.
If slice 1's before/after CSS diff shows any changed *value* outside the new
`[data-surface]` blocks, stop and report rather than continuing.

---

## 9. Owner decisions this plan does not make

1. **`.starpick` off-state at 3.36:1.** `--text-muted` on `--paper-050`. A `★` drawn with a text
   character is either text (4.5:1, fails) or a non-text graphical indicator (3:1, passes). The
   token file already draws exactly this distinction for icons. §5.4 keeps `text-muted-foreground`
   and makes state non-colour-dependent via `aria-checked`, so nothing is *blocked* either way —
   but if the owner wants the stricter reading, the fix is `text-foreground-secondary` (8.66:1)
   and it is a one-word change.
2. **The six pen colours stay literals** (§1.5). Recorded as a decision, not an accident.
3. **§1.4's scope extension to `.actionbar`.** Approve it and `.barbtn`/`.icbtn--ondark` retire
   completely; decline it and they survive for `PhotoGrid` and go to TB8-10.
4. **Close/nav shrink from 48px to 44px on phone** (§5.2) — convergence onto the repo's stated
   contract, and a deliberate reduction. Flagged because it is the one place this plan makes a
   target *smaller*.
