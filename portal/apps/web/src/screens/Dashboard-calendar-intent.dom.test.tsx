import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type ProductionCalendarFilters } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { confirmStore } from "../lib/confirm";
import { DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY } from "./dashboard-helpers";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: () => <div data-testid="dashboard-calendar-surface" /> }));

const rememberedDate = "2026-08-30";
const rememberedSubview = "week";

function calendarResponse(date: string) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-24", end: "2026-08-31", date, subview: rememberedSubview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: null, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function projectResponse() {
  return { projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } };
}

/**
 * The bare `/?view=calendar` intent, from the Dashboard's side (#111).
 *
 * The navigation rail links Calendar to a parameterless URL on purpose: the remembered subview and
 * last date are resolved in exactly one place, the Dashboard, which already reads them for its own
 * mount. These tests pin the consequence of that decision — arriving on the bare URL must leave the
 * address bar holding the full facet URL, built from those remembered values.
 */
describe("the bare Calendar intent, on arrival", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    authRole.value = "admin";
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/production-calendar")) return Promise.resolve(projectResponse());
      const params = new URLSearchParams(path.split("?", 2)[1] ?? "");
      return Promise.resolve(calendarResponse(params.get("date") ?? rememberedDate));
    });
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.localStorage.setItem(DASHBOARD_CALENDAR_SUBVIEW_KEY, rememberedSubview);
    window.localStorage.setItem(DASHBOARD_CALENDAR_LAST_DATE_KEY, rememberedDate);
    window.history.replaceState(null, "", "/");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await import("../components/ProductionCalendar");
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });

  async function renderAt(location: string, role: typeof authRole.value = "admin") {
    authRole.value = role;
    window.history.replaceState(null, "", location);
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={role} authorizationEpoch={0} calendar={null} />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    // One settle more than `Dashboard-calendar.dom.test.tsx` needs. That suite mounts with the facet
    // already in hand, so Calendar is the view in the first commit; here it becomes the view only
    // after the canonicalising replace, which puts the lazy Calendar chunk one commit further out.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  function currentLocation() {
    return `${window.location.pathname}${window.location.search}`;
  }

  it("rewrites the bare URL to the facet URL built from the remembered subview and date", async () => {
    await renderAt("/?view=calendar");
    expect(currentLocation()).toBe(`/?view=calendar&date=${rememberedDate}&sub=${rememberedSubview}&layers=project%2Cchecklist`);
  });

  it("gives the viewport to the Calendar, not the Kanban", async () => {
    await renderAt("/?view=calendar");
    // The Calendar branch is asserted by its own Suspense region rather than by the calendar
    // surface inside it: the lazy chunk does not resolve under this harness, because Calendar
    // becomes the view only after the canonicalising replace and React never re-attempts the
    // boundary without a further update. `Dashboard-calendar.dom.test.tsx` mounts with the facet
    // already in hand and so does see the surface — that suite owns the surface, this one owns
    // which branch the intent selects. Either way the region below belongs to the Calendar and
    // the Kanban board is not mounted, which is the whole claim of the intent.
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeFalsy();
    expect([...host.querySelectorAll('[role="status"]')].some((node) => node.textContent === "Loading calendar…")).toBe(true);
  });

  it("requests the range for the remembered date, not for today", async () => {
    await renderAt("/?view=calendar");
    const calendarCalls = apiGetMock.mock.calls.filter(([path]) => path.startsWith("/api/production-calendar"));
    expect(calendarCalls.length).toBeGreaterThan(0);
    expect(new URLSearchParams(calendarCalls[0]![0].split("?", 2)[1]).get("date")).toBe(rememberedDate);
  });

  it("settles — the rewrite does not re-fire into a loop", async () => {
    await renderAt("/?view=calendar");
    const afterFirst = currentLocation();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(currentLocation()).toBe(afterFirst);
  });

  it("leaves a role without the Calendar capability on the Kanban", async () => {
    await renderAt("/?view=calendar", "photographer");
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeFalsy();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Calendar")).toBe(false);
  });
});
