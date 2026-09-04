# TB8-09 — Review Lightbox: Visual Plan

**Status: BUILT, VISUAL GATE PASSED — not yet merged or deployed.** Gate results in §11; it found
**three defects** that 1,763 tests and two review rounds all missed.

**Prior status: BUILT — all six slices committed; visual gate not yet run.** Slices `3a3f387`,
`90bb4e1`, `0d3453a`, `4d3ad17`, `b16c152`, and slice 6. `app.css` **800 → 679 lines**;
1,763 tests green (up 21). Build record in §10.

**Prior status: DRAFTED, both Sol rounds resolved, self-approved.** Round 1 returned 13 findings
(12 upheld), round 2 returned 7 (6 upheld, 1 stale). Every one was verified against the repo
before acting. **The ≤2-round cap is spent**, so per `Subagent-Frontend-Orchestration.md` §3 the
remaining resolution and approval are this session's. See §0a and §0d. Ranking candidate **#9** in
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

## 0a. Sol round 1 — 13 findings, 12 upheld

I verified every finding against the repo before acting. **Twelve held. One was stale** — Sol read
the draft as of `f8e7ee4`, before `c5dbc59` landed. Four of the twelve were the draft being
outright wrong rather than merely thin.

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| **B1** | `buttonClasses`' layered `focus-visible:outline-ring` loses to the unlayered global rule, so the panel trigger and the four text buttons keep an ink ring | Read `button.tsx:29`, `base.css:25`, `index.css` import order | **Stale — already fixed.** `c5dbc59` scopes `--focus-ring` as well as `--ring` (§2.3a), so the unlayered rule that *wins* now paints paper. Sol's cascade analysis is correct and is exactly why that fix was needed; it just landed first. The finding is what §2.3a already says. |
| **B2** | `data-surface="default"` has no implementation — a data attribute resets nothing by itself, so `.vpanel` would inherit the dark roles | Read §2.3 | **Upheld.** A real gap: I wrote that the pair is "read in one place" and then supplied only one half. §2.3 now carries both blocks. |
| **B3** | Retiring `.icbtn--ondark` breaks a real out-of-scope consumer | `grep -n "icbtn--ondark" PhotoGrid.tsx` → **lines 170–174, five buttons in `.tile__tools`, over photographs** — not in `.actionbar` | **Upheld, and §1.4 was wrong.** Scoping `.actionbar` cannot reach a tile overlay. `.icbtn--ondark` is now **K** unconditionally; only `.barbtn` is in play. |
| **B4** | Multiple retired load-bearing rules have no replacement | Compared §4 against §5 and the live DOM | **Upheld, and one part is worse than reported** — see below. §5 gains the missing specifications. |
| **B5** | Both named breakpoint edges are wrong for Tailwind's emitted media queries | Grepped the built CSS: `max-[1080px]` emits `@media not all and (width>=1080px)` = `width < 1080`, but the legacy `@media (max-width:1080px)` emits `@media (width<=1080px)` | **Upheld for 1080, and it is an off-by-one that changes behaviour at exactly 1080px.** Fixed to `max-[1081px]`; the repo already uses `(width>=1081px)`, so the `+1` convention was established and I ignored it. `max-[721px]` is **correct** as written (`width < 721` = `≤720`, matching the legacy `max-width:720px`). |
| **B6** | The touch-target and contrast arithmetic does not support the claimed fixes | Read `icon-button.tsx:19`; recomputed the contrast | **Upheld on all three counts, and the register overstated its own case.** See §0b. |
| **B7** | The ARIA radio groups omit the required radio keyboard model | Read §5.3–§5.5 and the handlers at `Lightbox.tsx:481,500–501` | **Upheld — and the fix is to drop the radio semantics, not to add roving focus.** See §0c. |
| **B8** | The R/D ledger contradicts its own acceptance test: **R** keeps the class, criterion 8 demands `grep` zero | Read §4 vs §7 | **Upheld.** Self-contradictory as written. Criterion 8 now counts **CSS rules**, not class names, and names the four classes that must survive. |
| **B9** | Slices 2–4 depend on slice 5's CSS retirement, so they ship visibly half-wired | Unlayered `app.css` beats the new utilities until its rules are deleted | **Upheld, and it is the most structural finding.** §8 is rebuilt: each slice retires its own CSS in the same commit that converts its markup. |
| **B10** | The accessible-name tests are not implementable with this test stack | `ls node_modules` — no `dom-accessibility-api`, no `@testing-library`; `ProjectOverviewRail.dom.test.tsx:163–170` documents the absence and works around it | **Upheld.** §6 now specifies the manual algorithm rather than assuming a library. |
| **NB1** | "No other primitive names `--focus-ring`" is false | Nine live call sites | **Upheld** — this plan already recorded them at §0.6, but §2.3a's wording overclaimed. Softened. |
| **NB2** | "One 255–507 CSS block" is false; 300–453 is unrelated | Read `app.css` | **Upheld.** The §1 inventory table always had the correct sub-ranges; the prose around it did not. Corrected. |
| **NB3** | The pen-swatch ring sits on `--ink-800`, so it is 17.35:1, not 18.64:1; and the plan diverges from its own register on `--signal-warm`'s replacement | Recomputed | **Upheld on both.** Corrected, and the divergence is now recorded as a decision (§9.5) rather than an unexplained change. |

**What Sol got wrong:** nothing material. B1 is stale rather than incorrect, and its reasoning is
sound. Every contrast figure it independently recomputed matched mine to rounding except the one
it correctly caught (B6).

**What I found that Sol did not, while verifying B4:** `.compare`, `.compare__pair`,
`.compare__cell`, `.compare__tag` and `.compare__pickbtn` are **dead CSS with zero consumers
anywhere in the app**. Sol observed that no `.compare` element exists in `Lightbox.tsx`; a
repo-wide grep for those class names in any `.tsx` returns nothing at all. Compare mode is
`.viewer.viewer--compare` (`Lightbox.tsx:484`), a modifier on the same root. So those five rules
are **D — delete as dead**, not R, and §2.3's instruction to put the inverse scope on `.compare`
was targeting a selector that never renders. The scope goes on `.viewer` alone, which already
covers compare mode.

## 0d. Sol round 2 — 7 findings, 6 upheld

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| **R2-1** | The new `data-open` breaks the retained phone sheet: `.vpanel.open` survives at `app.css:670` and `.vpanel.open + .strip` at `:686`, and unlayered CSS beats the layered `data-[open]` utility | Read those lines | **Upheld, and it is worse — `.vpanel.open` also survives at `:630`, in the *tablet* block.** So the switch would have broken both retained bands. **Resolution: `data-open` is withdrawn entirely; the `.open` class stays.** It is the minimal change and it removes the failure mode rather than managing it. |
| **R2-2** | The slice ranges leave live rules unassigned — `app.css:750–751` sit outside every claimed range | Read them | **Upheld, and it exposed a bigger problem: my §1.1 inventory was incomplete.** See §0e. |
| **R2-3** | B4's replacement spec is still incomplete, and Reset is *visible text* (`Lightbox.tsx:496`), not a glyph — a fixed `w-[28px] IconButton` cannot contain it | Read the JSX | **Upheld on every sub-item.** Reset becomes a text button; §5.9b now specifies `.drawbar__grp`, `.labels`, `.cmt__b`; `PANEL_SECTION`/`SECTION_LABEL` are mapped to real sites; the dangling "§3.2" is fixed; the cumulative star paint is specified; the two deferred decisions are closed. |
| **R2-4** | The §4 ledger still says `.starpick`/`.labels` are "rebuilt as a radio group", contradicting §0c | Read §4 | **Upheld for those two rows.** Its `.icbtn--ondark` bullet is **stale** — `a4f4520` already made that row **K** unconditionally. |
| **R2-5** | Criterion 5 demands `.cmt__pin.unpinned` ≥ 8:1 but the specified fix measures 7.40:1 — the implementation cannot pass its own gate | Recomputed | **Upheld. A self-contradiction I introduced while fixing B6**: I corrected the table and left the criterion. Criterion 5 now says ≥ 7:1. |
| **R2-6** | §0b's target framing is still mixed: `.swatch` *is* 44px at ≤720 today (`app.css:689`), so "fails at every width" is false; at wide widths its 19px targets have 25px centre spacing, satisfying 2.5.8's spacing exception; and if the internal 44px phone contract is the bar then three controls fail it, not two | Read `app.css:689`; applied 2.5.8's exception | **Upheld — my correction over-corrected in one direction and under-corrected in the other.** §0b is rewritten to state one bar plainly. |
| **R2-7** | Test 1 says "nine buttons" in the toolbar; nine is the formerly-unnamed subset, the toolbar has 11 (13 in edit mode) | Counted | **Upheld.** Non-blocking but it would have encoded a wrong count in a test. |

