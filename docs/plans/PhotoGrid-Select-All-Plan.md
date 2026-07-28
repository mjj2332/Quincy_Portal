# PhotoGrid Select-All — Plan

**Status: BUILT and verified (2026-07-28).** Plan approved by Terra (round 5). Built directly in
this session (small/mechanical routing). Terra diff review (fresh context) found one test-coverage
gap on first pass — fixed, second pass **APPROVED**. Full verify sequence green: typecheck (all
six workspaces), `apps/web` build, all four workspace test suites plus the separately-invoked
`packages/shared` suite, including the two new DOM test files this build required
(`PhotoGrid.dom.test.tsx`, `ProjectWorkspace.dom.test.tsx`). Not yet committed or deployed — the
§5 gate has passed in this session; awaiting the user's go-ahead to commit. The
handoff doc's summary table claimed this was already fully approved at "2 rounds" — that was
wrong; this file's own status line was the accurate source, confirmed by `git log` showing only
one commit ever touched it. Round 2 confirmed round 1's union/flip-condition fixes are correct,
found the `lastSelected` reset was incomplete, and surfaced a serious pre-existing cross-tab
stale-selection bug (fixed via `key={activeTab}`). Round 3 confirmed round 2's fixes but found the
`key` fix alone wasn't sufficient — a related fetch-gap race could still show one tab's assets
under another tab's controls. Round 4 found the proposed `useEffect`-based close of that gap is
still not fully synchronous (a single-render theoretical flash remains) and, separately, that
clearing `assets` to `[]` would introduce a real Lightbox crash if the lightbox is open during a
tab switch. Per explicit user decision: ship the pragmatic fix (closes the practical
network-latency window) plus the required Lightbox guard now; the fully synchronous architectural
fix is deferred to `docs/plans/ProjectWorkspace-Asset-Tab-Sync-Plan.md`, to be picked up after this
6-feature batch.

User request: a "select all" button/control for the images grid, so staff don't have to
shift-click every frame to bulk-act on a whole set.

## Current state (verified against the code, not assumed)

- **Selection already exists, just not a select-all shortcut.** `PhotoGrid.tsx:62` holds
  `multi: Set<string>` (selected asset IDs). `toggleMulti` (`PhotoGrid.tsx:83-92`) supports a
  single click (toggle one) and shift-click (`workspaceAssetIdsBetween`, `PhotoGrid.tsx:47-52`,
  range-select relative to `lastSelected.current`). The action bar
  (`PhotoGrid.tsx:138`, `multi.size > 0`) already has approve/flag/recommend/select-for-editing/
  rate/label bulk actions plus "Clear" (`setMulti(new Set())`) — select-all is the missing
  complement to that existing "Clear."
- **`displayOrder`** (`PhotoGrid.tsx:74`) is the exact set to select — it's already the
  filter-and-section-aware flattened list (`showSections ? sectionGroups.flatMap(...) : visible`,
  where `visible` already applies the active filter chip: all/recommended/rated/labeled/selected,
  `PhotoGrid.tsx:66-72`). Selecting `assets` (the unfiltered full prop) instead would silently
  select frames the user can't currently see, which would be confusing — `displayOrder` is the
  right scope.
- **Filter chips** (`PhotoGrid.tsx:75-81,134`) already show a per-chip count via the same
  filter-predicate logic duplicated inline — worth reusing, not re-deriving, per this codebase's
  general preference for a single source of truth over recomputing the same predicate twice.

## Design

**Revision note (Terra round 1)**: the first draft of this section internally contradicted
itself — it promised select-all would be purely additive (never dropping a previously-selected,
now-filtered-out item), but then specified `multi = new Set(displayOrder...)`, which *replaces*
`multi` and silently drops exactly those items. Terra caught this; corrected below along with two
related fixes to the same area.

- Add a "Select all" button next to the existing filter chips or in the `worktools` row
  (`PhotoGrid.tsx:134`) — exact placement is a small layout call for the build, not a planning
  decision. Clicking it **unions** the currently-visible set into the existing selection:
  `setMulti((current) => new Set([...current, ...displayOrder.map((asset) => asset.id)]))` —
  this is what actually delivers the "additive, never drops a hidden selection" behavior; the
  original `new Set(displayOrder...)` sketch did not.
- Button-flip condition, corrected: flip to "Deselect all" when
  `displayOrder.length > 0 && displayOrder.every((asset) => multi.has(asset.id))` — i.e., every
  *currently visible* item is selected, regardless of what else `multi` holds. The original
  `multi.size === displayOrder.length` test misfires whenever `multi` contains any ID outside the
  current filter (a real, easy-to-hit case given selections persist across filter changes,
  confirmed below).
