import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, dashboardSearchOf, PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { confirmStore } from "../lib/confirm";
import { parseStaffLocation } from "../lib/router";
import { DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_RENDERER_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY } from "./dashboard-helpers";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "admin" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: () => <div data-testid="dashboard-calendar-surface" /> }));

const noOneId = "00000000-0000-4000-8000-000000000000";
const date = "2026-08-27";

function calendarResponse(params: URLSearchParams) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: params.get("start"), end: params.get("end"), date: params.get("date"), subview: params.get("sub"), zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: noOneId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

/**
 * #222 — the renderer flag's one behaviour in this slice: FullCalendar (the default) draws no
 * `day`/`days` view, so with the flag off those subviews — in a URL shared by an opted-in browser,
 * or in the remembered-subview preference — are coerced to `week` in the URL AND in storage.
 */
describe("Calendar renderer flag — day/days coercion (#222)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let storage: Map<string, string>;

  beforeEach(async () => {
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/production-calendar")) return Promise.resolve({ projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } });
      return Promise.resolve(calendarResponse(new URLSearchParams(path.split("?", 2)[1] ?? "")));
    });
    storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await import("../components/ProductionCalendar");
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); __resetDashboardSearchStoreForTest(); });

  async function renderAt(location: string) {
    window.history.replaceState(null, "", location);
    const route = parseStaffLocation(location);
    if (route.kind === "dashboard") syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "user-1");
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role="admin" authorizationEpoch={0} calendar={null} />); await Promise.resolve(); await Promise.resolve(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  const currentLocation = () => `${window.location.pathname}${window.location.search}`;
  const calendarSubviewsRequested = () => apiGetMock.mock.calls
    .filter(([path]) => path.startsWith("/api/production-calendar"))
    .map(([path]) => new URLSearchParams(path.split("?", 2)[1]).get("sub"));

  for (const subview of ["day", "days"]) {
    it(`flag off: a sub=${subview} URL is rewritten to sub=week and only week is requested`, async () => {
      await renderAt(`/?view=calendar&date=${date}&sub=${subview}&layers=project%2Cchecklist`);
      expect(currentLocation()).toBe(`/?view=calendar&date=${date}&sub=week&layers=project%2Cchecklist`);
      expect(calendarSubviewsRequested().length).toBeGreaterThan(0);
      expect(calendarSubviewsRequested().every((sub) => sub === "week")).toBe(true);
      expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeTruthy();
    });

    it(`flag off: a remembered ${subview} subview resolves the bare intent to week and is rewritten in storage`, async () => {
      storage.set(DASHBOARD_CALENDAR_SUBVIEW_KEY, subview);
      storage.set(DASHBOARD_CALENDAR_LAST_DATE_KEY, date);
      await renderAt("/?view=calendar");
      expect(currentLocation()).toBe(`/?view=calendar&date=${date}&sub=week&layers=project%2Cchecklist`);
      expect(storage.get(DASHBOARD_CALENDAR_SUBVIEW_KEY)).toBe("week");
    });
  }

  it("flag on: a sub=day URL is left alone", async () => {
    storage.set(DASHBOARD_CALENDAR_RENDERER_KEY, "event-calendar");
    const location = `/?view=calendar&date=${date}&sub=day&layers=project%2Cchecklist`;
    await renderAt(location);
    expect(currentLocation()).toBe(location);
    expect(calendarSubviewsRequested()).toContain("day");
  });
});
