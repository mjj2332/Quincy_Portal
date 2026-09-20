import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type Role } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { readDashboardView, subscribeDashboardView } from "../lib/dashboard-view-store";
import { ApiError } from "../lib/api";
import { __resetDashboardSearchStoreForTest, setDashboardSearchDraft } from "../lib/dashboard-search-store";

/**
 * A mounted `Dashboard` losing `viewProductionCalendar` while still showing Calendar — #119.
 * `App`'s own `QuincyQueryProvider` is keyed on `${user.id}:${user.role}:${user.authorizationEpoch}`
 * (`App.tsx`), so a role change through the real shell always remounts the Dashboard and never
 * exercises this path. This file mounts `Dashboard` directly and re-renders the SAME element with a
 * new `role` prop, the same pattern `Dashboard-calendar.dom.test.tsx`'s own `DashboardRouteHarness`
 * uses to change `authRole` without remounting — the case the real shell cannot reach.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "admin" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: () => <div data-testid="dashboard-calendar-surface" /> }));

const editorId = "22222222-2222-4222-8222-222222222222";
const routeCalendar: DashboardCalendarState = {
  view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [editorId], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function calendarResponse() {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-07-27", end: "2026-09-07", date: routeCalendar.date, subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: routeCalendar.editorIds, includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: "00000000-0000-4000-8000-000000000000", unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function projectResponse() {
  return { projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } };
}

/** Same element every render — only `role` changes — so `Dashboard`'s own instance never remounts. */
function DashboardHarness({ role }: { role: Role }) {
  return <Dashboard currentUserId="user-1" role={role} authorizationEpoch={0} calendar={routeCalendar} />;
}

/** The Dashboard's own segmented control, independent of the store — reflects `view` directly. */
function dashboardViewControlActive(host: ParentNode): string | null {
  return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')]
    .find((button) => button.dataset.active === "true")?.textContent?.trim() ?? null;
}

/** Two real-timer rounds — one for the lazy Calendar chunk's own promise to resolve past its
 * Suspense boundary, one for whatever it requests over the (mocked) network in response. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("a mounted Dashboard losing the Calendar capability (#119)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await import("../components/ProductionCalendar");
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path.startsWith("/api/production-calendar") ? Promise.resolve(calendarResponse()) : Promise.resolve(projectResponse()));
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/");
  });

  it("stops publishing \"calendar\" and moves to a renderable view once the role loses the capability, without remounting", async () => {
    await act(async () => { root.render(<DashboardHarness role="admin" />); await Promise.resolve(); await Promise.resolve(); });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).not.toBeNull();
    expect(readDashboardView()).toBe("calendar");

    const published: Array<ReturnType<typeof readDashboardView>> = [];
    const unsubscribe = subscribeDashboardView(() => { published.push(readDashboardView()); });

    try {
      // The SAME `Dashboard` instance, re-rendered with a role that no longer has
      // `viewProductionCalendar` — `calendarState` is untouched, so `isCalendarView` is the only
      // thing standing between this render and showing Calendar content to a role that cannot see
      // it. A version that ignores the capability here renders the same `"calendar"` value it
      // already had, so `useLayoutEffect`'s own dependency check skips the publish entirely and
      // this listener never fires for that commit — it jumps straight to whatever the passive
      // reconciliation effect (unrelated to this fix) eventually corrects `view` to. The fix makes
      // that commit publish `"none"` instead, a real, observable step this listener does catch.
      await act(async () => { root.render(<DashboardHarness role="photographer" />); await Promise.resolve(); await Promise.resolve(); });
      await settle();

      expect(published).not.toContain("calendar");
      expect(published).toContain("none");
      expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
      const settled = readDashboardView();
      expect(settled === "list" || settled === "kanban").toBe(true);
      expect(dashboardViewControlActive(host)).toBe(settled === "list" ? "List" : "Kanban");
    } finally {
      unsubscribe();
    }
  });

  it("still renders Calendar normally for a role that keeps the capability", async () => {
    await act(async () => { root.render(<DashboardHarness role="admin" />); await Promise.resolve(); await Promise.resolve(); });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).not.toBeNull();
    expect(readDashboardView()).toBe("calendar");
    expect(dashboardViewControlActive(host)).toBe("Calendar");
  });
});

/**
 * #217 fix round 8, Sol review, item 3 (MEDIUM). `handleCalendarAccessLoss`'s fallback
 * (`Dashboard.tsx` ~761-768) used a bare `history.push("/")` whenever it left a facet URL --
 * dropping any committed `q` the Calendar facet URL carried, since `staffPathFor` was never
 * consulted for the fallback destination.
 */
describe("Dashboard's Calendar access-loss fallback preserves a committed q (#217 fix round 8, item 3)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await import("../components/ProductionCalendar");
    apiGetMock.mockReset();
    __resetDashboardSearchStoreForTest();
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    host.remove(); document.body.replaceChildren(); window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  it("a Calendar mutation answering 401/403 at a facet URL with q=smith lands on a Dashboard URL that still carries q=smith", async () => {
    window.history.replaceState(null, "", `/?view=calendar&date=${routeCalendar.date}&sub=month&layers=project%2Cchecklist&q=smith`);
    // Mirrors `ShellRoute`'s own draft-sync wiring (`syncDashboardSearchDraftFromLocation`), which
    // this file's harness does not mount — `takeDashboardSearchForNavigation` (what the fix reads)
    // reads the STORE's draft, not the URL directly.
    setDashboardSearchDraft("smith", "user-1");
    apiGetMock.mockImplementation((path) => path.startsWith("/api/production-calendar")
      ? Promise.reject(new ApiError("Calendar access lost", 403, {}))
      : Promise.resolve(projectResponse()));

    await act(async () => { root.render(<DashboardHarness role="admin" />); await Promise.resolve(); await Promise.resolve(); });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?q=smith");
  });

  // #217 fix round 9, Sol review, item 4. The test above's own title already claimed "401/403",
  // but only ever exercised 403 -- `useSchedulingCommands.tsx`'s own `handleAccessLoss` trigger
  // checks `err.status === 401 || err.status === 403` identically at every call site (the initial
  // query, `acceptRange`, and every command's own catch), so a 401 must reach the SAME
  // `handleCalendarAccessLoss` fallback on `Dashboard.tsx`, preserving the SAME committed `q`. The
  // 403 case above is left byte-for-byte unchanged.
  it("a Calendar mutation answering 401 at a facet URL with q=smith lands on a Dashboard URL that still carries q=smith", async () => {
    window.history.replaceState(null, "", `/?view=calendar&date=${routeCalendar.date}&sub=month&layers=project%2Cchecklist&q=smith`);
    setDashboardSearchDraft("smith", "user-1");
    apiGetMock.mockImplementation((path) => path.startsWith("/api/production-calendar")
      ? Promise.reject(new ApiError("Calendar access lost", 401, {}))
      : Promise.resolve(projectResponse()));

    await act(async () => { root.render(<DashboardHarness role="admin" />); await Promise.resolve(); await Promise.resolve(); });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?q=smith");
  });
});
