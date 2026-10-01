import { act, createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, dashboardSearchOf, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type ProductionCalendarFilters } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { Dashboard } from "./Dashboard";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { locationStore, parseStaffLocation, safeStaffDestination } from "../lib/router";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest, __getDashboardSearchSnapshotForTest, setDashboardSearchDraft, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Calendar rail's
// scroller, opened in the Filters sheet below) calls from a timer.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

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
// #224: the Calendar is the ReUI event calendar only; it draws through the shared vendor fake
// (`testing/event-calendar-fake.tsx`), which the drop / selection helpers below drive.
vi.mock("../components/reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("../components/reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("../components/reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const projectId = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";
const routeCalendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const,
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function calendarResponse(appliedEditors = routeCalendar.editorIds, appliedSearch = "", overrides: Partial<ProductionCalendarFilters> = {}, date = routeCalendar.date) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-07-27", end: "2026-09-07", date, subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: appliedEditors, includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: appliedSearch, myTasks: false, ...overrides } },
    events: [{ id: "project-deadline:one", kind: "project_deadline", title: "Deadline", project: { id: projectId, street: "1 Calendar Street", stageKey: "editing_autohdr", checklist: { completed: 0, total: 0 }, delivered: false, archived: false }, timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T09:00", deadlineVersion: 1, reminderOffsetsMinutes: [] }], filterFacets: { projects: [], people: [], myTasksUserId: projectId },
  });
}

function projectResponse() {
  return {
    projects: [{ id: "33333333-3333-4333-8333-333333333333", street: "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["33333333-3333-4333-8333-333333333333"] } },
  };
}

// #217 build, step 4: `Dashboard.tsx` reads the committed `q` from the route at render; nothing adopts it --
// `ShellRoute` only syncs the input DRAFT from the location (`syncDashboardSearchDraftFromLocation`, wired in a
// `useLayoutEffect` keyed on location + principal). This harness mirrors exactly that wiring, the
// same way `lib/app-router.tsx`'s real `ShellRoute` derives the `calendar` prop from the parsed
// route -- without it, a test that arrives directly at a URL carrying `q` (rather than typing it
// through `setDashboardSearchDraft`) would see a draft that never catches up to the URL.
function DashboardRouteHarness() {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "user-1");
  }, [location, route]);
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
    eventCalendarFake.reset();
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); __resetDashboardSearchStoreForTest(); });

  // Dashboard code-splits ProductionEventCalendar behind React.lazy; warm the dynamic
  // import so the Suspense boundary resolves within the render helper's ticks.
  beforeEach(async () => { await import("../components/ProductionEventCalendar"); });

  async function render(value: { role?: typeof authRole.value; calendar?: DashboardCalendarState | null } = {}) {
    authRole.value = value.role ?? "admin";
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} calendar={value.calendar ?? null} />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  // #217: the Dashboard no longer owns a search field -- the rail's `ShellSearch` does, and
  // neither `render()` nor `DashboardRouteHarness` mount the rail. Drives the shared store
  // directly, exactly as `ShellSearch`'s own `onChange` would.
  /** The route fixture's one Deadline, selected so the rail shows its project anchor. */
  async function selectedProjectAnchor(): Promise<HTMLAnchorElement> {
    await act(async () => { eventCalendarFake.click("project-deadline:one"); await Promise.resolve(); });
    return host.querySelector<HTMLAnchorElement>('a[data-testid="calendar-project-link"]')!;
  }

  /** A Month drag of the Deadline to 2026-08-20 (it keeps its 09:00 Sydney wall time); opens the confirm. */
  async function dropDeadline() {
    await act(async () => {
      eventCalendarFake.update("project-deadline:one", { start: new Date("2026-08-19T23:00:00.000Z"), allDay: false, granularity: "day" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * Adds the Unassigned chip through the People combobox, as a user would. This harness has no
   * `matchMedia`, so the Calendar draws its narrow layout: the rail (and its combobox) opens in a
   * sheet from the Filters toggle once the lazy Calendar and its first range have settled.
   */
  async function pickUnassigned() {
    for (let tick = 0; tick < 20 && !host.querySelector('[data-testid="event-calendar-rail-toggle"]'); tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-toggle"]');
    expect(toggle, "no Filters toggle rendered").not.toBeNull();
    await act(async () => { toggle!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter people"]');
    expect(input, "no People combobox rendered").not.toBeNull();
    await act(async () => { input!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input!.focus(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.includes("Unassigned"));
    expect(option, "no Unassigned option in the People combobox").toBeDefined();
    await act(async () => { option!.click(); await Promise.resolve(); });
  }

  async function typeSearch(value: string) {
    await act(async () => {
      setDashboardSearchDraft(value, "user-1");
      await Promise.resolve();
    });
  }

  it("shows Calendar only for a capable role and mounts a route-owned range once", async () => {
    await render({ calendar: routeCalendar });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(true);
    expect(host.querySelector('[data-testid="event-calendar-body"]')).toBeTruthy();
    // The event calendar asks for two ranges per load (docs/lessons.md, #223): the `bounds=1` main
    // range and the Up next agenda. The route-owned main range is requested exactly once.
    const calendarCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/production-calendar"));
    expect(calendarCalls.filter((path) => new URLSearchParams(path.split("?", 2)[1]).get("bounds") === "1")).toHaveLength(1);
    expect(calendarCalls).toHaveLength(2);
  });

  it("coerces and repairs a stored Calendar preference for a Photographer", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "calendar");
    await render({ role: "photographer" });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Board")?.getAttribute("aria-selected")).toBe("true");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("board");
    expect(host.querySelector('[data-testid="event-calendar-body"]')).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => path.startsWith("/api/production-calendar"))).toBe(false);
  });

  it("enters Calendar with a canonical pushed URL and records the preference, then leaves to explicit List", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toContain("view=calendar");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("calendar");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=table");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("table");
  });

  it("keeps List and Kanban as local-storage views with a focusable List project anchor", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=table");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("table");
    const row = host.querySelector<HTMLAnchorElement>('[data-testid="project-table-row-link"]');
    expect(row?.getAttribute("href")).toBe("/projects/33333333-3333-4333-8333-333333333333");
    expect(row?.tabIndex).toBe(0);
    expect(row?.querySelector("button, select")).toBeNull();

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=board");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("board");
  });

  it("opens List and Kanban project anchors on the Full Workspace", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>('[data-testid="project-table-row-link"]')!;
    expect(row.href).toContain("/projects/33333333-3333-4333-8333-333333333333");
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(window.location.pathname).toBe("/projects/33333333-3333-4333-8333-333333333333");
    expect(window.location.search).toBe("");

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")?.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="mock-kanban-project-link"]')?.getAttribute("href")).toBe("/projects/33333333-3333-4333-8333-333333333333");
  });

  it("takes List/Kanban view state from the URL across history arrivals", async () => {
    window.history.replaceState(null, "", "/?view=table");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Table")?.getAttribute("aria-selected")).toBe("true");
    window.history.replaceState(null, "", "/?view=board");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Board")?.getAttribute("aria-selected")).toBe("true");
  });

  it("restores the bare-route remembered view on a real Back navigation past an explicit switch", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "table");
    // Establish a known bare "/" history entry to return to — afterEach's replaceState from a
    // prior test only overwrites the current entry, it doesn't guarantee a clean stack, so a
    // genuine back() needs its own pushed anchor point.
    window.history.pushState(null, "", "/");
    await render();
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Table")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=board");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Board")?.getAttribute("aria-selected")).toBe("true");
    // A REAL Back pops the history entry selectView just pushed, landing back on bare "/" — the
    // view must revert to what that bare route originally showed, not stay on Kanban.
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(window.location.search).toBe("");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Table")?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens scheduled Calendar project anchors on the Full Workspace", async () => {
    await render({ calendar: routeCalendar });
    const anchor = await selectedProjectAnchor();
    expect(anchor.getAttribute("href")).toBe("/projects/" + projectId);
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/" + projectId);
  });

  it("leaves a modified Calendar project click to native navigation", async () => {
    await render({ calendar: routeCalendar });
    const anchor = await selectedProjectAnchor();
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, metaKey: true })); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects/" + projectId);
  });

  it("opens a keyboard-activated (Enter) Calendar anchor on the Full Workspace", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId);
    await render({ calendar: routeCalendar });
    const anchor = await selectedProjectAnchor();
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
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    await typeSearch(`smith\\${String.fromCharCode(7)} street`);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith street");
    expect(window.location.search).toBe("?view=table");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=calendar");
    expect(window.location.search).toContain("q=smith+street");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith street");
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
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    await typeSearch("newterm");
    // Still mid-debounce -- the URL has not been written yet, only the store's `draft` has changed.
    expect(window.location.search).not.toContain("newterm");

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

  // #217 build, step 4: a `calendar` PROP with no URL backing it no longer seeds the shared
  // store's draft -- `Dashboard.tsx` reads no search from anywhere but the route (`committedQuery`)
  // and its own draft-sync is `ShellRoute`'s job now, not this component's. In production the
  // `calendar` prop is ALWAYS derived from the same parsed route (`lib/app-router.tsx`'s
  // `dashboardRoute`), so this test now puts the search on the actual URL too, through
  // `DashboardRouteHarness` (mirrors `ShellRoute`'s own draft-sync wiring), rather than a prop that
  // could never arise this way for real.
  // #217 fix round 8, Sol review, item 2 (MEDIUM). Clicking the already-active Calendar control
  // (`selectView("calendar")` while `view` is already "calendar") used to read
  // `effectiveRouteCalendar.search`/`calendarState.search` (the STALE, already-committed `q`) and
  // write that value back into the shared draft via `setDashboardSearchDraft` -- clobbering
  // whatever the user had typed since, one line before `navigateCalendar` reads the draft back out
  // through `takeDashboardSearchForNavigation`. The fix deletes that Calendar-state search read
  // entirely: `navigateCalendar` already flushes and reads the CURRENT draft itself.
  it("clicking the already-active Calendar control carries a mid-debounce draft, not the stale committed q", async () => {
    window.history.replaceState(null, "", `/?view=calendar&date=${routeCalendar.date}&sub=month&layers=project%2Cchecklist&q=smith`);
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(window.location.search).toContain("q=smith");

    await typeSearch("jones");
    // Still mid-debounce -- the URL has not been written yet, only the store's `draft` has changed.
    expect(window.location.search).toContain("q=smith");

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });

    expect(window.location.search).toContain("q=jones");
    expect(window.location.search).not.toContain("q=smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("jones");
  });

  it("reflects route search and replaces the normalized debounced value without a history push", async () => {
    window.history.replaceState(null, "", `/?view=calendar&date=${routeCalendar.date}&sub=month&layers=project%2Cchecklist&q=smith+street`);
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith street");
    const lengthBefore = window.history.length;
    await typeSearch("a b ");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a b ");
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
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("harbour");
  });

  it("pushes committed filter changes and keeps them beside a debounced q", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const lengthBefore = window.history.length;
    await pickUnassigned();
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
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    await typeSearch("smith");
    // Switched BEFORE the 300ms debounce elapses -- the pending draft must not be dropped.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=board");
    expect(window.location.search).toContain("q=smith");
  });

  // #217 fix round 3, item 2 (Sol's whole-branch review). The writer-registration effect
  // registers a STABLE writer once per Dashboard mount (a ref, not the raw `view`/`calendarState`
  // dependency list), so unmount is the only thing that ever unregisters it. #217 build, step 6:
  // the cleanup no longer needs to cancel the pending timer explicitly either -- `commit()` simply
  // drops a fire with no writer registered (there is no local committed copy left for it to update
  // instead), so the SAME outcome (no later commit, no later URL write) now falls out of the
  // writer being gone, not an explicit `cancelPendingDashboardSearchWrite()` call in the cleanup.
  it("cancels a pending debounce on unmount: no later commit and no later URL write", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Table")?.click(); await Promise.resolve(); });
    await typeSearch("smith");
    const locationBeforeUnmount = window.location.search;
    // Still mid-debounce: the draft is live, but the URL hasn't been written yet.
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    expect(window.location.search).toBe(locationBeforeUnmount);

    await act(async () => { root.unmount(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });

    expect(window.location.search).toBe(locationBeforeUnmount);
    // The draft itself survives -- it is what lets an off-Dashboard Enter (the rail's
    // `ShellSearch`, mounted everywhere) still navigate with whatever text was showing.
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
  });

  it("type then change a Calendar facet inside the debounce keeps q", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=2026-08-12&sub=month&layers=project%2Cchecklist");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await typeSearch("smith");
    // Toggled BEFORE the 300ms debounce elapses.
    await pickUnassigned();
    expect(window.location.search).toContain("unassigned=1");
    expect(window.location.search).toContain("q=smith");
  });

  it("a committed search survives a view switch and does not disable the view buttons", async () => {
    await render();
    await typeSearch("smith");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.location.search).toContain("q=smith");
    const listButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Table")!;
    expect(listButton.disabled).toBe(false);
    await act(async () => { listButton.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=table");
    expect(window.location.search).toContain("q=smith");
  });

  // #217 chip-row: the same toolbar/summary separation checked in List and Kanban
  // (Dashboard-search-adversarial.dom.test.tsx), for Calendar -- the summary sits between the
  // toolbar and the Calendar surface, so the chip never sits beside the Calendar's own controls.
  it("lays the page out header, view bar (tabs and search), then the Calendar surface (#427)", async () => {
    window.history.replaceState(null, "", "/?view=calendar&q=smith");
    await render({ calendar: { ...routeCalendar, search: "smith" } });

    const header = host.querySelector('[data-testid="dashboard-header"]');
    const summary = host.querySelector('[data-testid="dashboard-summary"]');
    const bar = host.querySelector('[data-testid="dashboard-view-bar"]');
    const field = host.querySelector('[data-testid="dashboard-search"]');
    const newShootLink = [...host.querySelectorAll("a")].find((node) => node.textContent === "New shoot");
    const panel = host.querySelector('[role="tabpanel"]');
    const calendarSurface = host.querySelector('[data-testid="event-calendar-body"]');

    expect(header, "no header rendered — the assertions below would be vacuous").not.toBeNull();
    expect(summary, "no summary rendered — the assertions below would be vacuous").not.toBeNull();
    expect(bar, "no view bar rendered — the assertions below would be vacuous").not.toBeNull();
    expect(field, "no search field rendered — the assertions below would be vacuous").not.toBeNull();
    expect(newShootLink, "no New shoot link rendered — the assertions below would be vacuous").not.toBeUndefined();
    expect(calendarSurface, "no Calendar surface rendered — the assertions below would be vacuous").not.toBeNull();

    expect(header!.contains(summary!)).toBe(true);
    expect(header!.contains(newShootLink!)).toBe(true);
    expect(bar!.contains(field!)).toBe(true);
    expect(header!.contains(field!)).toBe(false);
    expect(bar!.contains(host.querySelector('[role="tablist"]'))).toBe(true);
    expect(header!.compareDocumentPosition(bar!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar!.compareDocumentPosition(panel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel!.contains(calendarSurface)).toBe(true);
    expect(panel!.getAttribute("aria-labelledby")).toBe(host.querySelector('[role="tab"][aria-selected="true"]')!.id);
  });

  it("silently replaces a URL after the server drops an inaccessible Editor", async () => {
    apiGetMock.mockImplementation((path) => path.startsWith("/api/production-calendar") ? Promise.resolve(calendarResponse([])) : Promise.resolve(projectResponse()));
    await render({ calendar: routeCalendar });
    expect(window.location.search).not.toContain(editorId);
    expect(window.location.search).toContain("view=calendar");
    expect(host.querySelector('[aria-live]')?.textContent ?? "").toBe("");
  });

  const tabByName = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === name)!;

  // #428: the Active/Archived segment is gone (Archived is the shared Filter's field, Admin only), so
  // the "Calendar tab leaves Archived" cases are moot; the Filter's own survival of a tab switch is in
  // `Dashboard-filter.dom.test.tsx`.
  it("the Calendar tab carries a committed search (S1)", async () => {
    await render();
    await typeSearch("smith");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { tabByName("Calendar").click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(window.location.search).toContain("view=calendar");
    expect(window.location.search).toContain("q=smith");
    expect(host.querySelector('[data-testid="event-calendar-body"]')).not.toBeNull();
  });

  it("every view tab points at the tabpanel with aria-controls (S3)", async () => {
    await render();
    const panel = host.querySelector('[role="tabpanel"]')!;
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.length).toBe(4);
    for (const tab of tabs) expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("disables Dashboard view navigation only while the Calendar accept gate is active", async () => {
    await render({ calendar: routeCalendar });
    const list = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === "Table")!;
    const isDisabled = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";
    expect(isDisabled(list())).toBe(false);
    await dropDeadline();
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]'), "the drop never opened the confirm").not.toBeNull();
    expect(isDisabled(list())).toBe(true);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="gantt-deadline-confirm-cancel"]')!.click(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(isDisabled(list())).toBe(false);
  });

  it("allows List/Kanban navigation after a failed Calendar settle without changing Board gates", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const boardBefore = boardPropsState.value;
    expect(boardBefore).not.toBeNull();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    apiPutMock.mockResolvedValueOnce({ changed: true, current: { version: 2, deadline: { localCivil: "2026-08-20T09:00", instant: "2026-08-19T23:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] });
    calendarRefetchFails.value = true;
    await dropDeadline();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="gantt-deadline-confirm-action"]')!.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); await Promise.resolve(); });

    const list = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Table")!;
    const kanban = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Board")!;
    expect(list.disabled).toBe(false);
    expect(kanban.disabled).toBe(false);
    await act(async () => { list.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=table");
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
