/**
 * #428 (seam C) -- the Dashboard's shared Filter: Stage, Priority and (Admin only) Archived
 * Hide / Include / Only, one URL, every view.
 *
 * The Gantt and Calendar surfaces and the Board are mocked at the Dashboard boundary (same idea as
 * `Dashboard-gantt.dom.test.tsx`): this file owns the Filter's URL <-> chips <-> request contract and
 * what the Dashboard does with it, not those surfaces' own rendering. The Filter itself (the trigger,
 * the chips, the vendored `Filters`) is real. Everything is selected by role, accessible name or a
 * Quincy `data-testid`, never by a vendor `data-slot`.
 */
import { act, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionGanttResponseSchema, dashboardSearchOf, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { locationStore, parseStaffLocation } from "../lib/router";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

type Role = "admin" | "editor" | "photographer" | "external_editor";
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as Role }));
const boardProps = vi.hoisted(() => ({ value: null as Record<string, any> | null }));
const ganttProps = vi.hoisted(() => ({ value: null as Record<string, any> | null }));
const calendarProps = vi.hoisted(() => ({ value: null as Record<string, any> | null }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({
    role: authRole.value,
    capabilities: [],
    can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard", "moveProjectStage", "prioritizeProjects"].includes(capability),
  }),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 1, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: (props: Record<string, any>) => { boardProps.value = props; return <div data-testid="dashboard-board" />; } }));
vi.mock("../components/ProductionGantt", () => ({ ProductionGantt: (props: Record<string, any>) => { ganttProps.value = props; return <div data-testid="dashboard-gantt-surface" />; } }));
vi.mock("../components/ProductionEventCalendar", () => ({ ProductionEventCalendar: (props: Record<string, any>) => { calendarProps.value = props; return <div data-testid="event-calendar-body" />; } }));

const ACTIVE_ID = "33333333-3333-4333-8333-333333333333";

function projectResponse(url: string) {
  const archived = /archived=only/.test(url);
  return {
    projects: [{ id: archived ? "44444444-4444-4444-8444-444444444444" : ACTIVE_ID, street: archived ? "9 Archived Street" : "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null, archivedAt: archived ? 1 : null }],
    board: archived ? { contractEnabled: true, orderedProjectIdsByStage: {} } : { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [ACTIVE_ID] } },
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

function RouteHarness() {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "user-1");
  }, [location, route]);
  return <Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} />;
}

