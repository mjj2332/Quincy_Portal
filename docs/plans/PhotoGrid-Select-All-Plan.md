# PhotoGrid Select-All — Plan

**Status: draft, revised after Terra round 1 (APPROVED WITH CHANGES), awaiting round 2.**

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
   coverage, not new behavior).

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces`.
- Manual smoke: open a project workspace with a mixed RAW set, apply a filter, click "Select
  all," confirm only the filtered/visible frames are selected and the bulk action bar reflects
  the correct count.

## Rollout

Frontend-only, single component (`PhotoGrid.tsx`) — one deploy, no migration, no API change.

## Routing (per Subagent-Orchestration.md §2 routing table)

Small, frontend-only, single-component change — Terra plan review, then (when the user
authorizes a build) Terra build, Terra diff review, Opus final read, §5 gate.
