# ProjectWorkspace Asset/Tab Sync — Plan (stub, deferred)

**Status: NOT STARTED. Stub only — written to preserve a real finding, not yet drafted as a full
plan, not yet Terra-reviewed. Explicit user decision (2026-07-28): pick this up after the current
6-feature batch (`docs/Build-Handoff-6-Feature-Plans.md`) is complete, not before.**

## Origin

Found by Terra during round 3/4 plan review of `docs/plans/PhotoGrid-Select-All-Plan.md`, while
verifying a `key={activeTab}`-based fix for a cross-tab stale-selection bug in
`portal/apps/web/src/screens/ProjectWorkspace.tsx`. Not caused by that fix — pre-existing.

## The problem

`ProjectWorkspace.tsx` holds a single `assets` state (`ProjectWorkspace.tsx:47`) shared across
every collection tab (RAW/Edited/video/floorplan/copy). When `activeTab` changes, `assets` is only
updated once the new tab's async fetch resolves (`refreshAssets`,
`ProjectWorkspace.tsx:82-93,141-150`). A `useEffect` keyed on `activeTab` synchronously restores
RAW's cached data (`rawAssetsRef.current`) or clears to `[]` for other tabs (added by
`PhotoGrid-Select-All-Plan.md`'s round-3/4 fix) — but because React commits and paints the render
with the *new* `activeTab` and the *old* `assets` before that effect runs, there is a real (if
narrow) window where the UI shows one collection's assets under another collection's controls.
`PhotoGrid-Select-All-Plan.md`'s shipped fix narrows this to a single-paint flash, which is not
realistically human-clickable, and separately guards against the resulting Lightbox crash by
closing the lightbox on every tab change — but does not eliminate the window architecturally.

There's a second instance of the same race: the initial-load effect
(`ProjectWorkspace.tsx:114-139`) sets `assets` to RAW data and then, in the same `.then()`,
conditionally calls `setActiveTab("edited")` for editors landing on in-progress projects
(`ProjectWorkspace.tsx:130-133`) — the same stale-assets-under-new-tab-controls shape, just at
mount instead of a user click.

## What the real fix looks like (sketch, not a committed design)

Track which collection the `assets` state actually holds data for (e.g. a parallel `assetsKind`
state, set alongside every `setAssets` call), then derive what's actually rendered as a pure
function of state during render:

```ts
const displayedAssets = assetsKind === activeTab ? assets : activeTab === "raw" ? rawAssets : [];
```

This closes the gap for *every* `activeTab`-changing code path (click handler, initial-load
programmatic switch, any future one) without needing to remember to pair every `setActiveTab` call
with a manual synchronous clear — the derivation is correct on every render regardless of how
`activeTab` got there.

This also requires auditing the optimistic-update paths (`updateReview`/`updateSelection` at
`ProjectWorkspace.tsx:207-222`, which write directly to `assets`/`rawAssets`) to make sure they
stay consistent with whichever collection is actually "current" under the new derived-state model,
and re-checking `CollectionPanel` (`ProjectWorkspace.tsx:340`) and `Lightbox` (`:343`) against the
new derivation.

## Scope note

This is a real architectural change to `ProjectWorkspace.tsx`'s state management, not a
one-off bug fix — it deserves its own full plan-review loop (draft → Terra review → revise) per
`docs/Subagent-Orchestration.md`, not a bolt-on to whatever feature happens to touch this file
next. Draft that plan properly when picked up; don't build directly from this stub.
