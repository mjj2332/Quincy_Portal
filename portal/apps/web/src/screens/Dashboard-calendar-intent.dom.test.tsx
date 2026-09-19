import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, dashboardSearchOf, PRODUCTION_CALENDAR_ZONE, type ProductionCalendarFilters } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { confirmStore } from "../lib/confirm";
import { parseStaffLocation } from "../lib/router";
import { DASHBOARD_CALENDAR_LAST_DATE_KEY, DASHBOARD_CALENDAR_SUBVIEW_KEY } from "./dashboard-helpers";
import { __resetDashboardSearchStoreForTest, __getDashboardSearchSnapshotForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

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

// `filterFacets.myTasksUserId` is `z.string().uuid()`, NOT nullable
// (`packages/shared/src/production-calendar.ts:586`) -- a real UUID here, not `null`
// (#217 design-fix round 3, item 4). Corrected (#217 build, step 7): this comment used to claim a
// `null` here validates fine when THIS file builds the fixture. It does not -- there is no
// `.nullable()` on the schema, so `adminProductionCalendarRangeResponseSchema.parse` below throws
// on a `null` `myTasksUserId` just as readily as `Dashboard.tsx`'s own `decodeProductionCalendarResponse`
// would, re-parsing the SAME shape against the per-role schema inside the real `queryFn` -- see
// `Dashboard-search-request-stability.dom.test.tsx`'s own investigation note for the mechanics of
// what a genuinely invalid response does there (three retry attempts at 0s/1s/3s under
// react-query's default backoff, not a parse that quietly succeeds).
const noOneId = "00000000-0000-4000-8000-000000000000";

function calendarResponse(date: string) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-24", end: "2026-08-31", date, subview: rememberedSubview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: noOneId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
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
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await import("../components/ProductionCalendar");
  });
  afterEach(() => { confirmStore.resolve(false); if (root) act(() => root.unmount()); host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); __resetDashboardSearchStoreForTest(); });

  async function renderAt(location: string, role: typeof authRole.value = "admin") {
    authRole.value = role;
    window.history.replaceState(null, "", location);
    // #217 build, step 4: `Dashboard.tsx` reads the committed `q` from the route at render; nothing adopts it
    // -- `ShellRoute` only syncs the input DRAFT from the location, a `useLayoutEffect` keyed on location + principal
    // (`lib/app-router.tsx`). This mirrors that ONE call directly, matching a real arrival exactly
    // (`ShellRoute` always runs ahead of `Dashboard` in production).
    const route = parseStaffLocation(location);
    if (route.kind === "dashboard") syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "user-1");
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
    // The claim of the intent is which BRANCH owns the viewport: the Calendar's surface is mounted
    // and the Kanban board is not. This used to be asserted through the Calendar's "Loading
    // calendar…" status, with a note that the surface never resolved under this harness. That was
    // an accident, not a property of the harness: the range fixture carried
    // `filterFacets.myTasksUserId: null`, which the strict response schema rejects, so every load
    // sat in react-query's retry loop and never left the loading state (#217 design-fix round 3).
    // With an honest fixture the range decodes and the surface renders, so assert it directly.
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeFalsy();
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeTruthy();
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

  // #217 fix round 4, item 1 (Sol re-review, BLOCKER). A fresh document load -- exactly what
  // keyboard Enter, cmd/middle-click, "open in new tab" and a reload on the rail's Calendar link
  // all do -- starts with a COLD, empty `dashboard-search-store.ts` singleton. Before this fix the
  // canonicaliser could only read that empty store, so the intent's own `q` (now legal --
  // `staff-routes.ts`'s `DashboardCalendarIntentRoute`) was the only place the search could still
  // be coming from on arrival.
  it("carries a `q` on the bare Calendar intent into the canonical facet URL, from an EMPTY store", async () => {
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
    await renderAt("/?view=calendar&q=smith");
    expect(currentLocation()).toBe(`/?view=calendar&date=${rememberedDate}&sub=${rememberedSubview}&layers=project%2Cchecklist&q=smith`);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
  });
});