**Stale:** R2-4's `.icbtn--ondark` bullet only. Everything else held.

## 0e. What R2-2 exposed: the inventory was incomplete, and there is a dead compare implementation

Chasing R2-2's two orphaned lines showed §1.1's ranges were wrong, and then that a whole abandoned
feature is sitting in `app.css`. **Neither round of review found this; it came out of verifying a
finding rather than accepting it.**

**Six selectors were missing from the inventory entirely:** `.compare-trigger` (`:752`),
`.viewer__compare-stage` (`:756`), `.viewer__compare-close` (`:757`),
`.strip__button.is-active, .strip__button.is-compare` (`:750`), `.strip__button .strip__t`
(`:751`), and the `.compare__pair` phone override (`:645`).

**And the dead set is far larger than the five rules §0a identified.** Every one of these has
**zero consumers** anywhere in the app — verified by grepping each class token against
`Lightbox.tsx` and `PhotoGrid.tsx`:

| Dead selector | `app.css` |
|---|---|
| `.compare`, `.compare__pair`, `.compare__cell`, `.compare__tag`, `.compare__pickbtn` | 501–506 |
| `.compare__pair` phone override | 645 |
| `.compare-trigger` | 752 |
| `.viewer__compare-stage` | 756 |
| `.viewer__compare-close` | 757 |
| `.strip__button.is-compare` (half of the `:750` selector list) | 750 |
| `.strip.full` | 494 |
| `.viewer.no-panel` | 259 |

That is an **entire abandoned compare-mode implementation** — a full-screen `.compare` container,
its own pair/cell/tag/pick-button, a floating trigger, a split stage with its own close button —
none of it reachable. The compare mode that actually ships is `.viewer.viewer--compare`
(`Lightbox.tsx:484`), a modifier on the ordinary viewer root, using `:753–755` only.

**Consequence:** `.strip.full` and `.viewer.no-panel` are dead too, and the draft gave both
conversion specifications — instructions to port markup that never renders. All of the above are
**D**, deleted outright. Nothing replaces them.

**This is the single largest retirement in the release** and it costs nothing to verify: a grep
per class. The final slice reports the count.

## 0b. What B6 forces: the touch-target bar was overstated

The drift register listed nine sub-44px targets and treated 44px as the bar at every width. That
is not this repo's contract, and the plan inherited the error.

**Rewritten again after Sol R2-6, which showed the first correction was itself mixed.** Stating
one bar, plainly.

**The bar is this repo's own contract**, because it is stricter than WCAG AA and is what every
converged surface since TB8-06 has been held to:

| | Glyph affordances | Text buttons |
|---|---|---|
| ≥721px | **28px** (`ICON_BUTTON`, `icon-button.tsx:19`) | **38px** (`BASE`, `button.tsx:24`) |
| ≤720px | **44px** | **44px** |

Two different desktop contracts, which the earlier text conflated. WCAG for reference only:
**2.5.5 (44×44) is Level AAA**; **2.5.8 (24×24) is Level AA**, and 2.5.8 has a *spacing exception*
— an undersized target passes if 24px-diameter circles centred on it do not overlap a neighbour's.

Measured against the repo contract, and correcting two claims the last revision got wrong:

| Control | Today | Real verdict | After |
|---|---|---|---|
| Control | ≥721px | ≤720px | Verdict against the repo contract |
|---|---|---|---|
| `.swatch` | **19 × 19** | 44 ✓ (`app.css:689`) | **Fails the 28px desktop contract.** It does *not* fail WCAG 2.5.8: six 19px targets with 6px gaps put centres 25px apart, clearing the spacing exception. And it does **not** "fail at every width" — the phone override already lifts it to 44. Both claims in the previous revision were wrong. |
| `.wbtn` | 28 ✓ | 44 ✓ | **Meets the contract already.** Converted for consistency, not to fix anything. |
| `.labelpick` | 26 × 26 | **26 × 26** | **Fails the 44px phone contract.** |
| `.starpick button` | ≈26 × 26 | **≈26 × 26** | **Fails the 44px phone contract.** |
| `.vpanel__collapse` | 36 ✓ | 44 ✓ | Meets it. **Must not regress** — see below. |
| `.strip__button` | 84 × 56 ✓ | **48 × 32** | **Fails the 44px phone contract**, and the phone override is what introduced it. |
| `.comment-reply` | inline text | inline text | **Fails the 44px phone contract.** |

**So five controls fail, not two.** `.swatch` on desktop; `.labelpick`, `.starpick button`,
`.strip__button` and `.comment-reply` on phone. The previous revision's "only two true failures"
understated it by measuring against WCAG AA instead of the contract the repo actually holds
itself to. The register is corrected to match.

Two consequences the plan carries:

1. **`.vpanel__collapse` must not become a bare `IconButton`.** That would take it from 36px to
   28px in the 721–1080 band — a regression, in the band where it is the drawer's only dismiss
   control. It keeps an explicit `min-h-[36px] min-w-[36px]` above the phone breakpoint.
2. **`buttonClasses("text")` cannot reach 44px.** It carries `px-0` and no `min-width`
   (`button.tsx:41`). **This is TB8-08's own §0 finding #1, and I re-shipped it in this draft** —
   the second time this exact trap has been walked into. `.comment-reply` gets an explicit
   `min-w`/`min-h`, specified in §5.7.

The register is corrected in place alongside this plan, so the two do not disagree.

## 0c. What B7 forces: `aria-pressed`, not `role="radiogroup"`

Sol is right that declaring `role="radiogroup"` obliges a roving `tabIndex`, Arrow/Home/End
handling and a single tab stop, none of which the plan specified.

**The resolution is to drop the radio semantics entirely, because they were the wrong semantics.**
Every one of these controls is a *toggle*, not a radio — read the handlers:

```
stars:      { stars:      number === stars ? null : number }        // Lightbox.tsx:500
colorLabel: { colorLabel: …=== label.value ? null : label.value }   // Lightbox.tsx:501
```

Clicking the set value **clears** it. A radio group cannot be deselected, so `role="radio"` would
have described behaviour the component does not have. `aria-pressed` describes it exactly, needs
no roving focus, keeps every control independently tabbable, and is what the phone peek bar
already uses (`Lightbox.tsx:491`).

**All four groups therefore use `aria-pressed` toggle buttons.** `role="radiogroup"` and
`role="radio"` appear nowhere in this release. The groups keep a `role="group"` with an
`aria-label` for structure.

## 1. What this release is

### 1.1 The surface

The review Lightbox: the stage, the image and its zoom frame, the markup layer and toolbar, the
filmstrip, compare mode, and the review side panel (decision, rating, label, annotations). One
component, `components/Lightbox.tsx` (506 lines). Its CSS is **not** one contiguous block, and
**the first two revisions of this plan both got its extent wrong** (Sol NB2, then R2-2 → §0e). The
complete set, established by grepping every class token the component renders against `app.css`:

**`245–253` · `255–299` · `454–507` · `626–631` · `645` · `660–690` · `749–757`**

`300–453` and everything else in between belongs to unrelated surfaces. `245–253` is the selection
action bar, in scope only because §9.3 was approved. The drift register's §1 table carries the
per-block breakdown; nothing outside these ranges is touched.

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

**Corrected after Sol B3 — the first draft of this section was wrong.** It claimed the inverse
scope would let both `.barbtn` and `.icbtn--ondark` retire. It will not:

