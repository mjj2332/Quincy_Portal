# Lightbox Neighbor Preload — Plan (revision 4)

**Status: built and verified.** Approved after 4 plan rounds, built, and diff-reviewed by Terra
(clean — the only note was the same pre-existing, untracked, unrelated `Notifications-Plan.md`
the gallery-preload diff review also flagged and this session already confirmed has no git
history and isn't part of any diff). An Opus final-draft review (per §1, since this session runs
as Sonnet 5, not Opus) signed off on shipping, and — specifically asked to hunt for the same bug
class it caught in Part 1's `succeed()`/`fail()` asymmetry — found a latent instance of it:
`finish()`'s permit release was gated behind the same identity check that (correctly) protects
against corrupting a newer entry for the same asset ID, meaning a future caller violating
`reconcile`'s invariant (never starting a fresh attempt while an active one exists) could leak a
permit permanently. Not reachable via the actual production call path today, but cheap to close
and the same shape as a bug that already shipped once in Part 1 — fixed by decoupling "release
exactly once" (a one-shot flag) from "still own this map slot" (identity check, now used only to
decide whether to `delete`). Also applied two further Opus recommendations: removed the `wanted`
field (set and mutated throughout but never read in production — asserted only by a test, which
made it look load-bearing when it wasn't) and added `fetchPriority = "low"` to the preload
`Image` so it doesn't compete with the hero image the user is actually looking at.

Depends on [Gallery-Eager-Background-Preload-Plan.md](Gallery-Eager-Background-Preload-Plan.md),
already shipped (commit `26dcaf5`, deployed) — this plan reuses that change's `happy-dom` DOM
test environment (`vitest.dom.config.ts`) rather than re-establishing it.

## Revision history

**Revision 1** was carried forward from a combined plan (with grid background preload) that went
through four review rounds before being split out — this document's own findings were recorded as
work notes, not yet resolved in the design itself.

**Revision 2** resolved all four: `neighborIndices()` deduping and excluding the current index; a
`finishActive`/map-presence one-shot guard; a corrected 8-way worst-case concurrency count; and a
corrected description of how this relates to `LazyImage` (justified on its own merits, not framed
as "mirroring" a mechanism `LazyImage` doesn't actually use). This session also caught, while
designing revision 2, that an already-granted ("active") neighbor can't be cleanly aborted the way
a not-yet-granted ("queued") one can, and designed a queued-vs-active split for that.

**Terra's first dedicated review of this document** (round 1) found real gaps in revision 2,
verified independently before this revision:

1. **The radius-normalization bug, confirmed.** `neighborIndices()`'s reliance on
   `cycleLightboxIndex()` (`(index + change + assetCount) % assetCount`) only produces a
   non-negative result when `|change| <= assetCount`. For `count=3, radius=4`,
   `cycleLightboxIndex(0, -4, 3)` returns `-1` — confirmed by running it directly. Not reachable
   at today's radius (1), but a real trap for the "raise it later, it's a one-constant change"
   path this plan itself describes.
2. **The one-shot guard had a real identity gap — this is the same bug class
   `docs/lessons.md` already documents ("reused DOM node lets a late load/error event from a
   prior attempt release the wrong permit"), reincarnated at the map level instead of the
   component level.** `finishActive(assetId)` checked "is there an active entry for this key,"
   not "is this the *same* attempt" — a stale completion event for an old, watchdog-abandoned
   attempt could find a *newer* entry that reused the same asset ID (created after the old entry
   was deleted and the asset became desired again) and incorrectly release/delete *that* one.
   Same root cause on the queued→active transition check (`?.kind === "queued"` doesn't
   distinguish "this specific queued attempt" from "a different, newer queued attempt that
   happens to share the same asset ID").
3. **No unmount cleanup, and the reconciliation trigger was underspecified** — the plan only
   said "on mount and index changes," missing both closing the lightbox entirely and the asset
   list itself changing (e.g., filtering) while `index` stays numerically the same.
4. **The worst-case concurrency count needed qualifying, not just stating.** The "8" figure
   bounds *permit-held* concurrency (our own accounting), not an absolute ceiling on real browser
   network activity — a watchdog-released permit doesn't guarantee the underlying HTTP request
   actually stopped, so real in-flight requests can transiently exceed 8.
5. **Testing gaps**: no coverage for a late completion after the same asset is reacquired, a
   canceled-then-immediately-re-desired asset, unmount cleanup, asset-list changes without an
   index change, or larger-radius normalization. Also: the hard-coded scheduler singleton makes
   queued/active/release-once tests hard to control — needs the same injectable-scheduler pattern
   the (already-reviewed, already-shipped) grid plan settled on.

Revision 3 fixed all five. **Round 2** (approved with changes — this revision closes them): the
five correctness findings were all confirmed genuinely closed (radius normalization traced
correctly for multiple cases; the reference-equality race verified against JS's synchronous
execution model; unmount handling confirmed safe; RAW-compare two-hero accounting re-verified
directly). Three remaining items: test 10 needed rewriting to actually force the race it claims to
test (not just re-exercise the simpler one-shot case test 9 already covers); the scheduler
injection needed the hook's actual signature shown, not just a prose description; and the
concurrency wording still slightly overreached ("transiently," "nowhere near 24-40" implied a
bound that isn't guaranteed — outstanding requests can accumulate, not just briefly spike). This
revision fixes all three.

## Why this feature, per the user

Quincy Portal's primary users are photographers and editors who need to move through a project's
images quickly. Paging one-by-one through a review sequence in the full-screen lightbox is
arguably the more direct expression of that need than the grid's background preload (which mainly
helps before the user has started navigating at all) — clicking next/prev today loads the next
image cold, every time, with zero prefetch.

## Current state (verified against the code)

- The lightbox's hero image (`/web`, `Lightbox.tsx:511`) is deliberately ungated per
  `docs/lessons.md:127-128` ("single hero images are fine ungated") and today does not preload
  neighbors on navigation — `move()` (`Lightbox.tsx:122`, using `cycleLightboxIndex` from
  `lib/lightbox-navigation.ts`) just swaps `index`, and the `<img src>` re-renders cold.
- When RAW-compare mode is active, the lightbox renders **two** hero images simultaneously — the
  edited hero (`Lightbox.tsx:511`) and the RAW-compare counterpart (`Lightbox.tsx:515-516`, gated
  on `compareActive = band !== "phone" && showRawCompare && Boolean(rawCompareAsset)`).
- `cycleLightboxIndex(index, change, assetCount) => (index + change + assetCount) % assetCount` —
  correct for `|change| <= assetCount` (true for `move()`'s own real use, always ±1), but not
  safe for arbitrary `change`/`assetCount` combinations — confirmed: `cycleLightboxIndex(0, -4, 3)`
  returns `-1`. This plan's own neighbor-index computation does not rely on this assumption (see
  Design §2).
- `portal/apps/web/vitest.dom.config.ts` (from the shipped gallery plan) provides a `happy-dom`
  environment for `*.dom.test.tsx` files — reused directly, not re-established.

## Goal

Fetch the next/previous asset's `/web` image ahead of navigation, using a small, separate
concurrency budget from the grid's scheduler, so paging through a review sequence feels instant.

## Design

### 1. A dedicated, single-priority, injectable scheduler

The lightbox has no scrolling/`IntersectionObserver` concept — one hero image, swapped on
navigation — so it needs a small dedicated semaphore, not the grid's two-priority abstraction;
every neighbor-preload request is equivalent priority.

```ts
export interface NeighborPendingRequest { promise: Promise<() => void>; cancel(): void }
export interface NeighborScheduler { acquire(): NeighborPendingRequest }

export function createNeighborScheduler(maxConcurrent: number): NeighborScheduler {
  let active = 0;
  const waiting: Array<{ grant: () => void }> = [];
  function drain(): void {
    if (active >= maxConcurrent || waiting.length === 0) return;
    const [w] = waiting.splice(0, 1);
    w.grant();
  }
  function acquire(): NeighborPendingRequest {
    let entry: { grant: () => void } | null = null;
    const promise = new Promise<() => void>((resolve) => {
      const grant = () => {
        active += 1;
        let released = false;
        resolve(() => { if (released) return; released = true; active -= 1; drain(); });
      };
      if (active < maxConcurrent) grant(); else { entry = { grant }; waiting.push(entry); }
    });
    return { promise, cancel() { if (!entry) return; const i = waiting.indexOf(entry); if (i !== -1) waiting.splice(i, 1); } };
  }
  return { acquire };
}

export const lightboxPreloadScheduler = createNeighborScheduler(2);
```

**Injectable, per the grid plan's already-reviewed pattern (closes finding 5's scheduler-control
gap).** Matching `LazyImage`'s shipped shape exactly (`scheduler?: Scheduler` prop, resolved as
`props.scheduler ?? gridImageScheduler` inside the effect — `LazyImage.tsx:13,115`):

```ts
function useLightboxNeighborPreload(
  assets: WorkspaceAsset[],
  index: number,
  scheduler: NeighborScheduler = lightboxPreloadScheduler,
): void {
  useEffect(() => {
    const neighbors = new Map<string, NeighborState>();
    reconcile(neighbors, scheduler, neighborIndices(index, assets.length, 1).map((i) => assets[i]!.id));
    return () => {
      for (const [assetId, entry] of neighbors) {
        if (entry.kind === "queued") entry.pending.cancel();
      }
    };
  }, [assets, index, scheduler]);
}
```

Production call sites never pass `scheduler` — they get the real shared singleton via the default
parameter, exactly as `LazyImage`'s consumers rely on its default. Tests pass their own fresh
`createNeighborScheduler(...)` instance directly. **A test-supplied scheduler must be stable
across the test's renders** (created once, outside any re-render, the same way a real call site's
implicit default is stable) — the effect's own dependency array includes `scheduler`, so a test
that constructs a *new* scheduler instance on every render would cause the effect to tear down
and re-run pointlessly, the same caveat that would apply to any effect dependency.

### 2. Neighbor set computation — self-contained normalization, not reliant on `cycleLightboxIndex` (closes finding 1)

```ts
function normalizeIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function neighborIndices(index: number, count: number, radius = 1): number[] {
  const indices = new Set<number>();
  for (let delta = 1; delta <= radius; delta++) {
    const next = normalizeIndex(index + delta, count);
    const prev = normalizeIndex(index - delta, count);
    if (next !== index) indices.add(next);
    if (prev !== index) indices.add(prev);
  }
  return [...indices];
}
```

`((n % count) + count) % count` is correct for any integer `n` and any `count >= 1`, regardless of
how large `delta` gets relative to `count` — this removes the class of bug entirely rather than
capping radius as a workaround. Traced against the edge cases: `count === 1` → both `next`/`prev`
equal `index` → excluded → empty result. `count === 2` → both resolve to the same other index →
added once via the `Set`. `count >= 3, radius <= count` → two genuinely distinct neighbors, as
expected. `count=3, radius=4` (the case that broke the old approach) → `normalizeIndex(0-4, 3)` =
`((-4 % 3) + 3) % 3` = `((-1) + 3) % 3` = `2` — correct, no negative index.

### 3. Tracking state — reference-equality guards close both the one-shot and re-acquisition gaps (finding 2)

The core fix: **capture the specific entry object when an attempt starts, and check the map still
points at *that exact object* (not just "some entry with a matching kind") before acting on it.**
This is the same principle `LazyImage`'s `releaseActive(id)` already uses (compare an attempt's
own identity, not just "is something currently active") — applied here via object reference
instead of a numeric id, since the map is naturally keyed by asset ID already.

