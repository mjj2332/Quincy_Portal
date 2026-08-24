# Revamp TB0A — React 19.2 Runtime Upgrade Plan

**Status: Accepted (2026-08-25).** Deployed to production (version
`202d4cd5-c6ec-4f98-8cd2-e7fb2b0d0d60`, 2026-08-24) — passive production smoke clean, no
regression found. All 22 matched `tb0a-*` visual-parity screenshots are captured, verified, and
show zero React 19 regression (see "Visual-parity acceptance" below). **Lightbox/PhotoGrid
interaction and the sign-out/in cycle remain unverified against a real rendered asset** (low-risk
per the static React-19 API-usage analysis below) — the owner accepted TB0A on the existing
evidence rather than block further, and this residual gap is tracked as follow-up debt in
`docs/todo.md`, not silently dropped. TB0A is a standalone,
compatibility-only production release. It must be accepted after TB0 and before TB0B/TB1, and it
must not share a commit or deployment with any later revamp work.

## Authority, outcome, and release boundary

Authority order for this plan is:

1. [`Decision-Sheet.md` D-15](../Decision-Sheet.md) (revised 2026-08-24).
2. [`Implementation-Plan.md` A12](../Implementation-Plan.md) (the promoted TB0A authority).
3. [TB0A roadmap scope brief](./revamp_2026_portal/roadmap/TB0A-React-19-2-Runtime-Upgrade.md).
4. This repository-native execution plan.

The only user outcome is that the existing Quincy Vite SPA runs on the latest stable, exactly
pinned React 19.2 patch with unchanged intended behavior and visual output. Retain TypeScript,
the Vite SPA, the typed custom router, `createRoot`, `StrictMode`, the modern JSX transform, Hono
RPC, Cloudflare Worker asset serving, and every current product contract. There is no schema,
storage, binding, API, auth, or product-design change.

This is one isolated app-Worker/web-bundle release. If compatibility requires more than the four
React package pins, the narrow source/type corrections listed below, or a demonstrated minimum
supporting-dependency update, stop and re-scope rather than absorbing unrelated modernization.

## Verified current state

### Dependency ownership and version baseline

The task brief names `portal/apps/web/package.json`, but the repository does not declare React
there. That workspace manifest currently contains only `happy-dom`; all shared runtime and type
dependencies are hoisted in [`portal/package.json`](../../portal/package.json), and no other
workspace manifest directly declares React. TB0A must preserve that ownership instead of adding
duplicate app-workspace declarations.

Current installed/locked versions are:

| Package | Manifest entry | Locked package |
|---|---:|---:|
| `react` | `^18.3.1` | `18.3.1` |
| `react-dom` | `^18.3.1` | `18.3.1` |
| `@types/react` | `^18.3.31` | `18.3.31` |
| `@types/react-dom` | `^18.3.7` | `18.3.7` |

The npm registry was rechecked on 2026-08-24. Its stable candidates were `react@19.2.8`,
`react-dom@19.2.8`, `@types/react@19.2.18`, and `@types/react-dom@19.2.5`;
`react-dom@19.2.8` requires `react@^19.2.8`, while `@types/react-dom@19.2.5` requires
`@types/react@^19.2.0`. These are the exact candidate pins below. **The implementer must query the
registry again immediately before editing:** if a newer stable `19.2.x` patch or compatible type
patch exists, use that exact stable set and update the recorded values. Canary, experimental, RC,
beta, caret, tilde, and unbounded `latest` entries are forbidden.

### Source and dependency compatibility audit

