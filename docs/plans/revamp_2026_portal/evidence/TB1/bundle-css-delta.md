# TB1 bundle, CSS, and dependency delta

Evidence basis: TB1 base is `HEAD` before TB1 edits; final is the post-build working tree on
2026-08-25. Both builds ran `npm run build -w @quincy/web` and the exact inventory from the TB1
plan with `gzip -9`.

## Live registry recheck

The live npm recheck used an isolated cache because the default npm cache was root-owned and
returned `EPERM` before contacting the registry. The chosen stable pins are:

| Package | Plan candidate | Rechecked/used | Result |
| --- | ---: | ---: | --- |
| `tailwindcss` | 4.3.3 | 4.3.3 | unchanged |
| `@tailwindcss/vite` | 4.3.3 | 4.3.3 | unchanged |
| `shadcn` | 4.19.0 | 4.19.0 | unchanged |
| `@base-ui/react` | 1.7.0 | 1.7.0 | unchanged; package name lookup returned `@base-ui/react` |
| `lucide-react` | 1.33.0 | 1.34.0 | drifted to latest stable |
| `clsx` | 2.1.1 | 2.1.1 | unchanged |
| `tailwind-merge` | 3.6.0 | 3.6.0 | unchanged |

`@tailwindcss/vite` requires `vite ^5.2.0 || ^6 || ^7 || ^8`. `@base-ui/react` requires React/
React DOM 17/18/19 and lists `date-fns`, `@date-fns/tz`, and `@types/react` as optional peers in
`peerDependenciesMeta`; no date packages were added. `tailwind-merge` has no peer dependency.

## Asset inventory

| State | Asset | Raw bytes | Gzip bytes |
| --- | --- | ---: | ---: |
| Base | `apps/web/dist/assets/index-BDaqREkt.js` | 917,710 | 276,536 |
| Base | `apps/web/dist/assets/index-BQpYqR4q.css` | 101,457 | 17,388 |
| Final | `apps/web/dist/assets/index-BRcM4W58.js` | 955,297 | 289,583 |
| Final | `apps/web/dist/assets/index-NmV-0yUO.css` | 112,876 | 19,561 |

| Total | Base | Final | Absolute delta | Percentage delta |
| --- | ---: | ---: | ---: | ---: |
| JavaScript raw | 917,710 | 955,297 | +37,587 | +4.10% |
| JavaScript gzip | 276,536 | 289,583 | +13,047 | +4.72% |
| CSS raw | 101,457 | 112,876 | +11,419 | +11.26% |
| CSS gzip | 17,388 | 19,561 | +2,173 | +12.50% |
| JS + CSS raw | 1,019,167 | 1,068,173 | +49,006 | +4.81% |
| JS + CSS gzip | 293,924 | 309,144 | +15,220 | +5.18% |
| Total `apps/web/dist` raw | 2,640,716 | 2,689,722 | +49,006 | +1.86% |

Refreshed 2026-08-25 after the Opus final-draft review's fix (below) — the CSS byte counts are
unchanged from the prior recorded figures (`.flex{display:flex}` remains in the built CSS, emitted
for other consumers elsewhere in the app), only the JS hash/byte count shifted by a few bytes from
the source edit itself.

The non-JS/CSS assets are unchanged. Tailwind accounts for the CSS increase through its theme and
the utility rules detected from the app; the expanded import is theme/utilities only, and neither
source nor built CSS contains `tailwindcss/preflight.css` or a Preflight reset. Existing unlayered
Quincy tokens/base/app styles remain the visual authority. The exact responsive grid utilities,
`38px` field minimum, Quincy border/radius/padding/font utilities, and unlayered `.quincy-input`
focus/invalid rules are present in the final CSS.

The JS increase is primarily the runtime Base UI Input implementation plus the small `cn()` path
(`clsx`/`tailwind-merge`); Base UI is the approved runtime primitive dependency and is tree-shaken
to the imported input path. `lucide-react` has no source import and contributes zero browser-bundle
strings; unused Lucide exports are tree-shaken. The pinned `shadcn` CLI is dev-only and contributes
zero browser-bundle strings. `class-variance-authority` was dropped: the reviewed trimmed source
does not invoke cva, and it is absent from direct dependencies, the lockfile, and the browser
bundle. Generator-only Separator source, Field-family exports, Button, `tw-animate-css`, and
`shadcn/tailwind.css` are absent.

## Direct dependency delta

`portal/apps/web/package.json` is unchanged. All direct additions remain owned by
`portal/package.json`:

