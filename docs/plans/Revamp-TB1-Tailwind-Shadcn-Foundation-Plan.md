# Revamp TB1 — Tailwind v4 + shadcn Foundation Plan

> **Status: APPROVED — plan review complete (2 Sol rounds, 2 Opus tier-2 rounds, final verdict
> APPROVE 2026-08-24); not yet implemented, verified, or deployed.**

## Authority and outcome

Authority order for this plan is:

1. [`Decision-Sheet.md` D-16](../Decision-Sheet.md), with D-13 and D-15 as revised on
   2026-08-24.
2. [`Implementation-Plan.md` A8](../Implementation-Plan.md), the promoted UI-platform and design-
   convergence amendment.
3. The [TB1 roadmap scope stub](./revamp_2026_portal/roadmap/TB1-Tailwind-Shadcn-Foundation.md).
4. The settled [Frontend Architecture](./revamp_2026_portal/core/04-Frontend-Architecture.md) and
   [Design Convergence Contract](./revamp_2026_portal/core/11-Design-Convergence.md).
5. This repository-native execution plan.

The primary user outcome is the roadmap's approved outcome: **“one bounded existing form section
uses the Quincy UI layer with equal/improved accessibility and demonstrable design convergence.”**
The one bounded consumer is the `ProjectFields` Client section—Agency, Agent, Agent email, and
Agent phone—in both Create and Edit modes. There is no product, validation, payload, or workflow
change.

D-16 and A8 make the implementation technique explicit: pinned Tailwind CSS v4, source-owned
shadcn components using the Base UI/Sera/Lucide baseline, CSS-variable-backed Quincy semantic
tokens, Preflight disabled, no dark mode, and matched evidence at `1440×900`, `1024×768`, and
`390×844`. Quincy remains visual authority. Generated source is reviewed application source; a
stock dependency aesthetic is a failure, not a shortcut.

### Implementation precondition

The TB1 roadmap requires TB0A and TB0B to be **live and accepted**. TB0B is live and explicitly
unblocks TB1. TB0A is live, but both
[`Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md`](./Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md)
and [`docs/todo.md`](../todo.md) still say it is not formally accepted because named runtime and
matched-evidence checks remain open. This does not block drafting. It does block implementation
until the owner either records TB0A acceptance or explicitly amends the TB1 precondition. Do not
infer acceptance from deployment alone.

## Verified current state

### Runtime, build, and dependency ownership

`portal/package.json` is the monorepo dependency owner. It currently pins React and React DOM to
`19.2.8`, TypeScript to `^7.0.2`, Vite to `^8.1.5`, and `@vitejs/plugin-react` to `^6.0.3`.
`portal/apps/web/package.json` contains only `happy-dom`. TB1 keeps this ownership model: runtime
and build packages go in `portal/package.json`; no duplicate declarations are added to the web
workspace manifest.

`portal/apps/web/vite.config.ts` currently has `react()` as its only plugin and no `resolve.alias`.
`portal/apps/web/tsconfig.json` extends `portal/tsconfig.base.json`, uses `jsx: "react-jsx"`, and
has no `baseUrl` or `paths`. The alias is therefore an additive TB1 change, not a repair of an
existing alias.

### Exact current Client-section contract

[`ProjectFields.tsx`](../../portal/apps/web/src/components/ProjectFields.tsx) currently renders one
native section:

- `<section className="create-project__section" aria-labelledby="client-heading">`;
- a legacy section head with eyebrow text `Client` and
  `<h2 className="serif" id="client-heading">Who is it for?</h2>`; and
- `<div className="create-project__fields">` containing four implicit native label/input pairs,
  each label carrying `className="admin-field"`.

The four controls and their exact behavior are:

| Label | Native control contract | Change contract | Error contract |
|---|---|---|---|
| Agency | `<input>` with no explicit `type`; controlled by `form.agencyName` | `onChange("agencyName", event.target.value)` | none |
| Agent | `<input>` with no explicit `type`; controlled by `form.agentName` | `onChange("agentName", event.target.value)` | none |
| Agent email | `<input type="email">`; controlled by `form.agentEmail`; `aria-invalid={Boolean(errors.agentEmail)}` | `onChange("agentEmail", event.target.value)` | conditional `<small>` with the exact `errors.agentEmail` text |
| Agent phone | `<input type="tel">`; controlled by `form.agentPhone` | `onChange("agentPhone", event.target.value)` | none |

The labels are currently associated implicitly by nesting each input inside its `<label>`. TB1 may
move to explicit `htmlFor`/`id` association only if the association is proved in the DOM test. The
email validator remains `EMAIL_PATTERN` in `validateProjectFields()` with the exact message
`Enter a valid email address.` Empty email remains valid. The same email rule applies in Create
and Edit modes.

Create and Edit intentionally do **not** differ for these four fields: all remain editable, and
neither mode adds `readOnly` or `disabled`. Create uses `validateProjectFields(form)` and sends the
four optional trimmed values from the local `submit()` inside `CreateProject`; its request body is
constructed inline in the `apiPost("/api/projects", body)` call. Edit uses
`validateProjectFields(form, "edit")` and sends the same four optional trimmed values through the
exported `editProjectPayload()`. Both parent `updateField()` functions clear `agentEmail` error
state when that field changes. TB1 leaves those functions and request shapes byte-for-byte
unchanged.

The existing tests cover the broad Create/Edit policies and team pickers but do not directly pin
the four Client controls' labels, native input attributes, change callbacks, email error
association, or ref behavior. TB1 closes that focused gap without rewriting unrelated tests.

### Current styling ownership

The section currently combines four shared legacy owners in `src/styles/app.css`. Their verified
consumers are not identical:

- `.create-project__section` and `.create-project__section-head` own section/head geometry. Outside
  the Client block, both remain on ProjectFields' Shoot, Order, Services, Dropbox, Team, and Notes
  sections and on EditProject's Property section.
- `.create-project__fields` owns the four/two/one-column responsive grid at desktop, compact, and
  phone widths. Outside the Client block, it remains on ProjectFields' Shoot, Order, and Dropbox
  sections and EditProject's Property section; Services, Team, and Notes do not use this selector.
- `.admin-field` plus its descendant rules own label typography, input geometry, normal/focus/
  invalid states, and error text. Outside the Client block, it remains on ProjectFields' Shoot,
  Order, Dropbox, and Notes controls; CreateProject's Property refinements; EditProject's Property
  controls and danger-zone delete confirmation; and Admin forms. ProjectFields' Services and Team
  sections do not use it.

Therefore **TB1 pre-authorizes deletion of none of these selectors**. The implementation must
repeat the repo-wide consumer grep immediately before any proposed deletion; only a selector with
zero remaining source consumer may be removed.

## Scope constraints

### In scope

- Add the pinned Tailwind v4 Vite integration and CSS-first theme/utilities imports while omitting
  Preflight.
- Add the exact app-local shadcn configuration, Base UI/Sera/Lucide dependency baseline, `cn()`
  utility, and `@/* → src/*` TypeScript/Vite alias.
