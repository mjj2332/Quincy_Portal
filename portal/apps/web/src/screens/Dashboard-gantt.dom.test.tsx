/**
 * #220 pass B, S9 — Dashboard's own Gantt wiring: URL, rail active child (via
 * `dashboard-view-store`'s publication) and the switcher button all agree, in both directions,
 * deep link and Back/Forward included. Mirrors `Dashboard-calendar.dom.test.tsx`'s own routing
 * suite (same harness shape, same render helper), scoped to exactly the Gantt-specific behaviour
 * S9 asks for — this is not a re-test of `ProductionGantt.tsx` itself
 * (`ProductionGantt-readonly.dom.test.tsx` and `production-gantt-adapter.test.ts` own that), so
 * `../components/ProductionGantt` is mocked at the surface, the same way this file's Calendar
 * sibling (`Dashboard-calendar.dom.test.tsx`) fakes the event-calendar vendor tree rather than
 * exercising it end to end.
 */
import { act, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionGanttResponseSchema, dashboardSearchOf, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { Dashboard } from "./Dashboard";
import { closeDisplay, displayGroup, displayMenu, groupCheckboxes, openDisplay, toggleGroupCheckbox } from "./dashboard-display-test-helpers";
import { locationStore, parseStaffLocation } from "../lib/router";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest, commitDashboardSearchNow, DASHBOARD_SEARCH_DEBOUNCE_MS, setDashboardSearchDraft, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";
import type { ProductionGanttFacetFilters } from "../lib/production-gantt-filters";
import type { ProductionGanttProps } from "../components/ProductionGantt";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
const ganttPropsState = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
// #255: the one test that drives the real filters bar (Back/Forward through real edits) flips
// this to render the real `ProductionGantt` behind the same props-recording mock.
const realGantt = vi.hoisted(() => ({ value: false }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => <div data-testid="notice-board" /> }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
// #220: the same "mock at the boundary" idea `Dashboard-calendar.dom.test.tsx` applies to the
// event-calendar vendor tree (`testing/event-calendar-fake.tsx`) — this suite owns Dashboard's routing/URL/rail contract, not the
// Gantt surface's own rendering (`ProductionGantt-readonly.dom.test.tsx` owns that).
vi.mock("../components/ProductionGantt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/ProductionGantt")>();
  return {
    ProductionGantt: (props: ProductionGanttProps) => {
      ganttPropsState.value = props as unknown as Record<string, unknown>;
      if (realGantt.value) return <actual.ProductionGantt {...props} />;
      return <div data-testid="dashboard-gantt-surface" data-q={String(props.q ?? "")} />;
    },
  };
});

function projectResponse() {
  return {
    projects: [{ id: "33333333-3333-4333-8333-333333333333", street: "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["33333333-3333-4333-8333-333333333333"] } },
  };
}

function ganttResponse() {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [],
    page: { limit: 100, returned: 0, nextCursor: null },
    density: { matchedProjects: 0, matchedRows: 0, drawCap: 2000, tooManyToDraw: false },
  });
}

function DashboardRouteHarness() {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "user-1");
  }, [location, route]);
  return <Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} />;
}

