// #217 build, step 4. The URL is the ONLY committed Dashboard search now: `committedQuery` is
// derived at render from `dashboardSearchOf(parsedRoute)`, never from the store. These are the
// six scenarios the design spec required to fail on the OLD code (`effectiveQuery`,
// `adoptedLocationRef`, the reconciliation effect's early return for a role without Calendar
// capability) before this refactor, and to pass after it.
import { act, createElement, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { locationStore, parseStaffLocation } from "../lib/router";
import { dashboardSearchOf } from "@quincy/shared";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  clearDashboardSearch,
  setDashboardSearchDraft,
  syncDashboardSearchDraftFromLocation,
} from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authState = vi.hoisted(() => ({ role: "admin" as "admin" | "photographer" | "editor" | "external_editor" }));
// `can` is independent of the real `roleHasCapability` `Dashboard.tsx` uses for
// `canViewProductionCalendar` -- granting `moveProjectStage` here regardless of role is what lets
// (a) below exercise "has Kanban move capability AND lacks Calendar capability" at all: no REAL
// role in `packages/shared/src/capabilities.ts` combines those two (photographer, the only role
// without `viewProductionCalendar`, also lacks `moveProjectStage`).
// #217 fix round 8, Sol review, item 4c: `external_editor` is deliberately NOT the other
// no-Calendar case here -- it HAS `viewProductionCalendar` via `EXTERNAL_EDITOR_CAPABILITIES`
// (`packages/shared/src/capabilities.ts:49-61`), unlike `photographer`'s own list
// (`packages/shared/src/capabilities.ts:129-137`), which omits it.
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authState.role, capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }) }));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "raw_review" as const, label: "RAW review", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({
  ProjectKanbanBoard2: (props: { projects: ProjectSummary[] }) => (
    <div data-testid="dashboard-board">
      {props.projects.map((project) => <button key={project.id} type="button" data-testid="kanban2-move-to" disabled={true}>{project.street}</button>)}
    </div>
  ),
}));

function project(id: string, street: string): ProjectSummary {
  return {
    id, street, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey: "raw_review", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null,
    boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  } as ProjectSummary;
}

const fullBoard = { projects: [project("a", "Alpha Street"), project("b", "Beta Street")], board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b"] } } };
const smithBoard = { projects: [project("b", "Beta Street")], board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["b"] } } };

function projectResponseFor(path: string) {
  return path.includes("q=smith") ? smithBoard : fullBoard;
}

/**
 * Mirrors `lib/app-router.tsx`'s `ShellRoute`: the ONE place `syncDashboardSearchDraftFromLocation`
 * is wired, in a `useLayoutEffect` keyed on location + principal, calling it only for a Dashboard
 * route. `Dashboard.tsx` itself no longer performs any URL-to-store adoption (#217 build, step 4)
 * -- exercising the draft-sync seam at all requires this harness, not `Dashboard` standalone.
 */