```ts
type NeighborState =
  | { kind: "queued"; pending: NeighborPendingRequest }
  | { kind: "active"; img: HTMLImageElement; release: () => void; watchdog: number; wanted: boolean };

function startNeighborPreload(neighbors: Map<string, NeighborState>, scheduler: NeighborScheduler, assetId: string): void {
  const pending = scheduler.acquire();
  const queuedEntry: NeighborState = { kind: "queued", pending };
  neighbors.set(assetId, queuedEntry);
  void pending.promise.then((release) => {
    // Reference check, not a "kind" check: a cancel() + later re-`startNeighborPreload()` for the
    // same asset ID would otherwise let this stale continuation mistake the *new* queued entry
    // for itself.
    if (neighbors.get(assetId) !== queuedEntry) { release(); return; }
    const img = new Image();
    const activeEntry: NeighborState = { kind: "active", img, release, watchdog: 0, wanted: true };
    const finish = () => {
      // Same reference check, now doing double duty as both the one-shot guard (whichever of
      // onload/onerror/watchdog fires first wins) and the identity guard (a late completion for
      // an old, already-superseded attempt at this same asset ID finds the map pointing at a
      // *different* object and correctly no-ops, instead of releasing/deleting the wrong entry —
      // the exact bug class docs/lessons.md documents for LazyImage's own reused-DOM-node case,
      // here reincarnated at the map level and closed the same way).
      if (neighbors.get(assetId) !== activeEntry) return;
      window.clearTimeout(activeEntry.watchdog);
      release();
      neighbors.delete(assetId);
    };
    activeEntry.watchdog = window.setTimeout(finish, 25_000); // mirrors LazyImage's timeout value
                                                               // for consistency; not the same
                                                               // mechanism (see Current state).
    neighbors.set(assetId, activeEntry);
    img.onload = finish;
    img.onerror = finish;
    img.src = `/media/asset/${encodeURIComponent(assetId)}/web`;
  });
}
```