- **`.icbtn--ondark` is used five times in `PhotoGrid.tsx:170–174`**, on the per-tile hover tools
  that float **over photographs** — not inside `.actionbar`. No scope applied to the action bar can
  reach a tile overlay, and a control sitting on arbitrary photographic content is a genuinely
  different problem from one sitting on a known ink ground. **`.icbtn--ondark` is therefore K,
  unconditionally**, and goes to TB8-10 with the rest of the tile surface.
- **`.barbtn` really is shared with `.actionbar`** (`PhotoGrid.tsx`), and that *is* ink chrome on a
  known ground, so the scope does reach it.

**Applying the §2 inverse scope to `.actionbar`, and retiring `.barbtn` alone — APPROVED by the
owner 2026-09-04 (§9.3).** The release therefore also owns replacement classes for each
action-bar button and the **nine `.actionbar .barbtn` queries in `PhotoGrid.dom.test.tsx`**,
migrated rather than deleted. This is slice 5's work.

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

Applied as `data-surface="inverse"` on **`.viewer` only** — plus `.actionbar` if §9.3 is approved.
It is *not* applied to `.compare`: that selector never renders (§0a), and compare mode is
`.viewer.viewer--compare`, already inside the scope.

`.vpanel` is a **light** panel inside a dark stage, so it carries `data-surface="default"`. **A
data attribute resets nothing on its own** (Sol B2), so the reset block is written out explicitly
in the same file, and it must list every property the inverse block sets — a role set in one and
missing from the other inherits the dark value into the light panel:

```css
/* The light panel inside the dark stage. Must mirror the inverse block property-for-property;
   anything omitted here inherits the ink value from .viewer. */
[data-surface="default"] {
  --background:            var(--bg-canvas);
  --foreground:            var(--text-primary);
  --foreground-secondary:  var(--text-secondary);
  --muted-foreground:      var(--text-muted);
  --card:                  var(--bg-surface);
  --card-foreground:       var(--text-primary);
  --popover:               var(--bg-surface);
  --popover-foreground:    var(--text-primary);
  --secondary:             var(--bg-raised);
  --secondary-foreground:  var(--text-primary);
  --border:                var(--border-hairline);
  --border-hover:          var(--greige-300);
  --input:                 var(--border-hairline);
  --surface-sunken:        var(--bg-sunken);
  --primary:               var(--accent);
  --primary-foreground:    var(--accent-on);
  --primary-hover:         var(--ink-700);
  --ring:                  var(--focus-ring);
  --focus-ring:            var(--ink-900);
}
```

Every value is its `:root` value, so this block is a restore, not a redefinition. **A test must
assert the two blocks declare the same property set** — §6 item 6.

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

**Scoped, not universally fixed.** Nine live call sites name `--focus-ring` directly (§0.6), and
`AnchoredPopover.tsx:84` is a *primitive* among them. This release makes them all correct **inside
the lightbox subtree** and changes nothing outside it — which is the intent. It does not make the
app's focus-ring handling uniformly scopeable, and this plan should not be cited as if it had.

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

## 3. Cascade discipline and the breakpoint rule

### 3.0 `max-[Npx]` is exclusive — always write N+1 (Sol B5)

Tailwind emits `max-[1080px]` as `@media not all and (width>=1080px)`, i.e. **`width < 1080`**.
The legacy rule it replaces, `@media (max-width: 1080px)`, emits `@media (width<=1080px)` and
**includes** 1080. They disagree at exactly 1080px, where `Lightbox.tsx:37`'s `viewerBand()`
(`innerWidth <= 1080`) says *tablet* while the utility says *desktop* — the JS and the CSS would
render two different layouts at one real, common viewport width.

**Rule for this release, no exceptions:**

| Legacy | Correct utility | Emits |
|---|---|---|
| `@media (max-width: 720px)` | `max-[721px]` | `width < 721` = `≤ 720` ✓ |
| `@media (max-width: 1080px)` | **`max-[1081px]`** | `width < 1081` = `≤ 1080` ✓ |

`max-[721px]` — the form already used throughout `buttonClasses` and `ICON_BUTTON_BASE` — is
**correct** and stays. Only the 1080 edge was wrong in the draft. The repo already emits
`@media (width>=1081px)` elsewhere, so the `+1` convention was established and this plan simply
failed to follow it. Every `max-[…]`/`min-[…]` this release writes must be checked against
`viewerBand()`'s two comparisons.

### 3.1 The two cascade facts

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
**R** = delete the CSS rule, keep the class name as a non-styling hook. **D** = delete the rule
**and** the class name. **K** = keep the rule, with a comment saying why.

**What "retired" is measured as (Sol B8).** The draft's acceptance criterion demanded `grep` zero
across `src/` for every R selector, which contradicts R's own definition — R keeps the class.
Criterion 8 now counts **CSS rules in `app.css`**, not class names anywhere. Four R classes are
required to survive as names, and a test asserts they do:

| Class | Why the name must survive |
|---|---|
| `.viewer` | The **K** rule `.app--impersonating .viewer` (`app.css:39`) still selects it. |
| `.viewer__img` | The **K** rule `.canvasframe .viewer__img` still selects it. |
| `.vpanel` | The **K** ≤720px bottom-sheet block still selects it. |
| `.viewer__panel-trigger` | A **live runtime selector** at `Lightbox.tsx:236`, not merely a test hook. |

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
| `.starpick`, `button`, `.on` | **R** | Rebuilt as **`aria-pressed` toggle buttons**, §5.4 — not a radio group (§0c). |
| `.labels`, `.labelpick`, `.is-on` | **R** | Rebuilt as **`aria-pressed` toggle buttons**, §5.5. `.labels`' own `flex gap-[var(--space-3)]` container classes are in §5.9b. |
| `.thread`, `.cmt`, `.cmt--highlighted`, `.cmt__*` | **R** | Fixes C-1, C-2. |
| `.annotation-note`, `:focus` | **R** | → `Textarea` (`ui/textarea.tsx`). |
| `.comment-reply` | **R** | → `buttonClasses("text")`, which carries `max-[721px]:min-h-[44px]`; fixes T-7. |
| `.strip`, `.strip.full`, `.strip__button`, `.strip__t` | **R** | **`.strip__button`'s `outline: 2px solid transparent` must be deleted, not overridden** (§3.1). Fixes T-5 (48×32 on phone) and C-8. |
| `.compare`, `__pair`, `__cell`, `__tag`, `__pickbtn` | **D — dead** | **Zero consumers anywhere.** Compare mode is `.viewer.viewer--compare` (`Lightbox.tsx:484`). Delete; nothing to convert. |
| `.compare__pair` phone override (`645`) | **D — dead** | Same. Missed by the first inventory (§0e). |
| `.compare-trigger` (`752`) | **D — dead** | Same. Missed by the first inventory. |
| `.viewer__compare-stage` (`756`) | **D — dead** | Same. Missed by the first inventory. |
| `.viewer__compare-close` (`757`) | **D — dead** | Same. Missed by the first inventory. |
| `.strip.full` (`494`) | **D — dead** | Zero consumers. The draft wrongly gave it a conversion spec. |
| `.viewer.no-panel` (`259`) | **D — dead** | Zero consumers. Same. |
| `.strip__button.is-active, .is-compare` (`750`) | **R** for `.is-active`, **D** for `.is-compare` | `.is-active` is live (`Lightbox.tsx:48`); `.is-compare` has zero consumers. Split the selector list, convert one, delete the other. Missed by the first inventory. |
| `.strip__button .strip__t` (`751`) | **R** | Live — `display: block` folds into §5.8's `.strip__t` classes. Missed by the first inventory. |
| `.viewer--compare`, `.viewer--compare .vpanel`, `.viewer--compare .strip` | **R** | **Live** — this is the real compare layout. Replacement in §5.9a. |
| `.viewer__panel-scrim` | **D** | Adopts `--scrim-overlay`, closing TB8-02-E-1. |
| `.barbtn`, `.barbtn--solid` | **R** | §9.3 **approved** 2026-09-04 — `.actionbar` takes the inverse scope and both retire. Slice 5. |
| `.actionbar`, `.actionbar .n/.lbl/.vline` | **R** | Same decision. `background: var(--ink-900)` / `color: var(--paper-050)` → `bg-background text-foreground` in scope; `.vline`'s `rgba(246,244,239,.2)` → `bg-border`. |
| `.icbtn--ondark` | **K** | **Not** retirable by this release: its five consumers (`PhotoGrid.tsx:170–174`) sit on the per-tile hover tools, over photographs, where no surface scope reaches. TB8-10. |
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
| `.viewer` root | `data-surface="inverse"` · `fixed inset-0 z-[80] bg-background grid grid-rows-[1fr_auto] grid-cols-[1fr_380px] max-[1081px]:grid-cols-[1fr]` — **`1081`, not `1080`; see §3.0** |
| — no panel | **`.viewer.no-panel` is dead** (§0e) — zero consumers. Delete the rule; add no conditional and no class. |
| — impersonating | `.app--impersonating .viewer { inset: 42px 0 0 }` is a **K** — it is the impersonation banner's offset, owned by that feature, and reaching into it from here would split its ownership |
| `.viewer__stage` | `row-start-1 row-end-2 relative grid place-items-center overflow-hidden min-w-0` |
| `.viewer__imgwrap` | `relative w-full h-full grid place-items-center overflow-hidden p-[28px] pb-[84px] max-[721px]:pt-[calc(28px+env(safe-area-inset-top))] max-[721px]:pb-[118px]` |

