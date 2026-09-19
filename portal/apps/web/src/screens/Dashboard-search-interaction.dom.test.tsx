// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision
// geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser
// focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance
// items. Mirrors Dashboard-stage-interactions.dom.test.tsx's own harness.
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { dashboardSearchOf } from "@quincy/shared";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { parseStaffLocation } from "../lib/router";
import {
  __resetDashboardSearchStoreForTest,
  clearDashboardSearch,
  commitDashboardSearchNow,
  __getDashboardSearchSnapshotForTest,
  setDashboardSearchDraft,
  syncDashboardSearchDraftFromLocation,
} from "../lib/dashboard-search-store";

function ClientCapture({ onClient }: { onClient: (client: QueryClient) => void }) {
  onClient(useQueryClient());
  return null;
}

// #217 fix round 4, item 4: the `<StrictMode>` suite below needs React's own `act()` to behave
// deterministically across its mount-cleanup-mount replay — the same flag every other `.dom.test.tsx`
// file in this codebase that exercises `act` sets, this file just never previously needed it.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * #217 fix round 1, items 1-2 (Sol's diff review, both blockers). Root cause shared by both:
 * `searchActive` had been folded into `interactionBlocked` (Dashboard.tsx), which meant "a Board
 * interaction is in flight: queue refreshes, disable the view switcher" -- a search is not that.
 * Item 1: the project-accept effect only ever queued while `interactionBlocked` was true, so a
 * searched `queryProjects` was never being accepted. Removing `searchActive` from
 * `interactionBlocked` restores the accept path for a searched result the same way an unsearched
 * load already worked -- but it also removes the incidental Board-movement blocking that flag used
 * to provide while searching. Item 2 restores that gating explicitly: `canMoveStages` /
 * `sameStageReorderEnabled` / `movementDisabled` now carry `searchActive` themselves, and
 * `runBoardMovement`'s own guard refuses as a last line of defence.
 */

const authState = vi.hoisted(() => ({ role: "admin" as const }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
type DndTestEvent = { active: { id: string }; over: { id: string } | null; activatorEvent?: Event };
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ props: Parameters<typeof import("@dnd-kit/core").DndContext>[0]; start?: (event: DndTestEvent) => void; over?: (event: DndTestEvent) => void; end?: (event: DndTestEvent) => void }> }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ props, start: props.onDragStart as ((event: DndTestEvent) => void) | undefined, over: props.onDragOver as ((event: DndTestEvent) => void) | undefined, end: props.onDragEnd as ((event: DndTestEvent) => void) | undefined });
      return createElement(actual.DndContext, props);
    },
  };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: authState.role, capabilities: ["moveProjectStage", "prioritizeProjects"], can: (capability: string) => capability === "moveProjectStage" || capability === "prioritizeProjects" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [
      { key: "awaiting_raw" as const, label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review" as const, label: "RAW review", displayOrder: 2, active: true },
      { key: "editing_autohdr" as const, label: "Editing · autoHDR", displayOrder: 3, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));

function summary(id: string, street: string, stageKey: ProjectSummary["stageKey"], boardPosition: number): ProjectSummary {
  return {
    id, street, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey, shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null,
    boardPosition, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  } as ProjectSummary;
}

const fullBoard = {
  projects: [
    summary("source", "Source Street", "awaiting_raw", 1),
    summary("before", "Before Street", "raw_review", 1),
    summary("target", "Target Street", "raw_review", 2),
  ],
  board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source"], raw_review: ["before", "target"] } },
};

const smithOnlyBoard = {
  projects: [summary("target", "Target Street", "raw_review", 1)],
  board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["target"] } },
};