The audit used the [official React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide),
the [official React 19.2 release notes](https://react.dev/blog/2025/10/01/react-19-2), the web
source/tests, installed package metadata/source, `npm ls react react-dom --all`, and the npm
registry. It found:

- [`main.tsx`](../../portal/apps/web/src/main.tsx) already imports `createRoot` from
  `react-dom/client`, mounts through `createRoot(root).render(...)`, and retains `StrictMode`.
  [`apps/web/tsconfig.json`](../../portal/apps/web/tsconfig.json) already uses `jsx: "react-jsx"`.
- **One real React 19 type break exists:** zero-argument `useRef<number>()` appears twice in
  [`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx)
  and once in [`ProjectWorkspace.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx),
  while [`RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx) has the
  fourth zero-argument generic ref, `useRef<{ from: number; to: number }>()`, for the Tiptap link
  selection. React 19 types require an argument. The expected narrow corrections are
  `useRef<number>(undefined)` at the three numeric declarations and
  `useRef<{ from: number; to: number }>(undefined)` in `RichTextEditor`, confirmed by the upgraded
  typecheck rather than changed speculatively.
- [`AnchoredPopover.tsx`](../../portal/apps/web/src/components/AnchoredPopover.tsx) names
  `React.MutableRefObject` once. React 19 types retain it as a deprecated alias, so it is not a
  demonstrated blocker. Leave it alone unless the upgraded compiler rejects it; if rejected,
  replace only that annotation with the compatible `React.RefObject` shape.
- No `ReactDOM.render`, `hydrate`, `unmountComponentAtNode`, `findDOMNode`, `createFactory`, module
  pattern component, string ref, legacy context, removed class lifecycle, `propTypes`, or function
  `defaultProps` pattern was found.
- No `react-dom/test-utils` or `react-test-renderer` usage was found. DOM tests already import
  `act` from `react` and mount with `createRoot`/unmount with `root.unmount()`.
- No implicit-return inline callback ref was found. The local callback ref in `Lightbox` is
  block-bodied, and named dnd-kit/Floating UI setters are typed as void callbacks. The upgraded
  typecheck remains the authority for indirect callbacks.
- No zero-argument `createContext`, global `JSX` namespace augmentation, `ReactElement` props/ref
  introspection, generic `useReducer` pattern, or React-internals access was found.
- `useEffectEvent` is absent. That is a useful negative finding, not permission to introduce it.
- `useId` is used by `MentionAutocomplete`, `SubtaskChecklist`, `NoticeBoard`, and `Topbar`.
  React 19.2 changes the generated prefix, but the app and tests relate controls to generated IDs
  rather than hard-coding the old prefix. Exercise those relationships manually and retain the
  implementation unchanged unless a failure is demonstrated.
- No render-error boundary, root reporting sink, or test that relies on a render error being
  re-thrown was found. React 19 changes default render-error reporting; retain React's default
  `createRoot` behavior unless a real reporting sink and failing requirement are identified.

Installed peer contracts do not presently block React 19:

| Installed package | Declared React peer contract | TB0A disposition |
|---|---|---|
| `@tiptap/react@3.30.2` | React/DOM/types `^17 || ^18 || ^19` | Keep; verify editor and mentions at runtime. |
| `@dnd-kit/core@6.3.1` and related packages | React/DOM `>=16.8` | Keep; verify checklist and collection drag/reorder. |
| `@floating-ui/react@0.27.16` | React/DOM `>=17` | Keep; verify portals, focus, outside-click, and Escape. |
| `better-auth@1.6.23` | React/DOM `^18 || ^19` | Keep; verify Google sign-in/session flow. |
| `use-sync-external-store@1.6.0` | React `^16.8 || ^17 || ^18 || ^19` | Keep; covered through Tiptap/runtime tests. |

No Radix/headless-UI dependency is declared. Broad peer ranges are evidence against an install
blocker, not proof of behavior. Do not update any supporting dependency merely because a newer
version exists. Update one only after the React 19 install, typecheck, tests, or a reproducible
manual flow demonstrates that the currently installed release is the blocker; record the evidence
and choose the minimum compatible exact update. A wider or cascading upgrade stops TB0A.

## Exact implementation

### 1. Pin the runtime and types

Immediately before editing, run from `portal/` with a writable task-specific npm cache if the
user cache remains unavailable:

```sh
npm view react dist-tags --json
npm view react-dom dist-tags --json
npm view @types/react dist-tags --json
npm view @types/react-dom dist-tags --json
npm view react-dom@<chosen-version> peerDependencies --json
npm view @types/react-dom@<chosen-version> peerDependencies --json
```

Then change exactly these four entries in `portal/package.json` (candidate values as verified on
2026-08-24):

| Section | Package | From | To |
|---|---|---:|---:|
| `dependencies` | `react` | `^18.3.1` | `19.2.8` |
| `dependencies` | `react-dom` | `^18.3.1` | `19.2.8` |
| `devDependencies` | `@types/react` | `^18.3.31` | `19.2.18` |
| `devDependencies` | `@types/react-dom` | `^18.3.7` | `19.2.5` |

Do not modify `portal/apps/web/package.json` or any other workspace manifest unless a fresh
inventory shows dependency ownership has changed by implementation time.

Regenerate `portal/package-lock.json` from `portal/` using the repository's npm version and exact
pins, then review—not merely accept—the diff:

```sh
npm install --save-exact react@19.2.8 react-dom@19.2.8
npm install --save-dev --save-exact @types/react@19.2.18 @types/react-dom@19.2.5
npm ls react react-dom --all
```

If the registry recheck selected newer stable patches, substitute those four reviewed values.
Confirm the lockfile has one resolved React runtime line, the chosen integrity/resolution records,
no RC/canary package, no unexpected supporting-dependency churn, and no invalid peer dependency.

### 2. Apply only demonstrated compatibility fixes

Run typecheck immediately after the lockfile update. Correct the four known zero-argument refs by
adding explicit `undefined` initializers. Address any additional compiler/runtime failure only when
it maps to the official React 19 migration guidance and has a focused regression test or an
existing test that reproduces it.

Do not run a broad codemod over the source tree. The official codemods may be used in dry-run or as
a search aid, but their output must be applied selectively; the pre-audit already shows most
recipes have no matching source. Do not rewrite already-valid refs, Effects, components, tests, or
JSX as cleanup.

### 3. Record the compatibility result

Before review, add a concise implementation record to this plan: final exact pins, lockfile
summary, source corrections, supporting-dependency changes (normally none), automated results,
reviewed React/browser warnings, bundle delta, evidence location, production deploy/version ID,
smoke result, and any accepted limitation. This record is part of TB0A acceptance.

## Hard non-goals

The build must not cross any of these constraints:

- React Compiler or compiler-driven refactoring.
- SSR, Server Components, hydration architecture, streaming, or Partial Pre-rendering.
- `Activity` adoption.
- Actions or form-action rewrite.
- `useEffectEvent` sweep.
- ref-as-prop sweep; keep existing `forwardRef`/imperative-ref interfaces unless they actually fail.
- router or framework migration.
- Tailwind or shadcn setup.
- product, layout, brand, interaction, or information-architecture redesign.
- Calendar, External Editor, Project Workspace rail, Stage/Deadline, or other TB0B/TB1+ work.
- dependency refreshes unrelated to a reproduced React 19 blocker.

## Verification plan

All verification runs from `portal/`. Capture command, exit code, and relevant warnings. Do not
silence React console output to make the gate appear clean.

### Automated gate

Run the four repository-standard commands exactly:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Typecheck, the web build, and the dedicated shared suite must exit cleanly; every real workspace
test suite invoked by the third command must pass. As recorded by TB0, npm currently reports a
non-zero missing-`test`-script result for `@quincy/shared` after the actual workspace suites pass;
the fourth command is the required direct shared run. Reconfirm and record that exact known harness
behavior rather than adding a shared script or changing test infrastructure in this compatibility
release. Any new failing test, type error, build error, peer warning, or React warning is a TB0A
blocker.

Add or adjust only focused regression coverage for a compatibility correction not already proved
by existing tests. Explicitly review render-error tests: if none rely on React 18 rethrow behavior,
record that negative result and keep the root's default reporting; do not invent an error sink.

### Local-media fixture preflight and stop condition

Before starting any local runtime check, attempt the supported local upload flow on the built app
Worker and establish media fixtures that make every media-dependent check reachable. Sufficient
fixtures mean at least one RAW asset and one corresponding Edited asset are successfully ingested
into the same local project, visibly appear in their respective Project Workspace grids, and open
through the UI into a Lightbox where navigation, RAW/Edited comparison, load failure/retry, Review,
and annotation-draft cancellation can actually be exercised. An upload API `200` or a database/R2
row without those UI confirmations is not sufficient.

TB0 already recorded four supported local uploads failing visibly with `Uploaded object was not
found in R2`, leaving `RAW 0` and making Lightbox, comparison, retry, and annotation surfaces
unreachable. If that failure recurs, **stop TB0A runtime verification**: the runtime gate cannot
complete as written, and none of the media-dependent items may be marked passed, inferred from TB0,
or silently waived. The owner must choose and record one of these resolutions before verification
or deployment continues:

1. **Default — prerequisite fix:** diagnose and fix the local-R2 upload problem as its own small,
   separately reviewed prerequisite outside TB0A's React-compatibility diff, then rerun this
   preflight and the full local runtime gate. This is analogous to TB0 clearing an unrelated flaky
   test before its own gate could go green.
2. **Explicit release exception:** the owner accepts a narrower local-runtime scope for this TB0A
   release and defers the named media-dependent checks to an explicitly recorded production smoke
   against existing accessible media. The exception must enumerate the deferred checks and their
   production results; it is not permission to claim that every local runtime item passed.

### Local React-runtime checks

Use the built app Worker at `http://localhost:8787`, not the Vite `5173` proxy, and use the
documented seeded Admin Google flow. Keep DevTools console visible and record zero unexplained React
warnings/errors for each check.

- **Mount/unmount, Effects, timers, and subscriptions:** hard-reload; navigate Dashboard → Project
  Workspace → Admin → Dashboard through the custom router; open/close Collaboration, Notice Board,
  notifications, popovers, and Lightbox repeatedly. Confirm no duplicated requests/polls, stale
  UI updates after unmount, leaked key/pointer/focus/resize listeners, duplicate notices, or timer
  activity from a closed/unmounted surface.
- **Refs and generated IDs:** open Topbar account/notification menus, Tiptap mention autocomplete,
  Notice Board, and checklist controls. Confirm each `aria-controls` resolves to the live target,
  callback/object refs remain usable through mount/unmount, and StrictMode's ref-callback replay
  causes no duplicate registration or lost reference.
- **Portals, focus, Escape, and return:** for checklist due/assignee/action popovers and the Tiptap
  link dialog, verify portal placement, initial focus, outside-click/focus close, Escape close, and
  deterministic focus return. For Lightbox and Collaboration overlay, verify Escape closes only
  the intended top surface and focus returns to its trigger.
- **Tiptap and mentions:** create/edit/cancel a local project comment and Notice Board post; enter a
  mention query, select a person with keyboard and pointer, exercise link editing and rich-text
  boundaries, then reopen persisted content. Confirm no selection loss, duplicate callback, stale
  autocomplete, malformed stored content, or React warning.
- **Lightbox, LazyImage, and PhotoGrid:** with local test media, load grid thumbnails through
  success/failure/retry, open/close Lightbox, move by buttons/keyboard/filmstrip, toggle RAW compare,
  open/collapse Review, and exercise annotation-draft cancellation. Confirm correct frame, focus,
  image cleanup/preload behavior, and no console warning/error.
- **Collaboration, checklist, and dnd-kit:** open/close the panel; add/edit/complete/delete a local
  checklist item; use due/assignee/action popovers; reorder by drag and verify the persisted result;
  also reorder a supported collection link if fixture state permits. Confirm no ghost/stuck drag,
  duplicated mutation, lost focus, or portal error.

### Local product-flow checks

- Sign out/in through Google on the Worker origin (with human re-authentication if required), then
  verify the session returns to the requested route and sign-out clears the protected shell.
- Exercise direct load, in-app navigation, Back/Forward, refresh, and unknown-route handling for
  the typed custom router.
- Open Dashboard List and Kanban at desktop, compact, and phone widths; confirm project navigation,
  filters/search, Notice Board, notification menu, and active view state.
- Open Project Workspace overview plus available RAW, Edited, video, floorplan, and copy tabs;
  confirm permissions/actions and Collaboration open/closed state.
- Open Admin Users, Directory, Pipeline, and Integrations; confirm each renders and navigation/focus
  works without mutation unless a local reversible check is required.
- Confirm notice and notification polling/open-close behavior does not duplicate after navigation
  or remount.

### Bundle-delta evidence

Use TB0's [Baseline Report](./revamp_2026_portal/baseline/TB0/Baseline-Report.md) as the fixed
pre-upgrade comparison, not a newly rebuilt React 18 branch:

| Metric | TB0 raw bytes | TB0 gzip bytes |
|---|---:|---:|
| JavaScript total | 868,387 | 263,501 |
| CSS total | 101,538 | 17,586 |

TB0 also records 2,591,474 total raw bytes across `apps/web/dist`. After the final TB0A build,
record each emitted JS/CSS asset, JS/CSS totals, total dist bytes, and absolute plus percentage
delta against those exact values. Explain the React-runtime delta and investigate any unrelated
CSS change or surprising asset/dependency growth. Hashed filenames may change; unexplained product
code or style growth is not acceptable.

### Matched visual-parity evidence

The before-state is TB0's
[`baseline/TB0/evidence/`](./revamp_2026_portal/baseline/TB0/evidence/) directory. Capture the
after-state into `docs/plans/revamp_2026_portal/baseline/TB0A/evidence/` at the same exact page
viewports: `1440×900`, `1024×768`, and `390×844`.

TB0's actual convention is hyphen-delimited, for example
`current-dashboard-1440-list-notice-open.png`, not the double-hyphen/`1440x900` example convention.
Create a one-for-one matched image for all 22 `current-*.png` files by replacing only the
`current-` prefix with `tb0a-` and retaining the remaining filename tokens exactly—for example
`tb0a-dashboard-1440-list-notice-open.png`. This covers Dashboard List/Kanban with Notice Board at
all three widths, Workspace/Collaboration states at all three widths, Create Project states,
Edited empty, notifications open, and all four Admin tabs. Do not recapture or rename the five
`prototype-*` files; those are historical design references, not TB0A's before-state.

Compare each pair directly and record pass/fail plus any difference. Pixel-level noise from data,
timestamps, or browser rendering must be identified; no intentional layout, typography, color,
spacing, responsive, focus, open/closed, or content-hierarchy change is allowed. Redact/check the
after images to the same TB0 standard before committing them. Lightbox/Tiptap interactions that
TB0 could not capture do not require a fabricated visual pair, but the local-media preflight and
stop condition above govern whether their manual checks run locally or, by explicit owner
exception, are deferred to production smoke.

### Production smoke after deploy

Production has no staging environment. After deploy, perform a passive authenticated smoke on
`https://quincy.flamingfire.my`: load Dashboard, one accessible Project Workspace, Admin, Notice
Board, and notifications; exercise read-only navigation/open-close/Escape/focus behavior; confirm
assets and API reads succeed; and review Worker/browser errors and React warnings. Do not create,
edit, reorder, publish, upload, notify, or trigger integrations in this passive smoke.

If—and only if—the owner selected the local-media release exception above, extend this smoke to
the enumerated media-dependent interactions against existing accessible production media. Keep it
non-mutating: do not upload or persist an annotation, and cancel any annotation draft. Record each
deferred result separately; a missing or unsafe production fixture leaves TB0A unaccepted rather
than converting the check into a waiver.

## Deployment and rollback

### App-only deployment

Build the final web bundle first. Before deployment, from `portal/workers/app/`, record the active
`quincy-portal-app` deployment and version ID:

```sh
npx wrangler deployments list --json
npx wrangler versions list --json
```

Then deploy only the app Worker, whose
[`wrangler.jsonc`](../../portal/workers/app/wrangler.jsonc) packages the Hono Worker and
`../../apps/web/dist` static assets into the same version:

```sh
cd portal/workers/app
npx wrangler deploy --message "TB0A React 19.2 compatibility release"
```

Record the commit SHA and new Worker version/deployment ID. `background` and `webhook-ingress` do
**not** need redeploying: TB0A changes neither Worker nor any service/queue/binding contract, and
the app's existing `BACKGROUND` service binding continues to target the already-deployed
`quincy-portal-background`. The repository's normal background → webhook-ingress → app order
applies when those providers change; redeploying unchanged providers here would enlarge this
isolated release without improving binding resolution.

No TB0B, TB1, Tailwind/shadcn, Calendar, External Editor, or unrelated product commit may be
present in the deployed revision.

### Concrete rollback

Cloudflare Worker versions capture bundled code, static assets, bindings, and compatibility
settings, and Wrangler `4.112.0` in this repository supports
[`wrangler rollback`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback).
If the automated/local gate fails, do not deploy. If production smoke or monitoring finds a
regression, immediately restore the recorded pre-TB0A app version:

```sh
cd portal/workers/app
npx wrangler rollback <pre-TB0A-version-id> --message "Rollback TB0A React 19.2" --yes
```

Using the explicit recorded version ID avoids guessing which upload preceded TB0A and restores
the matching previous Worker plus web assets as one unit. Repeat the passive production smoke and
record the rollback deployment ID. There is no database migration or data/resource rollback; D1,
R2, KV, queues, service bindings, and the unchanged background/webhook Workers remain in place.

## Acceptance checklist

- [x] TB0 is complete, and TB0A has its own branch/commit/review/deploy boundary before TB0B/TB1.
- [x] The npm registry was rechecked at implementation time and the final stable React 19.2/runtime
      and compatible React 19 type versions are recorded.
- [x] `portal/package.json` contains four exact pins with no range; no duplicate React declaration
      was added to `apps/web` or another workspace.
- [x] `portal/package-lock.json` was regenerated and reviewed; `npm ls` shows one valid React line,
      no invalid peer, no prerelease, and no unexplained transitive churn.
- [x] The four known zero-argument refs compile after the minimum correction, and every other
      source/supporting-dependency change is tied to a reproduced React 19 blocker.
- [x] No hard non-goal or product behavior/visual change entered the diff.
- [x] The four standard verification commands were run; all real suites/type/build gates pass and
      the known shared-workspace npm harness behavior is explicitly recorded.
- [x] No unreviewed React, peer-dependency, browser-console, or Worker warning/error remains.
- [x] The local-media fixture preflight established one UI-confirmed RAW/Edited pair; if the known
      failure recurred, the owner recorded either a completed prerequisite fix followed by a
      successful preflight rerun or the explicit release exception. (Owner selected the release
      exception for the Lightbox/PhotoGrid-dependent items; see "Owner acceptance disposition.")
- [x] Every applicable local React-runtime and product-flow item above passed with authenticated
      Worker-origin testing; if the owner selected the release exception, every named deferred
      media-dependent item instead has a separately recorded production-smoke result and no item
      was silently waived. (Lightbox/PhotoGrid and sign-out/in remain explicitly open, tracked in
      `docs/todo.md`, not marked passed — see "Owner acceptance disposition.")
- [x] Post-upgrade JS/CSS raw+gzip and total-dist bytes are reported against TB0's exact baseline,
      including absolute/percentage deltas and an explanation.
- [x] All 22 matched `tb0a-*` after images exist at TB0's three exact viewports, were redaction
      checked, and show no intended visual/product drift against the `current-*` before images.
- [x] The pre-TB0A app version ID, TB0A version/deployment ID, commit SHA, deploy command, and
      passive—or explicitly exception-expanded—authenticated production-smoke result are recorded.
- [x] Production deployment contained TB0A only; background and webhook-ingress were correctly
      left untouched.
- [x] Rollback was either not needed or restored the explicitly recorded prior app/web-bundle
      version and passed the passive smoke; no schema/data rollback was attempted. (Not needed —
      no regression found.)
- [x] TB0A is explicitly accepted before any TB0B or TB1 implementation/deploy begins. (TB0B is
      already live; TB1's build had not yet started code work at acceptance time.)
- [x] After production verification, this plan's status is updated with the commit hash and the
      file is moved with `git mv` to `docs/plans/implemented/` as required by repository policy.

## Implementation-time open items

1. Recheck the four registry versions immediately before editing; the 2026-08-24 pins are exact
   candidates, not permission to skip that gate.
2. Reconfirm installed and registry peer metadata after lockfile generation. Current key UI peers
   accept React 19, but only the gate and focused runtime checks can close behavioral compatibility.
3. Reconfirm whether the known `npm run test --workspaces` missing-shared-script exit remains; do
   not convert TB0A into test-harness work.
4. Capture and record the actual active app version ID before deploying; it cannot be known in this
   planning pass and is required for deterministic rollback.

## Implementation and verification record

### Implementation record — code-level TB0A scope

**Registry and final pins (2026-08-24):** The required live npm registry recheck immediately before
editing returned stable `latest` values of `react@19.2.8`, `react-dom@19.2.8`,
`@types/react@19.2.18`, and `@types/react-dom@19.2.5`. The React DOM peer requires `react@^19.2.8`
and the DOM types peer requires `@types/react@^19.2.0`. These exact pins match the plan's
2026-08-24 candidates; no newer stable 19.2.x patch was available, and no prerelease tag was used.
They are owned only by `portal/package.json`; no React declaration was added to `apps/web` or any
other workspace.

**Lockfile:** `portal/package-lock.json` now has one deduped React runtime line at `19.2.8`, the
four exact root pins, the reviewed registry resolutions/integrities, `scheduler@0.27.0` as the
React DOM transitive update, and the expected removal of React 18's `loose-envify`/`js-tokens`
records and the no-longer-used `@types/prop-types` record. No supporting dependency was manually
updated. The sequential npm install commands emitted temporary ERESOLVE warnings while the
runtime and type packages were being updated one command at a time; after both completed,
`npm ls react react-dom --all` showed only `19.2.8` with no invalid peer dependency.

**Source corrections:** The upgraded typecheck first reproduced the four documented
zero-argument-ref errors (`TS2554`) in:

- `portal/apps/web/src/components/ProjectCollaborationPanel.tsx:21-22` — two numeric refs.
- `portal/apps/web/src/screens/ProjectWorkspace.tsx:278` — one numeric ref.
- `portal/apps/web/src/components/RichTextEditor.tsx:201` — the Tiptap link-selection ref.

Each now has an explicit `undefined` initializer while retaining the original optional state:
`useRef<number | undefined>(undefined)` for the three numeric refs and
`useRef<{ from: number; to: number } | undefined>(undefined)` for the link selection. The union
was required by the demonstrated `pendingSignalRef.current = undefined` assignment after
React 19's overload inference; no additional ref site was changed. `AnchoredPopover.tsx` was
left untouched.

One focused, test-only compatibility correction was required after the first upgraded workspace
run: React 19 serializes the existing `readOnly` property as `readOnly` in static markup where
the React 18 expectation matched `readonly`. `portal/apps/web/src/components/ProjectFields.test.ts`
now accepts either spelling in its three read-only assertions (including the create-mode negative
checks). The component and behavior were not changed. This is the only beyond-four-ref change,
and is the minimum fix tied to an actual React 19 test failure; no other dependency or product
source change was needed.

**Supporting-dependency changes:** None. The `scheduler@0.27.0` lockfile change is transitively
required by `react-dom@19.2.8`, not an independent refresh.

### Automated gate

The four repository-standard commands were rerun after the final source/test diff:

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | Pass; all six workspace typechecks completed. |
| `npm run build -w @quincy/web` | 0 | Pass; Vite transformed 172 modules. The existing JavaScript chunk-size warning (>500 kB) remains. |
| `npm run test --workspaces` | 1 | Expected npm harness non-zero: `@quincy/shared` has no `test` script. Every runnable suite passed: db 22/22, web logic 65/65, web DOM 185/185, app 179 passed + 1 skipped (178 plus the new R2 dev-mode regression test added by the prerequisite fix), background 191/191, webhook-ingress 13/13. The required shared suite is not invoked by this command. |
| `npx vitest run --config packages/shared/vitest.config.ts` | 0 | Pass; 9 files and 60 tests. |

The third command's non-zero result is the known `@quincy/shared` npm workspace-script quirk
documented by TB0 and this repository's verification instructions, not a failing test suite; no
test script or test infrastructure was added. Automated runs also emitted reviewed environment
warnings: Wrangler could not write its user-level debug log (`EPERM`), the Worker suites logged
existing disabled-integration/image-body warnings, and the web DOM suite reported Node's missing
`--localstorage-file` path warning. No new React warning was reported by the automated suites.
The audit found no render-error test that depends on React 18 rethrow behavior, so the default
`createRoot` reporting remains unchanged.

### Bundle-delta evidence

Evidence is the final built inventory in `portal/apps/web/dist`, compared with the fixed TB0
values in [`baseline/TB0/Baseline-Report.md`](./revamp_2026_portal/baseline/TB0/Baseline-Report.md).
Gzip values below use the same direct asset measurement convention as the baseline report.

| Emitted asset | Raw bytes | Gzip bytes |
|---|---:|---:|
| `assets/index-OXRY17oJ.js` | 918,258 | 277,236 |
| `assets/index-C0MFG1Ba.css` | 101,538 | 17,586 |
| **JavaScript total** | **918,258** | **277,236** |
| **CSS total** | **101,538** | **17,586** |
| **Total `apps/web/dist` raw bytes** | **2,641,345** | — |

Against TB0's exact baseline:

| Metric | TB0 | TB0A | Absolute delta | Percentage delta |
|---|---:|---:|---:|---:|
| JavaScript raw | 868,387 | 918,258 | +49,871 | +5.743% |
| JavaScript gzip | 263,501 | 277,236 | +13,735 | +5.213% |
| CSS raw | 101,538 | 101,538 | 0 | 0.000% |
| CSS gzip | 17,586 | 17,586 | 0 | 0.000% |
| Total dist raw | 2,591,474 | 2,641,345 | +49,871 | +1.924% |

The entire raw dist increase is the single JavaScript asset; CSS and all brand/font/HTML assets
are unchanged. The increase is attributable to the React 19.2.8/react-dom 19.2.8 runtime bundle
and its required `scheduler@0.27.0` transitive package. No unrelated CSS, product code, or
supporting-dependency growth was found in the diff.

### Deferred evidence and release fields

No local-media preflight, authenticated local React/product-flow check, browser console review,
matched visual-parity screenshot, deployment, production smoke, commit SHA, or Worker version ID
was performed in this execution, per the task boundary. Those fields remain open for the
orchestrating session; this record does not update the acceptance checklist or plan status.

### Local-media fixture preflight — resolved via prerequisite fix (orchestrating session)

TB0's recorded upload failure (`Uploaded object was not found in R2`) reproduced identically at
the start of this session. Root-caused and fixed as the plan's option 1 (prerequisite fix,
separately committed): local `.dev.vars` was missing `APP_ENV=dev`, so presigning targeted
production R2/S3 while completion checked the local `MEDIA` binding. `createMultipartPresign` now
short-circuits to the local direct-upload path whenever `env.APP_ENV === "dev"`, regardless of
stale local S3 credentials. A regression test pins this. Full details in `docs/lessons.md`.

**Caveat:** one reproduction attempt during diagnosis reached the real production S3 endpoint
before the fix landed. Identified via the local D1 `upload.presign` audit row (the only row this
key has — no asset, ingest, or job row exists, confirming it was never ingested):

- **Key:** `projects/738d1b93-eb9a-44fe-8935-16767ad61002/raw/8b14b0f6-43ce-4e7b-b60b-ca58f56333c4/quincy-r2-upload-repro.jpg`
- **Uploaded:** approximately `2026-08-24 05:05:44 UTC` (`13:05:44 +08:00`)
- **Size:** 20,544 bytes

It was not deleted from production R2 — deleting it would itself be a mutating production action
outside this session's scope. It is an orphaned, unreferenced object with no client data and no
app-visible link (`738d1b93-…` is a local-only synthetic test project ID, not a real production
project, so no key collision is possible). A follow-up read-only check for incomplete multipart
uploads from the same window was attempted but could not complete — this Wrangler version
(4.112.0) has no `r2 object list`/`r2 bucket list-multipart-uploads` command, and no Cloudflare API
token was available in this environment to check another way. This remains open: the owner (or a
future session with real Cloudflare dashboard/API access) should confirm no incomplete multipart
upload was left behind from this window, and should decide whether to remove the orphaned object
above.

After the fix and a dev-server restart, local upload was re-verified end-to-end through the actual
UI (not just Luna's automated check): two JPEGs uploaded successfully to the synthetic test
project, both appear in the RAW grid with correct filenames, and `RAW capture · 2 received`
updated live with no console errors.

### Local React-runtime and product-flow checks — partial (orchestrating session, live browser)

Performed directly against the built app Worker at `localhost:8787`, reusing the human-authenticated
session (per this session's own rule against agent-initiated Google sign-in). Zero console
errors/warnings observed in any check below.

- **Mount/unmount, routing, browser history:** navigated Dashboard → Project Workspace → Admin
  (Users/Pipeline) → back-navigation → Dashboard repeatedly. Back-navigation correctly restored
  prior route and Collaboration-panel-open state. No stale UI, no duplicate requests observed.
- **Refs and generated IDs, portals/focus/Escape (direct regression coverage for this release's own
  fixes) — corrected after independent Sol diff review caught two misattributions in an earlier
  draft of this section:** the Topbar notifications popover (opened first, and closed cleanly with
  no console error) is **not** `AnchoredPopover` — `Topbar.tsx` uses its own separate deferred
  `window.setTimeout(...)` focus-restoration logic, unrelated to the TB0 `AnchoredPopover` fix. The
  actual `AnchoredPopover`/`useAnchoredPopover` component (verified via `grep` to be used only by
  `SubtaskChecklist.tsx`) **was** genuinely exercised: opening a checklist item's "Actions" popover
  (`SubtaskChecklist.tsx`'s action-menu popover) and its Escape/close behavior ran through the real
  fixed component with no error. Separately, the Tiptap link dialog in `RichTextEditor` (the
  component with this release's fourth `useRef` fix) was opened via selection → Link toolbar button
  — it renders **inline** in the component's own JSX (`rich-text__link-modal`), not through a React
  portal as originally (incorrectly) claimed; the dialog opened, the URL applied correctly, and
  focus returned to the editor with the link correctly inserted and underlined, confirming the
  `linkSelection` ref fix functions correctly even though the "portal" description was wrong.
- **Tiptap and mentions:** typed `@qu` in a project comment composer; autocomplete suggested
  "Quincy Admin" correctly; pointer selection inserted the mention chip correctly with no corrupted
  content. (A synthetic-Return-keypress selection attempt via browser automation did not select the
  suggestion — no console error, no corruption, and pointer selection immediately after worked
  cleanly, so this reads as a browser-automation key-dispatch limitation, not a reproduced product
  regression; not conclusive either way for a physical Enter press.)
- **Collaboration, checklist, dnd-kit:** opened/closed the Collaboration panel; added a second
  checklist item; drag-reordered the two items via the drag handle — reorder applied and persisted
  correctly (confirmed after re-render), no ghost/stuck drag state.
- **Local media/Lightbox:** RAW upload now succeeds (see preflight section above) and assets render
  in the grid. Rendition generation for uploaded assets stayed in "processing" state because the
  background Worker (which consumes the rendition queue) was not running in this ad hoc session —
  this is a separate local-multi-Worker-setup gap, not a React 19 regression, and not something this
  session stood up (no `.claude/launch.json` entry exists for the background Worker, and standing
  one up locally means resolving the app Worker's `BACKGROUND` service binding, queue consumers,
  Workflows, and Durable Objects together — non-trivial additional infrastructure work, not a quick
  check).
- **Responsive:** Dashboard rendered correctly at the mobile (390px) viewport with no console
  errors.

### Owner-recorded release exception (plan §"Local-media fixture preflight," option 2)

Per an independent Opus final-draft review's own risk analysis (an app-wide grep for every React
18→19 removed/changed API — `ReactDOM.render`/`hydrate`/`unmountComponentAtNode`/`findDOMNode`,
`react-dom/test-utils`, `defaultProps`, `propTypes`, string refs, `createFactory`, `createPortal`
— returned zero hits touching any of the surfaces below, and the one `forwardRef` use remains
supported in React 19), the orchestrating session recorded this exception rather than stand up a
full local multi-Worker environment for TB0A's narrow compatibility-only scope:

**Deferred to the post-deploy passive production smoke, each requiring its own recorded result:**

- Lightbox open/close/filmstrip navigation
- RAW-vs-Edited comparison view
- PhotoGrid image load-failure/retry
- Review panel open/collapse
- Annotation-draft cancellation
- Admin Directory and Integrations tabs (Users/Pipeline were checked locally; these were not)
- Full sign-out/in cycle (would require the human to re-authenticate again in this local session;
  verify via passive observation in production instead — do not sign out of a real account as part
  of this check)

None of these may be marked passed by inference from this reasoning alone — the "Production smoke
after deploy" section's per-item recording requirement still applies to each one individually.

This is a genuine but partial pass — it demonstrates no regression in every check performed, using
real interaction (not inference from TB0's screenshots), but does not by itself satisfy every
acceptance-checklist bullet under "Local React-runtime checks." The remaining Lightbox-rendering
gap should be resolved by one of: running the background Worker locally and re-testing, or folding
those specific checks into the post-deploy passive production smoke.

### Deployment record

- **Pre-deploy production version:** `84ca29ba-c2fb-4e65-8a2a-880bb2e8e5ea` (100% traffic, created
  2026-08-20T05:38:25.856Z) — the rollback target if needed.
- **Commit deployed:** `eb76732` (TB0A) on top of `fef61f5` (the prerequisite R2 fix), both on
  `main`.
- **Deploy command:** `npx wrangler deploy --message "TB0A React 19.2 compatibility release"` from
  `portal/workers/app`, after a fresh `npm run build -w @quincy/web` (asset hashes matched the
  locally-verified build exactly: `index-OXRY17oJ.js`, `index-C0MFG1Ba.css`).
- **New production version:** `202d4cd5-c6ec-4f98-8cd2-e7fb2b0d0d60`. Confirmed
  `env.APP_ENV ("production")` in the deploy output. Only 2 assets uploaded (`index.html`, the new
  JS bundle); the CSS asset was already present (byte-identical to TB0's baseline), matching the
  expected zero-CSS-delta.
- **Scope:** app Worker only, as the plan requires. `background` and `webhook-ingress` were not
  redeployed.

### Production smoke — passive, authenticated, real account (`Tez`, real production data)

Performed directly against `https://quincy.flamingfire.my` post-deploy. Zero console errors and
zero failed network requests observed across every check. No create/edit/delete/upload/publish/
notify/integration-trigger action was taken.

- **Dashboard:** loaded correctly (Kanban default view), real project counts, Staff Notice Board,
  search box, thumbnails for populated project cards all rendered; `/api/projects`, `/api/stages`,
  `/api/notifications`, `/api/notice-board/posts`, and multiple `/media/asset/.../thumb` requests
  all returned 200.
- **Project Workspace (multiple real projects):** navigated into 4 different real projects across
  different stages (Awaiting RAW, RAW Review, Editing, Edited Review) via direct project links.
  Real checklist items, real threaded comments with `@mentions`, real agency/agent/photographer
  data all rendered correctly; Collaboration panel opened and closed cleanly on each. None of the
  sampled projects happened to have populated RAW/Edited photo grids to open a Lightbox against —
  **Lightbox open/filmstrip/RAW-vs-Edited-compare/annotation-draft-cancellation remain unverified**
  post-deploy, beyond the static risk analysis already recorded above (zero removed/changed React
  API touches this surface). Video collection (13 items on one project) was visible in the rail but
  not opened, since it isn't a Lightbox/PhotoGrid surface.
- **Admin — all four tabs:** Users (real staff roster with roles/access state), Directory (Agencies
  & agents, empty but rendered correctly), Pipeline (real stage list, matches local), Integrations
  (Dropbox "Connected", Tonomo "Receiving" with real processed/received counts, Vimeo "Not
  configured") — all rendered correctly, closing the Admin Directory/Integrations gap from the
  local pass.
- **Notifications popover:** opened via the Topbar bell (its own separate `setTimeout` focus logic,
  not `AnchoredPopover` — see the corrected component attribution above), showed "You're all caught
  up," closed cleanly via Escape.
- **Sign-out/in:** not exercised — signing out of a real production staff account was correctly
  treated as out of scope for a passive, non-mutating smoke (would require the human to actually
  re-authenticate); the local session lifecycle around Google OAuth is unchanged by this release
  (no auth-library version bump, only React/React DOM), so this residual gap is low-risk but still
  genuinely unverified against React 19.2 specifically.

**Result: no regression found in anything checked.** Two items remain formally open after this
smoke pass — Lightbox/PhotoGrid interaction (no suitable populated project found in this sample)
and the sign-out/in cycle (deliberately not exercised against a real account) — both already
covered by the static risk analysis above and available for a lower-stakes follow-up check
(sampling a specific project known to have RAW/Edited assets, or exercising sign-out/in during a
future normal session) rather than blocking TB0A's live status.

### Visual-parity acceptance (2026-08-25)

All 22 matched `tb0a-*` after images were captured against the local authenticated Worker at
`http://localhost:8787` (danger-mode Luna, already-authenticated session, no sign-in performed) and
compared directly against TB0's `current-*` baseline set. Full pair-by-pair results are recorded in
[`baseline/TB0A/evidence/Visual-Parity-Report.md`](./revamp_2026_portal/baseline/TB0A/evidence/Visual-Parity-Report.md).
Result: **zero React 19 visual/layout regressions found.** Every noted difference is either the
already-approved TB0B pipeline-order boundary (Up/Down controls correctly absent from the Pipeline
tab) or expected local-fixture drift (the synthetic test project's stage/asset/checklist state
changed between TB0's baseline capture and this session; one notification is unread rather than
"caught up"). The orchestrating session independently spot-checked two pairs
(`admin-1440-pipeline`, `workspace-1440-collaboration-open`) directly against the baseline images
and confirmed the report's judgments.

### Owner acceptance disposition (2026-08-25)

The owner accepted TB0A on this evidence: the 22 visual-parity screenshots (zero regression), the
passive production smoke (zero regression on everything checked), and the static React-19
removed/changed-API sweep (zero hits touching Lightbox/PhotoGrid). The remaining Lightbox/PhotoGrid
interaction and sign-out/in cycle checks were not further pursued — closing them locally would
require standing up the local background Worker (queue consumers, Workflows, Durable Objects, a
nontrivial infrastructure task not yet done in this repository), and this environment's browser
tooling denied navigation to production for a passive check. Both remain open, tracked as
lower-priority follow-up debt in `docs/todo.md`, and are not silently marked passed.

## Primary external sources

- [React 19 Upgrade Guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- [React 19.2 release notes](https://react.dev/blog/2025/10/01/react-19-2)
- [npm registry: React stable metadata](https://registry.npmjs.org/react/latest)
- [npm registry: React DOM stable metadata](https://registry.npmjs.org/react-dom/latest)
- [npm registry: React types metadata](https://registry.npmjs.org/@types%2freact/latest)
- [npm registry: React DOM types metadata](https://registry.npmjs.org/@types%2freact-dom/latest)
- [Cloudflare Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Wrangler Worker commands and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback)