`bg-background` inside the inverse scope resolves to `--ink-900` — the same value the literal had,
now named.

### 5.2 Stage controls

**Five** stage buttons are `IconButton`, used **unmodified** — close, previous, next, zoom-in,
zoom-out (the draft said "four", which did not match the DOM; Sol B4). Reset zoom makes six if
present in the current build; the builder counts them from the file rather than from this
sentence, and reports the count. Its `focus-visible:!outline-[var(--focus-ring)]`
resolves to `--paper-050` inside the scope because §2.3 sets `--focus-ring` there — see §2.3a.
No primitive is edited by this release.

| Control | Classes | State |
|---|---|---|
| Close | `IconButton` + `absolute top-[16px] left-[16px] z-[5] max-[721px]:top-[calc(16px+env(safe-area-inset-top))] max-[721px]:left-[max(16px,env(safe-area-inset-left))]` | keeps `aria-label="Close"` |
| Prev / Next | `IconButton` + `absolute top-1/2 -translate-y-1/2 z-[3]` + `left-[18px]` / `right-[18px]`, `max-[721px]:left-[10px]` / `max-[721px]:right-[10px]` | keeps its `aria-label` |
| Zoom in / out | `IconButton` | keeps its `aria-label` |
| Reset zoom | `IconButton` | **was unspecified (Sol B4)** — same treatment; keep its existing name |
| Show / Hide markup | `buttonClasses("secondary")` | **was unspecified** — it is a text control, not a glyph, and it lives in the panel (`Lightbox.tsx:502`), so it is a `Button`, not an `IconButton`. `aria-pressed={markupVisible}` |
| Panel trigger | `buttonClasses("secondary", { className: "absolute top-[16px] right-[16px] z-[5] hidden max-[1081px]:inline-flex max-[721px]:!hidden" })` | `aria-expanded` + `aria-controls`, already present |

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

**Colour swatches** — six **toggle buttons** in a `role="group" aria-label="Pen colour"`
container (§0c: not a radio group). Each carries `aria-pressed={tool.color === color}` and a
**real accessible name**, `aria-label={PEN_COLOUR_NAMES[color]}`, from a new exported map —

```ts
export const PEN_COLOUR_NAMES = {
  "#e64b3c": "Red", "#f0a020": "Amber", "#3f8f5a": "Green",
  "#2f6df0": "Blue", "#ffffff": "White", "#0a0a0a": "Black",
} as const;
```

**Structure — one shape, stated once, because the draft contradicted itself here (Sol B4).**
The button is the hit target and carries **no colour of its own**; an inner `<span aria-hidden>`
carries the paint. The earlier draft said both "the colour as an inline `background`" on the
button *and* that only the inner span is painted. **Only the inner span is painted.**

```
<button type="button" aria-pressed={…} aria-label={PEN_COLOUR_NAMES[color]}
        class={ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px] rounded-full"}>
  <span aria-hidden="true" style={{ background: color }}
        class="w-[19px] h-[19px] rounded-full border border-[length:var(--border-width-hair)]
               border-solid border-border" />
</button>
```

The visible dot stays 19px — its *appearance* is unchanged — while the target becomes 28px
desktop / 44px at ≤720px. **Do not shrink the button to fit the dot**; that is the 19px target the
register flagged as the group's one real WCAG 2.5.8 failure (§0b).

Selected: `outline outline-[length:var(--border-width-bold)] outline-solid outline-[var(--ring)]
outline-offset-2` on the **button**, replacing the hand-rolled double `box-shadow`. It sits on
`--ink-800`, so paper-050 measures **17.35:1** (NB3 — the draft said 18.64, which is the value
against the stage, not the toolbar).

**Stroke widths** — three toggle buttons, `role="group" aria-label="Stroke width"`, each
`aria-pressed={tool.width === width}` and `aria-label={`${width} pixels`}`. Classes `ICON_BUTTON`;
selected `bg-secondary` (the `--ink-700` lift), replacing `rgba(246,244,239,.16)`. The inner dot
span keeps its inline `width`/`height` and gains `aria-hidden`.

**Undo / Clear / Cancel / Save** — `buttonClasses("secondary")`, and Save `buttonClasses("primary")`.
In the inverse scope `primary` is paper-on-ink, which is exactly what `.barbtn--solid` painted.
`disabled` states come from `BASE`'s `disabled:` utilities and must not be re-expressed.

### 5.4 Rating

Five **toggle buttons**, replacing five identically-named ones. Not a radio group: clicking the
set value clears it (`Lightbox.tsx:500`), which radio semantics cannot express (§0c).

```
<div role="group" aria-label="Rating" class="flex gap-[var(--space-1)]">
  <button type="button" aria-pressed={n === stars}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          class={n <= stars ? ON : OFF} …>
```

**Paint is cumulative, `aria-pressed` is not** (Sol R2-3). The existing rule paints every star up
to the rating (`className={number <= stars ? "on" : ""}`, `Lightbox.tsx:500`) — that is what makes
it read as a rating rather than five independent switches, and it must be preserved. But
`aria-pressed` is `n === stars`: only one button is "pressed", because only one sets the value.
**The two conditions are deliberately different; do not unify them.**

Button classes: `ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px] text-[length:var(--text-lg)]
leading-none"` — `--text-lg` is 22px, the size the rule already used, now on the scale. This fixes
**T-4 at every width**, which no override ever covered — to 28px desktop / 44px phone, the repo
contract, not to 44px everywhere (§0b).

Colour: **on** → `text-signal-caution-text` (**6.27:1**, up from the hardcoded `#9a6a1f`'s
4.44:1). This is the token file's own stated rule for caution *text*, and it kills K-2's literal.
**off** → `text-muted-foreground`. On the light panel that is `--text-muted` at 3.36:1 — see §9.1,
this is an owner decision, and the star is only the *indicator*; the accessible name and
`aria-pressed` now carry the state independent of colour, so §9.1 is a polish question rather than
a blocker.

### 5.5 Colour label

Four **toggle buttons** in a `role="group" aria-label="Colour label"` container — same reasoning
as §5.4, and the same handler shape (`Lightbox.tsx:501` clears on re-click). Each carries
`aria-pressed={asset.review?.colorLabel === label.value}` and `aria-label={label.name}` — a real
name, not the `title` fallback; keep `title` too for the pointer tooltip.

