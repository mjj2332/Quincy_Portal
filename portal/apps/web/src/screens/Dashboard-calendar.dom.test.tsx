import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type ProductionCalendarFilters } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { Dashboard } from "./Dashboard";
import { locationStore, parseStaffLocation, safeStaffDestination } from "../lib/router";
import { confirmStore } from "../lib/confirm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const calendarRefetchFails = vi.hoisted(() => ({ value: false }));
const boardPropsState = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const quickDetailPropsState = vi.hoisted(() => ({ value: null as Record<string, any> | null }));
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
const removeProjectDataMock = vi.hoisted(() => vi.fn());
const terminatePrincipalMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));
vi.mock("../lib/project-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/project-data")>();
  return {
    ...actual,
    removeProjectData: (...args: Parameters<typeof actual.removeProjectData>) => { removeProjectDataMock(...args); return actual.removeProjectData(...args); },
    terminatePrincipalOnUnauthorized: (...args: Parameters<typeof actual.terminatePrincipalOnUnauthorized>) => { terminatePrincipalMock(...args); return actual.terminatePrincipalOnUnauthorized(...args); },
  };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/ProjectKanbanBoard", () => ({ ProjectKanbanBoard: (props: Record<string, any>) => { boardPropsState.value = props; const project = Array.isArray(props.projects) ? props.projects.find((candidate: any) => typeof candidate?.id === "string") : undefined; return <div data-testid="dashboard-board">{project && props.projectHrefFor && <a className="mock-kanban-project-link" href={props.projectHrefFor(project)} onClick={props.onProjectAnchorClick}>{project.street}</a>}</div>; } }));
