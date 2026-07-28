# Gallery Background Preload — Plan (revision 7, split from lightbox preload)

**Status: built and verified; one post-approval fix applied.** Approved by Terra after 7 plan
rounds, built, and diff-reviewed by Terra (2 rounds — the first caught an unauthorized,
out-of-scope doc reorganization the builder made on its own initiative, since reverted; the
second approved the actual implementation cleanly). An Opus final-draft review (per §1, since
this session runs as Sonnet 5, not Opus) then found one real, confirmed defect: `succeed()` in
`LazyImage.tsx` set `succeededRef.current = true` *before* checking `releaseActive(id)`, unlike
`fail()`, which checks ownership first — a stale success event for an attempt already superseded
by the watchdog could poison `succeededRef` for the wrong attempt, permanently blocking `start()`
from ever running again for that tile. Fixed by reordering `succeed()` to match `fail()`'s
existing check-then-mutate pattern. A regression test was attempted but had to be withdrawn: it
tried to simulate the stale event via a detached DOM node, but React removes an unmounted
element's listeners during its commit phase, so the simulated event never reached the handler in
either the buggy or fixed configuration — the test didn't actually discriminate between the two,
so shipping it would have been false confidence rather than real coverage. The fix stands on the
code-reading justification alone (it exactly mirrors `fail()`'s already-reviewed, already-tested
ownership-check pattern). Two further Opus recommendations — lowering
`backgroundMaxConcurrent` from 3 to 2, and not surfacing terminal "Image unavailable" for
attempts that only ever ran at background priority — are **not applied**, flagged as optional
follow-ups for the user to decide on, not defects.

## Split decision

Revisions 1-4 covered both grid/dashboard/filmstrip background preload *and* lightbox neighbor
preload in one document, and went through four rejected rounds. Round 4's review closed 8 of 11
open findings but explicitly recommended splitting the work — "the shared `LazyImage` lifecycle,
new DOM test environment, scheduler injection, and independent neighbor state machine are enough
moving parts that shipping them as one change increases review and rollback risk." Per user
decision: **this document now covers background preload only** (Part 1 of the former plan).
Lightbox neighbor preload moves to its own document,
[Lightbox-Neighbor-Preload-Plan.md](Lightbox-Neighbor-Preload-Plan.md), to be picked up after
this ships. The findings below are exactly the ones that applied to *this* scope; the ones that
applied only to lightbox preload (concurrency counting during RAW-compare, the neighbor state
machine's one-shot completion guard, 1-2-image collection edge cases, and a corrected
description of how it relates to `LazyImage`'s own loading mechanism) are carried into that
document instead, not repeated here.

## Why this feature, per the user

Quincy Portal's primary users for this surface are photographers and editors, who need to move
through a project's images quickly — the interface has to feel fast and responsive during rapid
review. That's the reason a visible image must never wait behind lower-priority background work
(the reserved-headroom design below is built specifically around that).

## Revision history (condensed — full detail in git history / prior turns if needed)

- **Round 1** (rejected): unsafe promotion design, unmount leak, a latent re-fetch bug, no
  reserved headroom, `CollectionPanel`'s `/original` wrongly included, thin tests.
- **Round 2** (rejected): fixed all of round 1, but the reserved-headroom guarantee didn't
  actually hold at *drain* time (the real blocking defect), plus an idle/observer double-acquire
  race, a dangling `pendingRef`, promotion not updating `priorityRef`, a partly-unsourced cost
  claim, no future-consumer rule, and — structurally — no DOM test environment exists for
  `apps/web` at all, so `LazyImage`'s actual behavior has never been tested.
- **Round 3** (rejected): fixed the drain-time bug, the double-acquire race, the dangling ref,
  and the retry-priority bug. Found: promotion still didn't trigger an immediate drain when a
  slot was already free; a stale effect continuation could clobber a freshly-installed pending
  ref; the future-consumer rule literally said "thumb or web" (self-contradicting, since `web` is
  a 3200px rendition, not thumbnail-scale); and the scheduler singleton still wasn't test-
  injectable.
- **Round 4** (rejected): confirmed all of round 3's fixes for the background-preload mechanism
  (promotion now drains immediately, the ownership-checked continuation is correct, the
  priority/retry logic holds, the cost note is accurate). Found two remaining gaps: the
  `/thumb`-substring dev warning isn't real enforcement (misses rewritten URLs, doesn't fail CI),
  and the scheduler test-override is a global that needs mandatory reset. Also recommended
  splitting this plan from lightbox neighbor preload, acted on above.
