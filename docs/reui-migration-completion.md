# ReUI migration — completion ledger (#56)

Closes out the migration opened by #47. This file records the decisions #56 asks to be
*recorded* rather than merely made, and the acceptance amendment the ticket needs in order to be
satisfiable. Written before any code changed, so the scope is reviewable against the result.

Baseline for this work: `main` @ `eaec616` (PR #64, the calendar re-skin, merged). Verified at that
commit: typecheck clean, node suite 359/359, DOM suite 780/780, `npm run build` clean.

## What #56 assumed, and what was actually true

#56 is written as a delete-and-verify ticket: it assumes every earlier slice already deleted the
primitives it orphaned, so completion is a matter of confirming an empty directory. That was not
the case. At `eaec616` the legacy directory `portal/apps/web/src/components/ui/` still held:

| File | Non-test importers at `eaec616` |
| --- | --- |
| `ui/button.tsx` | `components/Topbar.tsx`, `components/ImpersonationBanner.tsx`, `lib/app-router.tsx` |
| `ui/menu.tsx` | `components/Topbar.tsx` |
| `ui/menu.dom.test.tsx` | (colocated test for the above) |

So acceptance criteria 1 and 2 were unmet on arrival. This is the ticket's own "a screen was
missed" branch, and the missed surfaces are the application shell rather than anything under
`screens/`.

Note also that `components/quincy/` is the **surviving** Quincy layer, not a legacy set. #61 added
`quincy/segment.ts` to it deliberately. Nothing in #56 asks for it to be emptied.

## Why the screen-purity guard did not catch this

Guard A in `src/config/reui-migration.guard.test.ts` holds a root to the purity standard only once
that root's own transitive closure contains a `components/reui/` module, and its closure walk stops
at (without expanding) any other root.

`App.tsx` imports the screens, which are themselves roots and therefore leaves. Its own closure is
`lib/auth`, `ImpersonationBanner`, `PrincipalFreshnessBoundary`, `lib/stages`, `lib/query-client`,
`lib/app-router`, and `Topbar` — and **none of those imported a `components/reui/` module**. So
`App.tsx` read as unmigrated, guard A's deliberate asymmetry exempted it, and the three shell edges
onto `ui/button` were never examined by anything.

The asymmetry is correct in itself — without it the first migrated screen would fail every other
screen. The gap is that the shell is only ever reachable as an unmigrated root, so nothing held it
to the standard. This is recorded in `docs/lessons.md` alongside the guard's retirement.

**Ordering consequence, and it is strict:** repointing any *one* of the three `ui/button` consumers
introduces a `components/reui/` module into `App.tsx`'s closure — including via `quincy/Button`,
which imports `@/components/reui/button` itself. That flips `App.tsx` to "migrated" and immediately
flags the two edges still on the legacy primitive. **All three consumers must be repointed and
`ui/button.tsx` deleted in a single commit.**

## Decision: the menu is retained, not replaced

`ui/menu.tsx` moves to `components/quincy/menu.tsx` with its implementation unchanged, and its
colocated test moves with it byte-for-byte.

It is already built on `@base-ui/react/menu` — the same foundation ReUI's own registry components
sit on. Swapping it for a registry menu would be Base UI for Base UI with no visual gain, while
putting the `role="menu"` contract, the overlay container, backdrop ordering and popup focus
handling at risk, along with ~13.7 KB of existing tests. `components/reui/` also has no menu
installed today, so the swap would mean a new registry install for no benefit.

Both files use package or `@/`-aliased specifiers and the test imports `"./menu"`, so the move
requires **no content edits at all** — the lowercase filename preserves the relative import.

It is documented as a Quincy-owned Base UI menu. It is not a ReUI component and must not be
described as one.

## Decision: guard B is repointed at `components/quincy/` only

Criterion 4 asks for a recorded judgement on the orphan guard. Both the ReUI set and the Quincy set
currently have at least one non-test importer for every module, so a repointed baseline would be
genuinely `{}` rather than padded.

The judgement is to **repoint guard B at `components/quincy/` and not at `components/reui/`**:

- `components/quincy/` is code this repository owns. A module there with no remaining consumer is
  real rot, and the guard has already demonstrated its worth — #53 enforced this rule by hand twice.
- `components/reui/` is a vendored registry set, re-addable at any time through the shadcn CLI.
  Guarding it would turn the ordinary workflow of installing a component in one commit and wiring
  it up in the next into a red build, which is friction without a corresponding benefit.

Recorded limitation, so the guard is not oversold later: guard B counts incoming import edges, not
reachability from an entry point. Two dead modules that import each other still pass. It detects
orphans, not dead code, and should not be described as dead-code detection.

## Acceptance amendment for criterion 8

Criterion 8 ("the full test suite passes with no test files modified") is not satisfiable as
literally written, and the conflict is with the ticket's own criteria rather than with anything
optional:

- Criterion 3 **requires** deleting `config/reui-migration.guard.test.ts`, which is a test file.
- The menu's colocated test must move when the menu moves, or it loses its module.
- The CI flake the owner folded into this ticket lives inside a test file.

The amendment, deliberately narrow:

> Existing application-test contents and assertions remain unchanged. The exceptions are: deletion
> of the completed temporary migration guard; byte-identical relocation of the menu test; and
> performance-only refactoring of the independent oracle in `checklist-schedule.test.ts`, whose
> corpus, comparisons, expected behaviour and `20_000` timeout all remain unchanged.

The intent criterion 8 protects — that no assertion is weakened or rewritten to accommodate a
source change — is preserved exactly. What is permitted is deletion of a guard that has completed
its purpose, relocation without edit, and a change that makes an oracle faster without changing
what it checks.

Because guard A and guard B are deleted as a unit, the node suite's expected count **cannot** stay
at 359. The delta must reconcile exactly to the test names removed with that file, and nothing else.

## Verification standard

`vitest.dom.config.ts` is **not** run by CI (`.github/workflows/portal.yml` runs the web node
config only), so a green CI badge is not evidence for criterion 8. The DOM suite is run locally.

Criterion 9 is a real-browser pass. `docs/lessons.md` (TB5B) records that happy-dom cannot exercise
sensors, real geometry or focus timing, so a green suite is not evidence of visual consistency.

A useful corroboration for a pure-refactor commit: if `dist/assets/<Chunk>-<hash>.css` keeps the
same content hash across the change, no Tailwind utility was gained or lost. This proves the
emitted stylesheet bytes are unchanged — **not** that appearance is unchanged, since it says
nothing about which classes were assigned to which element, ancestry, or state. Corroboration only.

## Class-token sweep — the protected set

Criterion 5 sweeps class names retained only as dead markup hooks. The following look dead to a
naive scan and are not. Each has a live consumer; none may be removed:

- **`qc-calendar-screen`** and **`qc-cal-event-card`** — every *paint* rule keyed to them is gone,
  but `styles/production-calendar.css:127-130` is a single four-selector list that still uses both,
  and the reduced-motion rules at 142-143 and 151-153 select through `qc-calendar-screen`
  (including a `:root:has()` rule reaching portaled dialogs).
  `components/ProductionCalendarChrome.guard.test.ts` fails if either is removed. If that guard
  goes red, the guard is right and the sweep is wrong.
  For the record, because the reasoning was previously stated wrongly: portaled calendar dialogs
  are covered by the `[data-modal-variant="calendar"]` selector on line 129, **not** by
  `.qc-calendar-screen` ancestry — the file says so in its own comment at lines 124-125. Removing
  these tokens does not delete *every* calendar focus indicator; it deletes the rings on the
  toolbar, filters panel, unscheduled panel and selected-day disclosure, and both reduced-motion
  mechanisms. The instruction to keep them is right; that narrower reason is the true one.
- **Both `__fold` rule groups** and the **`[data-modal-variant="calendar"]` coarse-pointer block** —
  the fold-choice radios are deferred to #57, so these still have live consumers.
- **`is-active`** — live through two independent mechanisms: `.topnav a.is-active` in CSS, and the
  Tailwind arbitrary variants `[&.is-active]:` / `not-[.is-active]:` inside `quincy/segment.ts`,
  consumed by Dashboard's two segment groups and the calendar toolbar.
- **`kcard`, `kcard-drag-handle`, `kcard-controls`** — pinned by `screens/dashboard-routing.test.ts`.

Issue #50's guard A forbids DOM tests from selecting by Quincy class name, so a token whose only
protection is a DOM test is protected by nothing. Class-name assertions belong in node-suite
`.test.ts` source guards.
