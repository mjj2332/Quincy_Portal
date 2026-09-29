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
import { Dashboard } from "./Dashboard";
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
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
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
    return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === label);
  }

  it("shows Gantt only for a capable role, with its own data-focus-key", async () => {
    await render();
    const gantt = switcherButton("Gantt");
    expect(gantt).toBeTruthy();
    expect(gantt?.getAttribute("data-focus-key")).toBe("dashboard-view-gantt");

    await render({ role: "photographer" });
    expect(switcherButton("Gantt")).toBeUndefined();
  });

  it("enters Gantt with a canonical pushed URL, records the preference, and mounts the surface once", async () => {
    await render();
    await act(async () => { switcherButton("Gantt")!.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=gantt");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("gantt");
    expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
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
    await act(async () => { switcherButton("Gantt")!.click(); await Promise.resolve(); });
    absent();
    await act(async () => { switcherButton("List")!.click(); await Promise.resolve(); });
    absent();
  });

  it("leaves Gantt to explicit List", async () => {
    await render();
    await act(async () => { switcherButton("Gantt")!.click(); await Promise.resolve(); });
    await act(async () => { switcherButton("List")!.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=list");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();
  });

  it("takes Gantt view state from the URL across history arrivals (deep link + Back/Forward)", async () => {
    window.history.replaceState(null, "", "/?view=gantt");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeTruthy();

    window.history.replaceState(null, "", "/?view=list");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(switcherButton("List")?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();

    window.history.replaceState(null, "", "/?view=gantt");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeTruthy();
  });

  it("bounces an explicit Gantt arrival while Archived back to active scope", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Archived")?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("Archived projects");
    window.history.pushState(null, "", "/?view=gantt");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).not.toContain("Archived projects");
    expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
  });

  it("coerces and repairs a stored Gantt preference for a role without the capability", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "gantt");
    await render({ role: "photographer" });
    expect(switcherButton("Gantt")).toBeUndefined();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban")?.getAttribute("data-active")).toBe("true");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("kanban");
    expect(host.querySelector('[data-testid="dashboard-gantt-surface"]')).toBeNull();
  });

  it("carries the committed q into Gantt and back out again", async () => {
    await render();
    await act(async () => { switcherButton("List")!.click(); await Promise.resolve(); });
    await typeSearch("smith");
    await act(async () => { switcherButton("Gantt")!.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=gantt");
    expect(window.location.search).toContain("q=smith");
    expect(ganttPropsState.value?.q).toBe("smith");
  });

  describe("search chip names what the Gantt shows (#260)", () => {
    async function renderAt(location: string) {
      window.history.replaceState(null, "", location);
      await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const chip = () => host.querySelector('[data-testid="dashboard-search-chip"]')?.textContent ?? "";
    const reportShown = async (count: number | null) => {
      await act(async () => { (ganttPropsState.value?.onShownProjectsChange as (count: number | null) => void)(count); await Promise.resolve(); });
    };

    beforeEach(() => {
      apiGetMock.mockImplementation(() => Promise.resolve({ ...projectResponse(), search: { query: "Schedule", matching: 2, total: 31 } }));
    });

    it("names both counts when the Gantt's filters hide a match", async () => {
      await renderAt("/?view=gantt&stages=raw_review&completed=1&q=Schedule");
      expect(chip()).toContain("2 of 31 projects · 'Schedule'");
      await reportShown(1);
      expect(chip()).toContain("2 of 31 projects match · 1 shown · 'Schedule'");
    });

    it("stays the plain search count when the Gantt shows every match, or has not reported", async () => {
      await renderAt("/?view=gantt&q=Schedule");
      await reportShown(2);
      expect(chip()).toContain("2 of 31 projects · 'Schedule'");
      await reportShown(null);
      expect(chip()).toContain("2 of 31 projects · 'Schedule'");
    });

    it("drops a Gantt's shown count once the Dashboard leaves the Gantt", async () => {
      await renderAt("/?view=gantt&q=Schedule");
      await reportShown(1);
      await act(async () => { switcherButton("List")!.click(); await Promise.resolve(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(chip()).toContain("2 of 31 projects · 'Schedule'");
      expect(chip()).not.toContain("shown");
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
      await renderAt("/?view=gantt&stages=raw_review&completed=1");
      expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: true });
      expect(url()).toBe("/?view=gantt&stages=raw_review&completed=1");
    });

    it("hands the surface default filters for the bare Gantt URL", async () => {
      await renderAt("/?view=gantt");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: [], delivered: false, completed: false });
    });

    it("pushes a filter change into the URL, carrying q", async () => {
      await renderAt("/?view=gantt&q=smith");
      await changeFilters({ editorIds: [], stageKeys: ["delivered", "raw_review"], delivered: true, completed: false });
      expect(url()).toBe("/?view=gantt&stages=raw_review%2Cdelivered&delivered=1&q=smith");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review", "delivered"], delivered: true, completed: false });
      expect(ganttPropsState.value?.q).toBe("smith");

      await changeFilters({ editorIds: [], stageKeys: [], delivered: false, completed: false });
      expect(url()).toBe("/?view=gantt&q=smith");
    });

    it("keeps the Gantt filters when a search commits on a filtered Gantt", async () => {
      await renderAt("/?view=gantt&stages=raw_review&completed=1");
      await act(async () => { setDashboardSearchDraft("smith", "user-1"); commitDashboardSearchNow("user-1"); await Promise.resolve(); });
      expect(url()).toBe("/?view=gantt&stages=raw_review&completed=1&q=smith");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: ["raw_review"], delivered: false, completed: true });
      expect(ganttPropsState.value?.q).toBe("smith");
    });

    it("keeps the Gantt filters when the debounced search writer fires, reading them from the live URL", async () => {
      await renderAt("/?view=gantt&stages=raw_review");
      await typeSearch("smith");
      // A filter change lands in the URL while the debounce is armed, without a Dashboard
      // re-render in between: the writer must read the filters at fire time, not from a snapshot.
      window.history.replaceState(null, "", "/?view=gantt&stages=edited_review&delivered=1");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, DASHBOARD_SEARCH_DEBOUNCE_MS + 50)); });
      expect(url()).toBe("/?view=gantt&stages=edited_review&delivered=1&q=smith");
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
      // The real `ProductionGanttFiltersBar`, driven by role / name / Quincy test id.
      const chipNames = () => {
        const toolbar = host.querySelector<HTMLElement>('[data-testid="production-gantt-filters"] [role="toolbar"][aria-label="Gantt filters"]');
        if (!toolbar) throw new Error("no Gantt filters toolbar");
        return [...toolbar.querySelectorAll('[role="group"]')].map((chip) => chip.getAttribute("aria-label"));
      };
      const waitForOption = async (name: string) => {
        const start = Date.now();
        for (;;) {
          const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.trim() === name);
          if (match) return match;
          if (Date.now() - start > 1500) throw new Error(`no option "${name}"`);
          // eslint-disable-next-line no-await-in-loop
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        }
      };
      const clickOption = async (name: string) => {
        const match = await waitForOption(name);
        await act(async () => { match.click(); });
        await settle();
      };
      const closeMenu = async () => {
        await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
        await settle();
      };
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
        expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: [], ...expected });
        // The bar's chips follow the URL (re-seeded on Back/Forward).
        const shown = [expected.delivered && "Delivered projects", expected.completed && "Completed checklist items"].filter(Boolean);
        expect(chipNames()).toEqual(shown.length === 0 ? [] : [`Show includes ${shown.length === 1 ? shown[0] : `${shown.length} selected`}`]);
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

      await renderAt("/?view=gantt");
      await settle();
      expectApplied({ delivered: false, completed: false });
      expectRequested({ delivered: false, completed: false });

      const trigger = host.querySelector<HTMLButtonElement>('[data-testid="production-gantt-filters-add"]');
      if (!trigger) throw new Error("no add-filter trigger");
      await act(async () => { trigger.click(); });
      await clickOption("Show");
      await clickOption("includes");
      await clickOption("Delivered projects");
      expect(url()).toBe("/?view=gantt&delivered=1");
      expectApplied({ delivered: true, completed: false });
      expectRequested({ delivered: true, completed: false });

      await clickOption("Completed checklist items");
      expect(url()).toBe("/?view=gantt&completed=1&delivered=1");
      await closeMenu();
      expectApplied({ delivered: true, completed: true });
      expectRequested({ delivered: true, completed: true });

      await traverse(() => window.history.back());
      expect(url()).toBe("/?view=gantt&delivered=1");
      expectApplied({ delivered: true, completed: false });
      expectRequestedSinceTraversal({ delivered: true, completed: false });

      await traverse(() => window.history.forward());
      expect(url()).toBe("/?view=gantt&completed=1&delivered=1");
      expectApplied({ delivered: true, completed: true });
      expectRequestedSinceTraversal({ delivered: true, completed: true });
      expect(switcherButton("Gantt")?.getAttribute("data-active")).toBe("true");
    });

    it("starts the Gantt with default filters when switching in from another view", async () => {
      await renderAt("/?view=gantt&stages=raw_review&delivered=1");
      await act(async () => { switcherButton("List")!.click(); await Promise.resolve(); });
      expect(url()).toBe("/?view=list");
      await act(async () => { switcherButton("Gantt")!.click(); await Promise.resolve(); });
      expect(url()).toBe("/?view=gantt");
      expect(ganttFilters()).toEqual({ editorIds: [], stageKeys: [], delivered: false, completed: false });
    });

    it("keeps Gantt and Calendar filter state independent", async () => {
      await renderAt("/?view=gantt&stages=raw_review&delivered=1");
      await act(async () => { switcherButton("Calendar")!.click(); await Promise.resolve(); });
      const calendarRoute = parseStaffLocation(url());
      expect(calendarRoute.kind === "dashboard" && "calendar" in calendarRoute ? calendarRoute.calendar.stageKeys : null).toEqual([]);
      expect(calendarRoute.kind === "dashboard" && "calendar" in calendarRoute ? calendarRoute.calendar.showDeliveredProjects : null).toBe(false);
    });
  });

  it("disables Gantt navigation only while a Board interaction blocks it, same as List/Kanban", async () => {
    await render();
    expect(switcherButton("Gantt")?.disabled).toBe(false);
  });
});
