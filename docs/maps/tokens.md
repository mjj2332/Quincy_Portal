Answers: which file under `portal/apps/web/src/styles/tokens/` defines a token, the order they load in, and which guard test protects what. (There is no `styles/tokens.css`.)

## Load order
`"./styles/index.css"` portal/apps/web/src/main.tsx:7 → `@layer theme, base, components, utilities` portal/apps/web/src/styles/index.css:1, Tailwind `theme.css` portal/apps/web/src/styles/index.css:2, then `colors.css` portal/apps/web/src/styles/index.css:5, `spacing.css` portal/apps/web/src/styles/index.css:6, `typography.css` portal/apps/web/src/styles/index.css:7, `tailwind.css` portal/apps/web/src/styles/index.css:8, `reui.css` portal/apps/web/src/styles/index.css:11, `inverse.css` portal/apps/web/src/styles/index.css:12, `base.css` portal/apps/web/src/styles/index.css:13, `./fonts.css` portal/apps/web/src/styles/index.css:14, `./app.css` portal/apps/web/src/styles/index.css:15.

## Token files
| File | Defines | Example |
|---|---|---|
| `portal/apps/web/src/styles/tokens/colors.css` | ink/paper/greige/signal ramps, then semantic roles | `--ink-900` portal/apps/web/src/styles/tokens/colors.css:9, `--bg-canvas` portal/apps/web/src/styles/tokens/colors.css:73, `--text-primary` portal/apps/web/src/styles/tokens/colors.css:79 |
| `portal/apps/web/src/styles/tokens/spacing.css` | 4px spacing grid, radii, shadows, motion, page container, z-index ladder | `--space-4` portal/apps/web/src/styles/tokens/spacing.css:13, `--radius-md` portal/apps/web/src/styles/tokens/spacing.css:26, `--dur-base` portal/apps/web/src/styles/tokens/spacing.css:48, `--container-page` portal/apps/web/src/styles/tokens/spacing.css:58, `--gutter` portal/apps/web/src/styles/tokens/spacing.css:59 |
| `portal/apps/web/src/styles/tokens/typography.css` | families, size scale, leading, tracking, `--type-*` font shorthands | `--font-sans` portal/apps/web/src/styles/tokens/typography.css:16, `--text-base` portal/apps/web/src/styles/tokens/typography.css:25, `--type-body` portal/apps/web/src/styles/tokens/typography.css:61 |
| `portal/apps/web/src/styles/tokens/tailwind.css` | shadcn role layer in `:root`, exposed to utilities by `@theme inline` portal/apps/web/src/styles/tokens/tailwind.css:22 | `--background` portal/apps/web/src/styles/tokens/tailwind.css:2, `--ring` portal/apps/web/src/styles/tokens/tailwind.css:19 |
| `portal/apps/web/src/styles/tokens/reui.css` | ReUI base-nova bridge: roles nova adds beyond shadcn's set | `--radius` portal/apps/web/src/styles/tokens/reui.css:55, `--success` portal/apps/web/src/styles/tokens/reui.css:95, `--sidebar` portal/apps/web/src/styles/tokens/reui.css:193 |
| `portal/apps/web/src/styles/tokens/inverse.css` | role overrides for `[data-surface="inverse"]` portal/apps/web/src/styles/tokens/inverse.css:24 (Lightbox, selection bar), restored by `[data-surface="default"]` portal/apps/web/src/styles/tokens/inverse.css:51 | `--background` portal/apps/web/src/styles/tokens/inverse.css:25 |
| `portal/apps/web/src/styles/tokens/base.css` | element defaults, the global focus ring, `.q-*` type helpers | `.q-display` portal/apps/web/src/styles/tokens/base.css:71 |
| `portal/apps/web/src/styles/tokens/fonts.css` | `@font-face` rules that nothing imports (its `../assets/fonts` path does not exist). The live faces are in `portal/apps/web/src/styles/fonts.css` | — |

