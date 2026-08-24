# TB1 dependency and style audit

Consolidates the plan's required dependency/style audit checks. Sources: the build's own recorded
audit notes (`bundle-css-delta.md`), and an independent Opus final-draft review that re-derived
these claims directly from the compiled CSS/lockfile rather than trusting the builder's self-report
(2026-08-25).

## Dependency audit

- `class-variance-authority` is genuinely absent: zero hits in `portal/package-lock.json`, absent
  from `node_modules`, and no source file imports it. The trimmed primitive set (`Input`, `Label`,
  `Field`/`FieldGroup`/`FieldLabel`/`FieldError`, `cn()`) never needed a variant surface.
- `lucide-react` produces zero occurrences in the built browser bundle (verified directly against
  `apps/web/dist/assets/*.js`) — fully tree-shaken, matching D-16's approved-but-unused-in-TB1
  baseline.
- The pinned `shadcn` CLI is dev-only and contributes zero browser-bundle strings.
- No generator-only Separator source, unused Field-family exports (`FieldSet`, `FieldLegend`,
  `FieldContent`, `FieldTitle`, `FieldDescription`, `FieldSeparator`), Button, `tw-animate-css`, or
  `shadcn/tailwind.css` runtime stylesheet entered the diff.
- `portal/apps/web/package.json` is byte-identical to the TB1 base commit — all direct additions
  are owned solely by `portal/package.json`, per the plan's dependency-ownership model.
- The lockfile adds 326 package entries for the pinned Tailwind/Base UI/shadcn toolchain; no
  pre-existing package entry changed version — explained entirely by the direct additions, no
  unrelated transitive churn.
- `@base-ui/react`'s only listed peers (`date-fns`, `@date-fns/tz`) are marked `optional: true` in
  `peerDependenciesMeta`; neither was installed, correctly avoiding two unneeded optional packages.

## Style/cascade audit

- **No Preflight anywhere.** Neither source nor the built CSS contains `tailwindcss/preflight.css`
  or a bare `@import "tailwindcss"`. The built CSS's only `box-sizing: border-box` and
  `-webkit-text-size-adjust` declarations both trace to Quincy's own `tokens/base.css`, not
  Tailwind's reset; `tab-size` is absent; `@layer base, components;` is an empty ordering statement
  with no rules. Zero `.dark` selectors and zero `prefers-color-scheme` media queries anywhere.
- **Token bridge collision sweep** (all nineteen `:root` bridge names plus `--accent`): only two
  intentional, checked reuses exist — `--accent` (`colors.css:55`, overridden by the existing
  `.app.acc-olive` mode) and `--ring` (already used by `.tile` for selection/status rings in
  `app.css`, set locally before consumption, so the bridge's `:root` fallback is inert for those
  tiles). No new collision was introduced.
- **`--focus-ring` semantic substitution is a color no-op**: `--focus-ring: var(--ink-900)` is
  confirmed, matching the literal legacy `border-color: var(--ink-900)` declaration the new
  `.quincy-input:focus` rule replaces.
- **The dead `--radius` bridge `:root` entry was dropped** (per the Opus tier-2 review's
  non-blocking note) — it had no `@theme inline` mapping or consumer; the live Quincy `--radius-*`
  tokens remain authoritative and the Input primitive references `var(--radius-sm)` directly.
- **The grid-collision fix compiles correctly.** The Client-block wrapper's `[&]:grid` (chosen to
  avoid colliding with the pre-existing, unrelated, unlayered `.grid` selector in `app.css` used by
  the photo-tile grid) compiles in the built CSS to `.\[\&\]\:grid{display:grid}` — a distinct
  selector the legacy `.grid { ... }` rule cannot match at all. Verified directly against the built
  CSS, including the `min-[721px]:`/`min-[1081px]:` breakpoints compiling to
  `@media (width>=721px)`/`@media (width>=1081px)`, exactly matching the legacy
  `max-width:720px`/`721–1080px`/base-4 threshold contract, and `grid-cols-N` emitting
  `repeat(N, minmax(0,1fr))`, identical to the legacy `.create-project__fields` mechanism.
- **`FieldGroup` carries exactly one display-owning utility.** Originally defaulted to
  `cn("flex w-full", className)`, which — combined with the Client-block's own `[&]:grid` — put two
  conflicting display utilities on the same element (correct only because Tailwind happened to sort
  the variant-carrying utility after the plain one within the same layer). Fixed 2026-08-25 by
  dropping the default to `cn("w-full", className)`; the primitive is now genuinely feature-neutral
  with no baked-in display opinion, and its one real consumer supplies `[&]:grid` itself.
- **One styling owner per migrated element.** Every scoped `input` selector elsewhere in `app.css`
  (`.search`, `.copyinput`, `.dashboard-search`, `.collection-link-form`,
  `.create-project__address`, `.rich-text__*`, `.subtask-*`) was swept and confirmed unable to reach
  the converted Client block. The old `.admin-field`'s `letter-spacing: normal`/
  `text-transform: none` resets are confirmed unnecessary in the new tree: no ancestor between
  `body` and the new `Field` sets either property, and the Input/Error are now siblings of the
  label rather than descendants of the uppercase-tracked legacy wrapper.
- **Geometry/typography reproduction confirmed against the real legacy rule**
  (`app.css:921-925`, `.admin-field`): `Field`'s `flex w-full flex-col gap-[6px]` matches the
  legacy `flex/column/gap:6px`; `Input`'s utility string (`min-h-[38px] px-[10px] py-[8px]
  border border-solid border-[var(--border-hairline)] rounded-[var(--radius-sm)]
  bg-[var(--paper-050)] text-[var(--text-primary)]` plus the one-piece font arbitrary-property
  utility) matches `width:100%; min-height:38px; padding:8px 10px; 1px solid
  var(--border-hairline); var(--radius-sm); var(--paper-050); var(--type-body); font-size:14px;
  var(--text-primary)` exactly, with `--type-body` correctly decomposed to
  `400 14px/1.5 var(--font-sans)`. `FieldError` reproduces the legacy `12px`/`1.5`/`400`/sans error
  typography as one arbitrary-property font utility, avoiding the utility-order shorthand-reset
  hazard the Opus tier-2 review had flagged as a risk to watch.
- **No stock shadcn/Sera residue**: no dark-mode, shadow, or stock ring classes remain on any
  primitive.

## Legacy selector survival check

Repo-wide grep confirms `.create-project__section`, `.create-project__section-head`,
`.create-project__fields`, and `.admin-field` all retain real consumers outside the converted
Client block (Shoot, Order, Dropbox, Notes, Property, Admin, and surrounding section/head markup,
per the plan's own pre-recorded per-selector consumer list). No legacy selector was deleted in TB1,
matching the plan's "pre-authorizes deletion of none of these selectors" constraint.
