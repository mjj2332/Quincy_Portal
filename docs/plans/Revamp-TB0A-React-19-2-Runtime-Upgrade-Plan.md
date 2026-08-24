# Revamp TB0A — React 19.2 Runtime Upgrade Plan

**Status: DRAFTED — not built, verified, committed, or deployed.** TB0A is a standalone,
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

- [ ] TB0 is complete, and TB0A has its own branch/commit/review/deploy boundary before TB0B/TB1.
- [ ] The npm registry was rechecked at implementation time and the final stable React 19.2/runtime
      and compatible React 19 type versions are recorded.
- [ ] `portal/package.json` contains four exact pins with no range; no duplicate React declaration
      was added to `apps/web` or another workspace.
- [ ] `portal/package-lock.json` was regenerated and reviewed; `npm ls` shows one valid React line,
      no invalid peer, no prerelease, and no unexplained transitive churn.
- [ ] The four known zero-argument refs compile after the minimum correction, and every other
      source/supporting-dependency change is tied to a reproduced React 19 blocker.
- [ ] No hard non-goal or product behavior/visual change entered the diff.
- [ ] The four standard verification commands were run; all real suites/type/build gates pass and
      the known shared-workspace npm harness behavior is explicitly recorded.
- [ ] No unreviewed React, peer-dependency, browser-console, or Worker warning/error remains.
- [ ] The local-media fixture preflight established one UI-confirmed RAW/Edited pair; if the known
      failure recurred, the owner recorded either a completed prerequisite fix followed by a
      successful preflight rerun or the explicit release exception.
- [ ] Every applicable local React-runtime and product-flow item above passed with authenticated
      Worker-origin testing; if the owner selected the release exception, every named deferred
      media-dependent item instead has a separately recorded production-smoke result and no item
      was silently waived.
- [ ] Post-upgrade JS/CSS raw+gzip and total-dist bytes are reported against TB0's exact baseline,
      including absolute/percentage deltas and an explanation.
- [ ] All 22 matched `tb0a-*` after images exist at TB0's three exact viewports, were redaction
      checked, and show no intended visual/product drift against the `current-*` before images.
- [ ] The pre-TB0A app version ID, TB0A version/deployment ID, commit SHA, deploy command, and
      passive—or explicitly exception-expanded—authenticated production-smoke result are recorded.
- [ ] Production deployment contained TB0A only; background and webhook-ingress were correctly
      left untouched.
- [ ] Rollback was either not needed or restored the explicitly recorded prior app/web-bundle
      version and passed the passive smoke; no schema/data rollback was attempted.
- [ ] TB0A is explicitly accepted before any TB0B or TB1 implementation/deploy begins.
- [ ] After production verification, this plan's status is updated with the commit hash and the
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

## Primary external sources

- [React 19 Upgrade Guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- [React 19.2 release notes](https://react.dev/blog/2025/10/01/react-19-2)
- [npm registry: React stable metadata](https://registry.npmjs.org/react/latest)
- [npm registry: React DOM stable metadata](https://registry.npmjs.org/react-dom/latest)
- [npm registry: React types metadata](https://registry.npmjs.org/@types%2freact/latest)
- [npm registry: React DOM types metadata](https://registry.npmjs.org/@types%2freact-dom/latest)
- [Cloudflare Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Wrangler Worker commands and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback)
