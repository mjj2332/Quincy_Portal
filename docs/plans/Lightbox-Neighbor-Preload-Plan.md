# Lightbox Neighbor Preload — Plan

**Status: draft, not yet submitted for review.** Split out from
[Gallery-Eager-Background-Preload-Plan.md](Gallery-Eager-Background-Preload-Plan.md) (revision
4, per user decision) after Terra's round-4 review recommended shipping grid background preload
and this separately, given the combined change had accumulated enough independent moving parts
(shared `LazyImage` lifecycle rewrite, a new DOM test environment, scheduler injection, and this
feature's own neighbor state machine) to raise real review/rollback risk as one change.

**Sequencing: pick this up after the grid plan ships**, not in parallel — it reuses the DOM test
environment established there rather than duplicating it, and building on an already-deployed,
stable `LazyImage` reduces the surface area this plan's own review needs to re-litigate.

This document has **not yet been through its own dedicated Terra review round** — the design
below is what survived four rounds of review on the combined plan, carried forward as-is where
confirmed, and flagged where still-open findings remain. Treat the "Still-open findings" section
as the actual starting point for whoever picks this up, not the "Design" section's prose as
already-approved.

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
- **When RAW-compare mode is active, the lightbox renders *two* hero images simultaneously** —
  the edited hero (`Lightbox.tsx:511`) and the RAW-compare counterpart
  (`Lightbox.tsx:515-516`, gated on `compareActive = band !== "phone" && showRawCompare &&
  Boolean(rawCompareAsset)`) — confirmed by reading the render output directly, not assumed. This
  matters for worst-case concurrency accounting below.
- `LazyImage.tsx` (the grid's shared component, see the other plan) renders a real, freshly-keyed
  `<img>` element directly per attempt — it does **not** use a detached `new Image()` object as
  an intermediate warm-then-render step. A correction from an earlier draft of this plan: don't
  describe the neighbor-preload design below as "mirroring" `LazyImage`'s mechanism — it doesn't
  literally work that way. The neighbor-preload design's own use of a detached `new Image()` is
  justified on its own merits (we explicitly do *not* want to render invisible off-screen `<img>`
  elements for neighbors the way a grid tile eventually renders one), not as consistency with
  `LazyImage`'s specific implementation.
- `cycleLightboxIndex(index, change, assetCount) => (index + change + assetCount) % assetCount`
  — for `assetCount === 1`, both `change=+1` and `change=-1` resolve to `index` itself (the
  current asset); for `assetCount === 2`, both resolve to the *same* other index. Any neighbor-set
  computation must dedupe and must exclude the current index.

## Goal

Fetch the next/previous asset's `/web` image ahead of navigation, using a small, separate
concurrency budget from the grid's scheduler, so paging through a review sequence feels instant.

## Design (carried forward; see "Still-open findings" for what actually needs fixing)

### A dedicated, single-priority semaphore

The lightbox has no scrolling/`IntersectionObserver` concept — one hero image, swapped on
navigation — so it needs a small dedicated semaphore, not the grid's two-priority abstraction
(every neighbor-preload request is equivalent priority; reusing the two-priority scheduler with
equal arguments was reviewed as confusing, not incorrect).

```ts
export interface NeighborPendingRequest { promise: Promise<() => void>; cancel(): void }

export function createNeighborScheduler(maxConcurrent: number) {
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

### Neighbor computation and tracking

A hook, `useLightboxNeighborPreload(assets: WorkspaceAsset[], index: number)`. On mount and on
every `index` change, compute the desired neighbor set via `cycleLightboxIndex` at radius 1
(`index-1`, `index+1`) — **deduped, and excluding `index` itself** (see the 1-2-image edge case
above; still-open finding, see below).

Tracking state per neighbor asset ID as a discriminated union:

```ts
type NeighborState =
  | { kind: "queued"; pending: NeighborPendingRequest }
  | { kind: "active"; img: HTMLImageElement; release: () => void; watchdog: number; wanted: boolean };
```

**No `Image.src` clearing for cancellation.** A neighbor that falls outside the current radius is
marked `wanted: false` on its `active` entry (or has its `queued` handle's `.cancel()` called if
not yet granted) — its `onload`/`onerror` still fires and still releases the permit normally, but
the result is ignored. Explicitly chosen over clearing `src`, since that isn't a reliable network
abort and could let real network activity exceed the claimed cap.

A watchdog per active neighbor attempt (mirroring `LazyImage`'s 25s constant), releasing its
permit if neither `onload` nor `onerror` fires — without it, two hung neighbor loads permanently
starve the 2-slot budget.

No idle-callback deferral — starts immediately, given the tiny working set and the latency-
sensitivity of the use case. Radius 1 by default (a one-constant change to raise later).
Explicitly **not** covering the RAW-compare overlay's counterpart image — an on-demand toggle
within one asset's view, not sequential navigation (confirmed correctly scoped out in review).
Respects `navigator.connection?.saveData` the same way as the grid plan.

## Still-open findings (from round 4's review of the combined plan — fix these before submitting for this plan's own review)

1. **Missing one-shot completion guard.** `onload`, `onerror`, and the watchdog can all
   potentially fire for the same attempt (e.g., the watchdog releases a permit, and the real
   `onload` arrives moments later) — nothing currently stops a second completion from acting on
   stale state. Needs a `released`-style boolean guard (mirroring `LazyImage`'s own
   `releaseActive`/`released` pattern) so exactly one of the three ever actually acts.
2. **1-2-image collection edge case unhandled in the design as written.** Confirmed above:
   `cycleLightboxIndex` returns `index` itself for a 1-image collection and the same other index
   twice for a 2-image collection. The neighbor-set computation must dedupe target indices and
   explicitly exclude the current index (it's already loaded via the hero, no need to preload it
   again).
3. **Corrected worst-case concurrency count: 4 (grid) + 2 (neighbors) + 2 (both simultaneous
   hero images during RAW-compare) = 8**, not 7 or 6 as earlier drafts of this plan claimed —
   confirmed by reading `Lightbox.tsx:515-516` directly (compare mode renders two heroes at once,
   not one replacing the other). Still nowhere near the 24-40 concurrent transforms that caused
   the 2026-07-21 incident; state this number accurately when this plan is written up properly,
   rather than repeat the undercount.
4. **The "mirrors `LazyImage`'s detached `new Image()` convention" framing was wrong** (see
   "Current state" above) — restate the justification for using a detached `Image()` here on its
   own terms (avoiding invisible rendered `<img>` elements for off-screen neighbors) rather than
   claiming consistency with a mechanism `LazyImage` doesn't actually use.

## Explicitly out of scope

- The RAW-compare overlay's counterpart image (see above).
- Raising the preload radius beyond 1 (structured to be trivial later, not needed now).
- Any server-side change.

## Before this plan goes to Terra for its own review round

1. Fix all four still-open findings above.
2. Confirm the grid background-preload plan has shipped and its DOM test environment
   (`vitest.dom.config.ts`, `happy-dom`/`jsdom`, the corrected dual-config `test` script) is live
   in `apps/web` — this plan's own tests build on that infrastructure rather than re-establishing
   it.
3. Write this plan's own testing requirements section (a first draft exists implicitly in the
   combined plan's history — items covering the one-shot guard, the 1-2-image edge case, and
   scheduler independence from the grid's — but it should be re-derived cleanly for this
   document rather than copied verbatim, now that the design has been corrected).
4. Submit for a fresh Terra plan review, in the same fresh-context loop as always.