vi.mock("../components/ProjectQuickDetailSheet", () => ({
  computeSheetVisible: () => true,
  ProjectQuickDetailSheet: (props: Record<string, any>) => {
    quickDetailPropsState.value = props;
    return <div data-testid="mock-quick-detail-sheet"><button type="button" data-testid="mock-detail-discussion" onClick={() => props.onViewChange("discussion")}>Discussion</button><button type="button" data-testid="mock-detail-close" onClick={props.onRequestClose}>Close</button></div>;
  },
}));
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
    quickDetailPropsState.value = null;
    removeProjectDataMock.mockClear();
    terminatePrincipalMock.mockClear();
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
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });

  // Dashboard code-splits ProductionCalendar behind React.lazy; warm the dynamic
  // import so the Suspense boundary resolves within the render helper's ticks.
  beforeEach(async () => { await import("../components/ProductionCalendar"); });

  async function render(value: { role?: typeof authRole.value; calendar?: DashboardCalendarState | null } = {}) {
    authRole.value = value.role ?? "admin";
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} calendar={value.calendar ?? null} />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  async function typeSearch(value: string) {
    const input = host.querySelector<HTMLInputElement>(".dashboard-search input");
    if (!input) throw new Error("Dashboard search input is missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
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
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban")?.className).toBe("is-active");
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
    const row = host.querySelector<HTMLAnchorElement>("a.prow");
    expect(row?.getAttribute("href")).toBe("/?view=list&detail=33333333-3333-4333-8333-333333333333");
    expect(row?.tabIndex).toBe(0);
    expect(row?.querySelector("button, select")).toBeNull();

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=kanban");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("kanban");
  });

  it("opens List and Kanban project anchors on the canonical quick-detail facet", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>("a.prow")!;
    expect(row.href).toContain("/?view=list&detail=33333333-3333-4333-8333-333333333333");
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=33333333-3333-4333-8333-333333333333");
    expect(quickDetailPropsState.value?.activeView).toBe("overview");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-discussion\"]")!.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("detailView=discussion");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=list");

    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLAnchorElement>("a.mock-kanban-project-link")?.getAttribute("href")).toBe("/?view=kanban&detail=33333333-3333-4333-8333-333333333333");
  });

  it("uses Back for a same-document opener and replace for a direct quick-detail route", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>("a.prow")!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    const back = vi.spyOn(window.history, "back");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(back).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?view=list");

    window.history.replaceState(null, "", "/?view=list&detail=33333333-3333-4333-8333-333333333333");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); });
    back.mockClear();
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await Promise.resolve(); });
    expect(back).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?view=list");
    back.mockRestore();
  });

  it("does not record a same-document opener for a modified-click", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>("a.prow")!;
    // A Ctrl/Cmd-click is left to native new-tab behavior; the callback must
    // not treat it as a same-tab opener even though InternalLink invokes it
    // before deciding whether to intercept the click.
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, metaKey: true })); await Promise.resolve(); });
    window.history.replaceState(null, "", "/?view=list&detail=33333333-3333-4333-8333-333333333333");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); });
    const back = vi.spyOn(window.history, "back");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await Promise.resolve(); });
    expect(back).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?view=list");
    back.mockRestore();
  });

  it("takes List/Kanban view state from the URL across history arrivals", async () => {
    window.history.replaceState(null, "", "/?view=list");
    await act(async () => { root.render(<DashboardRouteHarness />); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.className).toBe("is-active");
    window.history.replaceState(null, "", "/?view=kanban");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "Kanban")?.className).toBe("is-active");
  });

  it("restores the bare-route remembered view on a real Back navigation past an explicit switch", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    // Establish a known bare "/" history entry to return to — afterEach's replaceState from a
    // prior test only overwrites the current entry, it doesn't guarantee a clean stack, so a
    // genuine back() needs its own pushed anchor point.
    window.history.pushState(null, "", "/");
    await render();
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.className).toBe("is-active");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    expect(window.location.search).toBe("?view=kanban");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "Kanban")?.className).toBe("is-active");
    // A REAL Back pops the history entry selectView just pushed, landing back on bare "/" — the
    // view must revert to what that bare route originally showed, not stay on Kanban.
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(window.location.search).toBe("");
    expect([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')].find((button) => button.textContent === "List")?.className).toBe("is-active");
  });

  it("uses the separate Calendar facet writer to open a project sheet", async () => {
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>("a.qc-cal-event-card__project-link")!;
    expect(anchor.getAttribute("href")).toBe("/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId + "&detail=" + projectId);
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=" + projectId);
    expect(safeStaffDestination(window.location.pathname + window.location.search)).toBe(window.location.pathname + window.location.search);
    expect(quickDetailPropsState.value?.activeView).toBe("overview");
  });

  it("uses Back and restores focus to the originating Calendar anchor on close", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId);
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>("a.qc-cal-event-card__project-link")!;
    await act(async () => { anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    const back = vi.spyOn(window.history, "back");
    const focusSpy = vi.spyOn(anchor, "focus");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(back).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalled();
    back.mockRestore(); focusSpy.mockRestore();
  });

  async function openQuickDetailSheet() {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    const row = host.querySelector<HTMLAnchorElement>("a.prow")!;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=");
  }

  it.each([
    ["detail", 403] as const,
    ["detail", 404] as const,
    ["activity", 403] as const,
    ["activity", 404] as const,
    ["comments", 404] as const,
    ["comment-read-marker", 404] as const,
  ])("closes the sheet and purges the project cache on a %s %i access failure", async (resource, status) => {
    await openQuickDetailSheet();
    await act(async () => { quickDetailPropsState.value?.onAccessFailure(new ApiError("Project not found", status), resource); await Promise.resolve(); });
    expect(window.location.search).not.toContain("detail=");
    expect(removeProjectDataMock).toHaveBeenCalledTimes(1);
    expect(removeProjectDataMock.mock.calls[0]?.[1]).toBe("33333333-3333-4333-8333-333333333333");
    expect(terminatePrincipalMock).not.toHaveBeenCalled();
  });

  it("terminates the principal (not a per-project purge) on a 401, for any resource", async () => {
    await openQuickDetailSheet();
    await act(async () => { quickDetailPropsState.value?.onAccessFailure(new ApiError("Unauthorized", 401), "detail"); await Promise.resolve(); });
    expect(window.location.search).not.toContain("detail=");
    expect(terminatePrincipalMock).toHaveBeenCalledTimes(1);
    expect(removeProjectDataMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404] as const)("never closes the sheet or purges anything for a nested-comment %i (author-only mismatch is not project loss)", async (status) => {
    await openQuickDetailSheet();
    await act(async () => { quickDetailPropsState.value?.onAccessFailure(new ApiError("Forbidden: only the author can edit this comment.", status), "nested-comment"); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=");
    expect(removeProjectDataMock).not.toHaveBeenCalled();
    expect(terminatePrincipalMock).not.toHaveBeenCalled();
  });

  // A comments-family 403 never actually reaches Dashboard's onAccessFailure — it's consumed
  // locally by ProjectDiscussionThread's own consumeOrForward first (verified by
  // ProjectDiscussionThread.dom.test.tsx: "consumes a discussion-only 403 locally with no
  // composer or close/purge callback"), so it's not a scenario worth simulating in isolation here.

  it("uses Back and restores focus for a keyboard-activated (Enter) Calendar anchor", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId);
    await render({ calendar: routeCalendar });
    const anchor = host.querySelector<HTMLAnchorElement>("a.qc-cal-event-card__project-link")!;
    await act(async () => { anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=" + projectId);
    const back = vi.spyOn(window.history, "back");
    const focusSpy = vi.spyOn(anchor, "focus");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=\"mock-detail-close\"]")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(back).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalled();
    back.mockRestore(); focusSpy.mockRestore();
  });

  it("preserves the detail facet through Calendar navigation, debounced search, and applied filters", async () => {
    window.history.replaceState(null, "", "/?view=calendar&date=" + routeCalendar.date + "&sub=month&layers=project%2Cchecklist&editors=" + editorId + "&detail=" + projectId + "&detailView=activity");
    await render({ calendar: routeCalendar });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Previous period"]')!.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("detail=" + projectId);
    expect(window.location.search).toContain("detailView=activity");
    expect(safeStaffDestination(window.location.pathname + window.location.search)).toBe(window.location.pathname + window.location.search);
    await typeSearch("harbour");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(window.location.search).toContain("q=harbour");
    expect(window.location.search).toContain("detail=" + projectId);
    await act(async () => { [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Unassigned"))?.querySelector<HTMLInputElement>("input")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("unassigned=1");
    expect(window.location.search).toContain("detail=" + projectId);
    expect(safeStaffDestination(window.location.pathname + window.location.search)).toBe(window.location.pathname + window.location.search);
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
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("smith street");
    expect(window.location.search).toBe("?view=list");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.search).toContain("view=calendar");
    expect(window.location.search).toContain("q=smith+street");
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("smith street");
  });

  it("reflects route search and replaces the normalized debounced value without a history push", async () => {
    await render({ calendar: { ...routeCalendar, editorIds: [], search: "smith street" } });
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("smith street");
    const lengthBefore = window.history.length;
    await typeSearch("a b ");
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("a b ");
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
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("harbour");
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
    expect(host.querySelector(".qc-calendar-recovery")).toBeNull();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Refresh")).toBe(false);
  });
});