describe("Dashboard Gantt routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    authRole.value = "admin";
    ganttPropsState.value = null;
    realGantt.value = false;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation(() => Promise.resolve(projectResponse()));
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    confirmStore.resolve(false);
    if (root) act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  // Dashboard code-splits ProductionGantt behind React.lazy; warm the (mocked) dynamic import so
  // the Suspense boundary resolves within the render helper's own ticks — same reasoning as the
  // Calendar suite's identical `beforeEach` for `../components/ProductionEventCalendar`.
  beforeEach(async () => { await import("../components/ProductionGantt"); });

  async function render(value: { role?: typeof authRole.value } = {}) {
    authRole.value = value.role ?? "admin";
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  async function typeSearch(value: string) {
    await act(async () => { setDashboardSearchDraft(value, "user-1"); await Promise.resolve(); });
  }

  function switcherButton(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === label);
  }

  it("shows Gantt only for a capable role, with its own data-focus-key", async () => {
    await render();
    const gantt = switcherButton("Timeline");
    expect(gantt).toBeTruthy();
    expect(gantt?.getAttribute("data-focus-key")).toBe("dashboard-view-timeline");

    await render({ role: "photographer" });
    expect(switcherButton("Timeline")).toBeUndefined();
  });

  it("enters Gantt with a canonical pushed URL, records the preference, and mounts the surface once", async () => {
    await render();
    await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=timeline");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("timeline");
    expect(switcherButton("Timeline")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeNull();
  });

  it("#334: renders neither the project summary strip nor a notice board, on List and Gantt alike", async () => {
    await render();
    const absent = () => {
      expect(host.querySelector('section[aria-label="Project summary"]')).toBeNull();
      expect(host.querySelector('[data-testid="notice-board"]')).toBeNull();
    };
    absent();
    await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
    absent();
    await act(async () => { switcherButton("Table")!.click(); await Promise.resolve(); });
    absent();
  });

  it("leaves Gantt to explicit List", async () => {
    await render();
    await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
    await act(async () => { switcherButton("Table")!.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=table");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("table");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();
  });

  it("takes Gantt view state from the URL across history arrivals (deep link + Back/Forward)", async () => {
    window.history.replaceState(null, "", "/?view=timeline");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(switcherButton("Timeline")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeTruthy();

    window.history.replaceState(null, "", "/?view=table");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(switcherButton("Table")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();

    window.history.replaceState(null, "", "/?view=timeline");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(switcherButton("Timeline")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeTruthy();
  });

  it("coerces and repairs a stored Gantt preference for a role without the capability", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "timeline");
    await render({ role: "photographer" });
    expect(switcherButton("Timeline")).toBeUndefined();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Board")?.getAttribute("aria-selected")).toBe("true");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("board");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();
  });

  it("carries the committed q into Gantt and back out again", async () => {
    await render();
    await act(async () => { switcherButton("Table")!.click(); await Promise.resolve(); });
    await typeSearch("smith");
    await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=timeline");
    expect(window.location.search).toContain("q=smith");
    expect(ganttPropsState.value?.q).toBe("smith");
  });

  describe("the header summary names what the Timeline shows (#260, #427)", () => {
    async function renderAt(location: string) {
      window.history.replaceState(null, "", location);
      await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const summary = () => host.querySelector('[data-testid="dashboard-summary"]')?.textContent ?? "";
    const reportShown = async (count: number | null) => {
      await act(async () => { (ganttPropsState.value?.onShownProjectsChange as (count: number | null) => void)(count); await Promise.resolve(); });
    };

    beforeEach(() => {
      const base = projectResponse();
      const two = { ...base, projects: [base.projects[0]!, { ...base.projects[0]!, id: "44444444-4444-4444-8444-444444444444", street: "4 Board Street" }] };
      apiGetMock.mockImplementation(() => Promise.resolve({ ...two, search: { query: "Schedule", matching: 2, total: 31 } }));
    });

    it("names both counts when the Timeline's filters hide a match", async () => {
      await renderAt("/?view=timeline&stages=raw_review&completed=1&q=Schedule");
      expect(summary()).toContain("2 of 31 active projects");
      expect(summary()).not.toContain("shown");
      await reportShown(1);
      expect(summary()).toContain("2 of 31 active projects · 1 shown");
    });

    it("stays the plain search count when the Timeline shows every match, or has not reported", async () => {
      await renderAt("/?view=timeline&q=Schedule");
      await reportShown(2);
      expect(summary()).toContain("2 of 31 active projects");
      expect(summary()).not.toContain("shown");
      await reportShown(null);
      expect(summary()).toContain("2 of 31 active projects");
      expect(summary()).not.toContain("shown");
    });

    it("drops a Timeline's shown count once the Dashboard leaves the Timeline", async () => {
      await renderAt("/?view=timeline&q=Schedule");
      await reportShown(1);
      await act(async () => { switcherButton("Table")!.click(); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(summary()).toContain("2 of 31 active projects");
      expect(summary()).not.toContain("shown");
    });
  });

  describe("Gantt filters in the URL (#255)", () => {
    async function renderAt(location: string) {
      window.history.replaceState(null, "", location);
      await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }

    const url = () => `${window.location.pathname}${window.location.search}`;
    const ganttFilters = () => ganttPropsState.value?.filters as ProductionGanttFacetFilters | undefined;
    const changeFilters = async (next: ProductionGanttFacetFilters) => {
      await act(async () => { (ganttPropsState.value?.onFiltersChange as (next: ProductionGanttFacetFilters) => void)(next); await Promise.resolve(); });
    };

    it("applies a cold deep link's filters on the first render", async () => {
      await renderAt("/?view=timeline&stages=raw_review&completed=1");
      expect(switcherButton("Timeline")?.getAttribute("aria-selected")).toBe("true");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review"], priorities: [], archived: "hide" as const, delivered: false, completed: true, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
      expect(url()).toBe("/?view=timeline&stages=raw_review&completed=1");
    });

    it("hands the surface default filters for the bare Gantt URL", async () => {
      await renderAt("/?view=timeline");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
    });

    it("pushes a filter change into the URL, carrying q", async () => {
      await renderAt("/?view=timeline&q=smith");
      await changeFilters({ editorIds: [], stageKeys: ["delivered", "raw_review"], priorities: [], archived: "hide" as const, delivered: true, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
      expect(url()).toBe("/?view=timeline&stages=raw_review%2Cdelivered&delivered=1&q=smith");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review", "delivered"], priorities: [], archived: "hide" as const, delivered: true, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
      expect(ganttPropsState.value?.q).toBe("smith");

      await changeFilters({ editorIds: [], stageKeys: [], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
      expect(url()).toBe("/?view=timeline&q=smith");
    });

    it("keeps the Gantt filters when a search commits on a filtered Gantt", async () => {
      await renderAt("/?view=timeline&stages=raw_review&completed=1");
      await act(async () => { setDashboardSearchDraft("smith", "user-1"); commitDashboardSearchNow("user-1"); await Promise.resolve(); });
      expect(url()).toBe("/?view=timeline&stages=raw_review&completed=1&q=smith");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review"], priorities: [], archived: "hide" as const, delivered: false, completed: true, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
      expect(ganttPropsState.value?.q).toBe("smith");
    });

    it("keeps the Gantt filters when the debounced search writer fires, reading them from the live URL", async () => {
      await renderAt("/?view=timeline&stages=raw_review");
      await typeSearch("smith");
      // A filter change lands in the URL while the debounce is armed, without a Dashboard
      // re-render in between: the writer must read the filters at fire time, not from a snapshot.
      window.history.replaceState(null, "", "/?view=timeline&stages=edited_review&delivered=1");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, DASHBOARD_SEARCH_DEBOUNCE_MS + 50)); });
      expect(url()).toBe("/?view=timeline&stages=edited_review&delivered=1&q=smith");
    });

    it("restores the previous filter state on Back and the next one on Forward", async () => {
      realGantt.value = true;
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.startsWith("/api/production-gantt") ? ganttResponse() : projectResponse()));
      const settle = async () => {
        for (let i = 0; i < 3; i++) {
          // eslint-disable-next-line no-await-in-loop
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
        }
      };
      // The real Timeline Display (#430): Show checkboxes, read by role and accessible name.
      const showChecked = () => groupCheckboxes("Show").map((item) => [item.textContent, item.getAttribute("aria-checked")]);
      const listQueriesSince = (callIndex: number) => apiGetMock.mock.calls.slice(callIndex)
        .map(([called]) => called)
        .filter((called) => called.startsWith("/api/production-gantt?") && !called.includes("childrenOf="))
        .map((path) => new URLSearchParams(path.slice(path.indexOf("?") + 1)));
      const lastListQuery = () => {
        const query = listQueriesSince(0).at(-1);
        if (!query) throw new Error("no /api/production-gantt project-list request");
        return query;
      };
      // The browser's own Back/Forward, awaited on the `popstate` it dispatches — not a synthetic
      // `replaceState` + `PopStateEvent`, so a filter change that replaced instead of pushing
      // leaves no entry to go back to and this fails.
      const traverse = async (step: () => void) => {
        callsBeforeTraversal = apiGetMock.mock.calls.length;
        await act(async () => {
          const popped = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no popstate after history traversal")), 1000);
            window.addEventListener("popstate", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          step();
          await popped;
        });
        await settle();
      };
      let callsBeforeTraversal = 0;
      const expectApplied = (expected: { delivered: boolean; completed: boolean }) => {
        expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null, ...expected });
        // The Display checkboxes follow the URL (Back/Forward included), with the menu still open.
        if (displayMenu()) expect(showChecked()).toEqual([["Show delivered Projects", String(expected.delivered)], ["Show completed Subtasks", String(expected.completed)]]);
      };
      // A filter push fetches its new key, so the latest project-list request is the new filters'.
      const expectRequested = (expected: { delivered: boolean; completed: boolean }) => {
        expect(lastListQuery().get("delivered")).toBe(expected.delivered ? "1" : null);
        expect(lastListQuery().get("completed")).toBe(expected.completed ? "1" : null);
      };
      // A Back/Forward returns to a key fetched moments ago, which the Gantt query's
      // `staleTime: 15_000` (`production-gantt-query.ts`) serves from cache with no request. So:
      // any project-list request the traversal did make must be for the restored filters.
      const expectRequestedSinceTraversal = (expected: { delivered: boolean; completed: boolean }) => {
        for (const query of listQueriesSince(callsBeforeTraversal)) {
          expect(query.get("delivered")).toBe(expected.delivered ? "1" : null);
          expect(query.get("completed")).toBe(expected.completed ? "1" : null);
        }
      };

      await renderAt("/?view=timeline");
      await settle();
      expectApplied({ delivered: false, completed: false });
      expectRequested({ delivered: false, completed: false });

      // Open Display once: a checkbox item leaves the menu open across each URL push and traversal.
      await openDisplay(host);
      expect(showChecked()).toEqual([["Show delivered Projects", "false"], ["Show completed Subtasks", "false"]]);
      await toggleGroupCheckbox("Show", "Show delivered Projects", host);
      await settle();
      expect(displayMenu()).not.toBeNull();
      expect(url()).toBe("/?view=timeline&delivered=1");
      expectApplied({ delivered: true, completed: false });
      expectRequested({ delivered: true, completed: false });

      await toggleGroupCheckbox("Show", "Show completed Subtasks", host);
      await settle();
      expect(displayMenu()).not.toBeNull();
      expect(url()).toBe("/?view=timeline&completed=1&delivered=1");
      expectApplied({ delivered: true, completed: true });
      expectRequested({ delivered: true, completed: true });

      await traverse(() => window.history.back());
      expect(url()).toBe("/?view=timeline&delivered=1");
      expectApplied({ delivered: true, completed: false });
      expectRequestedSinceTraversal({ delivered: true, completed: false });

      await traverse(() => window.history.forward());
      expect(url()).toBe("/?view=timeline&completed=1&delivered=1");
      expectApplied({ delivered: true, completed: true });
      expectRequestedSinceTraversal({ delivered: true, completed: true });
      expect(switcherButton("Timeline")?.getAttribute("aria-selected")).toBe("true");
    });

    describe("Display (#430)", () => {
      const COLD = "/?view=timeline&stages=delivered&completed=1&delivered=1";

      it("resolves an old URL with Show parameters byte-identically, and the Display checkboxes reflect it", async () => {
        await renderAt(COLD);
        expect(url()).toBe(COLD);
        expect(ganttFilters()).toMatchObject({ stageKeys: ["delivered"], delivered: true, completed: true });
        await openDisplay(host);
        expect(groupCheckboxes("Show").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Show delivered Projects", "true"], ["Show completed Subtasks", "true"]]);
        // Opening and closing Display never rewrites the URL.
        await closeDisplay();
        expect(url()).toBe(COLD);
      });

      it("resolves the old URL's whole filter set byte-identically", async () => {
        const full = "/?view=timeline&stages=raw_review&priority=5&archived=include&overdue=1&mine=1&completed=1&delivered=1";
        await renderAt(full);
        expect(url()).toBe(full);
        expect(ganttFilters()).toMatchObject({ stageKeys: ["raw_review"], priorities: ["5"], archived: "include", overdueOnly: true, myTasks: true, completed: true, delivered: true });
      });

      it("offers only the Show group on the Timeline, and nothing for Layers", async () => {
        await renderAt("/?view=timeline");
        await openDisplay(host);
        expect(displayGroup("Show")).not.toBeNull();
        expect(displayGroup("Layers")).toBeNull();
        expect(displayGroup("Sort")).toBeNull();
        expect(displayGroup("Columns")).toBeNull();
      });

      it("a Show toggle pushes the URL and keeps the other filters", async () => {
        await renderAt("/?view=timeline&stages=raw_review");
        const lengthBefore = window.history.length;
        await toggleGroupCheckbox("Show", "Show completed Subtasks", host);
        expect(url()).toBe("/?view=timeline&stages=raw_review&completed=1");
        expect(window.history.length).toBe(lengthBefore + 1);
        // The menu stays open across the URL push.
        expect(displayMenu()).not.toBeNull();
      });

      it("unchecking delivered while Stage = Delivered drops it from Stage and announces why", async () => {
        await renderAt(COLD);
        await toggleGroupCheckbox("Show", "Show delivered Projects", host);
        expect(url()).toBe("/?view=timeline&completed=1");
        expect(document.body.textContent).toContain("Removed Delivered from Stage.");
      });

      it("announces a repeated Delivered-pair removal again after Back", async () => {
        const live = () => host.querySelector('[data-testid="dashboard-live-region"]')?.textContent ?? "";
        await renderAt("/?view=timeline&stages=delivered&delivered=1");
        await toggleGroupCheckbox("Show", "Show delivered Projects", host);
        expect(live()).toBe("Removed Delivered from Stage.");
        // Back is an outside navigation: the pair notice clears, as the old bar's did.
        await act(async () => {
          const popped = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no popstate after history traversal")), 1000);
            window.addEventListener("popstate", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          window.history.back();
          await popped;
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(url()).toBe("/?view=timeline&stages=delivered&delivered=1");
        expect(live()).toBe("");
        await toggleGroupCheckbox("Show", "Show delivered Projects", host);
        expect(live()).toBe("Removed Delivered from Stage.");
      });

      // The real Display menu (#430): the checkbox item in use keeps focus, and is the same node,
      // while the changed filter's first page is pending or fails.
      const checkboxItem = () => groupCheckboxes("Show").find((item) => item.textContent === "Show delivered Projects")!;
      const toggleFocusedItem = async () => {
        await openDisplay(host);
        const item = checkboxItem();
        act(() => { item.focus(); });
        expect(document.activeElement).toBe(item);
        await act(async () => { item.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
        return item;
      };

      it("keeps focus on the Display checkbox item while the new filter's first page is pending, and after it lands", async () => {
        realGantt.value = true;
        await renderAt("/?view=timeline");
        let resolvePending: ((value: unknown) => void) | undefined;
        apiGetMock.mockImplementation((path: string) => {
          if (!path.startsWith("/api/production-gantt")) return Promise.resolve(projectResponse());
          if (path.includes("delivered=1")) return new Promise((resolve) => { resolvePending = resolve; });
          return Promise.resolve(ganttResponse());
        });
        const item = await toggleFocusedItem();
        expect(url()).toBe("/?view=timeline&delivered=1");
        expect(host.querySelector('[data-testid="production-gantt-loading"]')).not.toBeNull();
        expect(checkboxItem()).toBe(item);
        expect(item.isConnected).toBe(true);
        expect(document.activeElement).toBe(item);

        await act(async () => { resolvePending?.(ganttResponse()); await Promise.resolve(); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
        expect(checkboxItem()).toBe(item);
        expect(document.activeElement).toBe(item);
      });

      it("keeps focus on the Display checkbox item when the new filter's request fails", async () => {
        realGantt.value = true;
        await renderAt("/?view=timeline");
        apiGetMock.mockImplementation((path: string) => {
          if (!path.startsWith("/api/production-gantt")) return Promise.resolve(projectResponse());
          return path.includes("delivered=1") ? Promise.reject(new ApiError("boom", 400)) : Promise.resolve(ganttResponse());
        });
        const item = await toggleFocusedItem();
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
        expect(host.querySelector('[role="alert"]')?.textContent).toContain("The production schedule is unavailable.");
        expect(checkboxItem()).toBe(item);
        expect(item.isConnected).toBe(true);
        expect(document.activeElement).toBe(item);
      });

      it("both view-bar triggers clear the sticky shell header when scrolled to", async () => {
        await renderAt("/?view=timeline");
        const classes = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
        expect(classes(host.querySelector('[data-testid="dashboard-filter-trigger"]'))).toContain("scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]");
        expect(classes(host.querySelector('[data-testid="dashboard-display-trigger"]'))).toContain("scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]");
      });

      it("hands the Gantt focus callbacks that reach the Filter and Display triggers", async () => {
        await renderAt("/?view=timeline");
        const props = ganttPropsState.value as unknown as ProductionGanttProps;
        await act(async () => { props.focusFilterTrigger!(); });
        expect(document.activeElement).toBe(host.querySelector('[data-testid="dashboard-filter-trigger"]'));
        await act(async () => { props.focusDisplayTrigger!(); });
        expect(document.activeElement).toBe(host.querySelector('[data-testid="dashboard-display-trigger"]'));
      });
    });

    it("carries the shared Filter across views and starts the Gantt's own Show facets (delivered, completed) at their defaults (#428)", async () => {
      await renderAt("/?view=timeline&stages=raw_review&delivered=1");
      await act(async () => { switcherButton("Table")!.click(); await Promise.resolve(); });
      expect(url()).toBe("/?view=table&stages=raw_review");
      await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
      expect(url()).toBe("/?view=timeline&stages=raw_review");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review"], priorities: [], archived: "hide" as const, delivered: false, completed: false, includeUnassigned: false, myTasks: false, overdueOnly: false, shootRange: null, deadlineRange: null });
    });

    it("carries the shared Filter into the Calendar, but not the Gantt's Show delivered", async () => {
      await renderAt("/?view=timeline&stages=raw_review&delivered=1");
      await act(async () => { switcherButton("Calendar")!.click(); await Promise.resolve(); });
      const calendarRoute = parseStaffLocation(url());
      expect(calendarRoute.kind === "dashboard" && "calendar" in calendarRoute ? calendarRoute.calendar.stageKeys : null).toEqual(["raw_review"]);
      expect(calendarRoute.kind === "dashboard" && "calendar" in calendarRoute ? calendarRoute.calendar.showDeliveredProjects : null).toBe(false);
    });
  });

  it("disables Gantt navigation only while a Board interaction blocks it, same as List/Kanban", async () => {
    await render();
    expect(switcherButton("Timeline")?.disabled).toBe(false);
  });

  // #365 (AC3): the Gantt row label opens the Project through the Dashboard's own handler, which
  // pushes through `locationStore()` and shares the Calendar's scheduling gate.
  describe("opening a Project from a Gantt row label (#365)", () => {
    const projectId = "44444444-4444-4444-8444-444444444444";
    const ganttProps = () => ganttPropsState.value as unknown as ProductionGanttProps;

    it("passes projectHrefFor and onOpenProject, and pushes /projects/<id> through the location store", async () => {
      await render();
      await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
      expect(ganttProps().projectHrefFor?.(projectId)).toBe(`/projects/${projectId}`);
      expect(typeof ganttProps().onOpenProject).toBe("function");
      await act(async () => { ganttProps().onOpenProject!(projectId); await Promise.resolve(); });
      expect(window.location.pathname).toBe(`/projects/${projectId}`);
    });

    it("is a no-op while the Gantt's scheduling gate is blocked", async () => {
      await render();
      await act(async () => { switcherButton("Timeline")!.click(); await Promise.resolve(); });
      await act(async () => { ganttProps().onAcceptGateChange!(true); await Promise.resolve(); });
      await act(async () => { ganttProps().onOpenProject!(projectId); await Promise.resolve(); });
      expect(window.location.pathname).toBe("/");
    });
  });
});