- "Deselect all" removes only the currently-visible IDs, not the whole selection:
  `setMulti((current) => { const next = new Set(current); for (const asset of displayOrder) next.delete(asset.id); return next; })`.
  The action bar's existing "Clear" (`setMulti(new Set())`, `PhotoGrid.tsx:138`) remains
  unchanged and is still the only control that clears a selection *outside* the current filter.
- Changing the active filter chip while a selection exists does **not** auto-clear `multi` today
  (confirmed: `toggleMulti`/`multi` state is independent of `filter` state) — select-all/deselect-
  all must not change that existing behavior, per the union/subtract design above.
- `lastSelected.current` (used for shift-click range anchoring, `PhotoGrid.tsx:65,91`), corrected:
  the original claim that leaving it untouched "falls back to single-click semantics" was wrong —
  `toggleMulti`'s shift-click branch (`PhotoGrid.tsx:86-88`) only checks
  `lastSelected.current !== null`, so a stale anchor from *before* the select-all click remains
  live and a subsequent shift-click would range-select against it, which is surprising after a
  bulk action. Fix: explicitly reset `lastSelected.current = null` in both the select-all and
  deselect-all handlers.
- **Extended per Terra round 2**: the same stale-anchor problem already exists today, independent
  of this feature, at two other call sites that clear `multi` without touching `lastSelected`:
  the existing "Clear" button (`PhotoGrid.tsx:138`, `setMulti(new Set())`) and `bulk()`
  (`PhotoGrid.tsx:97-102`, which also ends with `setMulti(new Set())`). Since this build is
  already correcting `lastSelected` handling in the same file for the same reason, fix these two
  as well: reset `lastSelected.current = null` at both sites. (A third case Terra flagged — a
  shift-click anchor that's still set but now points to an asset filtered out of the current
  `displayOrder` after a filter-chip change — is a separate, narrower staleness issue:
  `workspaceAssetIdsBetween` returns `[]` when the anchor id isn't found in `displayOrder`, so the
  shift-click silently no-ops rather than misbehaving. Left as-is; out of scope here, since fixing
  it means deciding whether filter changes should reset the anchor at all, a separate design
  question from what this plan is for.)
- **New pre-existing bug surfaced by Terra round 2, more serious, fixed as part of this build**:
  `PhotoGrid` is mounted once in `ProjectWorkspace.tsx:339` with no `key` prop, while its `assets`
  prop is swapped out wholesale on every RAW/Edited tab change (`ProjectWorkspace.tsx:145-146`,
  `refreshAssets`/`setAssets`). Because `PhotoGrid` isn't remounted, its internal `multi` state
  survives the swap — so a selection made on one tab can still hold asset IDs after switching to
  the other tab, where those IDs aren't even in `assets` anymore. Since asset IDs are global (not
  scoped per collection/tab), a bulk action fired after the switch would call
  `onSelection`/`onReview` against those orphaned IDs — silently mutating assets outside the
  collection currently on screen, not just a UI glitch. Fix: add `key={activeTab}` to the
  `<PhotoGrid>` element at `ProjectWorkspace.tsx:339`, forcing a clean remount (resetting `multi`,
  `filter`, `lastSelected`, and the thumbnail-retry state) on every tab change. This touches
  `ProjectWorkspace.tsx` in addition to `PhotoGrid.tsx` — noted in Rollout below, since the
  original plan scoped this as single-component-only.