Structure is §5.3's exactly: an unpainted `ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px]
rounded-full"` button wrapping an `aria-hidden` painted span of `w-[26px] h-[26px] rounded-full
border border-[length:var(--border-width-hair)] border-solid border-border`. Selected ring as
§5.3, on the button. Fixes **T-3** to 28/44 (§0b).

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
| `.cmt__pin.unpinned` | **DELETE — dead.** Zero JSX consumers; the modifier has never rendered (Sol R2-3 flagged it alongside `.strip.full` and `.viewer.no-panel`, and this row previously gave it a conversion spec anyway). **C-2 is therefore withdrawn as a live defect** — a 2.87:1 contrast on a state nothing can reach is not a user-visible failure. Deleted, not converted, and **not given a newly-invented trigger**: slice 4's builder inferred one (`!annotation.strokeR2Key`, i.e. a note with no drawing), which is plausible product design but is a *product change*, not convergence. Reverted in review. If the studio wants an unpinned state it is a separate, owner-approved change. |
| `.cmt__who` | `[font:var(--type-label)]` |
| `.cmt__who span` | `META_TEXT ml-[var(--space-2)]` — **C-1 fixed**, 3.36:1 → 8.66:1, and 11.5px → 12px onto the scale |
| `.cmt__txt` | `text-[length:var(--text-sm)] leading-[var(--leading-normal)] mt-[3px] text-foreground-secondary` — 14.5px → 14px |
| `.annotation-note` | `<Textarea>` from `ui/textarea.tsx`, `className="mt-[var(--space-3)]"` — **keep its default `min-h-[96px]`**, do not restore the legacy 56px. 96px is the system's textarea contract and the panel scrolls, so there is no reason to invent a second height. The legacy `:focus` rule (a bare `border-color` swap with `outline: none`) dies with it; `FIELD_BOX` carries the real focus treatment. |
| `.comment-reply` | `buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" })` — **T-7**. The `min-w` and `px` are **required and must not be dropped**: the `text` variant sets `px-0` and supplies no `min-width` at all (`button.tsx:41`), so `buttonClasses("text")` alone cannot reach a 44px target. **This is TB8-08's §0 finding #1 and this draft re-shipped it** (Sol B6) — the second walk into the same trap, which is why it is spelled out here rather than left to the variant. |

Note the `.comment-reply` group is `Edit note · Edit drawing · Delete`, separated by literal `·`
text nodes. Those separators are `aria-hidden` decoration between three buttons; wrap them.

### 5.8 Filmstrip

| Element | Classes |
|---|---|
| `.strip` | `col-start-1 col-end-2 row-start-2 row-end-3 flex min-w-0 gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] overflow-x-auto bg-[var(--scrim-overlay)] border-t border-solid border-[length:var(--border-width-hair)] border-border` |
| `.strip.full` | **DELETE — dead** (§0e). Zero consumers; the draft specified a conversion for markup that never renders. |
| `.strip__button` | `flex-none w-[84px] h-[56px] p-0 border-0 bg-transparent leading-none cursor-pointer` + the `!`-prefixed focus utilities from **§3.1** (the draft said "§3.2", which does not exist — Sol R2-3) — **and no `outline: … transparent`, ever** |
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
| `.vpanel__collapse` | `IconButton` + `absolute top-[var(--space-4)] right-[var(--space-4)] min-h-[36px] min-w-[36px]` — the explicit 36px floor is **required**: a bare `IconButton` is 28px above the phone breakpoint, which would take this control from today's 36px **down** to 28px in the 721–1080 band, where it is the drawer's only dismiss affordance (Sol B6). `max-[721px]` still lifts it to 44px from the base. |

### 5.9a The three band layouts, and the compare grid

The draft retired these and specified no replacement (Sol B4). All three are load-bearing.

**Desktop (≥1081px)** — `.viewer` is a two-column grid, `grid-cols-[1fr_380px]`, `.vpanel` in
column 2. Already in §5.1.

**Tablet (721–1080px)** — `.viewer` collapses to `grid-cols-[1fr]` and `.vpanel` becomes a
right-hand **drawer**, which the draft dropped entirely. Replacement, on `.vpanel`:

```
max-[1081px]:fixed max-[1081px]:right-0 max-[1081px]:top-0 max-[1081px]:bottom-0
max-[1081px]:w-[min(420px,90vw)] max-[1081px]:z-[6]
max-[1081px]:shadow-[var(--shadow-lg)] max-[1081px]:translate-x-full
max-[1081px]:transition-transform max-[1081px]:duration-[var(--dur-slow)]
max-[1081px]:ease-[var(--ease-entrance)]
max-[1081px]:[&.open]:translate-x-0
```

**The `.open` class stays — `data-open` is withdrawn (Sol R2-1).** The retained blocks still use
`.vpanel.open` at `app.css:630` (tablet) *and* `:670` (phone), plus `.vpanel.open + .strip` at
`:686`; unlayered CSS beats a layered `data-[open]` utility, so introducing the attribute would
have left the sheet collapsed and the filmstrip stranded in **both** bands. The tablet drawer's
open state is therefore `.vpanel.open` too, written as the arbitrary variant
`[&.open]:translate-x-0`.
`.viewer__panel-scrim` (marked **D**) is replaced by a plain element rendered only when
`panelOpen && band !== "desktop"`:
`fixed inset-0 z-[5] bg-[var(--scrim-overlay)] backdrop-blur-[2px]` — closing TB8-02-E-1, which
deferred this scrim here by name.

**Phone (≤720px)** — the bottom sheet, **K** in full, below.

**Compare mode** is `.viewer.viewer--compare` (`Lightbox.tsx:484`), a modifier on the same root —
not a separate `.compare` element, which does not exist. Its grid replaces §5.1's on the root when
`compareActive`:

| | Classes |
|---|---|
| root when comparing | `grid-cols-[minmax(0,1fr)_minmax(0,1fr)_380px] max-[1081px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]` |
| `.vpanel` when comparing | `col-start-3` |
| `.strip` when comparing | `col-start-1 col-end-3` |

`.compare`, `.compare__pair`, `.compare__cell`, `.compare__tag` and `.compare__pickbtn` are
**deleted as dead CSS** (§0a) — zero consumers; nothing replaces them because nothing renders them.

### 5.9b Elements the draft named but did not specify

