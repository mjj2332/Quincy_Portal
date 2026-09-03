# TB8-09 — Review Lightbox: drift register

**Surface:** the review Lightbox and everything reachable from inside it — the stage, the image
and its zoom frame, the markup layer and its toolbar, the filmstrip, compare mode, and the review
side panel (decision, rating, label, annotation thread).

**Owner of record today:** `portal/apps/web/src/components/Lightbox.tsx` (506 lines) for markup,
`portal/apps/web/src/styles/app.css` lines **255–507** plus the responsive overrides at **622–690**
and the compare grid at **753–755** for paint. One component, one CSS block — the surface can
retire its legacy owner cleanly, which is why it ranks as a candidate at all.

**Status:** static pass complete (2026-09-04), **corrected 2026-09-04** after Sol round 1 on
the plan — see §4's header and C-2. The corrections are to this register's *verdicts and one
arithmetic ground*, not to its measurements, which held. Every number below is derived from the checked-in
source and is reproducible without a browser — CSS values read directly, contrast computed by
compositing each stated `rgba()` over its real ancestor stack and applying the WCAG 2.x relative-
luminance formula. **Items marked `RUNTIME` are asserted from source and still need confirming in
a real browser**; they are layout/overflow claims, which source cannot settle. The runtime pass
runs at `1440×900`, `1024×768`, `390×844` (TB1's matched viewports) plus `721px` and `1080px`,
the two band edges this surface actually switches on.

## 0. Why this candidate warrants a release

The roadmap gates candidate #9 on "only if evidence warrants". It does, on four independent
grounds — and the one thing that previously blocked it is gone:

1. **Size and containment.** ~250 lines of `app.css`, the largest remaining legacy block, with
   exactly one consumer. Grep for the surface's classes across `*.tsx` returns `Lightbox.tsx`
   and its two test files, nothing else.
2. **Debt already pointed here.** TB8-02-E-1 deferred `.viewer__panel-scrim` "to the Lightbox
   candidate" and left `--scrim-overlay` in place for it to adopt. That token is still unadopted,
   and this surface has since accumulated **three more** scrim literals at three different alphas.
3. **Severity.** 11 unnamed or ambiguously-named controls, 5 toggle groups conveying state by
   colour alone, 6 measured contrast failures, and 9 sub-44px touch targets in a band that has no
   override — see §2–§4. Two of these are the same bug families TB8-06 and TB8-07 each shipped a
   fix for in a different file.
4. **A fourth phantom token.** `--signal-warm` is used and defined nowhere (§5.1). TB8-07 found
   `--signal-warning` in the same state and added a regression test naming only that one.

**The blocker is resolved.** TB0-VIS-02 recorded lightbox evidence as N/A — "four synthetic JPEG
uploads reached the unchanged UI but failed with `Uploaded object was not found in R2`". That was
the storage-plane split since diagnosed and fixed (`docs/lessons.md`: local `.dev.vars` must set
`APP_ENV=dev` and the upload route must take its dev direct-PUT path), and
`workers/app/src/routes/media.ts:124` gives local dev a direct-original fallback for both `/web`
and `/thumb` when no rendition cache exists. A populated local lightbox is capturable now.

## 1. Inventory

| Block | `app.css` lines | What it paints |
|---|---|---|
| Image viewer | 255–275 | `.viewer`, `.viewer__stage/__img/__imgwrap/__nav/__close/__panel-trigger/__meta/__shortcuts`, `.kbd` |
| Drawing markup layer | 277–288 | `.canvasframe*`, `.markup-svg`, `.pin` |
| Markup toolbar | 290–298 | `.drawbar`, `.drawbar__lbl/__grp`, `.swatch`, `.wbtn` |
| Viewer side panel | 454–476 | `.vpanel*`, `.decide`, `.dbtn`, `.starpick`, `.labels`, `.labelpick` |
| Comments thread | 477–491 | `.thread`, `.cmt*`, `.annotation-note`, `.comment-reply` |
| Filmstrip | 492–499 | `.strip`, `.strip.full`, `.strip__button`, `.strip__t` |
| Compare mode | 500–507 | `.compare`, `.compare__pair/__cell/__tag/__pickbtn` |
| Responsive overrides | 622–631 (≤1080), 659–690 (≤720) | band behaviour for all of the above |
| Compare grid | 753–755 | `.viewer--compare` |

The ≤720px block is **not** neglected — it already raises `.swatch`/`.wbtn` to 44px, handles
`env(safe-area-inset-*)` on four properties, and converts the panel to a bottom sheet with a peek
bar. The defects below concentrate in the bands that block does *not* cover.

## 2. Accessible name and state — the most severe group

`Lightbox.tsx:481` and `:500–501`. All confirmed by reading the JSX; none is a judgement call.

| # | Control | Count | Defect |
|---|---|---|---|
| **A-1** | `.swatch` (markup pen colour) | **6** | `<button className="swatch" style={{background: color}} />` — self-closing, no children, no `aria-label`, no `title`. **Six buttons with no accessible name at all.** WCAG 4.1.2. |
| **A-2** | `.wbtn` (stroke width) | **3** | `<button …><span style={{width, height}} /></button>` — the only child is an empty presentational span. **Three buttons with no accessible name.** WCAG 4.1.2. |
| **A-3** | `.starpick button` (rating) | **5** | Every one is `<button>★</button>`. All five compute the **same** accessible name, "★" — nothing distinguishes 1 star from 5 to a screen reader or to voice control. |
| **A-4** | `.labelpick` (colour label) | **4** | Self-closing, named only by `title`. `title` is the accname spec's last-resort fallback and is unreachable by touch; the visible control carries no text. |
| **A-5** | `.swatch`, `.wbtn`, `.starpick button`, `.labelpick`, and the desktop/tablet `.dbtn` decision pair | **5 groups** | **No `aria-pressed`.** Selected state is carried by `.on`/`.is-on` → colour, ring or background only. WCAG 1.4.1 and 4.1.2. |
| **A-6** | `.cmt__pin` | per annotation | Renders the literal `✎` as text, so AT announces a decorative pencil as content. |

A-1 and A-2 together are **nine unnamed buttons in one toolbar**. A voice-control user cannot
address any of them; a screen-reader user hears nine anonymous buttons.

**The phone path is not the broken one — the desktop path is.** `Lightbox.tsx` carries exactly
two `aria-pressed` attributes and both are on `.vpanel__peek-action` (`:491`), the phone peek
bar's Approve and Flag. Their desktop/tablet equivalents, the `.dbtn` decision pair at `:498`,
carry none. The same asymmetry runs through naming: the peek bar's rating has
`aria-label={`Rating ${stars}…`}` while the desktop `.starpick` is five bare `★` buttons. Whoever
built the phone band applied the rule and it was never carried back up. **Any fix must be checked
in both bands, and the phone band is the reference implementation, not the thing to change.**

For the record, the controls that *are* correctly named today — so a repaint does not lose them —
are Close, Previous/Next frame, Zoom in/out, Collapse review panel, the filmstrip thumbnail
(including its distinct retry name), the edit-note textarea, the dialog itself, and the two peek
actions plus the peek rating. The desktop `.dbtn` buttons are named by their own text content
("✓ Approve", "⚑ Flag", "Recommend to QA", "Compare with RAW"), which is fine.

## 3. Contrast — measured

Computed by compositing each declared `rgba()` over its real ancestor stack. Stage ground is
`--ink-900 #0a0a0a`; panel ground is `--paper-050 #faf8f2`; peek-bar ground is `--paper-000`.

### 3.1 Failures

| # | Site | Declared | Measured | Bar | Verdict |
|---|---|---|---|---|---|
| **C-1** | `.cmt__who span` (annotation author's role, 11.5px) | `--text-muted` on `--paper-050` | **3.36:1** | 4.5:1 | **Fails.** Unambiguous small text. |
| **C-2** | `.cmt__pin.unpinned` | `--text-muted` on `--paper-200` | **2.87:1** | 4.5:1 / 3:1 | **Fails both bars.** (Fix measures **7.40:1**, not the 8.66:1 first written into the plan — 8.66 is this text colour against `--paper-050`, the wrong ground. Corrected 2026-09-04 after Sol B6.) |
| **C-3** | `.starpick button.on` | `#9a6a1f` on `--paper-050` | **4.44:1** | 4.5:1 | **Fails**, and by the token file's own rule: caution *text* must use `--signal-caution-text`, which measures **6.27:1** here. |
| **C-4** | `.wbtn` border (the control's own boundary) | `rgba(246,244,239,.22)` on `--ink-800` | **1.93:1** | 3:1 | **Fails 1.4.11** — this border is the only thing that identifies an unselected tool button. |
| **C-5** | `.viewer__panel-trigger` border | `rgba(246,244,239,.28)` over 45% ink | **2.33:1** | 3:1 | **Fails 1.4.11.** |
| **C-6** | `.kbd` border | `rgba(246,244,239,.24)` over its pill | **2.12:1** | 3:1 | Fails 3:1; the `.kbd` *text* is fine at 15.89:1, so this is boundary-only. |

### 3.2 Effectively invisible, though not strictly a failure

| # | Site | Declared | Measured | Note |
|---|---|---|---|---|
| **C-7** | `.vpanel` `border-left` | `rgba(246,244,239,.14)` over `--paper-050` | **1.01:1** | A 14%-opacity *paper* line on a *paper* panel. It is invisible, and it is on the wrong side of the seam — the contrast the seam needs is against the dark stage. Almost certainly intended to read against `--ink-900`. |
| **C-8** | `.strip` `border-top` | `rgba(246,244,239,.1)` over the strip's own 60%-ink ground | **1.23:1** | Decorative divider; no bar applies, but it does nothing. |
| **C-9** | `.drawbar` border | `rgba(246,244,239,.18)` over `--ink-800` | **1.67:1** | Container boundary, not a control; below any bar it would be held to. |

### 3.3 Passing — recorded so a repaint does not regress them

`.viewer__meta .a` 18.64:1 · `.viewer__meta .b` 11.78:1 · `.viewer__shortcuts` text 11.78:1 ·
`.kbd` text 15.89:1 · `.viewer__panel-trigger` label 18.17:1 · `.drawbar` text 17.35:1 ·
`.drawbar__lbl` 10.96:1 · `.cmt__txt` 8.66:1 · `.vpanel__sec .eylab` 8.66:1 ·
`.dbtn.on-approve.is-on` 7.58:1 · `.dbtn.on-flag.is-on` 10.0:1 · `.vpanel__peek-rating` 4.71:1 ·
`.swatch` border 3.21:1.

**Note on `.starpick button` (off state):** `--text-muted` on `--paper-050` measures **3.36:1**.
Whether that fails depends on whether a `★` glyph is text (4.5:1) or a non-text graphical object
(3:1) — it is a rating indicator drawn with a text character. The token file already draws this
distinction explicitly for icons. **Owner decision required**; recorded, not assumed.

## 4. Touch targets

**Corrected 2026-09-04 (Sol B6). This section originally treated 44px as the bar at every width.
That is not this repo's contract and the claim was overstated.** The contract is `ICON_BUTTON`'s —
**28px desktop, 44px at ≤720px** (`icon-button.tsx:19`), applied by every converged surface since
TB8-06. Against WCAG, 44px is 2.5.5 (**AAA**); the AA bar is 2.5.8's **24px**. The table below
keeps the original measurements, which were right, and states the verdict honestly.

Only two of the seven are true failures: **`.swatch` at 19px** (below even the 24px AA bar, at
every width) and **`.strip__button` at 48×32 on phone** (below the repo's own 44px phone
contract — and introduced by the phone override itself). The rest pass AA today and are raised to
28/44 because convergence onto `ICON_BUTTON` gives that for free, not because they were failing.

The ≤720px block raises `.swatch` and `.wbtn` to 44px. Nothing raises anything in the
**721–1080px band** — still worth noting, since that band is where `.vpanel__collapse` is the
drawer's only dismiss control, and any conversion must not shrink it below today's 36px.

| # | Control | ≥721px | ≤720px | Note |
|---|---|---|---|---|
| # | Control | ≥721px | ≤720px | Verdict |
|---|---|---|---|---|
| **T-1** | `.swatch` | **19 × 19** | 44 × 44 ✓ | **Real failure — WCAG 2.5.8 (24px AA), at every width.** The group's only one. `box-sizing: border-box` is global, so 19px is the whole target. |
| **T-2** | `.wbtn` | 28 × 28 | 44 × 44 ✓ | Passes AA; meets the repo contract already. |
| **T-3** | `.labelpick` | 26 × 26 | 26 × 26 | Passes AA. Below the repo's 44px phone contract. |
| **T-4** | `.starpick button` | ≈26 × 26 | ≈26 × 26 | Passes AA. Below the repo's 44px phone contract. 22px glyph + 2px padding. |
| **T-5** | `.strip__button` | 84 × 56 ✓ | **48 × 32** | **Real failure** — the phone override introduces it: height drops from a passing 56px to 32px. |
| **T-6** | `.vpanel__collapse` | 36 × 36 | 44 × 44 ✓ | Passes AA. **Must not be reduced** — a bare `IconButton` would take it to 28px in the band where it is the drawer's only dismiss control. |
| **T-7** | `.comment-reply` | inline text | inline text | Below the phone contract. Bare underlined inline text, no min box — same shape as TB8-08's `Edit`/`Delete` finding (20.5 × 24 there), and `buttonClasses("text")` alone **cannot** fix it: `px-0`, no `min-width`. |

T-3, T-4 and T-7 sit below the repo's phone contract at **every** width, phone included.

## 5. Tokens and one-owner violations

| # | Finding |
|---|---|
| **K-1** | **`--signal-warm` is defined nowhere.** Used once, `app.css:681` (`.vpanel__peek-rating`). It survives only because it carries a `, #9a6a1f` fallback — the right colour by luck, not design. This is the same family as TB8-07's `--signal-warning`, which had no fallback and rendered as inherited ink for its whole life. TB8-07's regression test asserts only that `--signal-warning` is absent; nothing guards this one. Correct fix: `--signal-caution`, and delete the phantom name. |
| **K-2** | **`#9a6a1f` hardcoded** at `app.css:471` (`.starpick button.on`) — a literal duplicate of `--signal-caution`, which is also why C-3 slipped the `--signal-caution-text` rule. |
| **K-3** | **A label palette duplicated across two files.** `Lightbox.tsx:12` and `PhotoGrid.tsx:12` each declare `{hero #9a6a1f, select #3f5b3a, maybe #2f3b4d, cut #7a2420}` — four brand signal values, copy-pasted verbatim, outside the token system. One styling owner is a roadmap rule. |
| **K-4** | **A second undeclared palette:** the six markup pen colours `#e64b3c #f0a020 #3f8f5a #2f6df0 #ffffff #0a0a0a` are inline in `Lightbox.tsx:481`. These are pen ink, not chrome, so they may legitimately stay literals — but that should be a written decision, not an accident. |
| **K-5** | **`#fff` hardcoded** in `.dbtn.on-approve.is-on` / `.on-flag.is-on` (and again in both `.vpanel__peek-action` equivalents). `--paper-050` is the brand's on-inverse text and measures 7.14:1 vs `#fff`'s 7.58:1 on olive — both pass, so this is a token-hygiene item, not a contrast one. |
| **K-6** | **`--panel` is defined nowhere.** Used twice (`app.css:258`, `:753`) as `var(--panel, 380px)`. Same class as K-1: a fallback masking a name that resolves to nothing. |
| **K-7** | **Four scrim literals at three alphas** on this surface: `rgba(10,10,10,.52)` (`.viewer__panel-scrim`, the one TB8-02-E-1 deferred here), `rgba(10,10,10,.6)` (`.viewer__shortcuts` and `.strip`), `rgba(20,20,21,.45)` (`.viewer__panel-trigger`). `--scrim-overlay` exists at 50% and is unadopted. |

## 6. Type off the scale

`12.5px` (`.dbtn`) · `13px` (`.annotation-note`, `.cmt__who`) · `11.5px` (`.cmt__who span`) ·
`14.5px` (`.cmt__txt`) · `20px` (`.vpanel__addr`, `.vpanel__collapse`, `.vpanel__peek-action`,
`.vpanel__peek-handle span`) · `11px` (`.viewer__panel-trigger`, `.cmt__pin`,
`.vpanel__peek-handle`) · `10px` (`.kbd`, `.viewer__meta .b` at ≤720) · `22px`
(`.starpick button`) · `12px` (`.pin`, `.vpanel__peek-rating span`).

Nine distinct off-scale sizes. TB8-07 moved nine onto the scale on its own surface; this is the
same job.

## 7. What the runtime pass still has to settle

Source cannot answer these. Each is asserted from the CSS and must be confirmed or withdrawn.

| # | Claim | Why it needs a browser |
|---|---|---|
| **R-1** `RUNTIME` | `.drawbar` is `flex-wrap: wrap` with `max-width: calc(100vw - 32px)` and holds 9 controls plus up to 4 more in edit mode. It should wrap onto a second row somewhere in the 721–1080px band. | Wrap point depends on rendered text metrics. |
| **R-2** `RUNTIME` | `.viewer__shortcuts.is-drawing` moves to `bottom: 70px` while `.drawbar` sits at `bottom: 18px`. If the drawbar wraps to two rows it grows upward past 70px and the two collide. | Depends on R-1. |
| **R-3** `RUNTIME` | `.viewer__meta` is centred at `left: 50%` and capped at `45vw` only at ≤720px. Between 721 and 1080 it is uncapped, with `.viewer__close` at the left and `.viewer__panel-trigger` at the right — a long filename may run under both. | Depends on filename length. |
| **R-4** `RUNTIME` | `.canvasframe .viewer__img` is capped at `max-height: calc(100vh - 230px)`; `.viewer__imgwrap` pads `84px` bottom (`118px` at ≤720). Whether 230px is still the right constant at every band needs measuring. | Two independent constants that must agree. |
| **R-5** `RUNTIME` | The §8 focus-ring failure is provable from source, but its *visible* remedy — where an offset ring lands against a `overflow: hidden` stage and a scrolling filmstrip — is not. Confirm each ring is not clipped by `.viewer__stage`/`.viewer__imgwrap`/`.strip`, all three of which set `overflow`. | `outline-offset: 2px` vs three overflow contexts. |
| **R-6** `RUNTIME` | `.vpanel.open + .strip { bottom: 85vh }` at ≤720 assumes the sheet is exactly `max-height: 85vh`. If the sheet is shorter (short content), the filmstrip floats detached above it. | Depends on real content height. |

## 8. The headline defect: the focus ring is invisible on the entire dark stage

Found while verifying R-5, and provable without a browser. **This is the most severe item in the
register** — it is not cosmetic, it removes keyboard operability from the whole surface.

The app has one global focus rule, `tokens/base.css:25`:

```css
:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring); outline-offset: 2px; }
```

and `tokens/colors.css:74` sets `--focus-ring: var(--ink-900)` — `#0a0a0a`. That is correct
everywhere in the app except here, because `.viewer` sets `background: var(--ink-900)`. **The ring
and the stage are the same colour.**

| Ring against | Measured |
|---|---|
| `.viewer` stage (`--ink-900`) | **1.00:1** |
| `.strip` filmstrip ground (60% ink over ink-900) | **1.00:1** |
| `.viewer__panel-trigger` (45% ink over ink-900) | **1.03:1** |
| `.drawbar` ground (`--ink-800`) | **1.07:1** |
| `.vpanel` side panel (`--paper-050`) | 18.64:1 — correct, the panel is unaffected |

Everything focusable on the dark stage is affected: Close, Previous/Next frame, Zoom in/out, the
panel trigger, all nine markup-toolbar buttons, Undo/Clear/Cancel/Save, and every filmstrip
thumbnail. A keyboard user tabbing through the lightbox gets **no visible indication of focus at
any point** until they reach the side panel. WCAG 2.4.7, and 2.4.11 in WCAG 2.2.

**A second, independent cause on the filmstrip.** `.strip__button` declares
`outline: 2px solid transparent` (`app.css:495`). Both `:focus-visible` and `.strip__button` have
specificity (0,1,0), and `index.css` imports `app.css` **after** `tokens/base.css` — so on an
equal-specificity tie the later rule wins and the transparent outline beats the focus ring
outright. Filmstrip thumbnails would have no ring even if `--focus-ring` were fixed.

This is the **third** appearance of this exact cascade-order trap in TB8: TB8-02 round 3 found a
≤720px override losing to a later equal-specificity rule in the same file, and TB8-05's B4 found
the mobile menu computing `display: none` at every width for the same reason. The plan should
treat "equal specificity, later source wins" as a checked invariant, not a thing to rediscover.

**The fix is not to redefine `--focus-ring` globally** — it is correct for the other 95% of the
app. It needs a stage-scoped ring token (the natural value is `--text-on-inverse` /
`--paper-050`, which measures 18.64:1 against the stage), plus deleting `.strip__button`'s
transparent outline rather than trying to out-specify it.

## 9. Deliberately out of scope

- **`.compare`** (`app.css:500–507`) is in scope for paint, but compare mode is disabled on phone
  (`Lightbox.tsx:111`, `band !== "phone"`), so it carries no phone evidence and no phone criteria.
- **`.pin`, `.markup-svg`, `.canvasframe`** are the annotation geometry itself. The roadmap says
  "specialized CSS remains where evidence shows it is clearer" — an SVG overlay whose transforms
  are computed in JS is the clearest case in the app for keeping CSS. Expect these to be *kept*
  with a written reason, as TB8-07 kept its 24 rich-text prose rules.
- **`LazyImage`** is shared with `PhotoGrid` and the Dashboard; changing it reaches beyond this
  surface. K-3's shared label palette will need a home that both consumers can import — that is a
  plan decision, not a drift item.