## Spacing, overlay/scrim, typography, focus — where to look
| Need | Token |
|---|---|
| Spacing | `--space-0` portal/apps/web/src/styles/tokens/spacing.css:9 … `--space-11` portal/apps/web/src/styles/tokens/spacing.css:20 |
| Stacking | `--z-popover` portal/apps/web/src/styles/tokens/spacing.css:62 < `--z-menu` portal/apps/web/src/styles/tokens/spacing.css:64 < `--z-dialog` portal/apps/web/src/styles/tokens/spacing.css:65 < `--z-toast` portal/apps/web/src/styles/tokens/spacing.css:66 |
| Overlay motion | `--overlay-enter` portal/apps/web/src/styles/tokens/spacing.css:86, `--overlay-exit` portal/apps/web/src/styles/tokens/spacing.css:87 |
| Scrim | `--scrim-overlay` portal/apps/web/src/styles/tokens/colors.css:125 |
| Type scale | `--text-2xs` portal/apps/web/src/styles/tokens/typography.css:22 … `--text-6xl` portal/apps/web/src/styles/tokens/typography.css:33 |
| Focus ring | `--focus-ring` portal/apps/web/src/styles/tokens/colors.css:98 → `--ring` portal/apps/web/src/styles/tokens/tailwind.css:19; inverse `--focus-ring` portal/apps/web/src/styles/tokens/inverse.css:43; ReUI `--focus` portal/apps/web/src/styles/tokens/reui.css:131 |
| Focus rule | unlayered `:focus-visible` portal/apps/web/src/styles/tokens/base.css:25; default inside `@layer base`: `outline-color` portal/apps/web/src/styles/tokens/base.css:67 |

## Guard tests (all in `portal/apps/web/src/styles/`)
| File | Enforces |
|---|---|
| `portal/apps/web/src/styles/design-system-guards.test.ts` | 13 repeat-offender rules, e.g. `every custom property used in CSS is defined` portal/apps/web/src/styles/design-system-guards.test.ts:96, `no focus ring is suppressed in unlayered CSS` portal/apps/web/src/styles/design-system-guards.test.ts:301, `focus ring colour never comes from a raw palette step` portal/apps/web/src/styles/design-system-guards.test.ts:993. Baselines only shrink. |
| `portal/apps/web/src/styles/overlay-stacking.guard.test.ts` | `orders popover < menu < dialog < toast` portal/apps/web/src/styles/overlay-stacking.guard.test.ts:11; dialogs never use the registry's bare z-50 |
| `portal/apps/web/src/styles/frame-token-bridge.guard.test.ts` | `the frame token bridge` portal/apps/web/src/styles/frame-token-bridge.guard.test.ts:264 |
| `portal/apps/web/src/styles/sidebar-token-bridge.guard.test.ts` | `the sidebar token bridge` portal/apps/web/src/styles/sidebar-token-bridge.guard.test.ts:314 |
| `portal/apps/web/src/styles/signal-text-tokens.guard.test.ts` | `every text-/bg-/border-signal-* utility` portal/apps/web/src/styles/signal-text-tokens.guard.test.ts:50 has a declared token |
| `portal/apps/web/src/styles/unlayered-utility.guard.test.ts` | `unlayered CSS never redefines a Tailwind utility` portal/apps/web/src/styles/unlayered-utility.guard.test.ts:12 |
| `portal/apps/web/src/styles/page-frame.guard.test.ts` | `page frame (real files)` portal/apps/web/src/styles/page-frame.guard.test.ts:400: one `--container-page`, full/capped split |
| `portal/apps/web/src/styles/dashboard-fill.guard.test.ts` | `dashboard fill rules` portal/apps/web/src/styles/dashboard-fill.guard.test.ts:215 |
| `portal/apps/web/src/styles/shell-breakpoint.guard.test.ts` | the shell has exactly one collapse breakpoint |
| `portal/apps/web/src/styles/app-railed.test.ts` | railed shell layout, rail width per `data-rail-mode`, toast inset |
| `portal/apps/web/src/styles/link-preview-card.design.test.ts` | `link preview card design` portal/apps/web/src/styles/link-preview-card.design.test.ts:25 |

Run them (node environment, ~1 s), from `portal/apps/web`:

    npx vitest run --config vitest.config.ts src/styles

Last verified against 495766e9