- Add only `Input`, the minimal Field/Label/Error surface needed by the four controls, and one
  Quincy-owned field composite. Retain no generated Separator, animation, or Button source that
  the active consumer does not use.
- Replace only the Client section's four legacy `admin-field` label/input blocks and its
  `create-project__fields` grid owner. The containing section/head may keep the legacy classes so
  the section title and outer geometry do not drift.
- Preserve every native prop, controlled value, callback field key, validation rule/message,
  submission payload, and Create/Edit editability contract named above.
- Add focused primitive/component tests, matched evidence, drift classifications, dependency and
  bundle/CSS records, and the app-only release/rollback record.

### Hard non-goals

- No whole-form or whole-app migration. Shoot, Order, Services, Dropbox, Team, Notes, Create's
  Property/details/hero/actions, Edit's Property/actions/danger zone, Admin forms, and every other
  form remain untouched.
- No Preflight enablement; `tailwindcss/preflight.css` must not enter the built CSS.
- No React/runtime work, React Compiler, ref-as-prop sweep, router/framework change, SSR, Server
  Components, or hydration work.
- No query, discussion, notification, coordination, Project Workspace rail, Stage, Deadline,
  Kanban, Calendar, or External Editor change.
- No dark mode, `.dark` token set, theme toggle, or dark-mode utility branch.
- No shared UI workspace/package. Everything is app-local under `apps/web/src/components/` and
  `apps/web/src/lib/`.
- No bulk shadcn install and no third-party registry. The later FullCalendar exception belongs to
  TB5C and is not added to `components.json` here.
- No Button primitive: the Client section contains no button. Existing Create/Edit submit and
  cancel controls are outside the authorized migration boundary. Installing or converting Button
  would exceed the active consumer.
- No retained Separator, unused Field-family exports, `tw-animate-css`, or `shadcn/tailwind.css`
  runtime styling unless a fresh CLI dry-run demonstrates an unavoidable requirement. A newly
  demonstrated requirement stops for review; it is not silently absorbed.
- No import cleanup or conversion of unrelated relative imports to `@/`.
- No deletion of a legacy selector that still has any consumer.

## Exact implementation plan

### 1. Recheck and pin the dependency set

The npm registry and official package pages were checked on 2026-08-24. Candidate exact stable
versions are:

| Ownership | Package | Candidate | TB1 use |
|---|---|---:|---|
| `devDependencies` | `tailwindcss` | `4.3.3` | CSS-first Tailwind compiler/theme/utilities |
| `devDependencies` | `@tailwindcss/vite` | `4.3.3` | Vite integration |
| `devDependencies` | `shadcn` | `4.19.0` | pinned generator/review tool; not a browser runtime |
| `dependencies` | `@base-ui/react` | `1.7.0` | Base UI native Input primitive |
| `dependencies` | `lucide-react` | `1.33.0` | D-16's one approved icon-library baseline; unused exports must tree-shake |
| `dependencies` | `clsx` | `2.1.1` | `cn()` class composition |
| `dependencies` | `tailwind-merge` | `3.6.0` | Tailwind v4-aware `cn()` conflict resolution |