**Reconciling the desired set against tracked state, on mount and whenever the desired set could
change (index, or the assets array/count — see finding 3 below):**

```ts
function reconcile(neighbors: Map<string, NeighborState>, scheduler: NeighborScheduler, desired: string[]): void {
  const desiredSet = new Set(desired);
  for (const [assetId, entry] of neighbors) {
    if (desiredSet.has(assetId)) continue; // still wanted — leave it exactly as is
    if (entry.kind === "queued") {
      entry.pending.cancel(); // never granted a permit — clean, immediate removal
      neighbors.delete(assetId);
    } else {
      entry.wanted = false; // already mid-flight — can't cleanly abort; let its own `finish`
                             // release the permit when it actually completes (no retry either way)
    }
  }
  for (const assetId of desiredSet) {
    const existing = neighbors.get(assetId);
    if (existing) {
      if (existing.kind === "active") existing.wanted = true; // re-desired before it finished
      continue; // already tracked (queued or active either way) — no duplicate fetch
    }
    startNeighborPreload(neighbors, scheduler, assetId);
  }
}
```

**No retry on failure, by design.** Unlike `LazyImage`'s grid tiles (where a failed load is
user-visible and needs a retry path), a failed neighbor preload has no user-visible surface — if
it fails, the user gets today's existing behavior (a cold load) when they actually navigate
there. This is an optimization failing to help, not a user-visible failure, and `/media/asset/
.../web` responses are `private, no-store`, so there's nothing stale to worry about caching
either.