| Element | Classes |
|---|---|
| `.viewer__img` | `max-w-full max-h-full object-contain select-none` (the `.canvasframe .viewer__img` override stays **K**) |
| `.viewer__meta` | `absolute top-[16px] left-1/2 -translate-x-1/2 z-[4] text-center text-foreground max-[721px]:top-[calc(18px+env(safe-area-inset-top))] max-[721px]:max-w-[45vw]` |
| `.viewer__meta .a` | `[font:var(--type-h3)] [font-family:var(--font-display)] max-[721px]:hidden` |
| `.viewer__meta .b` | `<Eyebrow className="mt-[3px] text-on-inverse-muted max-[721px]:mt-0">` |
| `.viewer__shortcuts` | `absolute bottom-[18px] left-1/2 -translate-x-1/2 z-[4] flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-1)] rounded-[var(--radius-pill)] border border-solid border-[length:var(--border-width-hair)] border-border bg-[var(--scrim-overlay)] text-on-inverse-muted [font:var(--type-eyebrow)] tracking-[var(--tracking-wide)] whitespace-nowrap pointer-events-none max-[721px]:hidden` |
| — `.is-drawing` | `bottom-[70px]`. **Provisional by design, not a deferred decision** (Sol R2-3): R-2 is a `RUNTIME` item because the drawbar's wrap width cannot be known from source. Build it at `bottom-[70px]`; if the browser pass shows a collision, raise it to clear the **measured** wrapped height and record that measurement in the gate. The method is the decision, and it is closed. |
| — its `span` | `inline-flex items-center gap-[var(--space-1)]` |
| — its `i` | `not-italic text-on-inverse-muted` (was `rgba(246,244,239,.4)`, 3.55:1 on its pill — a decorative separator, so the token's 11.78:1 is a free improvement) |
| `.kbd` | `inline-grid place-items-center min-w-[17px] px-[var(--space-1)] rounded-[var(--radius-xs)] border border-solid border-[length:var(--border-width-hair)] border-border bg-secondary text-foreground [font:var(--type-mono)] text-[length:var(--text-2xs)]` — `border-border` fixes **C-6** (2.12:1 → 3.24:1); `--text-2xs` is 11px, replacing the off-scale 10px |
| "Save annotation" (`.dbtn` at `Lightbox.tsx:502`) | `buttonClasses("primary", { className: "w-full mt-[var(--space-2)]" })` — **was unspecified**; a submit action, not a toggle, so no `aria-pressed` |
| `.drawbar__grp` | `inline-flex items-center gap-[var(--space-2)] px-[var(--space-1)]` — **was unspecified** (Sol R2-3); deleting its rule without this loses the swatch/width group spacing |
| `.drawbar__lbl` | `<Eyebrow className="text-on-inverse-muted">` |
| `.labels` | `flex gap-[var(--space-3)]` — **was unspecified**; the colour-label row's container |
| `.cmt__b` | `flex-1 min-w-0` — **was unspecified**; without `flex: 1` the annotation body collapses beside its pin. `min-w-0` is added deliberately: the legacy rule lacked it, so a long unbroken token in a note could push the row wide. |

**`PANEL_SECTION` and `SECTION_LABEL`, mapped to real sites** (Sol R2-3: they were declared and
never used). `.vpanel__sec` has **seven** instances, each a `<section>` with an `.eylab` heading.
Every one takes `PANEL_SECTION` on the `<section>`; every `.eylab` becomes `<Eyebrow>` **except**
"Markup & annotations", which is a flex row holding a heading *and* a button, so it keeps its
element and takes `SECTION_LABEL`:

| # | Section | Heading |
|---|---|---|
| 1 | RAW ↔ Edited (`Lightbox.tsx:497`) | `<Eyebrow>` |
| 2 | Decision (`:498`) | `<Eyebrow>` |
| 3 | Recommendation (`:499`) | `<Eyebrow>` |
| 4 | Rating (`:500`) | `<Eyebrow>` |
| 5 | Label (`:501`) | `<Eyebrow>` |
| 6 | Markup & annotations (`:502`) | `SECTION_LABEL` on the existing `<div>`, keeping `flex justify-between items-center` |
| 7 | the thread block inside 6 | no heading |

**No element's tag is left to the builder's judgment.** The draft said to use `<Eyebrow>` "wherever
the element can be a `<span>`" (Sol B4); the table above states the tag at every site. `Eyebrow`
renders a `<span>` and is used exactly where this table says `<Eyebrow>`; everywhere else uses
`SECTION_LABEL` on the element the DOM already has.

The ≤720px bottom-sheet block (`.vpanel` fixed/translate/`max-height`, `__head::before`'s grab
handle, the seven `__peek*` rules) is a **K** in full, per §4 — eight interacting
`env(safe-area-inset-*)` declarations and a transform-driven sheet, the same class of geometry
TB8-07 kept for the same reason. Two edits only: `var(--signal-warm, #9a6a1f)` →
`var(--signal-caution-text)` (killing K-1's phantom token), and the two `#fff` →
`var(--primary-foreground)`.

---

## 6. Tests

**There is no accessible-name computation available in this repo** (Sol B10): no
`dom-accessibility-api`, no `@testing-library/dom`. `ProjectOverviewRail.dom.test.tsx:163–170`
already documents that absence and works around it by hand. **This release does not add a
dependency.** It follows that precedent, with the algorithm written out so two builders cannot
produce two different tests.

**The accessible-name helper**, in the new test file, covering only the sources this surface uses:

```ts
// Not a full accname implementation — the four sources these controls actually use, in spec
// order. Mirrors the manual approach documented in ProjectOverviewRail.dom.test.tsx:163.
function accessibleName(el: HTMLElement): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    return labelledby.split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ").trim();
  }
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  const text = [...el.childNodes]
    .filter((n) => !(n instanceof HTMLElement) || n.getAttribute("aria-hidden") !== "true")
    .map((n) => n.textContent ?? "").join("").trim();
  if (text) return text;
  return el.getAttribute("title")?.trim() ?? "";
}
```

New `components/Lightbox.a11y.dom.test.tsx`:

1. **Every** button inside the markup toolbar returns a non-empty `accessibleName` — assert over
   all of them, not a fixed count. The toolbar holds **11** buttons ordinarily and **13** in
   drawing-edit mode; **nine** is the formerly-unnamed subset (6 swatches + 3 widths), not the
   total (Sol R2-7). The A-1/A-2 regression lock.
2. The five rating buttons return five *distinct* names.
3. Each of the four toggle groups exposes exactly one `aria-pressed="true"` when a value is set,
   and none when the value is null. (`aria-pressed`, not `aria-checked` — §0c.)
4. Approve/Flag/Recommend carry `aria-pressed` matching the review state — asserted in **both**
   bands, since the register's finding was that the two bands disagreed.
5. The `.strip__button` lock. **The existing `Lightbox.dom.test.tsx` does not import `index.css`,
   so a computed-style assertion would read nothing** (Sol B10). Assert against the stylesheet
   source instead: `app.css` contains no `outline` declaration for `.strip__button`. That is what
   the defect actually was — a rule that should not exist — so testing for the rule's absence is
   both implementable and closer to the truth than a computed style.
6. `tokens/inverse.css`'s two blocks declare **the same property set** — parse the file, diff the
   two property lists, require empty. This is what stops §2.3's reset block from silently drifting
   out of sync with the inverse block (Sol B2's failure mode).
7. The four class names §4 requires to survive (`.viewer`, `.viewer__img`, `.vpanel`,
   `.viewer__panel-trigger`) are still present in `Lightbox.tsx` — the counterpart to criterion 8,
   so "retired" cannot be over-applied.

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
3. The rating group reports five distinct names and exactly one `aria-pressed="true"`.
4. **Touch targets, against the repo's contract, not a flat 44 (§0b).** At **≤720px**:
   `.swatch`, `.wbtn`, `.labelpick`, `.starpick button`, `.strip__button`, `.comment-reply` and
   `.vpanel__collapse` each measure **≥ 44 × 44**. At **721–1080px**: each measures **≥ 28 × 28**,
   and `.vpanel__collapse` **≥ 36 × 36** (it must not regress from today's 36).
   **At exactly 721px the desktop sizes apply**, because `max-[721px]` is `width < 721` — that is
   correct, not a miss, and the gate records the 28px reading there rather than flagging it.
   The 721–1080 band is measured explicitly, never inferred from 1440.
5. Contrast, measured, no regressions from the register's §3.3 pass list, and:
   `.cmt__who span` ≥ 8:1 (was 3.36) · `.cmt__pin.unpinned` — **criterion withdrawn**, the state is dead and deleted (see §5.7) ·
   `.starpick.on` ≥ 6:1 (was 4.44) · toolbar and `.kbd` borders ≥ 3:1 (were 1.93 / 2.12) ·
   `.vpanel`'s left seam ≥ 3:1 **against the stage** (was 1.01).
6. Zero horizontal overflow at all five widths, and zero elements overflowing their own box.
7. The drawbar does not collide with `.viewer__shortcuts` at any width, wrapped or not (R-1/R-2).
7a. **At exactly 1080px the JS band and the CSS layout agree** — `viewerBand()` returns `tablet`
   and the panel renders as a drawer, not a desktop column. This is the §3.0 off-by-one; it is a
   one-pixel check that would never surface at 1024 or 1440.
8. **Retirement, counted as CSS rules — not class names (§4, Sol B8).** `app.css` contains **0**
   rules for every selector marked **R** or **D**. Class *names* may survive as hooks; the four
   in §4's table **must** survive, and test 7 asserts it. Every **K** rule carries a comment
   saying why. The final slice reports retired-vs-kept counts.
9. Full suite green: `npm run typecheck` (6/6), `npm run build -w @quincy/web`,
   `npm run test --workspaces`, and `packages/shared`'s standalone vitest config.
10. Zero console errors and zero failed requests throughout.

---

## 8. Slices

**Restructured after Sol B9, which was the most structural finding.** The draft put the whole §4
retirement ledger in slice 5, which does not work: `app.css` is unlayered, so it beats every
utility an earlier slice adds. Slice 3's 28px swatch would have stayed 19px, slice 4's rating
would have kept losing to `.starpick button`, and slice 2's phone close/nav would have stayed
48px — three slices shipping visibly half-wired while typecheck and build stayed green, which is
exactly the failure §8 claimed to prevent.

**Rule: a slice deletes the `app.css` rules for the elements it converts, in the same commit.**
Retirement is not a phase; it is part of each conversion. A slice is done when its elements have
*one* styling owner, never two.

Bottom-up, so nothing is ever half-wired. Each ends green on typecheck and build; only the last
slice must satisfy §7 in full.

| # | Scope | Reads in full |
|---|---|---|
| **1** | The role-layer indirection (§2.2) and `tokens/inverse.css` (§2.3, §2.3a). Touches no component. **Visually inert by construction** — every value is identical at `:root`, and nothing yet carries `data-surface`. Prove it: build before and after, diff the emitted CSS, and state what changed. | §2, §3 |
| **2** | Stage: root, `__stage`, `__imgwrap`, the five `IconButton` controls + Reset, `__meta` (+`.a`/`.b`), `__shortcuts` (+`span`/`i`), `.kbd`, `__panel-trigger`, `__panel-scrim`. **Deletes `255–275`, plus its responsive rules `626–628` and `660–668`.** **Also puts `data-surface="default"` on `.vpanel`** — see the rule below. | §2, §3, §5.1, §5.2, §5.9b |
| **3** | Markup toolbar — the nine unnamed buttons, both toggle groups, `PEN_COLOUR_NAMES`, `.drawbar__grp`/`__lbl`, the four text buttons. **Deletes `290–298` plus its responsive rule `689–690`.** The highest-value slice; do not merge it with another. | §2, §3, §5.3, §0c |
| **4** | Side panel: decision, rating, label, thread, `.cmt__b`, textarea, "Save annotation", the seven section heads, `review-labels.ts`, and the two peek-bar edits. **Deletes `454–476` and `477–491`**, keeping the ≤720 sheet block (`669–688`). | §2, §3, §5.4–§5.7, §5.9b, §0b, §0c |
| **5** | Filmstrip, the three band layouts, and **the whole dead compare implementation**: `.strip*`, the tablet drawer, the live `.viewer--compare` grid. **Deletes `492–507`, `645`, `749–757`**, and rewrites the tablet band block `629–631`. **Plus §9.3 (approved): `.actionbar` takes the inverse scope, `.barbtn`/`.barbtn--solid`/`.actionbar` retire (`245–253`), and `PhotoGrid.tsx`'s action bar plus its nine `PhotoGrid.dom.test.tsx` queries migrate.** | §2, §3, §3.0, §5.8, §5.9, §5.9a, §0e, §9.3 |
| **6** | The §4 ledger reconciliation (counts + the four surviving names), all tests, the register correction, and the docs. **Adds no new styling.** | all |

**Ranges corrected after Sol R2-2**, which found `749–751` outside every claimed range — and
chasing that found six more selectors missing from the inventory entirely (§0e). The draft also
left each slice's *responsive* rules to slice 5, which is the same two-owner bug B9 was about at a
smaller scale: a slice that converts `.viewer__close` but leaves `660–668` alive has not finished.
**Each slice owns its element's rules in every band it appears in.** Slice 4 is the one exception,
and it is deliberate: the ≤720 sheet block is **K**, so slice 4 leaves it standing on purpose.

Slice 1 is the one to get exactly right — every later slice assumes the inverse scope resolves.
If slice 1's before/after CSS diff shows any changed *value* outside the new `[data-surface]`
blocks, stop and report rather than continuing.

**`data-surface="default"` lands in the same slice that activates the inverse scope — slice 2, not
slice 4.** The draft assigned the two attributes to different slices, which is the B9 failure in
miniature and was caught during slice 2's verification rather than by either review round: the
moment `.viewer` becomes `data-surface="inverse"`, **every descendant** inherits the dark roles,
and `.vpanel` is a descendant. Between slice 2 and slice 4 the side panel's controls would have
rendered `text-foreground` = `--paper-050` on a `--paper-050` panel — invisible, and the panel's
own zoom `IconButton`s are converted in slice 2, so the breakage would have been immediate and
visible. **General rule: an inverse scope and the `default` scopes nested inside it are one
atomic change. Never split them across slices.**

**Each of slices 2–5 must end with its own two-owner check**: for every selector it deleted,
`grep` `app.css` and confirm zero rules remain, and confirm the element renders with the intended
utility rather than a surviving legacy value. A slice that adds utilities without deleting its
rules has not finished, however green the build is.

---

## 9. Owner decisions — **1 and 3 answered 2026-09-04; 2, 4 and 5 recorded**

1. **`.starpick` off-state at 3.36:1 — ANSWERED 2026-09-04: treat the `★` as text.**
   Owner's decision, taking the stricter of the two readings. Binding consequences, which override
   the values written elsewhere in this plan:

   | Site | Was | **Now** | Measured |
   |---|---|---|---|
   | `.starpick button.on` | `#9a6a1f` literal | `text-signal-caution-text` | 4.44 → **6.27:1** |
   | `.starpick button` (off) | `--text-muted` | **`text-foreground-secondary`** | 3.36 → **8.66:1** |
   | `.vpanel__peek-rating` | `var(--signal-warm, #9a6a1f)` | `text-signal-caution-text` | 4.71 → **6.27:1** on `--paper-000` |

   Every rating site now clears 4.5:1 with no judgment call left in the code, and item 5 below is
   settled by the same decision. §5.4's "off → `text-muted-foreground`" is **superseded**; use
   `text-foreground-secondary`.
2. **The six pen colours stay literals** (§1.5). Recorded as a decision, not an accident.
3. **§1.4's scope extension to `.actionbar` — ANSWERED 2026-09-04: APPROVED.**
   `.actionbar` carries `data-surface="inverse"` and **`.barbtn` / `.barbtn--solid` retire
   completely**. This release therefore also owns:
   - replacement classes for every action-bar button — `buttonClasses("secondary")`, and
     `buttonClasses("primary")` where `.barbtn--solid` was, exactly as §5.3's four text buttons;
   - the **nine `.actionbar .barbtn` queries in `PhotoGrid.dom.test.tsx`** — migrated, not deleted;
   - `.actionbar`'s own rule (`app.css:245–248`), whose `background: var(--ink-900)` and
     `color: var(--paper-050)` become `bg-background text-foreground` inside the scope, and whose
     `.vline` literal `rgba(246,244,239,.2)` becomes `bg-border`.

   This is **slice 5's** work (it already owns the band/layout tier); §8's slice 5 row is extended
   accordingly. **`.icbtn--ondark` still stays K** — its five consumers sit on photographs, not on
   the action bar, and no scope reaches them.
4. **Close/nav shrink from 48px to 44px on phone** (§5.2) — convergence onto the repo's stated
   contract, and a deliberate reduction. Flagged because it is one of two places this plan makes a
   target smaller; the other, `.vpanel__collapse` at 36→28, is **rejected** and floored at 36
   (§0b).
5. **`--signal-warm` becomes `--signal-caution-text` — SETTLED by decision 1.** The register had
   proposed `--signal-caution`, and `colors.css:40–46`'s icon exemption would have allowed it. The
   owner's "treat the glyph as text" ruling covers this site too, so the divergence from the
   evidence base is now a decision rather than an unexplained change. The register is annotated to
   match.


---

## 10. Build record

Six slices, each retiring its own `app.css` rules in the same commit. Every slice independently
re-verified in the orchestrating session rather than accepted on the builder's report — which
found three real problems the builders' own self-checks did not.

| Slice | Commit | What |
|---|---|---|
| 1 | `3a3f387` | The role indirection and `tokens/inverse.css`. Visually inert, proven by a before/after CSS diff. |
| 2 | `90bb4e1` | The stage, and `data-surface` on both `.viewer` and `.vpanel`. |
| 3 | `0d3453a` | The markup toolbar — the nine unnamed buttons. |
| 4 | `4d3ad17` | The side panel. |
| 5 | `b16c152` | Filmstrip, band layouts, the dead compare implementation, the action bar. |
| 6 | this commit | The ledger reconciliation, `Lightbox.a11y.dom.test.tsx`, docs. |

### What review caught that the builders did not

1. **Slice 2 — a plan defect, not a build defect.** The plan put `data-surface="inverse"` in
   slice 2 and `data-surface="default"` in slice 4. But `.vpanel` is a *descendant* of `.viewer`,
   so the moment the inverse scope activated, every role inherited into the light panel — and the
   panel's own zoom controls were converted in slice 2, so they would have rendered
   `--paper-050` text on a `--paper-050` panel. Invisible, immediately, for two slices. The
   builder noticed the leak and classified it as an expected intermediate state; it was not.
   **Rule added to §8: an inverse scope and the `default` scopes nested inside it are one atomic
   change.**
2. **Slice 4 — an invented product state.** The builder wired `.cmt__pin`'s dormant `.unpinned`
   modifier to "annotation has no drawing". Plausible design, but the modifier has never
   rendered: that is a *product change*, not convergence. Reverted; the modifier is deleted as
   dead, which also withdraws C-2 (a contrast failure on an unreachable state is not a defect).
3. **Slice 6 — the session's own verification was unsound.** `npm run typecheck 2>&1 | grep -c
   "error TS"` reports **0 even when `tsc` fails**: the output carries ANSI colour codes between
   `error` and `TS`, and the pipe discards the exit code. Caught when `build` failed on a file
   `typecheck` had just "passed". Earlier slices are unaffected — their `✓ built in` line only
   prints when `tsc` succeeds, so the flawed check was redundant rather than load-bearing — but
   **check the exit code, never grep the output.**

### Deviations accepted

- **`.vpanel__collapse` is a raw `<button>` carrying `ICON_BUTTON`'s classes**, not `IconButton`.
  That component is not `forwardRef`-wrapped and the collapse ref must keep working. It carries
  the explicit 36px floor either way.
- **The tablet drawer was built in slice 4 rather than slice 5**, because slice 4 deleted its
  rules — leaving it would have been exactly the half-wired state the slicing exists to prevent.
- **`.cmt__role` was deleted as dead** — zero consumers, inside a block slice 4 was retiring
  anyway. Not in the §4 ledger because the register never found it.

### Still to do

The browser pass and the visual gate (§7's ten criteria), then deploy. Six `RUNTIME` items in the
drift register (§7 there) are asserted from source and still need confirming in a real browser.


---

## 11. Visual gate — PASSED

Run by this session (never delegated), against local dev at `1440×900`, `1024×768`, `900`, `721`,
`720` and `390`, in the human-authenticated Chrome on CDP 9333. **No OAuth was performed by this
session** — the session was already signed in as Admin from the human's earlier work, which is the
sanctioned path. Local D1 had zero `asset_renditions` rows, so no asset was ever reviewable; four
fixture rows were inserted to make two RAW assets `ready`, and **deleted afterwards** (verified).

### The headline fix, measured

`--focus-ring` was `--ink-900` on a `--ink-900` stage — **1.00:1**. Now, forcing `:focus-visible`
per element via CDP and reading the computed ring:

| Control | Ring | Ground | Contrast |
|---|---|---|---|
| Close, Prev/Next | `rgb(250,248,242)` 2px @ offset 2 | `rgb(10,10,10)` | **18.64:1** |
| Pen swatch, stroke width | `rgb(250,248,242)` 2px @ offset 2 | `rgb(20,20,20)` | **17.35:1** |
| Filmstrip thumbnail | `rgb(250,248,242)` 2px @ offset 2 | 50% ink | **~18.6:1** |
| Rating, colour label (panel) | `rgb(10,10,10)` 2px @ offset 2 | `rgb(250,248,242)` | **18.64:1** |

The filmstrip was additionally confirmed with **real keyboard Tab** over CDP (`:focus-visible`
matched `true`), not just a forced pseudo-state — it was the one control with two independent
causes. Scope resolution verified directly: `--ring`/`--focus-ring` are `#faf8f2` on `.viewer`,
`#0a0a0a` on `.vpanel`, and `#0a0a0a` at `:root` — unchanged for the rest of the app.

### Touch targets, at every band edge

| | 1440 | 1024 | 721 | 720 | 390 |
|---|---|---|---|---|---|
| swatch / wbtn / star / label | 28×28 | 28×28 | 28×28 | **44×44** | **44×44** |
| filmstrip button | 84×56 | 84×56 | 84×56 | **60×44** | **60×44** |
| `.vpanel__collapse` | — | **36×36** | — | — | **44×44** |

The 721→720 flip lands exactly on the boundary, confirming `max-[721px]`. `.vpanel__collapse`
holds **36px** in the tablet band — the regression §0b blocked is verified absent.

### The 1080px off-by-one (criterion 7a)

| Width | `viewerBand()` | `.vpanel` position | Agree |
|---|---|---|---|
| 1081 | desktop | `static` | ✓ |
| **1080** | **tablet** | **`fixed`** | **✓** |
| 1024 | tablet | `fixed` | ✓ |

Sol's B5 fix verified at the exact pixel. With `max-[1080px]` the CSS would have said desktop
while the JS said tablet.

### Contrast (no regressions, and the owner's ruling applied)

meta filename 18.64:1 · meta eyebrow 11.78:1 · `.kbd` 14.8:1 · drawbar label 10.96:1 · panel
address 18.64:1 · section label 8.66:1 · **star unselected 8.66:1 (was 3.36)**.

### Three defects the gate found — and nothing else did

**1. The rating stars silently shrank, 22px → 18px.** `RATING_BUTTON` asked for
`text-[length:var(--text-lg)]`, but `ICON_BUTTON_BASE` already carries
`[font:…var(--text-md)…]`, and two utilities touching `font-size` are resolved by Tailwind's
*emission order*, not class order. **`button.tsx` documents this exact trap in its own comment**
and I walked into it anyway. Fixed by overriding the whole shorthand, the precedent that file
already sets. Re-measured live: 22px.

**2. The markup toolbar wrapped to two rows and covered the shortcut hints.** Root cause is a
CSS-layout subtlety, not a spacing miss: an absolutely-positioned shrink-to-fit box at
`left: 50%` can never be wider than *half* its containing block, so the toolbar was capped at
530px inside a 1060px stage and wrapped at 106px tall. This release's larger touch targets are
what pushed it over — the constraint is pre-existing (the legacy CSS centred the same way), the
overflow is new. Fixed by centring with `inset-x-0 mx-auto w-max` instead. Now **56px, one row,
at every width ≥721**, and the same fix applied to the shortcut pill.

**3. The shortcut pill sat behind the toolbar whenever markup was available.** Both were anchored
at `bottom: 18px`; `.is-drawing` only lifted the pill while a draft existed. Pre-existing —
verified against `7c9544f` — but in scope. The pill now clears the measured toolbar height
whenever the toolbar is present: **8px gap, zero overlap, at every width ≥721**.

R-1 was initially mis-called: my first reading counted three "rows" that were really one
centre-aligned row. Re-measured properly before acting.

### Deferred, with measurement

**The toolbar covers the filmstrip on phone.** At 390px the toolbar wraps to 136px at
`bottom: 18px`, spanning 746–882, while the fixed filmstrip sits at 766–828. Pre-existing: the
legacy phone rules also set 44px targets and pinned the filmstrip at `72px`. Fixing it means
deciding where the annotation toolbar lives on a phone when the filmstrip is fixed above it —
a product-shaped decision, not a convergence one, and not something to invent at the end of a
release. **To TB8-10 with this measurement.**

### The rest

Zero horizontal overflow and zero elements overflowing their own box at all six widths. Eleven
toolbar buttons, **none unnamed**. Typecheck and build green by exit code; 1,763 tests passing.

### A method correction worth keeping

`npm run typecheck 2>&1 | grep -c "error TS"` reports **0 even when `tsc` fails** — ANSI colour
codes sit between `error` and `TS`, and the pipe discards the exit code. Check the exit code.
