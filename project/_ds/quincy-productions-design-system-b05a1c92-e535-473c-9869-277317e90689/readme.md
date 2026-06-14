# Quincy Productions — Design System

An editorial, resolutely monochrome design system for **Quincy Productions**, an
independent film & content production house. The brand voice is unhurried and
literary; the visual world is black ink on warm paper, set in a refined display
serif, with a single characterful display face for rare big statements.

> This is the design system project itself. An automated compiler reads these
> files and ships `styles.css` + a component bundle (`_ds_bundle.js`) to consuming
> projects. Do not hand-edit the generated `_ds_*` files.

---

## Sources provided
- **`uploads/QUINCY PRODUCTIONS SOCIAL MEDIA GUIDELINES 2026.pdf`** — *referenced in the brief but NOT present on the filesystem at build time.* The colour/voice decisions below are inferred from the supplied logo, pattern and font files. **Please re-upload the PDF** so the guidelines can be reconciled.
- Brand marks (PNG, transparent): `Quincy-productions-{BLACK,WHITE}`, `Quincy-HERO-{BLACK}`, `Quincy-HERO-Q-WHITE`, `Quincy-QP-{BLACK,WHITE}`, `Quincy-Pattern-{BLACK,WHITE}`.
- Fonts (OTF): `ApfelGrotezk-Regular`, `MAZIUSREVIEW20.09-Regular`, `Messapia-Regular`, `Messapia-Bold`.
- **Missing fonts:** `MAZIUSREVIEW…-Extraitalic` was listed but not supplied. `Athelas` (the long-form body serif) has now been uploaded and is self-hosted across Regular / Italic / Bold / Bold-Italic.

---

## What's here (index / manifest)

**Root**
- `styles.css` — the single entry point consumers link. `@import`s only.
- `readme.md` — this file.
- `SKILL.md` — Agent-Skill front-matter so this can be used in Claude Code.

**`tokens/`** — CSS custom properties (`@import`ed by `styles.css`)
- `fonts.css` — `@font-face` for Mazius Review, Apfel Grotezk, Messapia.
- `colors.css` — ink/paper, greige ramp, muted signal colours, semantic aliases.
- `typography.css` — families, scale, leading, tracking, semantic type roles.
- `spacing.css` — spacing grid, radii, borders, shadows, motion, layout widths.
- `base.css` — element defaults + brand helper classes (`.q-eyebrow`, `.q-rule`, …).

**`components/`** — React primitives (each `Name.jsx` + `Name.d.ts` + `Name.prompt.md`)
- `core/` — `Button`, `Badge`, `Card`, `SectionHeader`, `Logo`
- `forms/` — `Input`, `Select`, `Checkbox`, `Switch`

**`ui_kits/website/`** — full click-through recreation of the marketing site
(`index.html`, `Nav`, `Home`, `Studio`, `Contact`, `Footer`).

**`guidelines/`** — foundation specimen cards (the Design System tab).

**`assets/`** — `logos/`, `patterns/`, `fonts/`.

---

## CONTENT FUNDAMENTALS

How Quincy writes.

- **Voice:** first-person plural ("we make…", "we take on a handful of films"). The
  studio speaks as a small collective, never a faceless brand.
- **Register:** literary and calm. Short, declarative sentences. A fondness for the
  em-dash and for understatement. Nothing breathless, no exclamation marks.
- **Casing:** sentence case for everything that is read as language (headlines,
  body, buttons-as-sentences). **Spaced UPPERCASE** is reserved for labels, eyebrows,
  nav and metadata — echoing the "P R O D U C T I O N S" lockup under the wordmark.
- **Person:** "we" (the studio) and "you" (the client). Warm but professional.
- **Taglines** read like quiet manifestos: *"Patience is a production value."*,
  *"Stories, made with patience."*, *"A small house, built for the long take."*
- **Numbers / metadata** are terse and factual: `Documentary · 2025`, `Founded 2016`.
- **No emoji. No slang. No hype words** ("revolutionary", "game-changing" — never).
- **Vibe:** an arthouse film studio's letterhead. Confident, spare, a little austere.

---

## VISUAL FOUNDATIONS

- **Colour:** a strict duotone — brand black `--ink-900 #0A0A0A` on warm paper
  `--paper-050 #FAF8F2`. Hierarchy comes from a warm **greige** neutral ramp, not
  from new hues. Signal colours (olive / ochre / oxblood / slate) exist but are
  muted and used only for system states. **There is no bright accent — the
  restraint is the brand.**
- **Type:** three voices. **Mazius Review** (high-contrast editorial serif) is the
  brand voice — all display and headlines, and the logotype. **Apfel Grotezk**
  (neo-grotesque sans) is the workhorse for body, UI and labels. **Messapia**
  (reverse-contrast display) appears rarely, uppercase, for poster-scale statements.
- **Backgrounds:** mostly flat paper or flat ink. The signature texture is the
  **four-Q pinwheel** pattern, used at very low opacity (≈6%) over ink panels — never
  loud. No gradients. No photographic hero washes in the kit (add real film stills
  when available — they should read warm, filmic, lightly grained).
- **Layout:** editorial and architectural. Generous whitespace, content held in
  `--container-*` widths, structure drawn with **hairline rules (1px)** and the
  signature **3px ink rule** under section eyebrows. Grids divided by hairlines
  rather than cards-with-gaps.
- **Corners:** square by default (`--radius-card: 0`). Only incidental controls
  soften (`--radius-sm: 4px`); pills exist only for the toggle.
- **Borders over shadow:** elevation is almost never used. Shadows are whisper-quiet
  and reserved for true overlays (dialogs, menus). Cards are defined by a 1px
  greige hairline, not a drop shadow.
- **Motion:** calm and brief. Ease-out (`--ease-standard`) and a refined settle
  (`--ease-entrance`); durations 120–420ms. Fades and small translates only — no
  bounce, no spin, no infinite loops on content.
- **Hover:** surfaces tint up one paper step (`--paper-100`); links underline;
  nav items grow a 1.5px underline. **Press:** a 1px downward nudge on buttons; no
  scaling, no colour flips.
- **Focus:** a 2px solid ink outline, offset 2px — visible and on-brand.
- **Imagery treatment:** when photography is added it should be warm, filmic,
  high-contrast, occasionally black-and-white; think 35mm, soft grain, available light.

---

## ICONOGRAPHY

- The supplied brand kit contains **no icon set** — the visual language is built
  from **letterforms** (the Q, the QP monogram, the four-Q pinwheel), not pictograms.
- Where small UI affordances are genuinely needed (a select chevron, a checkmark),
  they are drawn inline as **1.5px square-cap strokes** to match the editorial line
  weight — see `Select` and `Checkbox`. Keep any iconography to this hairline,
  geometric, square-cornered style.
- **No emoji. No coloured icon system. No icon font.** If a fuller utilitarian icon
  set becomes necessary for a product surface, use **Lucide** (CDN) at 1.5px stroke
  — its weight matches the brand — and document the addition here. *(Not currently
  bundled; flagged as the recommended substitute.)*
- The brand marks themselves are the iconography: use `Logo` with
  `mark="qp"` (monogram), `mark="hero"` (Quincy script), `mark="pinwheel"`
  (pattern tile) or `mark="wordmark"` (full lockup).

---

## Namespace
Components are exposed at `window.QuincyProductionsDesignSystem_b05a1c`.
In a card or kit: `const { Button } = window.QuincyProductionsDesignSystem_b05a1c;`
