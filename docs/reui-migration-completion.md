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
> of the completed temporary migration guard; byte-identical relocation of the menu test;
> performance-only refactoring of the independent oracle in `checklist-schedule.test.ts`, whose
> corpus, comparisons, expected behaviour and `20_000` timeout all remain unchanged; and deletion
> of the `insetFocus` suite in `quincy/Button.dom.test.tsx`, replaced by a suite guarding the
> invariant that deletion depends on.

The fourth exception was added after the fact, in `daf1a41`. `reui/button.tsx` divergence 5
removed nova's focus ring from the cva base, so `buttonClasses`' `insetFocus` option had nothing
left to neutralise; assertions about a mechanism that no longer exists cannot fail. They were
deleted rather than edited to keep passing, and the replacement suite pins the fact the deletion
rests on — that the ring must stay absent, since re-fetching `button` from the registry would
silently reintroduce it. This is the same category as the first exception, not a new kind of
licence, but the amendment permitted exactly three exceptions and this is a fourth, so it is
recorded rather than absorbed silently.

The intent criterion 8 protects — that no assertion is weakened or rewritten to accommodate a
source change — is preserved exactly. What is permitted is deletion of a guard that has completed
its purpose, relocation without edit, and a change that makes an oracle faster without changing
what it checks.

Because guard A and guard B are deleted as a unit, the node suite's expected count was predicted
not to stay at 359. **That prediction was wrong, and the ledger is corrected here:** the count *is*
359 at the end of the branch, and it reconciles exactly. `reui-migration.guard.test.ts` (530 lines)
was deleted while `Topbar.inset-focus.guard.test.ts` and `quincy/orphan.guard.test.ts` were added;
the removals and additions happen to cancel. A count that did not move is therefore not evidence
of a masked test loss here — the reconciliation above is.

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

## Criterion 5 — the dead class-hook sweep

Thirteen commits (`af2ec1f`..`65b8226`) removed **137 class tokens** that no longer had a
consumer. The candidate set went from 149 to 12, and those 12 are the deliberate keeps below.

### Decision procedure

A token is dead only if it is **emitted** and appears in **none** of three consumer sets. Each
stage is mechanical, and the emission stage is an AST walk rather than a grep — a line-based scan
is blind to multi-line strings, `cn()` composition and template literals, and misreports in both
directions.

| Stage | What it is | How it was derived |
| --- | --- | --- |
| Emission | class tokens actually rendered | Babel AST walk over class-bearing JSX attributes, keyed on the *attribute name*, so a `data-testid` value can never be mistaken for a class |
| L1 · CSS | every selector in the shipped stylesheet | `/\.((?:\\.|[-_A-Za-z0-9])+)/g` over the two pre-sweep `dist/assets/*.css` files — 1910 selectors. Subsumes Tailwind utilities and arbitrary variants; `is-active` appears as a bare selector because the built CSS literally contains `.\[\&\.is-active\]\:bg-primary.is-active` |
| L2 · runtime | selectors used by application code | `querySelector`/`closest`/`matches`/`classList` in non-test source. Exactly five class selectors: `.kanban`, `.viewer__panel-trigger`, `.vpanel__peek`, `.subtask-checklist__title-trigger`, `.button` |
| L3 · tests | selectors and assertions in tests | bucketed **by shape, not by file type** — see below |

L1 was derived from the **pre-sweep** build only. Deriving it mid-sweep is circular: commit *N*'s
deletion becomes commit *N+1*'s evidence.

L3 buckets: a selector is a consumer; `toContain`/`toMatch`/`indexOf` over rendered markup or read
source is a consumer; a `.not.` negative is *weak* — kept and recorded, because removing the token
makes the assertion vacuous rather than failing; a name inside a `data-*` selector is **not** a
consumer of the class; a comment, an `it()` title, or a guard fixture is not a consumer.

### The AST walker had to be corrected twice

Both bugs inflated the dead list with tokens that were never classes, and both are worth recording
because the naive version of this walk is the obvious thing to write:

1. Descending into **all** `CallExpression` arguments, `ConditionalExpression` *tests*, and
   option-object keys harvested prop values as classes — `buttonClasses("primary", …)` yielded
   `primary`, `link.source === "tonomo"` yielded `tonomo`.
2. Harvesting **both sides of every `BinaryExpression`** harvested comparison operands —
   `view === "calendar" && "is-active"` yielded `calendar`. Only `+` concatenation is class-relevant.

Together these injected 50 phantom tokens (`primary`, `secondary`, `text`, `danger`, `className`,
`tonomo`, `approved`, `flagged`, `archived`, `calendar`, `list`, `error`, `month`, `notifications`,
`phone`, `schedule_needs_attention`, …). Deleting them would have been a real defect: `"a"` in
`Lightbox.tsx:306` is the **approve keyboard shortcut**, not a class.