| Ownership | Package | Before | After | Purpose |
| --- | --- | --- | --- | --- |
| runtime | `@base-ui/react` | — | 1.7.0 | Base UI native Input primitive |
| runtime | `lucide-react` | — | 1.34.0 | D-16 approved icon baseline; unused in TB1 |
| runtime | `clsx` | — | 2.1.1 | `cn()` composition |
| runtime | `tailwind-merge` | — | 3.6.0 | Tailwind v4-aware `cn()` conflict resolution |
| dev | `tailwindcss` | — | 4.3.3 | CSS-first compiler/theme/utilities |
| dev | `@tailwindcss/vite` | — | 4.3.3 | Vite integration |
| dev | `shadcn` | — | 4.19.0 | Pinned generator/review CLI only |

The lockfile adds 326 package entries for the pinned Tailwind/Base UI/shadcn toolchain; no
pre-existing package entry changed version. The added toolchain entries are therefore explained
by the direct additions, not unrelated dependency churn.

## Source/style audit notes

- The pinned CLI help exposed four proposed files (`input`, `label`, `separator`, `field`); the
  committed source is trimmed to `Input`, `Label`, `Field`, `FieldGroup`, `FieldLabel`, and
  `FieldError`. No Separator or cva source remains.
- The exact legacy-selector grep still finds real consumers in Shoot, Order, Dropbox, Notes,
  Property, Admin, and surrounding section/head markup. No legacy selector was deleted.
- The exact bridge collision sweep found only the two intentional existing reuses: `--accent`
  (including `.app.acc-olive`) and local tile/status `--ring` values. Both remain scoped and
  intentional.
- No explicit Tailwind `@source` is needed: Tailwind's content-detection base is the build CWD,
  `portal/apps/web`, for both `npm run dev` and `npm run build -w @quincy/web`; `dist/` and
  `node_modules/` are excluded by `portal/.gitignore`.
- The approving note's dead `--radius: var(--radius-sm)` root bridge entry was dropped because
  it had no `@theme inline` mapping or consumer. The live Quincy `--radius-*` tokens remain
  authoritative and the composite uses `var(--radius-sm)` directly.
- The Input font shorthand is one arbitrary-property utility carrying the resolved 14px Quincy
  shorthand, avoiding utility-order reset of the size; the emitted CSS was inspected directly.
- **Opus final-draft review fix (2026-08-25):** `components/ui/field.tsx`'s `FieldGroup` originally
  defaulted to `cn("flex w-full", className)`. Since the Client-block usage site separately applies
  `[&]:grid` (Tailwind's arbitrary-variant form, chosen in an earlier fix round specifically to
  avoid colliding with a legacy `.grid` selector — see below), the rendered element carried both a
  `flex` and a `[&]:grid` display utility simultaneously. It rendered correctly only because
  Tailwind happens to sort the variant-carrying utility after the plain one within the same layer —
  correct today, but an undocumented two-owner fragility on a primitive the plan calls
  "feature-neutral." Fixed by dropping the default to `cn("w-full", className)`, leaving exactly one
  display-owning utility (the caller's `[&]:grid`) on the only real consumer. Rebuilt and reran the
  focused TB1 DOM suites (`ProjectFields.dom.test.tsx`, `QuincyField.dom.test.tsx`,
  `CreateProject.dom.test.tsx` — 9/9 pass) and confirmed via the built CSS that
  `.\[\&\]\:grid{display:grid}` still compiles correctly and the legacy `.grid` selector still
  cannot match it.

## Automated gate record

- `npm run typecheck`: PASS; all six workspace typechecks passed.
- `npm run build -w @quincy/web`: PASS; the existing >500 kB chunk advisory appeared in both
  base and final builds and is not TB1-specific.
- `npm run test --workspaces`: real suites PASS — db 22/22; web node 68/68; web DOM 193/193;
  app 180 passed, 1 skipped; background 191/191; webhook-ingress 13/13. The command exits 1
  only because `@quincy/shared` has no `test` script, the documented workspace-command quirk;
  that is expected and not a real suite failure. **Independently re-run directly by the
  orchestrating session outside any codex sandbox** (not just the builder's own sandboxed run,
  which had separately reported an `EPERM` binding `127.0.0.1` on the Worker suites and one
  unrelated `RichTextEditor` DOM-test failure — neither reproduced in the real, unsandboxed run,
  confirming both were sandbox artifacts of the builder's environment, not real regressions).
- `npx vitest run --config packages/shared/vitest.config.ts`: PASS; 9 files, 60/60 tests.

The npm install/audit warning is pre-existing: a production-only `npm audit --omit=dev` against
both the TB1 base lock and final lock reports the same 7 vulnerabilities (6 moderate, 1 high) in
existing `esbuild`/legacy `drizzle-kit` transitive tooling, `hono`, `nanoid`, and `postcss`.
`npm audit fix --force` proposes a breaking `drizzle-kit` downgrade, so no unrelated audit repair
was applied in TB1.