- **Third pre-existing bug, surfaced by Terra round 3 while checking the `key={activeTab}` fix,
  fixed as part of this build per explicit user decision (asked directly, "fix it now too")**:
  `key={activeTab}` alone isn't sufficient. `assets` (`ProjectWorkspace.tsx:47`) is shared across
  every tab and is only updated once `refreshAssets`'s async fetch resolves
  (`ProjectWorkspace.tsx:82-93,141-150`). The effect at `ProjectWorkspace.tsx:141-150` already
  special-cases switching *to* "raw": it synchronously restores `assets` from `rawAssetsRef`
  before the async refresh even starts (existing comment: "This never leaves Edited assets under
  RAW-only controls"). Switching to any other tab has no equivalent synchronous step — `assets`
  keeps showing whatever the *previous* tab held until the new fetch resolves, so the
  freshly-remounted `PhotoGrid` (correctly empty `multi`, thanks to the `key` fix) can briefly
  render the *previous* tab's assets under the *new* tab's controls. This is pre-existing and not
  caused by the `key` fix, but the `key` fix's whole point was closing this class of "wrong
  collection under active controls" risk, so it needs to close for every tab, not just the
  RAW-restore case that already existed. Fix: generalize the existing synchronous branch —
  `setAssets(activeTab === "raw" ? rawAssetsRef.current : [])` — clearing to empty rather than
  restoring for every non-RAW tab (there's no equivalent cache for Edited/video/floorplan/copy).
  This means a brief empty-grid flash on switching away from RAW while the fetch is in flight,
  which is an acceptable, honest "loading" signal (the existing empty state, "No frames in this
  view," already covers this visually) — strictly safer than the alternative of showing wrong
  data. Also benefits `CollectionPanel` (`ProjectWorkspace.tsx:340`), which receives the same
  `assets` prop for non-RAW/Edited tabs and has its own review actions.
- **Scope decision on the fetch-gap fix, made explicitly by the user after round 4**: Terra round
  4 found the `useEffect`-based clear above is still not fully synchronous — React renders once
  with the new `activeTab` and the *old* `assets` before the effect runs (the effect fires after
  that render commits, and after paint), so a single-frame flash of the wrong collection under
  the new tab's controls is still possible in principle. Closing that completely requires
  restructuring `ProjectWorkspace.tsx` to track *which* collection its `assets` state currently
  belongs to and derive what's actually displayed at render time (touching the optimistic-update
  code paths at `ProjectWorkspace.tsx:207-222` too) — a genuine architectural change, not a
  one-liner, and out of proportion to a "select-all button" plan. **User decision: ship the
  pragmatic `useEffect`-based fix now** (closes the realistic network-latency-duration window,
  which is the risk that actually matters in practice — a human cannot reliably click a bulk
  action inside a single React commit/paint cycle) **and track the full architectural fix as its
  own separate follow-up, to be picked up after this 6-feature batch is complete** — see
  `docs/plans/ProjectWorkspace-Asset-Tab-Sync-Plan.md` (new, not yet built, not yet Terra-plan-
  reviewed — stub only, written to preserve the finding, not to be picked up early).
- **Lightbox crash regression, found by Terra round 4, required (not optional) given the pragmatic
  fix above**: clearing `assets` to `[]` during a tab switch introduces a *new* crash if a
  lightbox is open at that moment. `openAssetId`/`lightboxOrderIds` (`ProjectWorkspace.tsx:53,56`)
  aren't reset on tab change today, and `Lightbox.tsx:101` does `const asset = assets[index]!;` —
  a non-null assertion with no bounds check. An emptied `assets` array plus a stale `index` would
  dereference `undefined`. Fix: in the same effect that clears/restores `assets` on tab change,
  also `setOpenAssetId(null); setLightboxOrderIds(null);` — closing any open lightbox on every tab
  switch. This is unconditionally required (not scope-optional) because it prevents a regression
  this plan's own fix would otherwise introduce, independent of whether the fuller architectural
  fix is deferred.

- **Fourth pre-existing bug, found during the build itself by the DOM tests this plan's own
  testing requirements called for** (not caught by any of the 5 plan-review rounds, since it's a
  React scheduling race only observable by actually running the code): `toggleMulti`'s original
  shift-click branch read `lastSelected.current` from *inside* the `setMulti` functional updater,
  while the same function's trailing line (`lastSelected.current = asset.id`) mutates that same
  ref immediately after calling `setMulti`. React does not always invoke a functional updater
  synchronously at call time — under some conditions it defers the actual invocation until after
  the rest of the handler's synchronous code has run, so the updater can end up reading *this
  call's own* `asset.id` (already mutated in) instead of the true prior anchor, silently turning
  a shift-click range-select into a same-item no-op. Reproduced directly by the DOM test for
  "reset the anchor on select-all, then shift-click" below — a plain click-then-shift-click
  sequence (no select-all involved) happened not to trigger the race, but select-all-then-
  shift-click did, which is how this build's own tests caught it. Fixed by capturing
  `const anchor = lastSelected.current;` *before* calling `setMulti`, and using `anchor` (a
  stable local, not a mutable ref) inside the updater — the ref mutation afterward can no longer
  affect a computation already in flight. This is a real, previously-shipped production bug in
  existing shift-click behavior, not something this plan introduced; fixed here because it's the
  exact `lastSelected` handling this plan is already modifying and was caught by the exact test
  coverage this plan's own testing requirements demanded.

## Explicitly out of scope

- Selecting across a filter change (i.e., "select all matching every filter, not just the
  currently active one") — select-all only ever operates on `displayOrder`, the currently visible
  set.
- Keyboard shortcut (e.g. Cmd/Ctrl+A) — a click target only for v1; add a shortcut later if
  requested.

## Testing requirements for the build

1. `apps/web`: select-all unions `displayOrder`'s asset IDs into `multi` without dropping any
   pre-existing, currently-hidden-by-filter selection; deselect-all removes only the
   currently-visible IDs, leaving any hidden selection intact; the button correctly flips to
   "Deselect all" only when every *visible* item is selected (not when `multi.size` happens to
   equal `displayOrder.length` by coincidence while containing different IDs — construct a test
   fixture where `multi` holds a hidden ID plus all-but-one visible ID to exercise this); both
   handlers reset `lastSelected.current` to `null`, and a shift-click immediately after either
   action behaves as a fresh anchor-less click, not a range-select against the pre-action anchor;
   existing shift-click/single-click/bulk-action/"Clear" behavior is unchanged (regression
   coverage, not new behavior). **Added per Terra round 2**: the existing "Clear" button and
   `bulk()` also reset `lastSelected.current` to `null` — a shift-click immediately after either
   is a fresh anchor-less click, not a range-select against the pre-clear anchor.
2. **New DOM-level coverage required** (per Terra round 3: `PhotoGrid.test.ts` today is
   SSR/static-markup-only, under the `node`-environment `vitest.config.ts`; there's no existing
   `ProjectWorkspace` test at all). Add `apps/web/src/components/PhotoGrid.dom.test.tsx` and/or
   `apps/web/src/screens/ProjectWorkspace.dom.test.tsx`, picked up automatically by the existing
   `vitest.dom.config.ts` (`happy-dom`, `src/**/*.dom.test.tsx` glob — no new config needed):
   - select-all/deselect-all button clicks, real DOM interaction (not just reducer-level asserts).
   - switching the active tab (RAW ↔ Edited) with a non-empty `multi` selection results in an
     empty selection on the new tab (via the `key={activeTab}` remount) — construct a fixture
     that selects assets on one tab, switches, and asserts no bulk action bar is shown and no
     stale IDs from the prior tab are retained.
   - **the fetch-gap guard** (added per Terra round 3's third finding): mock `apiGet` so the
     tab-switch asset fetch doesn't resolve synchronously: switch from RAW to Edited, and before
     the mocked fetch resolves, assert the grid does **not** render any RAW-only asset tile (i.e.
     `assets` was cleared to `[]`, not left showing stale RAW data) — the "No frames in this
     view" empty state is expected during this gap; then resolve the mock and assert the Edited
     assets appear.
   - `lastSelected` resets: a shift-click immediately after select-all, deselect-all, "Clear", or
     a completed `bulk()` behaves as a fresh anchor-less click, not a range-select against the
     pre-action anchor.
   - **Lightbox guard** (added per Terra round 4): open the lightbox on one tab, switch tabs, and
     assert it closes (`openAssetId`/`lightboxOrderIds` reset to `null`) rather than crashing or
     showing the wrong collection's asset.

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and**
  `npx vitest run --config packages/shared/vitest.config.ts` (silently skipped by the workspaces
  script otherwise, per this repo's own gotcha — added per Terra round 2's reminder even though
  this feature itself doesn't touch `packages/shared`, since it's part of the standard verify
  sequence).
- Manual smoke: open a project workspace with a mixed RAW set, apply a filter, click "Select
  all," confirm only the filtered/visible frames are selected and the bulk action bar reflects
  the correct count. **Added per Terra round 2**: select several frames on the RAW tab, switch to
  the Edited tab, confirm the selection and action bar are gone; select frames, click "Clear" (or
  fire a bulk action), then shift-click a different frame and confirm it behaves as a fresh
  single-select, not a range-select against the pre-clear anchor. **Added per Terra round 3**: on
  a throttled connection (or DevTools network throttling), switch tabs and confirm the grid
  briefly shows the empty state rather than a flash of the previous tab's frames.

## Rollout

Frontend, two files: `PhotoGrid.tsx` (select-all/deselect-all, `lastSelected` reset extended to
"Clear"/`bulk()`) and `ProjectWorkspace.tsx` (`key={activeTab}` on the `<PhotoGrid>` mount, per
Terra round 2's cross-tab stale-selection finding — corrected from the original "single
component" scoping). One deploy (the `app` Worker, which serves `apps/web`'s built output), no
migration, no API change.

## Routing (per Subagent-Orchestration.md §2 routing table)

Small, frontend-only change across two files (corrected per Terra round 3 — no longer
single-component, see Rollout) — routed as "too small to be worth delegating": this session
builds directly, still gated by a fresh-context Terra diff review before the §5 gate, per the
Build-Handoff doc's routing for this plan.