### Kept, with the consumer that saved each one

- **`create-project__section`** — `ProjectFields.test.ts:79` does
  `markup.indexOf('<section class="create-project__section" aria-labelledby="client-heading">')`
  and slices from that index. Remove the class and `indexOf` returns `-1`, so `slice(-1, …)`
  returns garbage **while the test still passes**. The attribute order it depends on is also
  preserved.
- **`workspace-section`** — `PhotoGrid.test.ts:77` asserts `.not.toContain(...)` to prove the
  sectioned branch did not render. Removing it makes the assertion vacuously true forever.
- **`strip__button`** — `Lightbox.a11y.dom.test.tsx:202` asserts `app.css` declares no outline for
  it. Same weak shape as above.
- **`document-history__entry`, `document-preview--incomplete`** — positive `toContain` plus an
  occurrence count in `CollectionPanel.dom.test.tsx:85,86,102`.
- **`kcard`, `kcard-controls`, `kcard-drag-handle`** — markup regex in `dashboard-routing.test.ts:20,28`.
- **`kanban-overlay`** — `.querySelector(".kanban-overlay")` twice in `Dashboard-stage-interactions`;
  a `DragOverlay` cannot carry a testid.
- **`st-`** — not a token but the static half of `st-${state}`; `.st-approved` and `.st-flagged`
  are live rules.
- **`group/field-content`, `peer/field-label`** — Tailwind named group/peer markers in
  `components/reui/`, out of scope.

### `data-*` name collisions

Seven tokens are dead **as classes** while sharing a string with an attribute that must survive.
The class goes; the attribute — #50's sanctioned replacement — stays.

`admin-stage`, `dashboard-live-region`, `project-collaboration-only`, `project-deadline`, and —
not in the original ledger, found by the L3 pass — `collection-link`, `collection-link-editor`,
`collection-links`. Every sweep commit was gated on a multiset comparison of `data-*` attributes
across the diff; none changed.

### The #50 tension dissolves

Guard A inspects only `*.dom.test.tsx` and only class selectors in `querySelector`/`closest`/
`matches`. Its baseline is `{Dashboard-stage-interactions: 2}`, both `kanban-overlay`. The set of
tokens protected *only* by a guard-A-class DOM selector is therefore **empty** apart from
`kanban-overlay`, which is protected anyway. Every other DOM-test reference is a markup assertion
or a `data-*` collision. **Criterion 5 never conflicted with criterion 8, and no test file was
edited by any of the thirteen sweeps.**

### Per-commit verification

Every sweep commit was held to: diff shape (only class-string literals changed, removals equal to
the declared list, **zero** tokens added); no `data-*` attribute added, removed or altered; no
`className` reshaped into `cn()`/template form and no `cn()` argument reordered; a re-grep proving
each removed token is gone from non-test source and from `styles/`; `typecheck` clean; both suites
**by exact count**, node 37 files/359 tests and DOM 74 files/779 tests; and a rebuild whose CSS is
byte-identical to the frozen baseline:

    dist/assets/index-B-H2LYCY.css               3e27881762f0d46d8e85fc8547ab9e85
    dist/assets/ProductionCalendar-CuQ4OBFt.css  f4dd4d1c27769f059f0bdadf75c0fe5f

**What the hash gate proves, and what it does not.** Byte-identical CSS means no Tailwind utility
was gained or lost — it catches the likeliest mechanical error, a fat-fingered deletion mid-string.
It is blind to *which element wears which class*: ancestry breaks, `:has()`/sibling-combinator
breaks (`app.css:462`'s `.viewer__stage:has(.drawbar) ~ .strip`), `classList` toggles and portal
placement all survive it. That residue is exactly what criterion 9's browser pass covers, which is
why the browser pass is not a formality.

Also corrected while here: the DOM suite is **779** tests, not the 780 this ledger previously
recorded.

### Follow-ups this sweep deliberately did not do

1. **`workspace-section` and `strip__button` still guard by absence.** Both assertions go vacuous
   if the token is ever removed. They should be repointed at something that cannot silently stop
   checking.
2. **`document-history__entry` / `document-preview--incomplete` remain class-based test contracts.**
   Converting them to testids would keep the assertions green while silently repointing the
   contract from a class to an attribute; that is a decision, not a cleanup.
3. **`font-inherit` in `Dashboard.tsx` was a no-op typo** (Tailwind v4 spells it `font-[inherit]`).
   It emitted no rule, so it was removed as dead rather than corrected — correcting it changes
   rendering and belongs to a separate change.