Primary checks: the [Tailwind registry](https://registry.npmjs.org/tailwindcss/latest),
[`@tailwindcss/vite`](https://www.npmjs.com/package/@tailwindcss/vite),
[`shadcn`](https://www.npmjs.com/package/shadcn),
[`@base-ui/react`](https://www.npmjs.com/package/@base-ui/react),
[`lucide-react`](https://www.npmjs.com/package/lucide-react),
[`clsx`](https://www.npmjs.com/package/clsx), and
[`tailwind-merge`](https://www.npmjs.com/package/tailwind-merge).

Immediately before editing, run from `portal/`:

```bash
npm view tailwindcss version
npm view @tailwindcss/vite version
npm view shadcn version
npm view @base-ui/react name
npm view @base-ui/react version
npm view lucide-react version
npm view clsx version
npm view tailwind-merge version
npm view @tailwindcss/vite@<chosen-version> peerDependencies --json
npm view @base-ui/react@<chosen-version> peerDependencies --json
npm view tailwind-merge@<chosen-version> peerDependencies --json
```

Keep the separate package-name lookup: `@base-ui/react` is the current published Base UI package
named by the official installation guide, distinct from the historical
`@base-ui-components/react` name. A missing/mismatched `name` result stops the version check rather
than allowing the plan to assume the scope is still valid.

Use the latest stable exact versions returned at execution time, keeping `tailwindcss` and
`@tailwindcss/vite` on the same stable `4.x` release. Update this table in the execution record if
any candidate changes. Do not use caret, tilde, `latest`, prerelease, RC, canary, or an unreviewed
CLI-written range. Install with exact pins and review `portal/package-lock.json` for one resolved
line per direct package, compatible peers, no unexpected registry/runtime package, and no
unexplained transitive churn.

With the currently verified candidates, the exact install commands from `portal/` are:

```bash
npm install --save-exact @base-ui/react@1.7.0 lucide-react@1.33.0 clsx@2.1.1 tailwind-merge@3.6.0
npm install --save-dev --save-exact tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 shadcn@4.19.0
```

Substitute only freshly verified stable versions. `portal/apps/web/package.json` must remain
unchanged: the CLI must not duplicate these declarations in the web workspace.

`class-variance-authority` is not a default TB1 dependency: the trimmed §5 surface has no variant
API and its normal/invalid states are owned by native attributes plus scoped CSS. Add cva only if
the actual reviewed primitive source invokes a cva variant function; in that case recheck its
stable version, install it with an exact pin, and add it to the execution-time dependency table.
Otherwise it remains absent from the install command, direct dependency table, and lockfile's
direct additions.

Execution order is intentionally not the document's section order. Create the exact
`components.json` in §2, then apply §3's TypeScript, Vite, and Vitest alias wiring **before any**
`shadcn info`, `add`, `--dry-run`, or `--diff` invocation. The CLI resolves the configured `@/`
targets through the web app's TypeScript paths; running this inspection before §3 would fail its
alias validation.

After those prerequisites and before installing source, capture the pinned CLI's own `add --help`
and run inspection mode for only `input` and `field`:

```bash
npx shadcn@4.19.0 add --help
npx shadcn@4.19.0 info --cwd apps/web
npx shadcn@4.19.0 add input field --cwd apps/web --dry-run
npx shadcn@4.19.0 add input field --cwd apps/web --diff input.tsx
npx shadcn@4.19.0 add input field --cwd apps/web --diff field.tsx
```

Substitute the freshly verified CLI version if it changed. The current published CLI surface
documents `--dry-run` and `--diff [path]` as `add` flags, with `--diff` implying dry-run; nevertheless
the captured help from the exact chosen pin is authoritative. Record every proposed
file/dependency, then run `npx shadcn@<chosen-version> add input field --cwd apps/web` and review the
resulting diff before trimming it. Current upstream `field.tsx` statically imports Separator and
exports many parts the Client section does not need; current initialization can also suggest
`tw-animate-css` and `shadcn/tailwind.css`. TB1 must source-own and trim that output as described in
§5 rather than committing blind generator output. If the pinned help differs from a command shown
above, stop and correct the candidate sequence from that help; do not guess or replace the pin with
`@latest`.

The current Tailwind v4 browser floor is Chrome 111, Safari 16.4, and Firefox 128. Record the
product/browser-analytics disposition before rollout; changing build targets or adding a legacy
fallback is outside TB1.

### 2. Add the exact app-local shadcn contract

Create `portal/apps/web/components.json` with exactly:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-sera",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "utils": "@/lib/utils",
    "hooks": "@/hooks"
  }
}
```

Do not add `registries`; its omission means no additional registry and matches the settled
architecture. Do not add dark-mode metadata, a Tailwind config path, a prefix, RSC, or a second
primitive base. Validate the file against `https://ui.shadcn.com/schema.json` with the pinned CLI
before adding components.

Create these app-local locations:

```text
portal/apps/web/src/components/ui/
portal/apps/web/src/components/quincy/
portal/apps/web/src/lib/utils.ts
```

`components/ui` owns generic, reviewed primitive source; `components/quincy` owns the branded
field composition; `ProjectFields` retains domain/form behavior. No API call, capability, form
state, validator, or project-field name belongs in `components/ui`.

### 3. Wire `@/* → src/*` in TypeScript, Vite, and Vitest

In `portal/apps/web/tsconfig.json`, add only:

```json
"baseUrl": ".",
"paths": {
  "@/*": ["./src/*"]
}
```

under `compilerOptions`, retaining the current `lib`, `jsx`, `include`, base config, module
resolution, and build behavior.

In `portal/apps/web/vite.config.ts`:

1. import the Tailwind plugin from `@tailwindcss/vite`;
2. use an ESM-native absolute path for `@`, preferably
   `fileURLToPath(new URL("./src", import.meta.url))`, matching the already-used repository pattern
   in both Vitest configs rather than introducing `__dirname`; and
3. add `resolve.alias: { "@": <absolute src path> }`.

Add `tailwindcss()` after `react()` in `plugins`; retain the two existing dev-server proxies
unchanged. Do not rewrite any unrelated import to use `@/`. Only new generated/Quincy UI source
uses the alias in TB1.

`portal/apps/web/vitest.config.ts` and `portal/apps/web/vitest.dom.config.ts` are separate
`defineConfig` calls imported from `vitest/config`, each with its own `root`; neither extends
`vite.config.ts`, so neither inherits Vite's alias. Add the same entry to both existing config
objects (both files already import `fileURLToPath`):

```ts
resolve: {
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
  },
},
```

Both configs need it. The node-config suite also imports `ProjectFields.tsx`, which will reach
`@/components/quincy/QuincyField` after conversion; limiting the alias to the DOM config would
still break focused tests. Retain each config's current root, environment, and include pattern.

### 4. Integrate Tailwind v4 without Preflight and add the Quincy token bridge

Keep `portal/apps/web/src/styles/index.css` as the one application CSS entry. Add Tailwind using
the official expanded, Preflight-free form—never add `@import "tailwindcss"`:

Required Tailwind lines in `portal/apps/web/src/styles/index.css`:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
```

There must be no `@import "tailwindcss/preflight.css"`. Retain the existing Quincy imports for
`tokens/colors.css`, `tokens/spacing.css`, `tokens/typography.css`, `tokens/base.css`, `fonts.css`,
and `app.css` in their working order so Quincy's box sizing, margin defaults, typography, global
focus, and helpers remain intact. Those Quincy files are currently unlayered; normal declarations
in them therefore outrank declarations from Tailwind's named `utilities` layer. TB1 must account
for that cascade explicitly rather than assuming a layered utility can cancel an unlayered rule.

Final import order in `portal/apps/web/src/styles/index.css`:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "./tokens/colors.css";
@import "./tokens/spacing.css";
@import "./tokens/typography.css";
@import "./tokens/tailwind.css";
@import "./tokens/base.css";
@import "./fonts.css";
@import "./app.css";
```

`tokens/tailwind.css` is the only new local import. Add that one reviewed bridge file after the
existing Quincy token definitions and before consumers. Its CSS-first `@theme inline` maps
Tailwind's semantic color namespace to the real current Quincy variables.

Contents of `portal/apps/web/src/styles/tokens/tailwind.css`:

```css
:root {
  --background: var(--bg-canvas);
  --foreground: var(--text-primary);
  --card: var(--bg-surface);
  --card-foreground: var(--text-primary);
  --popover: var(--bg-surface);
  --popover-foreground: var(--text-primary);
  --primary: var(--accent);
  --primary-foreground: var(--accent-on);
  --secondary: var(--bg-raised);
  --secondary-foreground: var(--text-primary);
  --muted: var(--bg-raised);
  --muted-foreground: var(--text-muted);
  --accent-foreground: var(--accent-on);
  --destructive: var(--signal-critical);
  --destructive-foreground: var(--paper-050);
  --border: var(--border-hairline);
  --input: var(--border-hairline);
  --ring: var(--focus-ring);
  --radius: var(--radius-sm);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-signal-positive: var(--signal-positive);
  --color-signal-caution: var(--signal-caution);
  --color-signal-critical: var(--signal-critical);
  --color-signal-info: var(--signal-info);
}
```

This is an alias bridge, not a replacement palette. Raw Tailwind neutral/brand colors and raw
hexes are forbidden in the new feature/composite source. Existing Quincy `--font-sans`,
`--font-display`, `--text-*`, `--radius-*`, `--space-*`, `--dur-*`, and `--ease-*` variables remain
authoritative; use their values directly through arbitrary-value utilities where Tailwind's stock
scale would differ. Do not emit a generated neutral palette, overwrite the real Quincy variables,
or introduce a dark token block. `--input` deliberately maps to `--border-hairline`: the current
`--field-border` resolves to black `--ink-900`, while the live form-control rules use the lighter
`1px solid var(--border-hairline)` contract that the migrated Input must preserve.

Tailwind's theme file also declares stock `--text-*`, `--radius-*`, `--tracking-*`, `--leading-*`,
`--shadow-*`, `--container-*`, `--font-sans`, and `--font-mono` names in its named `theme` layer.
Quincy's same-named declarations in `tokens/typography.css` and `tokens/spacing.css` are unlayered,
so Quincy wins the cascade. The overlap is intentional but materially repoints stock utilities:
for example, Quincy/Tailwind currently differ at `--text-lg` (`22px` versus `1.125rem`),
`--radius-lg` (`14px` versus `0.5rem`), `--tracking-wide` (`0.08em` versus `0.025em`), and
`--container-sm` (`640px` versus `24rem`). At execution time, recheck those stock values in the
installed `tailwindcss/theme.css`. Every later TB phase inheriting this foundation must treat
"unlayered Quincy beats layered Tailwind theme" as the governing rule rather than assuming the
utility name retains Tailwind's stock scale.

Before adding the bridge, repeat a repo-wide collision sweep for every one of its nineteen
`:root` target names plus the directly reused `--accent`, not only the known accent mode:

```bash
rg -n --pcre2 -- '(?<![A-Za-z0-9_-])--(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|destructive-foreground|border|input|ring|radius)(?=[^A-Za-z0-9_-]|$)' apps/web/src/styles
```

The current sweep finds two intentional collisions. `--accent` is Quincy's live semantic token and
may be overridden by `.app.acc-olive`; the bridge deliberately reuses it, so computed variables
must be checked with and without that class. `--ring` already owns tile selection/status rings in
`app.css`: `.tile` sets it locally to `transparent`, selection/status rules replace the local
value, and the olive mode replaces it locally again. The new root fallback therefore does not
change those tiles. Record both as checked, non-conflicting reuse and stop for review if the repeat
sweep finds any additional exact-name collision.

### 5. Add only the source-owned primitives the Client block consumes

Use the pinned CLI output as an upstream proposal, then commit reviewed app source only:

- `components/ui/input.tsx`: a Base UI `InputPrimitive` wrapper typed with
  `React.ComponentProps<"input">`. Preserve and spread `type`, `value`, `onChange`, every native
  input prop, `aria-*`, and React 19 `ref` to the underlying native input. Remove stock dark-mode,
  shadow, rounded, palette, ring, and motion classes. Its reviewed Quincy utilities own the
  rendered input's width, height, padding, explicit solid border, radius, background, and type, and
  it always supplies the stable `quincy-input` class used by the scoped unlayered focus/invalid
  rules below.
- `components/ui/label.tsx`: the minimal native label wrapper used by `FieldLabel`; preserve
  `htmlFor`, native props, and ref behavior. Remove unused Sera appearance.
- `components/ui/field.tsx`: retain only `Field`, `FieldGroup`, `FieldLabel`, and `FieldError`.
  Delete unused `FieldSet`, `FieldLegend`, `FieldContent`, `FieldTitle`, `FieldDescription`, and
  `FieldSeparator` exports and the Separator import. Do not add `separator.tsx`. `FieldError`
  preserves the supplied text and renders only when content exists; its `role="alert"` and the
  explicit input association are the bounded accessibility improvement. `FieldGroup` remains a
  feature-neutral composition primitive: it accepts `className`, but its own styling contains no
  Client-specific column count or responsive breakpoint opinion.
- `lib/utils.ts`: the standard typed `cn(...inputs: ClassValue[])` implementation using `clsx` and
  `tailwind-merge`; no domain logic.
- `components/quincy/QuincyField.tsx`: compose `Field`, `FieldLabel`, `Input`, and conditional
  `FieldError`, accept native `React.ComponentProps<typeof Input>` without swallowing props, pass
  `ref` through on React 19, and derive a stable error id from the supplied control id. It owns
  association/composition only; it must not restyle the Input, Label, or Error elements.

The reviewed primitive set must explicitly reproduce the current control geometry. `Field` owns
the vertical layout and `6px` label/control gap; `FieldLabel` owns the `var(--type-eyebrow)`
uppercase label with `var(--tracking-wide)`/`var(--text-secondary)`; `Input` owns its minimum
`38px` height, `8px 10px` padding, `border: 1px solid var(--border-hairline)`,
`var(--radius-sm)`, `var(--paper-050)`, `var(--type-body)` at `14px`, and
`var(--text-primary)`. `FieldError` owns `font-family: var(--font-sans)`, `font-size: 12px`,
`line-height: 1.5`, `font-weight: 400`, and `color: var(--signal-critical)`. This reproduces the
current `.admin-field small` result: `var(--type-body)` supplies the 400/sans/1.5 pieces while its
explicit `font-size: 12px` overrides the token's `16px` body size. The old
`letter-spacing: normal` and `text-transform: none` resets are intentionally unnecessary in the
new tree because `FieldError` is a sibling of `FieldLabel`, not a descendant of the
uppercase/tracked legacy label. The explicit `solid` style is mandatory because Preflight is
absent; a border-width utility alone may not rely on Tailwind's reset to establish
`border-style: solid`.

The literal current focused-field rule in `app.css` is `outline: none; border-color:
var(--ink-900)`. TB1 intentionally substitutes the semantic `var(--focus-ring)` token for that
literal token reference; `--focus-ring` currently resolves to `var(--ink-900)` (`#0a0a0a`), so the
substitution does not change the rendered color and makes the new primitive follow the focus
semantic going forward. A layered `outline-none` utility cannot override the unlayered global
`:focus-visible` rule in `tokens/base.css`, which paints a two-pixel outline at a two-pixel offset.
Therefore add these scoped rules as ordinary **unlayered** CSS in `app.css`, after the existing
`.admin-field` focus/invalid rules:

```css
.quincy-input:focus,
.quincy-input:focus-visible {
  outline: none;
  border-color: var(--focus-ring);
}

.quincy-input[aria-invalid="true"] {
  border-color: var(--signal-critical);
}
```

Because `app.css` is imported unlayered after `tokens/base.css` and after Tailwind's named layers,
the scoped rule cancels the global outline instead of stacking a second indicator. Keep the
invalid rule after the focus rule so a focused invalid field remains critical-red, matching the
current `.admin-field` rule order. Remove any stock three-pixel shadcn ring, shadow, easing, or
radius rather than adding another focus owner. Motion remains absent for this static field block.

The CLI/package baseline remains Base UI/Sera/Lucide, but the rendered elements have one reviewed
Quincy styling system: primitive/composite classes plus the scoped unlayered state rules above.
Do not retain `cn-input`/`cn-field` style hooks or `shadcn/tailwind.css` if they would apply a second
stock visual owner.

### 6. Convert exactly the `ProjectFields` Client block

Keep the existing `<section>`, eyebrow, `h2`, `client-heading`, text, and outer
`create-project__section`/`create-project__section-head` classes unchanged. Replace only:

```text
div.create-project__fields
  └── 4 × label.admin-field > span + native input (+ small for email)
```

with:

```text
FieldGroup (ProjectFields-supplied Quincy/Tailwind responsive utilities)
  ├── QuincyField → Field + FieldLabel + Input                         Agency
  ├── QuincyField → Field + FieldLabel + Input                         Agent
  ├── QuincyField → Field + FieldLabel + Input + conditional FieldError Agent email
  └── QuincyField → Field + FieldLabel + Input                         Agent phone
```

Use explicit stable ids scoped to this one `ProjectFields` instance:
`project-agency-name`, `project-agent-name`, `project-agent-email`, and
`project-agent-phone`. Each `FieldLabel.htmlFor` must equal its Input `id`. When the email error is
present, render it with `id="project-agent-email-error"` and point the email Input to it with
`aria-describedby` and `aria-errormessage`; retain `aria-invalid={Boolean(errors.agentEmail)}` in
both the false and true states. The added association/alert semantics are classified as a
required accessibility improvement; the visible string and validation timing do not change.

Pass the controls exactly as follows:

- Agency: no explicit `type`; `value={form.agencyName}`; unchanged `agencyName` callback.
- Agent: no explicit `type`; `value={form.agentName}`; unchanged `agentName` callback.
- Agent email: `type="email"`; `value={form.agentEmail}`; unchanged `agentEmail` callback and
  Boolean error state.
- Agent phone: `type="tel"`; `value={form.agentPhone}`; unchanged `agentPhone` callback.

Do not add `name`, `required`, `placeholder`, `autoComplete`, `inputMode`, formatting/masking,
normalization, blur validation, uncontrolled state, debounce, or a form library. Do not move the
fields out of the current form or change their DOM order.

`ProjectFields` owns the Client-specific responsive layout by passing the complete utility set to
the generic `FieldGroup` through `className`, using exactly
`grid grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4 gap-[var(--space-4)]`. Tailwind
v4 supports these arbitrary `min-[<value>]` variants; they preserve four equal columns from
`1081px`, two equal columns from `721px` through `1080px`, one column at `720px` and below, and the
existing token gap. Do not use stock `sm:`, `md:`, or `lg:` variants for this block: their default
`640px`/`768px`/`1024px` thresholds do not match Quincy's layout, including the required
`1024×768` evidence viewport. Do not bake those columns or breakpoints into
`components/ui/field.tsx`, and do not combine the new classes with `create-project__fields`.
Either would blur the feature/generic seam or create two layout owners.

Leave every line from the Shoot section onward unchanged. Leave `validateProjectFields`,
`projectFieldsPolicy`, `emptyProjectForm`, `CreateProject`, `EditProject`, request payloads, and
parent action buttons unchanged.

### 7. Delete only verified dead CSS

Before and after conversion, run:

```bash
rg -n 'admin-field|create-project__fields|create-project__section|create-project__section-head' apps/web/src
rg -n 'cn-input|cn-field|shadcn/tailwind|tw-animate|separator' apps/web/src apps/web/components.json package.json
```

The known shared legacy selectors must remain because other consumers survive. Remove only a
selector/import generated within TB1 that has zero consumer after trimming. Record the grep output
in the dependency/style audit. No “appears obsolete” judgment substitutes for a zero-consumer
result.

## Focused tests

Extend `ProjectFields.test.ts` and `ProjectFields.dom.test.tsx`, and add
`components/quincy/QuincyField.dom.test.tsx` plus `screens/CreateProject.dom.test.tsx`, with direct
assertions rather than snapshots.

### Static/logic assertions

- Invalid non-empty Agent email returns exactly `Enter a valid email address.` in both Create and
  Edit; empty email remains valid in both. No other validator or policy result changes.
- Create and Edit markup each contains exactly four Client inputs in the approved order.
- Agency and Agent retain no explicit non-text native type contract; email is `type="email"`; phone
  is `type="tel"`.
- Every FieldLabel `for` value resolves to the corresponding unique Input id.
- Valid email renders `aria-invalid="false"` and no error node. Invalid email renders
  `aria-invalid="true"`, the exact visible message once, and matching
  `aria-describedby`/`aria-errormessage` targets.
- All four Client inputs remain enabled and writable in both modes. The extracted Client control
  contract is equal between Create/Edit; existing non-Client mode differences remain green.
- In `ProjectFields.test.ts`, extend the existing `editProjectPayload()` assertion against the real
  export from `screens/EditProject.tsx` with two form cases: padded Agency, Agent, Agent email, and
  Agent phone values become trimmed strings in its output, and whitespace-only values become
  `null` for all four optional keys.

### DOM/interaction assertions

- Dispatch native input changes for each control and assert one exact callback tuple:
  `("agencyName", value)`, `("agentName", value)`, `("agentEmail", value)`, and
  `("agentPhone", value)`.
- Re-render with updated controlled values and prove the DOM reflects the parent state; the
  primitive must not keep private form state.
- For each explicit label, assert the native association directly with
  `expect(label.control).toBe(input)` (or the equivalent `HTMLLabelElement.control === input`
  check). `happy-dom@20.11.1` does not move `document.activeElement` for label clicks, so that
  browser behavior is verified manually rather than asserted in this suite.
- Render the source-owned Input/QuincyField with `createRef<HTMLInputElement>()`; assert
  `ref.current` is the underlying native `HTMLInputElement` and `.focus()` moves
  `document.activeElement` to it.
- Assert native props are not swallowed by testing a representative set (`type`, `value`,
  `readOnly`, `disabled`, `required`, `inputMode`, `autoComplete`, `aria-*`, and a data attribute)
  on the generic primitive without adding any of those props to the four production fields.
- Confirm an Agent email error added on rerender becomes associated/announced and disappears when
  the parent clears it; text and input value remain intact.
- In `screens/CreateProject.dom.test.tsx`, exercise the real `CreateProject` submit path with a
  required no-op `onNavigate` prop, a resolved `apiGet("/api/users")` mock (the always-mounted
  `ProjectFields` fetches users in its mount effect), and a mocked `apiPost`. Set a non-empty
  Street address before submitting: `submit()` returns on the street error at
  `CreateProject.tsx:31-33`, and both submit buttons are disabled while `form.street.trim()` is
  empty. The Client fields are descendants of the controlled `<details>` but remain mounted when
  it is closed, so the test does not need to open the disclosure unless its chosen query helper
  excludes closed-details descendants. Fill the four Client controls, submit, and inspect the body
  passed to `apiPost("/api/projects", body)`. Cover two submissions so padded values are trimmed
  and whitespace-only values are `null` for the real `agencyName`, `agentName`, `agentEmail`, and
  `agentPhone` request keys; do not introduce a production payload helper solely for the test.

From `portal/`, run the focused suites before the full gate:

```bash
npx vitest run --config apps/web/vitest.config.ts src/components/ProjectFields.test.ts
npx vitest run --config apps/web/vitest.dom.config.ts src/components/ProjectFields.dom.test.tsx src/components/quincy/QuincyField.dom.test.tsx src/screens/CreateProject.dom.test.tsx
```

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run the repository-standard gate exactly:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Record each actual workspace result. The repository warning that the workspace command can miss
`packages/shared` is why the fourth command is mandatory; it must not hide any real suite failure.
Any new type, peer, CSS, Tailwind, Vite, React, browser-console, or test warning is investigated
and dispositioned before acceptance.

Also assert from built CSS/source inspection that:

- no Preflight reset rules/import are present;
- the four migrated controls emit the expected utility CSS;
- no `.dark` branch, stock raw palette, `cn-input`/`cn-field`, unused Separator/Button, or
  third-party registry entered the change; and
- legacy selectors continue to serve their remaining consumers without a specificity collision.

In the browser, capture `getComputedStyle(document.documentElement).getPropertyValue(...)` for a
representative overlap sample before and after the Tailwind import lands: at minimum `--text-lg`,
`--radius-lg`, `--tracking-wide`, `--container-sm`, `--font-sans`, and `--shadow-sm`. Record the two
sets side by side and require the Quincy values to remain identical; an unexpected shift means the
layer/import contract is wrong even if the migrated Client block happens to look acceptable.

### Bundle, CSS, and dependency delta

Before changing dependencies/source, make a clean web build at the TB1 base commit and record each
emitted JS/CSS asset, raw bytes, gzip bytes, JS/CSS totals, and total `apps/web/dist` bytes. Repeat
after the final build using the same commands and compression level. At minimum, use this exact
inventory from `portal/` for both states (substitute only the evidence heading/commit in the
record):

```bash
find apps/web/dist -type f -print0 | sort -z | xargs -0 wc -c
wc -c apps/web/dist/assets/*.js apps/web/dist/assets/*.css
for asset in apps/web/dist/assets/*.js apps/web/dist/assets/*.css; do
  test -f "$asset" || continue
  raw_bytes="$(wc -c < "$asset" | tr -d ' ')"
  gzip_bytes="$(gzip -9 -c "$asset" | wc -c | tr -d ' ')"
  printf '%s\t%s\t%s\n' "$asset" "$raw_bytes" "$gzip_bytes"
done
```

Save the result at:

`docs/plans/revamp_2026_portal/evidence/TB1/bundle-css-delta.md`

The record must include absolute and percentage deltas, direct dependency before/after tables,
and explanations for Tailwind-generated CSS, Base UI, Lucide tree-shaking, and any JS increase.
Confirm that unused Lucide exports, the shadcn CLI, and generator-only source are absent from the
browser bundle. A retained full shadcn/Sera/animation stylesheet or unexplained primitive bundle
is a blocker, not an accepted foundation cost.

### Manual QA matrix

Use the built app Worker at `http://localhost:8787`, not the Vite `5173` proxy, with the documented
seeded Admin. Use equivalent deterministic values in both modes:

- Agency: `Quincy Test Agency`;
- Agent: `Alex Example`;
- Agent email: first `not-an-email`, then `alex@example.test`;
- Agent phone: `+61 412 345 678`.

At each exact viewport—desktop `1440×900`, compact `1024×768`, and phone `390×844`—perform:

1. Create: open `Add details now`; confirm Client section is four/two/one columns respectively,
   field order is unchanged, values type normally, tab order is Agency → Agent → email → phone,
   click each label and confirm focus moves to its control in the real browser, and confirm no
   horizontal overflow occurs.
2. Create validation: submit with invalid email; confirm the exact error appears once, is
   announced/associated, value is retained, focus style remains Quincy, then correct the email and
   confirm the parent clears the error without changing another field.
3. Edit: load a disposable local project; confirm all four values populate, all remain editable,
   change each value, save, reload, and confirm the existing payload/persistence path. Restore or
   delete only the disposable local fixture.
4. Compare Create and Edit Client blocks for identical field geometry/behavior. Confirm their
   authorized surrounding-mode differences—Edit's protected Order/Services/Notes behavior—remain
   unchanged.
5. Inspect computed styles for Apfel UI/body type, Mazius section heading, exact Quincy paper/ink/
   signal variables, `38px` minimum field height, spacing, radius, hairline, critical error color,
   focus ring, and absence of stock shadow/motion/blue-purple neutral defaults.
6. Navigate the immediately adjacent Shoot and Order sections plus Create/Edit actions to confirm
   surviving `.admin-field`/`.create-project__fields` consumers are unchanged. Check console and
   network for zero unexplained error/warning.

Loading, open-overlay, read-only Client, permission, and conflict states do not exist for these
four controls. Record them as **not applicable with source rationale**, not unassessed. The
relevant material states are populated, empty, focus, invalid/error, and Create/Edit.

### Exact evidence paths and drift classification

Capture before-state at the TB1 base commit before editing and after-state from the final build,
with equivalent values and scroll position:

```text
docs/plans/revamp_2026_portal/evidence/TB1/create-client-before-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-after-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-before-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-after-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-before-390x844.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-after-390x844.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-before-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-after-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-before-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-after-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-before-390x844.png
docs/plans/revamp_2026_portal/evidence/TB1/edit-client-after-390x844.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-before-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-after-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-before-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-after-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-before-390x844.png
docs/plans/revamp_2026_portal/evidence/TB1/create-client-email-error-focus-after-390x844.png
```

TB0's existing `current-create-project-*-empty-correct.png` files are contextual baseline only;
they do not show the opened Client block and cannot replace the matched TB1 before captures.

The prototype contains no comparable Create/Edit Project Client form; its Tonomo view displays
client facts but is not an editable counterpart. Do not fabricate a prototype match. Document
that source-backed non-comparability, then compare typography/tokens/geometry against the ported
Quincy design system and comparable prototype fields where available, at:

```text
docs/plans/revamp_2026_portal/evidence/TB1/reference-assessment.md
docs/plans/revamp_2026_portal/evidence/TB1/drift-register.md
docs/plans/revamp_2026_portal/evidence/TB1/dependency-and-style-audit.md
docs/plans/revamp_2026_portal/evidence/TB1/automated-gates.txt
docs/plans/revamp_2026_portal/evidence/TB1/manual-qa.md
docs/plans/revamp_2026_portal/evidence/TB1/bundle-css-delta.md
```

In `drift-register.md`, classify every material difference as Conforming, Intentional evolution,
Required platform/accessibility/security change, Unwanted drift, or Unassessed. The explicit
label/error association and alert semantics should normally be Required accessibility change;
visual differences should normally be corrected to Conforming. Intentional evolution/deferral
needs owner disposition. Unassessed material differences block acceptance. Redaction-check every
image before commit.

### Deployment

TB1 changes the web bundle and app Worker static assets only. It adds no schema, binding, secret,
queue, Workflow, background, or webhook-ingress contract. After review and a green full gate:

1. record the active app Worker version/deployment id as the rollback target;
2. make the final web build;
3. from `portal/workers/app`, run
   `npx wrangler deploy --message "TB1 Tailwind shadcn foundation"`; and
4. perform a passive production smoke on Create and Edit at all three viewports, without saving a
   real project mutation. Confirm the Client fields, focus/error presentation, adjacent legacy
   sections, console/network, and static assets.

No background or webhook-ingress deployment and no D1 migration are required. After production
verification, update this plan's status with the commit hash/version, update `docs/todo.md`, and
move this file with `git mv` to `docs/plans/implemented/` as required by repository policy.

### Concrete rollback

If a local/automated gate fails, do not deploy. If production smoke finds a regression, restore
the explicitly recorded pre-TB1 app Worker version from `portal/workers/app` with the following
command, replacing the placeholder with the version id recorded before deployment:

```bash
npx wrangler rollback <recorded-pre-TB1-version-id> --message "Rollback TB1 Tailwind shadcn foundation" --yes
```

Wrangler `4.112.0` accepts the version id positionally and supports both flags above. This
atomically restores the previous Worker and web assets. Repeat the passive smoke and record the
rollback version.

The source revert consists exactly of:

- reverting the TB1 dependency and lockfile additions;
- removing `apps/web/components.json`, the Tailwind Vite plugin/alias, the Preflight-free Tailwind
  imports/token bridge, `components/ui`, `components/quincy/QuincyField.tsx`, and `lib/utils.ts`;
- restoring `apps/web/tsconfig.json` by removing TB1's `baseUrl` and `paths` additions;
- removing TB1's alias entries from both `apps/web/vitest.config.ts` and
  `apps/web/vitest.dom.config.ts`;
- removing the `.quincy-input` focus/focus-visible and invalid rules added to
  `apps/web/src/styles/app.css`;
- restoring the prior four native label/input blocks and legacy `create-project__fields` owner in
  `ProjectFields.tsx`; and
- reverting only TB1's focused tests/evidence record changes.

There is no schema/data/resource rollback. Do not delete user/project data, touch D1/R2/KV, or
redeploy unchanged background/webhook Workers. Because the previous legacy CSS selectors remain
for other consumers, rollback does not require reconstructing deleted shared CSS.

## Execution record

Built by Luna (xhigh effort), reviewed by 2 fresh Sol diff-review rounds (2 real issues fixed each
round: a legacy `.grid` CSS name collision breaking the responsive layout, thin Edit-mode test
coverage, then a still-partially-vacuous test assertion and stale bundle evidence), then 3 Opus
final-draft/evidence review rounds:

1. First Opus pass: verdict APPROVE on the code (independently re-derived the grid fix, cascade
   contract, Preflight absence, and token collisions from primary sources), but found the required
   evidence package (18 screenshots + 5 documents) was missing, plus a `FieldGroup` double-
   `display`-utility fragility and a stale test count.
2. Both code items were fixed directly (`FieldGroup` now `cn("w-full", className)`, single display
   owner; the stale 192→193 count corrected) and the evidence package was captured: 18 matched
   `1440×900`/`1024×768`/`390×844` before/after screenshots (9 "before" from a clean `git
   stash`-restored checkout of the TB1 base commit, 9 "after" from the final build), plus
   `reference-assessment.md`, `drift-register.md`, `dependency-and-style-audit.md`,
   `automated-gates.txt`, and `manual-qa.md`.
3. The manual-QA/drift-comparison pass (danger-mode Luna) reported one blocking finding — typed
   values in the `type="email"`/`type="tel"` controls allegedly not retaining in the DOM. The
   orchestrating session independently reproduced the exact scenario directly (a separate
   authenticated browser session, real keystrokes, a real submit-triggered validation render, no
   `POST` sent) and found the value genuinely retained throughout, matching the already-passing
   automated suite. A second Opus review then traced the actual Base UI source (`Input` resolves
   through `useFieldRootContext()`; no `Field.Root` exists anywhere in the app, so validation
   hooks are all no-ops) and confirmed no code path could cause the reported loss — the most likely
   cause is a Chrome-automation input-dispatch artifact specific to typed attribute inputs, with a
   documented precedent for this exact class of false positive (TB0A's own recorded
   "browser-automation key-dispatch limitation"). This Base UI shared-ref finding is recorded as a
   non-blocking latent risk in `docs/lessons.md` for future Field.Root consumers.
4. A final Opus confirmation pass verified all fixes and found 5 places where corrected sections
   still had stale prose asserting the retracted regression as fact (headers said PASS, prose
   underneath still said FAIL) — all 5 corrected, plus two optional notes added (a byte-identical
   before/after screenshot pair explained in `drift-register.md`; the `lessons.md` entry above).

The independent verification gate (§5) was run directly by the orchestrating session, outside any
codex sandbox, at multiple points and confirmed green every time: `npm run typecheck`,
`npm run build -w @quincy/web` (byte counts matched the evidence record exactly), `npm run test
--workspaces` (all real suites — db 22/22, web node 68/68, web DOM 193/193, app 180+1 skipped,
background 191/191, webhook-ingress 13/13 — only the documented `@quincy/shared` quirk causes the
nonzero exit), and `npx vitest run --config packages/shared/vitest.config.ts` (60/60). Two of the
builder's own sandboxed test runs had separately reported an `EPERM` loopback-binding failure on
the Worker suites and once an unrelated `RichTextEditor` failure; neither reproduced in the
orchestrating session's real runs, confirming both were sandbox artifacts, not real regressions.

## Acceptance checklist

- [x] TB0A and TB0B are both recorded live and accepted before implementation begins; the current
      TB0A acceptance-status discrepancy is resolved explicitly. (TB0A formally accepted 2026-08-25
      — see `docs/plans/implemented/Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md`.)
- [x] React/React DOM remain exactly on the accepted React `19.2.x` baseline and all React 19.2
      baseline gates remain green; no runtime work entered TB1.
- [x] Registry versions and peer contracts were rechecked at execution time; all direct additions
      are exact stable pins and the lockfile has no unexplained churn. (`lucide-react` drifted
      1.33.0 → 1.34.0 at execution time, permitted by the plan; recorded in
      `bundle-css-delta.md`.)
- [x] Tailwind v4 runs through `@tailwindcss/vite`; CSS-first theme/utilities are present and
      Preflight is absent from source and built CSS. (Confirmed directly against built CSS by two
      independent Opus passes.)
- [x] `components.json` exactly matches the Base UI `base-sera`, neutral, CSS-variable, Lucide,
      `rsc:false`, `tsx:true`, empty-config/no-prefix contract and contains no registry/dark-mode
      addition.
- [x] TypeScript, Vite, and both standalone Vitest configs resolve `@/* → src/*`; unrelated imports
      were not rewritten. (`tsconfig.json`'s `baseUrl` was correctly omitted — TypeScript 7 rejects
      it (`TS5102`) and `moduleResolution: "bundler"` resolves `paths` without it — a builder
      deviation from the plan's literal text that a fresh Sol review confirmed correct.)
- [x] `components/ui`, `components/quincy`, and `lib/utils` are app-local; no shared UI package or
      second primitive system was introduced.
- [x] Only Input and the minimal Field/Label/Error surface needed by the Client block were added;
      no Button, Separator, bulk component, `tw-animate-css`, unused cva dependency, or unused
      generated Field family is committed. (`class-variance-authority` was dropped entirely —
      confirmed absent from the lockfile, `node_modules`, and every source import.)
- [x] Only Agency, Agent, Agent email, and Agent phone in the `ProjectFields` Client section
      converted; every other form/screen/component remains on its prior markup and owner.
- [x] All four controls retain their controlled values, exact callback field names, DOM order,
      native type/attributes, editability, and parent payload behavior in Create and Edit.
      (Independently reproduced live by the orchestrating session after an initial false-positive
      finding — see the Execution record above.)
- [x] Label association, exact email error text/display, error clearing, explicit error
      association/announcement, `aria-invalid`, native prop pass-through, and ref-to-native-input
      behavior pass focused tests and manual QA.
- [x] `validateProjectFields` preserves empty/valid/invalid Agent email behavior in both modes;
      all existing Create/Edit differences outside Client remain unchanged.
- [x] Quincy typography, spacing, responsive four/two/one-column geometry, hairlines, radii,
      signals, focus, and motion behavior are preserved at desktop/compact/phone.
- [x] No stock Sera/shadcn appearance, raw Tailwind palette, stock shadow/radius/ring, dark branch,
      or extra styling owner leaks into the rendered block. (The `FieldGroup` double-display-owner
      fragility found by Opus was fixed — `cn("w-full", className)`, one display owner.)
- [x] The semantic Quincy token bridge uses the real existing variables and one CSS entry; legacy
      CSS coexists cleanly with one styling owner per migrated element, and the sampled overlapping
      Quincy custom properties retain their pre-import computed values.
- [x] Repo-wide grep proves every deleted selector/generated source has zero remaining consumer;
      the known shared legacy selectors remain available to untouched consumers. (No selector was
      deleted in TB1 — all legacy selectors retain real consumers, confirmed by grep.)
- [x] Matched Create/Edit before/after evidence exists at `1440×900`, `1024×768`, and `390×844`;
      focus/error evidence and the prototype non-comparability/design-system assessment are
      recorded.
- [x] Every material difference is classified; no Unwanted drift or Unassessed material item
      remains, and owner disposition exists for any Intentional evolution/deferral. (The one
      initially-reported Unwanted drift item was independently re-verified and corrected to
      Conforming — see the Execution record above.)
- [x] Raw/gzip JS and CSS, total dist, direct dependency, and absolute/percentage deltas are
      recorded and explained; generator-only/unused packages are absent from the browser bundle.
- [x] Focused tests, typecheck, web build, every runnable workspace suite, and the dedicated shared
      suite are green with no unexplained warning. (Independently re-run by the orchestrating
      session multiple times outside any sandbox — see the Execution record above.)
- [x] Manual Create/Edit QA is complete at all three viewports, including valid/invalid/focus,
      label keyboard/pointer behavior, persistence on a disposable local fixture, adjacent legacy
      sections, console, and network.
- [ ] App-only deploy, rollback target, commit SHA, production Worker version, and passive
      production smoke are recorded; no migration or background/webhook deployment occurred.
- [ ] After production verification, the status/todo are updated and this plan is moved with
      `git mv` to `docs/plans/implemented/`.

## Primary external implementation references

- [Tailwind CSS v4 release and Vite integration](https://tailwindcss.com/blog/tailwindcss-v4)
- [Tailwind Preflight import boundary](https://tailwindcss.com/docs/preflight)
- [Tailwind CSS compatibility floor](https://tailwindcss.com/docs/compatibility)
- [Tailwind CSS-first theme variables and `@theme inline`](https://tailwindcss.com/docs/theme)
- [Tailwind stock theme source](https://github.com/tailwindlabs/tailwindcss/blob/main/packages/tailwindcss/theme.css)
- [Tailwind arbitrary responsive breakpoints](https://tailwindcss.com/docs/responsive-design#using-arbitrary-values)
- [shadcn Vite installation](https://ui.shadcn.com/docs/installation/vite)
- [shadcn `components.json` contract](https://ui.shadcn.com/docs/components-json)
- [shadcn CLI](https://ui.shadcn.com/docs/cli)
- [Sera style rationale](https://ui.shadcn.com/docs/changelog/2026-04-sera)
- [Base UI default rationale](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
- [shadcn Base UI Input](https://ui.shadcn.com/docs/components/base/input)
- [shadcn Field](https://ui.shadcn.com/docs/components/base/field)
- [Base UI React package](https://www.npmjs.com/package/@base-ui/react)

## Implementation-time open item

1. Resolve the authoritative precondition mismatch before code work: TB0A is deployed and TB1 is
   described as unblocked, but TB0A's own plan and `docs/todo.md` still say it is not formally
   accepted. The reviewer/owner must record acceptance or amend the TB1 precondition; this plan
   deliberately does not guess which governance action is intended.

   **Orchestrator disposition (2026-08-24):** the owner chose to proceed with TB1 planning now and
   close out TB0A's remaining acceptance items (Lightbox/PhotoGrid interaction check, 22
   visual-parity screenshots vs. the TB0 baseline) before TB1's own **build** phase begins, not
   before its planning phase.

   **Resolved (2026-08-25):** the 22 matched `tb0a-*` visual-parity screenshots are captured and
   show zero React 19 regression. The owner formally accepted TB0A on this evidence, with
   Lightbox/PhotoGrid interaction and the sign-out/in cycle remaining open as tracked low-priority
   follow-up debt in `docs/todo.md` (twice attempted, blocked both times by local/production
   infrastructure limits, not by any found regression). TB0A is now both live and accepted —
   `docs/plans/implemented/Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md`. This precondition is
   satisfied; TB1 build work may proceed.

## Opus final-approval notes for the builder (non-blocking)

The plan review pipeline concluded APPROVE after 2 Sol rounds and 2 Opus tier-2 rounds
(2026-08-24). The approving Opus review flagged four small items that did not justify a further
revision round but are worth the builder's attention:

1. **Tailwind v4 `@source`/content-detection base path is unaddressed.** The plan specifies the CSS
   entry and layers but not the content-detection base. The default base is the build CWD
   (`portal/apps/web` for both `npm run dev` and `npm run build -w @quincy/web`), and
   `portal/.gitignore` excludes `dist/`/`node_modules/`, so this works as-is — record one line
   confirming this in the execution record rather than leaving it unstated, since later TB phases
   inherit this same setup.
2. **`Input`'s `font: var(--type-body); font-size: 14px` combination is utility-order-sensitive.**
   §5 gives exact values but not exact Tailwind utility strings for the primitives (unlike §6's
   grid). If implemented as two separate Tailwind utilities in the same layer, sort order could let
   the `font` shorthand reset the size back to `16px`. Prefer one arbitrary-property utility
   carrying the resolved shorthand, or verify explicitly via the existing manual-QA computed-style
   check (§ Manual QA matrix, step 5).
3. **`--radius: var(--radius-sm)` in the token bridge's `:root` block is currently dead** — it has
   no `@theme inline` mapping and no consumer. Either map it (`--color-radius`/`--radius` Tailwind
   utility) or drop the unused `:root` entry.
4. **`@base-ui/react`'s peer-dependency check should read `peerDependenciesMeta`, not just
   `peerDependencies`.** Its listed peers (`date-fns ^4.0.0`, `@date-fns/tz ^1.2.0`) are marked
   `optional: true` — installing them unconditionally would violate the plan's own "no unused
   packages in the bundle" acceptance criterion. §1's recheck commands should include
   `peerDependenciesMeta` so the builder doesn't install unneeded optional peers.

**Operational note:** the Manual QA matrix requires signing in to local dev at
`http://localhost:8787` as the seeded admin — a real Google OAuth flow. Per this session's standing
rule, that step is performed by the human, not an agent; Luna must pause and report rather than
attempt it.