describe("Dashboard shared Filter (#428)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    authRole.value = "admin";
    boardProps.value = null;
    ganttProps.value = null;
    calendarProps.value = null;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => Promise.resolve(path.startsWith("/api/production-gantt") ? ganttResponse() : projectResponse(path)));
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await import("../components/ProductionGantt");
    await import("../components/ProductionEventCalendar");
  });

  afterEach(() => {
    confirmStore.resolve(false);
    if (root) act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  const url = () => `${window.location.pathname}${window.location.search}`;
  const tick = (ms = 10) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

  async function renderAt(location: string, role: Role = "admin") {
    authRole.value = role;
    window.history.replaceState(null, "", location);
    await act(async () => { root.render(<RouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await tick();
    await tick();
  }

  async function waitFor(assertion: () => void, timeoutMs = 1500) {
    const start = Date.now();
    for (;;) {
      try {
        assertion();
        return;
      } catch (error) {
        if (Date.now() - start > timeoutMs) throw error;
        // eslint-disable-next-line no-await-in-loop
        await tick(20);
      }
    }
  }

  const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[aria-label="Dashboard view"] [role="tab"]')].find((candidate) => candidate.textContent === label);
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-testid="dashboard-filter-trigger"]');
  const chipRegion = () => host.querySelector<HTMLElement>('[data-testid="dashboard-filter-chips"]')!;
  const chipNames = () => [...chipRegion().querySelectorAll<HTMLElement>('[role="group"]')].map((chip) => chip.getAttribute("aria-label") ?? "");
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const optionNames = () => options().map((candidate) => candidate.textContent?.trim());
  const option = (name: string) => {
    const match = options().find((candidate) => candidate.textContent?.trim() === name);
    if (!match) throw new Error(`no option "${name}" in [${optionNames().join(", ")}]`);
    return match;
  };
  const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
  const escape = async () => {
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await tick(60);
  };
  const projectRequests = () => apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
  const lastProjectRequest = () => projectRequests().at(-1);

  /** Opens the picker, picks a field, its one condition, then the named values; leaves the menu open. */
  async function addFilter(field: string, condition: string, values: string[]) {
    await click(trigger()!);
    await waitFor(() => expect(optionNames()).toContain(field));
    await click(option(field));
    await waitFor(() => expect(optionNames()).toEqual([condition]));
    await click(option(condition));
    for (const value of values) {
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => option(value));
      // eslint-disable-next-line no-await-in-loop
      await click(option(value));
    }
  }

  it("has no Active/Archived segment any more", async () => {
    await renderAt("/?view=table");
    expect(host.querySelector('[aria-label="Project status"]')).toBeNull();
    expect([...host.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("Archived");
    expect(host.textContent).not.toContain("Archived projects");
  });

  it("seeds the chips from the URL: Stage, Priority and Archived", async () => {
    await renderAt("/?view=table&stages=raw_review&priority=5%2Cnone&archived=only");
    expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 2 selected", "Archived is Only archived"]);
    // The request carries all three, in the canonical spelling.
    expect(lastProjectRequest()).toBe("/api/projects?stages=raw_review&priority=5%2Cnone&archived=only");
    expect(host.textContent).toContain("9 Archived Street");
  });

  it("offers the Filter in the view bar between the search and Display, icon-labelled for assistive tech", async () => {
    await renderAt("/?view=board");
    const filter = trigger()!;
    expect(filter).not.toBeNull();
    expect(filter.getAttribute("aria-label")).toBe("Filter");
    expect(filter.textContent).toContain("Filter");
    const bar = host.querySelector('[data-testid="dashboard-view-bar"]')!;
    const order = [...bar.querySelectorAll<HTMLElement>('[data-testid="dashboard-search"], [data-testid="dashboard-filter-trigger"], [aria-label="Display"], [aria-haspopup="menu"]')];
    const searchIndex = order.findIndex((element) => element.getAttribute("data-testid") === "dashboard-search");
    const filterIndex = order.findIndex((element) => element === filter);
    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(filterIndex).toBeGreaterThan(searchIndex);
  });

  it("a chip edit pushes the URL (one history entry) and changes the request, and Back re-seeds the chips", async () => {
    await renderAt("/?view=table");
    expect(chipNames()).toEqual([]);
    const before = window.history.length;

    await addFilter("Priority", "is any of", ["5 stars"]);
    await escape();
    expect(url()).toBe("/?view=table&priority=5");
    expect(chipNames()).toEqual(["Priority is any of 5 stars"]);
    expect(lastProjectRequest()).toBe("/api/projects?priority=5");
    expect(window.history.length).toBe(before + 1);

    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      window.history.back();
      await popped;
    });
    await tick(60);
    expect(url()).toBe("/?view=table");
    expect(chipNames()).toEqual([]);
  });

  it("survives every tab switch: the URL, the chips and each view's own request carry it", async () => {
    await renderAt("/?view=table&stages=raw_review&priority=5");

    await act(async () => { tab("Board")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toBe("/?view=board&stages=raw_review&priority=5");
    expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 5 stars"]);
    expect(lastProjectRequest()).toBe("/api/projects?stages=raw_review&priority=5");

    await act(async () => { tab("Timeline")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toBe("/?view=timeline&stages=raw_review&priority=5");
    expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 5 stars"]);
    expect(ganttProps.value?.filters).toMatchObject({ stageKeys: ["raw_review"], priorities: ["5"], archived: "hide" });

    await act(async () => { tab("Calendar")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toContain("view=calendar");
    expect(url()).toContain("stages=raw_review");
    expect(url()).toContain("priority=5");
    expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 5 stars"]);
    expect(calendarProps.value?.calendar).toMatchObject({ stageKeys: ["raw_review"], priorities: ["5"], archived: "hide" });

    await act(async () => { tab("Table")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toBe("/?view=table&stages=raw_review&priority=5");
    expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 5 stars"]);
  });

  it("an Admin's Archived: Only reaches all four views", async () => {
    await renderAt("/?view=table&archived=only");
    expect(host.textContent).toContain("9 Archived Street");
    expect(lastProjectRequest()).toBe("/api/projects?archived=only");

    await act(async () => { tab("Board")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toBe("/?view=board&archived=only");
    expect(lastProjectRequest()).toBe("/api/projects?archived=only");
    expect(chipNames()).toEqual(["Archived is Only archived"]);

    await act(async () => { tab("Timeline")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toBe("/?view=timeline&archived=only");
    expect(ganttProps.value?.filters).toMatchObject({ archived: "only" });

    await act(async () => { tab("Calendar")!.click(); await Promise.resolve(); });
    await tick();
    expect(url()).toContain("archived=only");
    expect(calendarProps.value?.calendar).toMatchObject({ archived: "only" });
    expect(chipNames()).toEqual(["Archived is Only archived"]);
  });

  it("offers Archived (Hidden / Included / Only archived) to an Admin, and writes the mode", async () => {
    await renderAt("/?view=table");
    await click(trigger()!);
    await waitFor(() => expect(optionNames()).toEqual(["Stage", "Priority", "Archived"]));
    await click(option("Archived"));
    await waitFor(() => expect(optionNames()).toEqual(["is"]));
    await click(option("is"));
    await waitFor(() => expect(optionNames()).toEqual(["Hidden", "Included", "Only archived"]));
    await click(option("Included"));
    await waitFor(() => expect(url()).toBe("/?view=table&archived=include"));
    expect(lastProjectRequest()).toBe("/api/projects?archived=include");
  });

  it("never offers Archived to a non-Admin, and never sends it even from a pasted URL", async () => {
    await renderAt("/?view=table&archived=only&stages=raw_review", "editor");
    await click(trigger()!);
    await waitFor(() => expect(optionNames()).toEqual(["Stage", "Priority"]));
    await escape();
    expect(chipNames()).toEqual(["Stage is any of RAW review"]);
    expect(projectRequests().length).toBeGreaterThan(0);
    for (const path of projectRequests()) expect(path).not.toContain("archived");
  });

  it("an External Editor is offered Stage only (no Priority, no Archived)", async () => {
    await renderAt("/?view=table", "external_editor");
    await click(trigger()!);
    await waitFor(() => expect(optionNames()).toEqual(["Stage"]));
  });

  it("disables Board moves and reordering while the Priority or Archived filter narrows the Board", async () => {
    await renderAt("/?view=board");
    expect(boardProps.value?.movementDisabled).toBe(false);
    expect(boardProps.value?.canMoveStages).toBe(true);
    expect(boardProps.value?.sameStageReorderEnabled).toBe(true);

    await renderAt("/?view=board&priority=5");
    expect(boardProps.value?.movementDisabled).toBe(true);
    expect(boardProps.value?.canMoveStages).toBe(false);
    expect(boardProps.value?.sameStageReorderEnabled).toBe(false);

    await renderAt("/?view=board&archived=include");
    expect(boardProps.value?.movementDisabled).toBe(true);
    expect(boardProps.value?.canMoveStages).toBe(false);
  });

  it("keeps Board moves enabled under a Stage-only filter (a Stage filter does not reshuffle a column)", async () => {
    await renderAt("/?view=board&stages=raw_review");
    expect(boardProps.value?.movementDisabled).toBe(false);
    expect(boardProps.value?.canMoveStages).toBe(true);
  });

  it("locks the Filter while a Calendar or Board write holds the Dashboard", async () => {
    await renderAt("/?view=calendar");
    expect(trigger()?.disabled).toBe(false);
    await act(async () => { (calendarProps.value?.onAcceptGateChange as (blocked: boolean) => void)(true); await Promise.resolve(); });
    expect(trigger()?.disabled).toBe(true);
    await act(async () => { (calendarProps.value?.onAcceptGateChange as (blocked: boolean) => void)(false); await Promise.resolve(); });
    expect(trigger()?.disabled).toBe(false);
  });

  describe("focus after a chip is removed from its menu", () => {
    const chipByField = (field: string) => [...chipRegion().querySelectorAll<HTMLElement>('[role="group"]')].find((chip) => chip.getAttribute("aria-label")?.startsWith(`${field} `))!;
    async function removeFromMenu(field: string) {
      await click(chipByField(field).querySelector<HTMLElement>(`button[aria-label="${field} filter options"]`)!);
      await waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Remove"]));
      await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!);
      await tick(60);
    }
    const focusedChip = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="group"]')?.getAttribute("aria-label") ?? null;

    it("moves focus to the next chip, else the previous, else the Filter trigger", async () => {
      await renderAt("/?view=table&stages=raw_review&priority=5&archived=only");
      expect(chipNames()).toEqual(["Stage is any of RAW review", "Priority is any of 5 stars", "Archived is Only archived"]);

      await removeFromMenu("Priority");
      expect(chipNames()).toEqual(["Stage is any of RAW review", "Archived is Only archived"]);
      await waitFor(() => expect(focusedChip()).toBe("Archived is Only archived"));

      await removeFromMenu("Archived");
      expect(chipNames()).toEqual(["Stage is any of RAW review"]);
      await waitFor(() => expect(focusedChip()).toBe("Stage is any of RAW review"));

      await removeFromMenu("Stage");
      expect(chipNames()).toEqual([]);
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });
  });

  it("draws only the Board columns a Stage filter names (an excluded column would read 0), and all of them without one", async () => {
    await renderAt("/?view=board");
    expect(boardProps.value?.activeStages.map((stage: { key: string }) => stage.key)).toEqual(["awaiting_raw", "raw_review"]);
    await renderAt("/?view=board&stages=raw_review");
    expect(boardProps.value?.activeStages.map((stage: { key: string }) => stage.key)).toEqual(["raw_review"]);
    // A Stage-only filter still leaves moves as they were.
    expect(boardProps.value?.movementDisabled).toBe(false);
  });

  it.each(["table", "board"])("the %s empty state under a filter reads like the Timeline's, with a Clear filters action", async (view) => {
    apiGetMock.mockImplementation((path) => Promise.resolve(path.startsWith("/api/production-gantt") ? ganttResponse() : { projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } }));
    await renderAt(`/?view=${view}&priority=5`);
    expect(host.textContent).toContain("No projects match these filters.");
    const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Clear filters")!;
    expect(clear).toBeDefined();
    await click(clear);
    await waitFor(() => expect(url()).toBe(`/?view=${view}`));
    expect(chipNames()).toEqual([]);
  });
});