### 4. Lifecycle: unmount, and reconciling on more than just `index` (closes finding 3)

**On unmount** (the lightbox closes): cancel every still-*queued* entry immediately (clean,
nothing was granted). Leave *active* entries alone — mark them `wanted: false` if that's not
already the effective state, but do not force-terminate them; their own `finish` still fires
eventually and releases the permit correctly regardless of whether the component that started
them is still mounted, since `finish`'s reference-equality guard and the scheduler's own release
logic are independent of any component lifecycle.

**Reconciliation must re-run when the *desired set* could have changed, not only when `index`
does.** The desired set depends on `cycleLightboxIndex`'s output, which depends on both `index`
and `assets.length` (and, if assets can reorder without the array reference changing, the actual
identities at each position) — so the hook's effect must depend on the assets array itself (or an
equivalent stable derived key, e.g. a joined string of asset IDs) alongside `index`, not `index`
alone. Without this, filtering or reordering the collection while the numeric `index` happens to
stay the same would leave stale neighbor targets tracked and the actually-adjacent assets
un-preloaded.

### 5. Scheduling and scope

No idle-callback deferral — starts immediately. The working set is tiny (at most 2 under radius
1) and the entire value of this feature depends on completing before the user's *next* click.
Radius 1 by default, a one-constant change to raise later (now safe to raise per §2's fix).
Respects `navigator.connection?.saveData` the same way as the grid plan.

## Explicitly out of scope

- The RAW-compare overlay's counterpart image (`Lightbox.tsx:516`) — an on-demand toggle within
  one asset's view, not sequential navigation.
- Raising the preload radius beyond 1.
- Any server-side change.

## Worst-case concurrency (qualified — closes finding 4)

`MAX_CONCURRENT = 4` (grid scheduler) + 2 (this plan's dedicated scheduler) + 2 (both hero images
simultaneously rendered during RAW-compare mode, confirmed at `Lightbox.tsx:511,515-516`) = **8**.
**Precisely what this bounds:** the number of permits held and the number of *new* requests this
system will deliberately start at once. It does **not** bound actual outstanding browser network
requests at every instant: a watchdog-released permit means we've stopped waiting on that request
and freed its budget slot for a new one to start, not that the underlying HTTP request was
actually aborted (no `Image.src` clearing, per §3) — so real in-flight requests can exceed 8, and
if several watchdogs fire in succession without their underlying requests ever actually
completing, that excess can **accumulate**, not just spike briefly. This is a real, open-ended gap
in the guarantee, not a bounded one — stated plainly rather than softened. It's still nowhere near
the 24-40 *simultaneous new* transforms that caused the 2026-07-21 incident (`docs/lessons.md`),
since that failure mode was specifically about how many transforms get *started* at once, which
this design does bound — but "8" itself should not be read as a network-layer ceiling.

## Testing requirements for the build

**Scheduler module, plain Node environment:**

1. A request is granted immediately under the cap; queued once the cap is reached.
2. `cancel()` removes a still-queued entry; granting a later request fills the freed slot.
3. Each test creates its own `createNeighborScheduler(...)` instance — no shared state.

**Neighbor reconciliation logic, `happy-dom` environment (reusing the gallery plan's
`vitest.dom.config.ts`), every test passing its own fresh scheduler instance:**

4. Mounting at some `index` in a 5+ image collection preloads exactly `index-1` and `index+1`.
5. A 1-image collection preloads nothing (empty desired set, zero `acquire()` calls).
6. A 2-image collection preloads exactly one neighbor, not two redundant requests for the same
   asset ID.
7. Navigating forward cancels a still-*queued* neighbor that fell outside the new radius, without
   touching one still in radius.
8. An already-*active* neighbor that falls outside the new radius is marked `wanted: false` but
   remains tracked; its eventual completion still releases its permit (no leak), with no retry.
9. **The one-shot + identity guard, directly:** a single active neighbor's `finish` runs exactly
   once even if both `onload` and the watchdog (or `onerror` after `onload`) fire for it.
10. **The reacquisition race, directly (this is the bug Terra's review actually found) — must
    force the actual race, not just re-exercise test 9's one-shot behavior:** start a neighbor,
    finish it via its **watchdog specifically** (not `onload`/`onerror`, and without going through
    `reconcile()`'s normal "fall out of radius" path — the old attempt must genuinely complete
    and be deleted from the map on its own, mimicking the true race), so its map entry is deleted
    while its real `img` object's `onload`/`onerror` handlers are still captured by the test.
    Then `reconcile()` the *same* asset ID again, confirm a **new** attempt starts (new `active`
    entry, new `img`, handlers freshly assigned). Only *then* invoke the **old**, captured
    `img`'s `onload` (or `onerror`) — and separately, the old captured watchdog callback, if still
    reachable — and assert the **new** entry's release/deletion state is completely untouched
    (release call count for the new entry stays at zero events from the stale calls, and
    `neighbors.get(assetId)` still points at the new entry object, not `undefined`).
11. A canceled queued attempt, immediately followed by the same asset becoming desired again,
    starts a genuinely fresh `acquire()` rather than being confused with the canceled one.
12. Unmounting cancels all still-queued entries; an active entry's later completion still fires
    cleanly (no error, no double-release) even though the owning component is gone.
13. The assets array changing (e.g., a filtered/reordered list) while `index` stays numerically
    the same still triggers reconciliation against the new desired set.
14. `neighborIndices()` at `count=3, radius=4` (the case that broke the naive approach) returns
    correct, non-negative, deduped indices — a direct unit test of §2's fix, independent of the
    component-level tests.
15. `navigator.connection.saveData === true` prevents new neighbor preloads from starting; API
    absence fails open.
16. **Scheduler-permit independence** (not a network-layer claim — see the qualified "Worst-case
    concurrency" section above): mount both this plan's dedicated scheduler and the grid's
    scheduler at once, each with its own instance, and assert neither's *permit accounting* is
    affected by the other's activity — i.e., confirm the two budgets are genuinely separate
    counters, not that any particular number of real network requests is observed.

## Verification (§5 gate, after Terra approves the plan and the build lands)

1. `npm run typecheck` (from `portal/`, covers all six workspaces).
2. `npm run build -w @quincy/web`.
3. The `apps/web` test suite (both configs, via its existing `test` script).
4. `npx vitest run --config packages/shared/vitest.config.ts` (per `CLAUDE.md`, unaffected).
5. **Manual, real-browser verification**: open the lightbox on a real project, page through
   several frames with `read_network_requests` open, confirm `/media/asset/.../web` requests for
   upcoming neighbors fire ahead of each click landing, and confirm total concurrent requests
   never spike unreasonably even with the grid still mounted underneath.

## Rollout

- Frontend-only: `portal/apps/web`. No backend/worker logic, schema, or migration.
- Deploy: `cd portal/workers/app && npx wrangler deploy` (only `app` needs redeploying).
- **Rollback:** revert the diff and redeploy `app` — no data involved either direction.

## Routing (per Subagent-Orchestration.md §2 routing table)

Normal feature touching a new, independent concurrency mechanism — routes to **Terra as
builder**, **Terra fresh-context as reviewer** of both this plan and the resulting diff.