- **Round 5** (rejected — this revision fixes it): the type-level redesign for the
  future-consumer rule (discriminated `LazyImageProps` union) was **approved outright** — no
  further changes needed there. But the `withTestScheduler` try/finally helper was **not**
  adequate: it only restores correctly for cleanly-nested, fully-awaited scopes, and two
  overlapping or un-awaited calls can restore the global in the wrong order, leaking a stale
  scheduler into an unrelated later test. Also found: the dynamic-`preload`-transition resolution
  slightly overclaimed what the type redesign actually prevents; the testing list was missing
  idle-callback/Safari-fallback/cleanup coverage and a `PhotoGrid` regression test; "happy-dom (or
  jsdom)" was underspecified; and the "established here, once" wording overclaimed a dependency on
  an unreviewed companion plan.

Revision 6 removed the global scheduler override entirely in favor of a `scheduler` prop, and
fixed the four smaller round-5 findings. **Round 6** (approved with changes — this revision
closes them): the prop was described but never actually added to the real `LazyImageProps` union
(tests couldn't have compiled); the "no shared mutable state" wording overclaimed —
`gridImageScheduler` is still a real mutable production singleton, so the plan needed to say
explicitly that DOM tests must always pass their own explicit scheduler rather than imply
omitting the prop is automatically test-safe; and the lifecycle effect's dependency array needed
to explicitly key off the effective URL/`assetId` (not the old literal `[src, retryToken]`) for
the stale-continuation test to actually mean anything. This revision fixes all three.

## Terminology, clarified up front

This is not lazy loading in the strict sense — the app already has that (an `IntersectionObserver`
with a 600px lookahead). What's being added is a layer on top: visible images still load first and
fastest, but not-yet-visible images also keep loading in the background, so a whole gallery
finishes loading soon after the page opens without requiring scroll interaction.

## Current state (verified against the code, not assumed)

- **`portal/apps/web/src/components/LazyImage.tsx`** is the shared component behind every photo
  thumbnail: `PhotoGrid.tsx:105` (RAW-review/Edited-QA grid, unpaginated, measured at 130-192
  images in real production projects — `docs/plans/Dropbox-RAW-Fetch-Performance-Analysis.md`),
  `Lightbox.tsx:55-59` (`FilmstripThumbnail` — background preload only; neighbor preload is the
  separate, split-out plan), `CollectionPanel.tsx:19-21` (`DocumentPreview`), and
  `Dashboard.tsx:36-39` (`CoverMedia`). No native lazy-load attribute exists anywhere.
- Each `LazyImage` owns a per-instance `IntersectionObserver` (`rootMargin: "600px"` —
  `lib/lazy-image-observer.ts`). A module-level global semaphore, `MAX_CONCURRENT = 4`
  (`LazyImage.tsx:4`), caps simultaneous in-flight loads app-wide — this exists because of a
  documented 2026-07-21 incident (`docs/lessons.md`): a 130-200-image grid mount used to fire
  24-40 concurrent `/cdn-cgi/image/` transforms and got edge-rate-limited (403s). The fix was
  client concurrency limiting plus R2-cached renditions
  (`portal/workers/app/src/routes/media.ts:44-62`). **This design must not reintroduce that.**
- `PhotoGrid.tsx:102-105` already skips mounting `LazyImage` for `renditionStatus ===
  "processing"` assets — `Dashboard.tsx` and `Lightbox.tsx`'s filmstrip have no equivalent gate.
- No virtualization library exists — every gallery image is a real mounted DOM node from render.
- No pagination/infinite scroll — `ProjectWorkspace.tsx` fetches an entire collection at once.
- `enqueueRenditionSafely` runs on every ingest path, so `thumb` renditions are normally
  pre-generated before a human views a gallery — but `quincy-renditions` processes them with
  `max_concurrency: 1`, so there's a real window right after a bulk ingest where a freshly-added
  asset's rendition isn't ready yet.

## Goal

Background preload for `LazyImage` consumers rendering bounded `thumb`-scale renditions (grid,
filmstrip, dashboard covers), opted in per usage site, without weakening the concurrency safety
net that prevents the 2026-07-21 stampede.

## Design

### 1. Standalone, testable, injectable scheduler module

`portal/apps/web/src/lib/image-preload-scheduler.ts` — a factory, not module-level state:

```ts
export type Priority = "visible" | "background";
export interface PendingRequest { promise: Promise<() => void>; promote(): void; cancel(): void }
export interface Scheduler { acquire(priority: Priority): PendingRequest }

export function createImagePreloadScheduler(maxConcurrent: number, backgroundMaxConcurrent = maxConcurrent - 1): Scheduler {
  let activeVisible = 0;
  let activeBackground = 0;
  const waiting: Array<{ priority: Priority; grant: () => void }> = [];

  function tryGrantNext(): void {
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i].priority !== "visible") continue;
      if (activeVisible + activeBackground >= maxConcurrent) continue;
      const [w] = waiting.splice(i, 1);
      w.grant();
      return tryGrantNext();
    }
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i].priority !== "background") continue;
      if (activeVisible + activeBackground >= maxConcurrent) continue;
      if (activeBackground >= backgroundMaxConcurrent) continue;
      const [w] = waiting.splice(i, 1);
      w.grant();
      return tryGrantNext();
    }
  }

  function acquire(priority: Priority): PendingRequest {
    let entry: { priority: Priority; grant: () => void } | null = null;
    let grantedAs: Priority = priority;
    const promise = new Promise<() => void>((resolve) => {
      const grant = () => {
        grantedAs = entry ? entry.priority : priority;
        if (grantedAs === "visible") activeVisible += 1; else activeBackground += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          if (grantedAs === "visible") activeVisible -= 1; else activeBackground -= 1;
          tryGrantNext();
        });
      };
      const total = activeVisible + activeBackground;
      const fits = priority === "visible" ? total < maxConcurrent : (total < maxConcurrent && activeBackground < backgroundMaxConcurrent);
      if (fits) grant(); else { entry = { priority, grant }; waiting.push(entry); }
    });
    return {
      promise,
      // Promoting a queued entry must attempt an immediate drain — otherwise a slot that's
      // already free (nothing else is waiting to claim it) leaves the newly-visible request
      // stuck queued until some unrelated acquire/release happens to trigger one.
      promote() { if (entry) { entry.priority = "visible"; tryGrantNext(); } },
      cancel() {
        if (!entry) return;
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
      },
    };
  }

  return { acquire };
}

export const gridImageScheduler = createImagePreloadScheduler(4);
```

**Round 5 correction:** the previous draft of this plan solved test isolation with a
process-global override (`activeScheduler` + a `withTestScheduler` try/finally helper). Terra's
round-5 review correctly rejected this: the restore is only safe for cleanly-nested,
fully-awaited scopes — two overlapping or un-awaited `withTestScheduler` calls (plausible under
Vitest's default parallelism within a file, e.g. `test.concurrent`, or simply a test that doesn't
`await` the helper before another starts) can restore in the wrong order and leave a stale
scheduler installed globally, corrupting an unrelated later test. **There is no test-override
global at all in this revision.** `LazyImage` takes the scheduler as a prop instead, added to the
actual `LazyImageProps` union (§4 below), not a separate untethered interface:

```ts
scheduler?: Scheduler
```

defaulting to `gridImageScheduler` when omitted. Production call sites never pass it — they
always get the real shared singleton, and caller-visible behavior (including the app-wide
concurrency cap) is unchanged from today.

**Round 6 correction — precise claim, not overclaimed:** `gridImageScheduler` itself is still a
mutable module-level singleton (that's intentional — it's the real, shared, production
concurrency budget). What's actually eliminated is the *test-override* mechanism, not all
mutable state everywhere. **Every DOM-environment `LazyImage` test must pass its own fresh
`scheduler` prop explicitly — never rely on the default.** Two tests that both omitted the prop
would both hit the same production singleton and could still interfere with each other; the
guarantee this design provides is that tests *can* be fully isolated by always passing an
explicit instance, not that omitting the prop is automatically safe in a test context. This is a
requirement on how the tests in this plan are written, not a property of the scheduler itself.

### 2. `LazyImage`'s `start()`, with ownership-checked continuations

```ts
const priorityRef = useRef<Priority>("visible");
const succeededRef = useRef(false);
const pendingRef = useRef<PendingRequest | null>(null);

const start = async (priority: Priority) => {
  if (cancelled || terminalRef.current || active || retryTimer !== undefined || succeededRef.current) return;
  if (pendingRef.current) {
    if (priority === "visible") { pendingRef.current.promote(); priorityRef.current = "visible"; }
    return;
  }
  if (priority === "visible" && !visibleRef.current) return;
  priorityRef.current = priority;
  const pending = (props.scheduler ?? gridImageScheduler).acquire(priority);
  pendingRef.current = pending;
  const release = await pending.promise;
  // Only clear the ref if it's still *this* continuation's own handle — an effect re-run
  // (new src/retryToken) may have already installed a newer pending request by the time this
  // resumes, and this must not clobber that one. Distinct acquire() calls always return distinct
  // objects, so reference equality is a safe ownership check.
  if (pendingRef.current === pending) pendingRef.current = null;
  if (cancelled || active) { release(); return; }
  // ...unchanged from here (set active, render the <img>, arm the watchdog)
};
```

`succeededRef.current = true` remains the first statement inside `succeed()`, before any state
update or callback — this must be synchronous-first to actually close the re-intersection window.

Cleanup:

```ts
return () => {
  cancelled = true;
  observer?.disconnect();
  if (observerRef.current === observer) observerRef.current = null;
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  if (idleHandle !== undefined) cancelIdleCallback(idleHandle);
  if (idleFallbackTimer !== undefined) window.clearTimeout(idleFallbackTimer);
  pendingRef.current?.cancel();
  pendingRef.current = null;
  releaseActive();
  if (eventHandlersRef.current === handlers) eventHandlersRef.current = null;
};
```

Retry preserves the priority the failed attempt actually ran at (post-promotion):

```diff
    if (attempts < 2) {
      const retryNumber = attempts++;
-     retryTimer = window.setTimeout(() => { retryTimer = undefined; void start(); }, ...);
+     const retryPriority = priorityRef.current;
+     retryTimer = window.setTimeout(() => { retryTimer = undefined; void start(retryPriority); }, ...);
      return;
    }
```

### 3. Background-eligible trigger, scheduled to yield

On mount, if eligible for background preload (see §4 — determined by which prop branch is used,
not a runtime string check) and not already visible, schedule `start("background")` via
`requestIdleCallback`, with a real fallback delay for Safari (`window.setTimeout(fn, 200)`, not
`setTimeout(0)`). Both handles are tracked and cleared in cleanup (shown above). The idle
callback, when it fires, re-checks eligibility at that moment (not just at schedule time) — cheap
protection against a (currently nonexistent, but possible-in-principle) scenario where the
usage site's props changed between scheduling and firing.

No current call site changes its preload mode after mount, so live transitions between the
`src`/visible-only branch and the `assetId`/background branch are deliberately not supported —
**this is a scope decision, not a consequence of the type redesign** (the discriminated union
only constrains which props are valid together on a given render; it doesn't, by itself, prevent
a parent from switching branches across renders). If a future need for live transitions arises,
revisit then rather than building unused generality now.

### 4. Scope: a type-level fix for the future-consumer rule, not a runtime string check

Round 4 rejected the dev-only `/thumb`-substring warning as unenforceable (misses rewritten URLs,
doesn't fail CI). Replacing it: **`LazyImage`'s props become a discriminated union**, so
background preload can only ever request a `thumb` rendition — not by convention, but because
the component itself constructs that URL:

```ts
// scheduler is on the base props (§1) — every branch can accept it, since injecting a test
// scheduler is orthogonal to which rendition variant a given usage site requests.
type LazyImageBaseProps = { alt: string; className?: string; retryToken?: number; onFailedChange?: (failed: boolean) => void; scheduler?: Scheduler };
type LazyImageProps =
  | (LazyImageBaseProps & { preload?: "visible-only"; src: string })
  | (LazyImageBaseProps & { preload: "background"; assetId: string });
```

When `preload === "background"`, `LazyImage` derives
`` `/media/asset/${encodeURIComponent(props.assetId)}/thumb` `` internally — a caller in that
branch has no `src` prop to misuse in the first place, so passing a `web` or `original` URL for
background preload is a compile error, not a runtime warning that only fires in dev and never in
CI. `CollectionPanel.tsx`'s `DocumentPreview` (`/original`) is structurally excluded — it stays on
the `src`-based branch, default `"visible-only"`, and simply has no way to opt into background
preload without also changing what it renders.

**The lifecycle effect's dependency array must key off the *effective* identity, not literally
`[src, retryToken]` as today.** Today's single `src` prop becomes either `src` directly or the
derived `/thumb` URL built from `assetId` — the effect must depend on whichever one is actually in
play (e.g. `[props.preload === "background" ? props.assetId : props.src, retryToken]`, or an
equivalent memoized effective-URL value), otherwise a change from one `assetId` to another in the
background branch wouldn't reset `succeededRef`/`pendingRef`/etc. and would incorrectly look like
the same image. This is also what makes the stale-continuation test (testing requirement 11)
meaningful in the first place: that test relies on the effect actually re-running when the
identity changes.

This requires updating the three opt-in call sites to pass `assetId` instead of a manually-built
`src` when using `preload="background"` — a small, mechanical change since they already have
`asset.id` available:

- `PhotoGrid.tsx` — `<LazyImage preload="background" assetId={asset.id} ... />`.
- `Lightbox.tsx`'s `FilmstripThumbnail` — same.
- `Dashboard.tsx`'s `CoverMedia` — same.

**Test requirement addition:** a type-level test (e.g. a `// @ts-expect-error` case) proving
`<LazyImage preload="background" src="...">` does not typecheck, alongside the runtime tests
below.

### 5. No artificial ceiling within opted-in consumers; data-saver respected

No cap on "only the next N images" within the opted-in set — the scheduler's own bounds already
govern resource usage. `navigator.connection?.saveData === true` skips scheduling new background
starts; visible-priority loads are unaffected; API absence (Safari) means no restriction.

### 6. Grid re-render churn fix

`PhotoGrid.tsx:105`'s `onFailedChange` must return the same `Set` reference when membership is
unchanged, since background preload makes successful-load callbacks far more frequent:

```diff
- onFailedChange={(failed) => setFailedThumbnails((current) => { const next = new Set(current); if (failed) next.add(asset.id); else next.delete(asset.id); return next; })}
+ onFailedChange={(failed) => setFailedThumbnails((current) => {
+   if (failed === current.has(asset.id)) return current;
+   const next = new Set(current);
+   if (failed) next.add(asset.id); else next.delete(asset.id);
+   return next;
+ })}
```

## Cost note

Renditions are normally pre-generated before a human views a gallery (`enqueueRenditionSafely` on
every ingest path); `media.ts` serves a cached R2 rendition directly on a hit, and Cloudflare
bills a unique transformation once per calendar month regardless of repeat requests — **sourced
from Cloudflare's Images pricing documentation**, verified earlier in this session's own
investigation, not from anything in this repository.

`quincy-renditions` processes rendition jobs with `max_concurrency: 1`, so there's a real window
right after a bulk ingest where preload would hit genuine cold transforms — **partially
mitigated**: `PhotoGrid.tsx` skips mounting `LazyImage` for `renditionStatus === "processing"`
assets, but `Dashboard.tsx` and `Lightbox.tsx`'s filmstrip have no equivalent gate. Accepted,
bounded trade-off (bounded in concurrency by the same scheduler).

## Worst-case concurrency (this scope only)

`MAX_CONCURRENT = 4`, unchanged. Background preload only affects *which* images use a free
permit, never how many can be in flight — the 2026-07-21 incident's actual cause (24-40
simultaneous transforms) cannot recur regardless of gallery size. (Lightbox neighbor preload's
own budget and its interaction with this one are addressed in the separate
[Lightbox-Neighbor-Preload-Plan.md](Lightbox-Neighbor-Preload-Plan.md).)

## An adjacent, currently-undocumented gap this plan's own verification depends on

`portal/apps/web/package.json` has no `test` script; `apps/web/vitest.config.ts` is
`environment: "node"` with no DOM renderer, so `LazyImage`'s actual component behavior has never
been testable. This plan adds:

- **`happy-dom`, pinned specifically** (not "happy-dom or jsdom" — lighter and faster, and this
  plan shouldn't leave the actual dependency choice to whoever builds it) as a new
  `apps/web/package.json` devDependency, plus a second Vitest config
  (`portal/apps/web/vitest.dom.config.ts`) with `environment: "happy-dom"` and
  `include: ["src/**/*.dom.test.tsx"]` — a distinct filename convention (`.dom.test.tsx`, vs. the
  existing `.test.ts`) so component tests are unambiguously separate from the Node-only
  scheduler/observer tests, both by directory convention and by which config picks them up.
- `"test": "vitest run --config vitest.config.ts && vitest run --config vitest.dom.config.ts"` —
  the `test` script must explicitly run both; a second config file existing on disk proves
  nothing about what actually executes in CI.
- Updates to **both** `CLAUDE.md` and `AGENTS.md` (confirmed mirrored verbatim, `AGENTS.md:1-3`)
  mentioning `apps/web` alongside `packages/shared`.

This DOM test environment is intended for reuse by the lightbox neighbor-preload plan once that
plan is itself reviewed and approved — it is **not** yet a settled dependency of this plan on
that one, since that plan hasn't been through review at all (see its own document's status).

## Testing requirements for the build

**Scheduler module (`image-preload-scheduler.ts`), plain Node environment:**

1. A background request is granted immediately under both caps; queued when either is reached.
2. 3 background + 1 visible active, another background queued, release the visible one — the
   freed slot stays unclaimed (background stays at 3), not handed to the queued background entry.
3. Promoting a queued background entry when a slot is already free is granted immediately
   (`promote()`'s drain call), not left queued until an unrelated acquire/release.
4. A queued entry's `promote()` wins the next slot ahead of older, still-background entries when
   slots are contended.
5. `cancel()` removes a still-queued entry; is a no-op once already granted.
6. Each test creates its own `createImagePreloadScheduler(...)` — no shared state between tests.

**`LazyImage` component, new DOM-capable environment (each test passes its own fresh
`scheduler` prop instance — no global to isolate, per the round-5 redesign):**

7. `preload="background"` reaches loading/success via the background trigger alone with no
   intersection; the `visible-only`/default branch does not.
8. A background-queued instance that becomes visible is promoted (`pendingRef`, not a second
   `start()` call) — `acquire()` invoked exactly once across the transition.
9. An already-*active* background load that becomes visible is left alone (no duplicate request).
10. Unmounting a background-*queued* instance cancels and nulls `pendingRef` — no leaked entry.
11. A stale continuation (effect re-runs with a new `src`/`assetId` while the old `start()` call
    is still awaiting `acquire()`) does not null out the new `pendingRef` when it resumes.
12. An already-*succeeded* instance re-intersecting does not re-fetch (`succeededRef`), reset
    only on `src`/`assetId`/`retryToken` change.
13. A failed attempt retries at its original, post-promotion priority.
14. Existing watchdog/terminal-failure/manual-retry behavior, tested for the first time.
15. `navigator.connection.saveData === true` blocks new background starts, not visible ones;
    API absence fails open.
16. **Type-level:** `<LazyImage preload="background" src="...">` does not typecheck
    (`// @ts-expect-error`); only `assetId` is accepted in that branch.
17. Two `LazyImage` instances rendered with two distinct `scheduler` prop instances in the same
    test never observe each other's state — direct confirmation that prop-based injection
    actually isolates them, replacing the withdrawn global-override test.
18. The idle callback actually schedules `start("background")` (fake-timers/mocked
    `requestIdleCallback`), and separately, the `setTimeout(fn, 200)` fallback fires when
    `requestIdleCallback` is undefined (simulating Safari).
19. Both the idle-callback handle and its fallback-timer handle are cleared on unmount — neither
    fires `start()` after the component is gone (a leaked timer calling into an unmounted
    instance's closure would be a real bug, not just wasted work).
20. **Regression test for the `PhotoGrid.tsx` `onFailedChange` fix:** calling it with the same
    failed-state value it already had returns the identical `Set` reference (not just an
    equal one) — proving the re-render-churn fix actually works, not just that behavior looks
    unchanged.

## Verification (this session, §5 gate — after Terra approves and the build lands)

1. `npm run typecheck` (from `portal/`, covers all six workspaces) — must also catch the new
   `// @ts-expect-error` type test actually failing to compile as expected (i.e., that it
   *would* be a type error without the annotation).
2. `npm run build -w @quincy/web`.
3. The new/updated `apps/web` test suite — both configs, via the corrected `test` script.
4. `npx vitest run --config packages/shared/vitest.config.ts` (per `CLAUDE.md`, unaffected).
5. **Manual, real-browser verification** — per `docs/lessons.md:163-167`: open a real project's
   RAW-review grid at or near 130-200 images, wait without scrolling, confirm every
   `/media/asset/.../thumb` request eventually completes 200 with zero 403s via
   `read_network_requests`, staggered rather than firing all at once.

## Rollout

- Frontend-only: `portal/apps/web`. No backend/worker logic, schema, or migration.
- Deploy: `cd portal/workers/app && npx wrangler deploy` (only `app` needs redeploying).
- **Rollback:** revert the diff and redeploy `app` — no data involved either direction.

## Routing (per Subagent-Orchestration.md §2 routing table)

Normal feature/refactor touching fragile concurrency semantics plus a new test environment —
routes to **Terra as builder**, **Terra fresh-context as reviewer** of both the plan and the
resulting diff.
