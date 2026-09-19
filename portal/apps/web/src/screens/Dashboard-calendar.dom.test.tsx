import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type ProductionCalendarFilters } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { Dashboard } from "./Dashboard";
import { locationStore, parseStaffLocation, safeStaffDestination } from "../lib/router";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest, getDashboardSearchSnapshot, setDashboardSearchDraft } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const calendarRefetchFails = vi.hoisted(() => ({ value: false }));
const boardPropsState = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: (props: Record<string, any>) => { boardPropsState.value = props; const project = Array.isArray(props.projects) ? props.projects.find((candidate: any) => typeof candidate?.id === "string") : undefined; return <div data-testid="dashboard-board">{project && props.projectHrefFor && <a className="mock-kanban-project-link" data-testid="mock-kanban-project-link" href={props.projectHrefFor(project)}>{project.street}</a>}</div>; } }));
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: (props: any) => <div data-testid="dashboard-calendar-surface" data-initial-view={props.initialView}>
  {props.eventContent?.({ event: { extendedProps: props.events?.[0]?.extendedProps } })}
  <button type="button" data-testid="dashboard-calendar-drop" onClick={() => props.eventDrop?.({ event: { allDay: true, start: new Date("2026-08-20T00:00:00.000Z"), startStr: "2026-08-20", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Deadline</button>
</div> }));

const projectId = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";
const routeCalendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function calendarResponse(appliedEditors = routeCalendar.editorIds, appliedSearch = "", overrides: Partial<ProductionCalendarFilters> = {}, date = routeCalendar.date) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-07-27", end: "2026-09-07", date, subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: appliedEditors, includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: appliedSearch, myTasks: false, ...overrides } },
    events: [{ id: "project-deadline:one", kind: "project_deadline", title: "Deadline", project: { id: projectId, street: "1 Calendar Street", stageKey: "editing_autohdr", checklist: { completed: 0, total: 0 }, delivered: false }, timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T09:00", deadlineVersion: 1, reminderOffsetsMinutes: [] }], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function projectResponse() {
  return {
    projects: [{ id: "33333333-3333-4333-8333-333333333333", street: "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["33333333-3333-4333-8333-333333333333"] } },
  };
}

function DashboardRouteHarness() {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  return <Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} calendar={route.kind === "dashboard" && "calendar" in route ? route.calendar : null} />;
}

describe("Dashboard Calendar routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    authRole.value = "admin";
    apiPutMock.mockReset();
    calendarRefetchFails.value = false;
    boardPropsState.value = null;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/production-calendar")) return Promise.resolve(projectResponse());
      if (calendarRefetchFails.value) return Promise.reject(new ApiError("Calendar unavailable", 503, {}));
      const query = path.split("?", 2)[1] ?? "";
      const params = new URLSearchParams(query);
      const editors = params.get("editors")?.split(",") ?? [];
      return Promise.resolve(calendarResponse(editors, params.get("q") ?? "", {
        includeUnassigned: params.get("unassigned") === "1",
        stageKeys: (params.get("stages")?.split(",") ?? []) as ProductionCalendarFilters["stageKeys"],
        showCompletedChecklist: params.get("completed") === "1",
        showDeliveredProjects: params.get("delivered") === "1",
        overdueOnly: params.get("overdue") === "1",
        myTasks: params.get("mine") === "1",
      }, params.get("date") ?? routeCalendar.date));
    });
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); __resetDashboardSearchStoreForTest(); });

  // Dashboard code-splits ProductionCalendar behind React.lazy; warm the dynamic
  // import so the Suspense boundary resolves within the render helper's ticks.
  beforeEach(async () => { await import("../components/ProductionCalendar"); });

  async function render(value: { role?: typeof authRole.value; calendar?: DashboardCalendarState | null } = {}) {
    authRole.value = value.role ?? "admin";
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} calendar={value.calendar ?? null} />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  // #217: the Dashboard no longer owns a search field -- the rail's `ShellSearch` does, and
  // neither `render()` nor `DashboardRouteHarness` mount the rail. Drives the shared store
  // directly, exactly as `ShellSearch`'s own `onChange` would.
  async function typeSearch(value: string) {
    await act(async () => {
      setDashboardSearchDraft(value);
      await Promise.resolve();
    });
  }

  it("shows Calendar only for a capable role and mounts a route-owned range once", async () => {
    await render({ calendar: routeCalendar });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(true);
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeTruthy();
    expect(apiGetMock.mock.calls.filter(([path]) => path.startsWith("/api/production-calendar"))).toHaveLength(1);
  });

  it("coerces and repairs a stored Calendar preference for a Photographer", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "calendar");
    await render({ role: "photographer" });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban")?.getAttribute("data-active")).toBe("true");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("kanban");
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => path.startsWith("/api/production-calendar"))).toBe(false);
  });

  it("enters Calendar with a canonical pushed URL and records the preference, then leaves to explicit List", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toContain("view=calendar");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("calendar");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=list");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
  });

  it("keeps List and Kanban as local-storage views with a focusable List project anchor", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=list");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
    const row = host.querySelector<HTMLAnchorElement>('[data-testid="project-list-row"]');
    expect(row?.getAttribute("href")).toBe("/projects/33333333-3333-4333-8333-333333333333");
    expect(row?.tabIndex).toBe(0);
    expect(row?.querySelector("button, select")).toBeNull();

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=kanban");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("kanban");
  });

  it("opens List and Kanban project anchors on the Full Workspace", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>('[data-testid="project-list-row"]')!;
    expect(row.href).toContain("/projects/33333333-3333-4333-8333-333333333333");
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(window.location.pathname).toBe("/projects/33333333-3333-4333-8333-333333333333");
    expect(window.location.search).toBe("");

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="mock-kanban-project-link"]')?.getAttribute("href")).toBe("/projects/33333333-3333-4333-8333-333333333333");
  });

  it("takes List/Kanban view state from the URL across history arrivals", async () => {
    window.history.replaceState(null, "", "/?view=list");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.getAttribute("data-active")).toBe("true");
    window.history.replaceState(null, "", "/?view=kanban");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "Kanban")?.getAttribute("data-active")).toBe("true");
  });

  it("restores the bare-route remembered view on a real Back navigation past an explicit switch", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    // Establish a known bare "/" history entry to return to — afterEach's replaceState from a
    // prior test only overwrites the current entry, it doesn't guarantee a clean stack, so a
    // genuine back() needs its own pushed anchor point.
    window.history.pushState(null, "", "/");
    await render();
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.getAttribute("data-active")).toBe("true");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=kanban");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "Kanban")?.getAttribute("data-active")).toBe("true");
    // A REAL Back pops the history entry selectView just pushed, landing back on bare "/" — the
    // view must revert to what that bare route originally showed, not stay on Kanban.
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(window.location.search).toBe("");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.getAttribute("data-active")).toBe("true");
  });

  it("opens scheduled Calendar project anchors on the Full Workspace", async () => {
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>('a[data-testid="calendar-project-link"]')!;
    expect(anchor.getAttribute("href")).toBe("/projects/" + projectId);
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/" + projectId);
  });

  it("leaves a modified Calendar project click to native navigation", async () => {
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>('a[data-testid="calendar-project-link"]')!;
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, metaKey: true })); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/" + projectId);
  });

  it("opens a keyboard-activated (Enter) Calendar anchor on the Full Workspace", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId);
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>('a[data-testid="calendar-project-link"]')!;
    await act(async () => { anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/" + projectId);
  });

  it("restores a remembered Calendar view by replacing the bare root with its canonical URL", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "calendar");
    await render();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toContain("view=calendar");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("calendar");
    expect(safeStaffDestination(window.location.pathname + window.location.search)).toBe(window.location.pathname + window.location.search);
  });

  it("sanitizes shared search input in List and carries it into a canonical Calendar URL", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch(`smith\\${String.fromCharCode(7)} street`);
    expect(getDashboardSearchSnapshot().draft).toBe("smith street");
    expect(window.location.search).toBe("?view=list");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=calendar");
    expect(window.location.search).toContain("q=smith+street");
    expect(getDashboardSearchSnapshot().draft).toBe("smith street");
  });

  // #217 fix round 3, item 1 (Sol's whole-branch review). Unlike the toolbar's own Calendar switch
  // above (`selectView` builds the full facet URL itself, straight from the live store — it never
  // touches this path at all), the RAIL's Calendar child link is the BARE `/?view=calendar` intent
  // (it carries no `q` of its own — `staff-routes.ts`'s `DashboardCalendarIntentRoute`). Arriving
  // at that bare intent is what reaches the reconciliation effect's OWN canonicaliser
  // (`Dashboard.tsx:~437`), which used to read `calendarState.search` — whatever this component
  // last wrote there, not necessarily what is live in the store right now.
  it("canonicalises a bare `/?view=calendar` arrival (the rail's own link) with the LIVE search, not a stale remembered one", async () => {
    await render({ calendar: { ...routeCalendar, editorIds: [], search: "oldterm" } });
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch("newterm");
    // Still mid-debounce -- the store's `query` has not committed yet, only `draft` has.
    expect(getDashboardSearchSnapshot().query).not.toBe("newterm");

    await act(async () => { locationStore().push("/?view=calendar"); await Promise.resolve(); });

    expect(window.location.search).toContain("view=calendar");
    expect(window.location.search).toContain("q=newterm");
    expect(window.location.search).not.toContain("oldterm");
  });

  // #217: the #122 P3 "latched focus request" tests that lived here (`requestProjectSearchFocus`
  // firing before/after mount) are deleted, not rewritten — the scenario they covered (a request
  // that must outlive the Dashboard not yet existing to mount its OWN search field) no longer
  // exists. The rail's `ShellSearch` is the one search input now, always present regardless of
  // which screen is showing, so there is nothing left to latch a request for. Superseded by
  // `dashboard-search-store.test.ts` (the store) and `ShellSearch.dom.test.tsx` (the rail's ⌘K
  // ref-focus, including the collapsed popover-then-focus case).

  // #217: the #122 P3 "latched focus request" tests that lived here (`requestProjectSearchFocus`
  // firing before/after mount) are deleted, not rewritten — the scenario they covered (a request
  // that must outlive the Dashboard not yet existing to mount its OWN search field) no longer
  // exists. The rail's `ShellSearch` is the one search input now, always present regardless of
  // which screen is showing, so there is nothing left to latch a request for. Superseded by
  // `dashboard-search-store.test.ts` (the store) and `ShellSearch.dom.test.tsx` (the rail's ⌘K
  // ref-focus, including the collapsed popover-then-focus case).

  it("reflects route search and replaces the normalized debounced value without a history push", async () => {
    await render({ calendar: { ...routeCalendar, editorIds: [], search: "smith street" } });
    expect(getDashboardSearchSnapshot().draft).toBe("smith street");
    const lengthBefore = window.history.length;
    await typeSearch("a b ");
    expect(getDashboardSearchSnapshot().draft).toBe("a b ");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.search).toContain("q=a+b");
    expect(window.location.search).not.toContain("a+b+");
  });

  it("does not navigate when a live search normalizes to its committed value", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist&q=smith");
    await render({ calendar: { ...routeCalendar, editorIds: [], search: "smith" } });
    const lengthBefore = window.history.length;
    await typeSearch("  smith   ");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.search).toContain("q=smith");
  });

  it("updates the shared input when navigation delivers a different Calendar q", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist&q=smith");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    window.history.pushState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist&q=harbour");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(getDashboardSearchSnapshot().draft).toBe("harbour");
  });

  it("pushes committed filter changes and keeps them beside a debounced q", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const lengthBefore = window.history.length;
    await act(async () => { [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Unassigned"))?.querySelector<HTMLInputElement>("input")?.click(); await Promise.resolve(); });
    expect(window.history.length).toBe(lengthBefore + 1);
    expect(window.location.search).toContain("unassigned=1");
    await typeSearch("a b ");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.history.length).toBe(lengthBefore + 1);
    expect(window.location.search).toContain("unassigned=1");
    expect(window.location.search).toContain("q=a+b");
    expect(window.location.search.indexOf("unassigned=1")).toBeLessThan(window.location.search.indexOf("q="));
  });

  // #217 fix round 1, item 3 (Sol's diff review). Restores the coverage this suite had before:
  // a committed search must survive a view switch or a Calendar facet change, and view-switching
  // must not be disabled just because a search is active.
  it("type then switch view inside the debounce carries q into the new view's URL", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch("smith");
    // Switched BEFORE the 300ms debounce elapses -- the pending draft must not be dropped.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=kanban");
    expect(window.location.search).toContain("q=smith");
  });

  it("type then change a Calendar facet inside the debounce keeps q", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await typeSearch("smith");
    // Toggled BEFORE the 300ms debounce elapses.
    await act(async () => { [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Unassigned"))?.querySelector<HTMLInputElement>("input")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("unassigned=1");
    expect(window.location.search).toContain("q=smith");
  });

  it("a committed search survives a view switch and does not disable the view buttons", async () => {
    await render();
    await typeSearch("smith");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.location.search).toContain("q=smith");
    const listButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "List")!;
    expect(listButton.disabled).toBe(false);
    await act(async () => { listButton.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=list");
    expect(window.location.search).toContain("q=smith");
  });

  it("silently replaces a URL after the server drops an inaccessible Editor", async () => {
    apiGetMock.mockImplementation((path) => path.startsWith("/api/production-calendar") ? Promise.resolve(calendarResponse([])) : Promise.resolve(projectResponse()));
    await render({ calendar: routeCalendar });
    expect(window.location.search).not.toContain(editorId);
    expect(window.location.search).toContain("view=calendar");
    expect(host.querySelector('[aria-live]')?.textContent ?? "").toBe("");
  });

  it("leaves Calendar when Archived is selected", async () => {
    await render({ calendar: routeCalendar });
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Archived")?.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=list");
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(host.textContent).toContain("Archived projects");
  });

  it("enters Archived from Kanban by selecting and recording List", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("kanban");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Archived")?.click(); await Promise.resolve(); });
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
    expect(host.textContent).toContain("Archived projects");
  });

  // #217 fix round 2, item 1 (Sol's diff review). `selectProjectScope` never pushes a URL when
  // `next === "archived"` and `view` is ALREADY "list" (the common case) -- the class-level bug is
  // that `viewingArchived` changing recreates `navigateCalendar` (its own dep list), which
  // re-registers the search-store's URL writer, and a re-registration must not strand a search
  // that is still mid-debounce (or, defensively, one already committed) regardless of which
  // specific call site triggered it.
  it("type then select Archived while already on List (inside the debounce) still carries q into the URL", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch("smith");
    // Selected BEFORE the 300ms debounce elapses.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Archived")?.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.location.search).toContain("q=smith");
  });

  it("a committed q survives selecting Archived while already on List", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch("smith");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.location.search).toContain("q=smith");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Archived")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("q=smith");
  });

  it("disables Dashboard view navigation only while the Calendar accept gate is active", async () => {
    await render({ calendar: routeCalendar });
    const list = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "List")!;
    expect(list().disabled).toBe(false);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="dashboard-calendar-drop"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(list().disabled).toBe(true);
    await act(async () => { confirmStore.resolve(false); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(list().disabled).toBe(false);
  });

  it("allows List/Kanban navigation after a failed Calendar settle without changing Board gates", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const boardBefore = boardPropsState.value;
    expect(boardBefore).not.toBeNull();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    apiPutMock.mockResolvedValueOnce({ changed: true, current: { version: 2, deadline: { localCivil: "2026-08-20T09:00", instant: "2026-08-19T23:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] });
    calendarRefetchFails.value = true;
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="dashboard-calendar-drop"]')!.click(); await Promise.resolve(); });
    confirmStore.resolve(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); await Promise.resolve(); });

    const list = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "List")!;
    const kanban = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban")!;
    expect(list.disabled).toBe(false);
    expect(kanban.disabled).toBe(false);
    await act(async () => { list.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=list");
    await act(async () => { kanban.click(); await Promise.resolve(); });
    expect(boardPropsState.value).toMatchObject({
      movementDisabled: boardBefore!.movementDisabled,
      canMoveStages: boardBefore!.canMoveStages,
      boardMutationEnabled: boardBefore!.boardMutationEnabled,
      sameStageReorderEnabled: boardBefore!.sameStageReorderEnabled,
    });
    expect(boardPropsState.value?.pendingMoves).toEqual(boardBefore!.pendingMoves);
    expect(boardPropsState.value?.pendingOrdering).toEqual(boardBefore!.pendingOrdering);

    // Leaving Calendar clears calendarSettle, not just the mounted view: re-entering
    // shows no leftover recovery notice.
    calendarRefetchFails.value = false;
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector('[data-testid="calendar-recovery-notice"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Refresh")).toBe(false);
  });
});
