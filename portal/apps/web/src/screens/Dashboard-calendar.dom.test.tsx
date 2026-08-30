import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type ProductionCalendarFilters } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { locationStore, parseStaffLocation } from "../lib/router";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: (props: any) => <div data-testid="dashboard-calendar-surface" data-initial-view={props.initialView} /> }));

const projectId = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";
const routeCalendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function calendarResponse(appliedEditors = routeCalendar.editorIds, appliedSearch = "", overrides: Partial<ProductionCalendarFilters> = {}) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-07-27", end: "2026-09-07", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: appliedEditors, includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: appliedSearch, myTasks: false, ...overrides } },
    events: [{ id: "project-deadline:one", kind: "project_deadline", title: "Deadline", project: { id: projectId, street: "1 Calendar Street", stageKey: "editing_autohdr", checklist: { completed: 0, total: 0 }, delivered: false }, timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: false, canResize: false }, deadlineLocalCivil: "2026-08-12T09:00", deadlineVersion: 1, reminderOffsetsMinutes: [] }], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function projectResponse() {
  return { projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } };
}

function DashboardRouteHarness() {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  return <Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} calendar={route.kind === "dashboard" ? route.calendar ?? null : null} />;
}

describe("Dashboard Calendar routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    authRole.value = "admin";
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/production-calendar")) return Promise.resolve(projectResponse());
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
      }));
    });
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });

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

  it("coerces a stored Calendar preference for a Photographer and never fetches the range", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "calendar");
    await render({ role: "photographer" });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(false);
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => path.startsWith("/api/production-calendar"))).toBe(false);
  });

  it("enters Calendar with a canonical pushed URL and records the preference, then leaves to /", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Calendar")?.click(); await Promise.resolve(); });
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toContain("view=calendar");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("calendar");
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
  });

  it("sanitizes shared search input in List and carries it into a canonical Calendar URL", async () => {
    await render();
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "List")?.click(); await Promise.resolve(); });
    await typeSearch(`smith\\${String.fromCharCode(7)} street`);
    expect(host.querySelector<HTMLInputElement>(".dashboard-search input")?.value).toBe("smith street");
    expect(window.location.search).toBe("");
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
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(host.textContent).toContain("Archived projects");
  });
});