function ShellRouteHarness({ userId, role }: { userId: string; role: typeof authState.role }) {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), userId);
  }, [location, route, userId]);
  return <Dashboard currentUserId={userId} role={role} authorizationEpoch={0} />;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authState.role = "admin";
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path) => Promise.resolve(path.startsWith("/api/projects") ? projectResponseFor(path) : {}));
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("Dashboard's committed query is derived from the route, not adopted into the store (#217 build, step 4)", () => {
  it("(a) a role without Calendar capability, at /?view=list&q=smith: the projects request carries q, the chip shows, and Kanban movement is gated", async () => {
    authState.role = "photographer";
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="photographer" />); await Promise.resolve(); });
    await settle();

    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent).toContain("smith");

    // Movement gating: switch to Kanban (the search must survive the switch) and confirm every
    // Move-to trigger the mocked board renders is disabled -- the last-line-of-defence guard
    // `canMoveStages` feeds, computed from `committedQuery`, not the store.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    await settle();
    expect(window.location.search).toContain("view=kanban");
    expect(window.location.search).toContain("q=smith");
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="kanban2-move-to"]')];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) expect(trigger.disabled).toBe(true);
  });

  it("(b) Back/Forward (popstate) to a q-less URL clears the chip, input and request in the SAME commit", async () => {
    // #217 fix round 8, Sol review, item 4a. The probe used to capture `requestQ` but never
    // ASSERT it, and captured no input value at all -- this harness mounts no real `ShellSearch`
    // (see `ShellRouteHarness`'s own docblock above), so the store's own `draft` is what a real
    // input would render, and is what "the input" below means. `requestQ` is also now read from
    // the MOST RECENT `/api/projects` call, not `.some()` over every call ever made: the initial
    // `/?q=smith` load genuinely did request `q=smith` once, so `.some()` would stay stuck `true`
    // forever regardless of what the popstate below does -- the only meaningful question is
    // whether the LATEST request still carries the stale `q`. Every commit the probe observes
    // after the popstate is captured and asserted, not just one, so a chip/draft/request that
    // flashes searched for even one extra commit before clearing is caught. A passive `useEffect`,
    // not `useLayoutEffect`: React flushes every LAYOUT effect for a commit before any PASSIVE
    // one, and `useDashboardProjects`' own `useQuery` dispatches its refetch for the new (q-less)
    // key from ITS passive effect -- a layout-effect probe would run first every time and always
    // observe the STALE previous request, never the one this popstate itself causes.
    const captures: Array<{ draft: string; chip: boolean; requestQ: boolean }> = [];
    function Probe({ userId }: { userId: string }) {
      useEffect(() => {
        const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
        captures.push({
          draft: __getDashboardSearchSnapshotForTest().draft,
          chip: host.querySelector('[data-testid="dashboard-search-chip"]') !== null,
          requestQ: (projectsCalls.at(-1) ?? "").includes("q=smith"),
        });
      });
      return null;
    }

    window.history.replaceState(null, "", "/?q=smith");
    window.history.pushState(null, "", "/");
    window.history.replaceState(null, "", "/?q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();

    window.history.pushState(null, "", "/?q=smith");
    window.history.replaceState(null, "", "/");
    captures.length = 0;
    act(() => {
      root.render(<><ShellRouteHarness userId="user-1" role="admin" /><Probe userId="user-1" /></>);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.chip).toBe(false);
      expect(capture.draft).toBe("");
      expect(capture.requestQ).toBe(false);
    }
    expect(window.location.search).toBe("");
  });

  it("(c) type then popstate within 300ms: no q reappears after 1s of fake time", async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/");
      await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });

      act(() => { setDashboardSearchDraft("smith", "user-1"); });
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

      // Back to a DIFFERENT, q-less location within the 300ms debounce window.
      act(() => {
        window.history.pushState(null, "", "/?view=list");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(window.location.search).not.toContain("q=smith");
      expect(__getDashboardSearchSnapshotForTest().draft).not.toBe("smith");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(e) principal A to B on /?q=smith: B's chip already agrees with the URL on B's VERY FIRST commit, never a render-scoped-empty flash while the URL still says smith", async () => {
    function Probe({ onLayout }: { onLayout: (chipText: string | null) => void }) {
      useLayoutEffect(() => {
        onLayout(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent ?? null);
      });
      return null;
    }

    window.history.replaceState(null, "", "/?q=smith");
    await act(async () => { root.render(<Dashboard currentUserId="principal-a" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent).toContain("smith");

    // Principal switch, still on the SAME `/?q=smith` URL, captured on the FIRST layout commit --
    // before B's own `resetDashboardSearchForPrincipal` PASSIVE effect has had any chance to run.
    // A route-derived chip must already show "smith" here, on B's very first render; a store-derived
    // one (principal-scoped-empty until that effect settles) shows nothing for at least one commit,
    // even though the URL never stopped saying smith.
    let captured: string | null | undefined;
    act(() => {
      root.render(<><Dashboard currentUserId="principal-b" role="admin" /><Probe onLayout={(chipText) => { captured = chipText; }} /></>);
    });

    expect(captured).toContain("smith");
  });

  // #217 fix round 8, Sol review, item 4b. (f) "the chip's x and Escape both clear the URL and
  // the list in one step" was deliberately left uncovered here -- investigating it at the time
  // surfaced a real, narrow regression this exact commit's own scope could not fix without
  // reaching into step 5's territory: once `syncDashboardSearchDraftFromLocation` (step 3) was the
  // ONLY thing keeping the store's `draft` in step with the URL, the store's `query`/`lastWritten`
  // fields were never updated by it (only `commit()` itself still wrote them) -- so after landing
  // on a URL that already carried a `q`, `query`/`lastWritten` stayed at their cold-module default
  // `""`. Clearing called `commit()` with a normalised draft of `""`, which collided with that
  // stale default and tripped `commit()`'s OWN no-op guard (`normalized === query && normalized
  // === lastWritten`) before the writer was ever called -- the clear button silently did nothing.
  // Step 5 (already shipped -- `dashboard-search-store.ts` carries no `query`/`lastWritten` fields
  // any more, `commit()` writes through the writer unconditionally) fixed the underlying bug this
  // scenario exercises; these two cases add the coverage that was deferred until it did.
  it("(f1) the chip's x clears the URL, the chip and the list in one step", async () => {
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);

    const clearButton = host.querySelector<HTMLButtonElement>('[data-testid="dashboard-search-chip"] button[aria-label="Clear search"]')!;
    await act(async () => { clearButton.click(); await Promise.resolve(); });
    await settle();

    expect(window.location.search).toBe("?view=list");
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).toBeNull();
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });

  it("(f2) Escape (`clearDashboardSearch`, the rail's own Escape handler) clears the URL, the chip and the list in one step", async () => {
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();

    // `ShellSearch.tsx`'s own Escape handler calls `clearDashboardSearch(principalId)` directly
    // (this harness mounts no real `ShellSearch` -- see the file-level docblock above); exercised
    // the same way this file already drives Enter/typing through the store, not a real input.
    await act(async () => { clearDashboardSearch("user-1"); await Promise.resolve(); });
    await settle();

    expect(window.location.search).toBe("?view=list");
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).toBeNull();
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });
});