async function dndStart(activeId: string) {
  const handler = dnd.handlers.at(-1)?.start;
  if (!handler) throw new Error("No DndContext drag-start handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: null }); await Promise.resolve(); });
}
async function dndOver(activeId: string, overId: string) {
  const handler = dnd.handlers.at(-1)?.over;
  if (!handler) throw new Error("No DndContext drag-over handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: { id: overId } }); await Promise.resolve(); });
}
async function dndEnd(activeId: string, overId: string | null) {
  const handler = dnd.handlers.at(-1)?.end;
  if (!handler) throw new Error("No DndContext drag-end handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: overId === null ? null : { id: overId } }); await Promise.resolve(); });
}

function addresses(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="kanban2-card-address"], [data-testid="project-list-row"] span')].map((element) => element.textContent ?? "");
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

let root: Root;
let host: HTMLElement;

describe("Dashboard search results and Kanban movement gating (#217 fix round 1, items 1-2)", () => {
  beforeEach(() => {
    authState.role = "admin";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    dnd.handlers.length = 0;
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/projects")) return Promise.resolve({});
      return Promise.resolve(path.includes("q=smith") ? smithOnlyBoard : fullBoard);
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  it("a committed search replaces the List through the same accept path as an unsearched load", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    expect(addresses(host)).toEqual(expect.arrayContaining(["Source Street", "Before Street", "Target Street"]));

    await act(async () => { setDashboardSearchDraft("smith", "admin-1"); commitDashboardSearchNow("admin-1"); });
    await flush();

    expect(addresses(host)).toEqual(["Target Street"]);
    expect(addresses(host)).not.toContain("Source Street");
  });

  it("clearing the search restores the full list", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await act(async () => { setDashboardSearchDraft("smith", "admin-1"); commitDashboardSearchNow("admin-1"); });
    await flush();
    expect(addresses(host)).toEqual(["Target Street"]);

    await act(async () => { clearDashboardSearch("admin-1"); });
    await flush();
    expect(addresses(host)).toEqual(expect.arrayContaining(["Source Street", "Before Street", "Target Street"]));
  });

  it("a background refetch while searching still updates the list", async () => {
    let queryClient: QueryClient | undefined;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Dashboard currentUserId="admin-1" role="admin" /><ClientCapture onClient={(c) => { queryClient = c; }} /></QueryClientProvider>);
      await Promise.resolve();
    });
    await flush();
    await act(async () => { setDashboardSearchDraft("smith", "admin-1"); commitDashboardSearchNow("admin-1"); });
    await flush();
    expect(addresses(host)).toEqual(["Target Street"]);

    // A server-side change surfaces on the next background poll -- `invalidateQueries` is the same
    // underlying mechanism a focus/interval refetch triggers, exercised directly rather than
    // fighting `staleTime: 15_000` with a real or fake clock.
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/projects")) return Promise.resolve({});
      return Promise.resolve({ projects: [summary("target", "Renamed Target Street", "raw_review", 1)], board: smithOnlyBoard.board });
    });
    await act(async () => { await queryClient!.invalidateQueries({ predicate: (query) => query.queryKey[0] === "dashboard-projects" }); });
    await flush();
    expect(addresses(host)).toEqual(["Renamed Target Street"]);
  });

  it("item 2: pointer/keyboard drag issues no mutation while searching (last-line-of-defence guard)", async () => {
    window.history.replaceState(null, "", "/?view=kanban&q=smith");
    // #217 build, step 4: `Dashboard.tsx` no longer adopts a route's own `q` into the shared store
    // -- that is `ShellRoute`'s job now (`syncDashboardSearchDraftFromLocation`, `lib/app-router.tsx`).
    // Mirrored here directly, matching a real arrival.
    const route = parseStaffLocation("/?view=kanban&q=smith");
    if (route.kind === "dashboard") syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "admin-1");
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/projects")) return Promise.resolve({});
      // Full board still "matches" here -- the point of this test is movement gating, not result
      // filtering, which item 1's tests already cover.
      return Promise.resolve(fullBoard);
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    // #217 build, step 5 (sanctioned): `committedQuery` is derived from the URL, not a store copy.
    expect(window.location.search).toContain("q=smith");

    // The mocked DndContext handler is invoked directly, bypassing whatever visual/pointer-level
    // affordance would normally stop a drag from starting -- this is deliberately the strictest
    // check available in this harness for "last line of defence, not just UI disabled".
    await dndStart("before");
    await dndOver("before", "target");
    await dndEnd("before", "target");
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("item 2: the keyboard reorder arrows do not render while searching", async () => {
    window.history.replaceState(null, "", "/?view=kanban&q=smith");
    apiGetMock.mockImplementation((path) => (path.startsWith("/api/projects") ? Promise.resolve(fullBoard) : Promise.resolve({})));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    expect(host.querySelector('[data-focus-key^="arrow-up:"]')).toBeNull();
    expect(host.querySelector('[data-focus-key^="arrow-down:"]')).toBeNull();
  });

  it("item 2: the Move-to trigger is disabled while searching", async () => {
    window.history.replaceState(null, "", "/?view=kanban&q=smith");
    apiGetMock.mockImplementation((path) => (path.startsWith("/api/projects") ? Promise.resolve(fullBoard) : Promise.resolve({})));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="kanban2-move-to"]')];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) expect(trigger.disabled).toBe(true);
    await act(async () => { triggers[0]!.click(); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

/**
 * #217 fix round 4, item 4 (SHOULD-FIX). `main.tsx` mounts the whole app under `<StrictMode>`,
 * which double-invokes an initial mount's effects (mount, cleanup, mount again) synchronously, in
 * the SAME commit. `Dashboard.tsx`'s own writer-registration effect cleanup used to call
 * `cancelPendingDashboardSearchWrite()` unconditionally — correct for a REAL unmount, but wrong for
 * StrictMode's own synthetic one: a debounce armed OFF-Dashboard (the rail's `ShellSearch`, mounted
 * everywhere) before Dashboard ever mounted got cancelled by the synthetic cleanup, even though
 * Dashboard — once the double-invoke dance settles — is still mounted with nothing left to receive
 * that debounce's eventual commit.
 *
 * #217 build, step 6: the fix described above (a `writerGenerationRef` / `queueMicrotask` dance
 * deferring the cancellation so a same-tick StrictMode replay could back off) is deleted along with
 * the explicit `cancelPendingDashboardSearchWrite()` call itself — a fire with no writer registered
 * is now simply dropped (step 5: there is no local committed copy left for it to update either), so
 * the cleanup can unregister unconditionally and BOTH scenarios below fall out of that alone: a
 * StrictMode replay re-registers a writer before the timer fires (still commits); a real unmount
 * never re-registers one (never commits).
 *
 * #217 fix round 8, Sol review, item 4d — CORRECTION. The first test below used to mount `Dashboard`
 * directly, with no `ShellRoute` sync ever running, and then advance the fake clock past the stale
 * off-Dashboard timer to prove it still committed. That models a path production cannot take: by
 * design (`spec-217-query-source.md` "Design", and #217 fix round 8 item 1) a navigation TO
 * Dashboard always carries the live draft on the URL itself, either because the rail's own
 * Dashboard href/Enter already carries it, or because `ShellRoute`'s `syncDashboardSearchDraftFromLocation`
 * cancels any pending timer unconditionally the moment it observes the arrival — so the stale
 * off-Dashboard timer this test armed is never the thing that ends up writing `q` into the URL.
 * Rewritten to the real path: the navigation itself carries `q=smith` (mirroring the rail href),
 * `ShellRoute`'s own sync (mirrored here, the same way every other file's `DashboardRouteHarness`/
 * `ShellRouteHarness` already does) cancels the obsolete timer on arrival, and no later URL write
 * occurs once that timer's original 300ms — and a full second beyond it — elapses.
 */
describe("Dashboard search writer registration under StrictMode (#217 fix round 4, item 4)", () => {
  beforeEach(() => {
    authState.role = "admin";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    apiGetMock.mockImplementation((path) => (path.startsWith("/api/projects") ? Promise.resolve(fullBoard) : Promise.resolve({})));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  // #217 fix round 9, Sol review, item 2. This scenario used to live here as a probe-only harness:
  // it pushed `/?q=smith` onto `window.history` directly (never a real rail click or Enter) and
  // drove the draft-to-URL sync through a LOCAL `ArrivalSync` stand-in rather than the real
  // `ShellRoute`'s own `useLayoutEffect`. It is now hosted where the real app shell already exists
  // to drive it faithfully -- `App-rail-dashboard-agreement.dom.test.tsx`'s own describe block "a
  // debounce armed off-Dashboard commits exactly once on arrival, under StrictMode, through the
  // real rail (#217 fix round 9, item 2)": types into the REAL `ShellSearch` at `/admin` under
  // `<StrictMode>`, arrives at Dashboard through (i) a REAL click on the rail's parent Dashboard
  // link and (ii) a REAL Enter keydown, and asserts against a spy on `locationStore()`'s own
  // `push`/`replace` rather than `window.location.search` alone. `ArrivalSync` no longer exists
  // anywhere in this codebase.

  it("a REAL unmount (no StrictMode replay involved) still cancels a pending debounce — the existing guarantee, unaffected", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(createElement(StrictMode, null, createElement(Dashboard, { currentUserId: "admin-1", role: "admin" })));
        await Promise.resolve();
      });
      const locationBeforeType = window.location.search;
      act(() => { setDashboardSearchDraft("smith", "admin-1"); });
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
      expect(window.location.search).toBe(locationBeforeType);

      await act(async () => { root.unmount(); });
      await act(async () => { vi.advanceTimersByTime(350); });

      expect(window.location.search).toBe(locationBeforeType);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * #217 fix round 5, item 1 (Sol re-review, BLOCKER) -- UPDATED by #217 build, step 4. The original
 * claim here was that a principal switch, mid-Dashboard-mount, must never let the NEW principal's
 * render show the OLD principal's committed search chip: the chip used to be sourced from the
 * store's OWN `query`, which was principal-scoped, so "whose search is this" was a real question a
 * render had to answer correctly.
 *
 * Step 4 changes what the chip even IS: `committedQuery` is derived from the URL alone
 * (`dashboardSearchOf(parsedRoute)`), never the store -- so it is no longer principal-scoped BY
 * DESIGN. A's `commitDashboardSearchNow` below writes `smith` into the URL itself (`?q=smith`),
 * which is public, shared page state, not A's private draft -- B looking at that SAME URL is
 * correctly shown the SAME chip; that is not a leak, it is the whole point of "the URL is the only
 * committed search". `Dashboard-committed-query.dom.test.tsx`'s own scenario (e) is the test that
 * replaces this one's ORIGINAL intent, at the render-timing level that matters now (B's chip must
 * already agree with the URL on B's very first commit, not lag a principal-reset effect) -- this
 * test is kept, rewritten to assert exactly the new invariant, rather than deleted outright, since
 * the underlying scenario (a live principal swap while a Dashboard instance stays mounted) is still
 * worth covering at this file's own level of detail (a real DnD-capable Dashboard, not a probe-only
 * harness).
 */
describe("Dashboard's own render is principal-scoped for the DRAFT, but the committed chip is URL-derived and principal-agnostic by design (#217 fix round 5, item 1; updated #217 build, step 4)", () => {
  function Probe({ onLayout }: { onLayout: () => void }) {
    useLayoutEffect(() => { onLayout(); });
    return null;
  }

  beforeEach(() => {
    authState.role = "admin";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    apiGetMock.mockImplementation((path) => (path.startsWith("/api/projects") ? Promise.resolve(fullBoard) : Promise.resolve({})));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  it("B's render, captured on the FIRST commit after the swap, already agrees with the URL A's own commit just wrote -- no lag on either a reset effect or a draft-sync effect", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await act(async () => { setDashboardSearchDraft("smith", "admin-1"); commitDashboardSearchNow("admin-1"); });
    await flush();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(window.location.search).toContain("q=smith");

    let probed = false;
    let capturedChip: Element | null | undefined;
    act(() => {
      root.render(<><Dashboard currentUserId="admin-2" role="admin" /><Probe onLayout={() => {
        probed = true;
        capturedChip = host.querySelector('[data-testid="dashboard-search-chip"]');
      }} /></>);
    });

    expect(probed).toBe(true);
    expect(capturedChip).not.toBeNull();
    expect(capturedChip?.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent).toContain("smith");
  });
});
