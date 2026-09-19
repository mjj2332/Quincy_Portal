// #217 design-review, item 10 (coordinator follow-up). A browser tester once saw "hundreds of
// repeated successful API requests" on the Calendar view with a search active; a targeted
// re-run (cold load of /?view=calendar&q=Probe, rail and toolbar switches, per-keystroke typing,
// facet changes, Back/Forward, two tabs, clear) could NOT reproduce it -- location.href stayed
// constant and history.length never grew. This file is the tripwire, not a repro: it mounts three
// shapes of "a Dashboard route carrying q=Probe" that are hardest to get wrong, lets everything
// settle, then proves a genuinely idle window produces zero further fetches and zero further
// location-store writes. If any assertion below fails, that is the loop -- stop and report the
// evidence rather than adjusting the assertions.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { DASHBOARD_VIEW_KEY } from "./dashboard-helpers";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "admin" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
// Mirrors Dashboard-calendar.dom.test.tsx / Dashboard-calendar-intent.dom.test.tsx: mocking only
// the SURFACE (not the whole `../components/ProductionCalendar` module) leaves the real
// `useProductionCalendarRange` query -- and so the real `/api/production-calendar` fetch this
// file needs to count -- intact.
vi.mock("../components/ProductionCalendarSurface", () => ({ ProductionCalendarSurface: () => <div data-testid="dashboard-calendar-surface" /> }));

function calendarResponse(date: string) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-24", end: "2026-08-31", date, subview: "week", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "Probe", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: null, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function projectResponse() {
  return { projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} }, search: { query: "Probe", matching: 0, total: 0 } };
}

let host: HTMLDivElement;
let root: Root;
let pushSpy: ReturnType<typeof vi.spyOn>;
let replaceSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date("2026-08-27T00:00:00.000Z") });
  // Preloaded, mirroring `Dashboard-calendar-intent.dom.test.tsx`'s own harness: `Dashboard.tsx`
  // reaches this module through `lazy(() => import(...))`, and letting that dynamic import resolve
  // for the first time only after `vi.useFakeTimers()` is installed is what left it unsettled
  // (perpetually "Loading calendar…") for every scenario below that mounts the Calendar view.
  await import("../components/ProductionCalendar");
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => path.startsWith("/api/production-calendar")
    ? Promise.resolve(calendarResponse(new URLSearchParams(path.split("?", 2)[1] ?? "").get("date") ?? "2026-08-27"))
    : Promise.resolve(projectResponse()));
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // Spied AFTER the initial `replaceState` above (the test harness's own reset), so only writes
  // `locationStore()` itself makes -- push and replace both bottom out in these two -- are counted.
  pushSpy = vi.spyOn(window.history, "pushState");
  replaceSpy = vi.spyOn(window.history, "replaceState");
});

afterEach(async () => {
  pushSpy.mockRestore();
  replaceSpy.mockRestore();
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  vi.useRealTimers();
});

function fetchCounts() {
  return {
    calendar: apiGetMock.mock.calls.filter(([path]) => path.startsWith("/api/production-calendar")).length,
    projects: apiGetMock.mock.calls.filter(([path]) => path.startsWith("/api/projects")).length,
  };
}

function locationWriteCount() {
  return pushSpy.mock.calls.length + replaceSpy.mock.calls.length;
}

async function mountAt(location: string) {
  window.history.replaceState(null, "", location);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Dashboard, { currentUserId: "user-1", role: "admin", authorizationEpoch: 0 })));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
  });
  // Settles until BOTH fetch counts stop moving for two consecutive 1s checks, not a fixed number
  // of passes: StrictMode's synthetic mount-cleanup-mount replay, on top of the lazy Calendar
  // chunk's own module-resolution microtasks (one commit further out than the canonicalising
  // replace itself, same as `Dashboard-calendar-intent.dom.test.tsx`), settles across a few
  // seconds of fake time here, not a handful of milliseconds -- capturing "before" any earlier
  // read genuine post-mount settling as if it were idle-window growth. Capped at 8 checks (8s) so
  // a genuine loop still fails loudly instead of looping here forever.
  let previous = fetchCounts();
  let stableChecks = 0;
  for (let check = 0; check < 8 && stableChecks < 2; check += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const current = fetchCounts();
    stableChecks = current.calendar === previous.calendar && current.projects === previous.projects ? stableChecks + 1 : 0;
    previous = current;
  }
}

/**
 * `refetchInterval` for both endpoints in play (`production-calendar-query.ts`,
 * `dashboard-projects.ts`) is 30_000ms; 10_000ms is a genuinely idle window under either, measured
 * from AFTER `mountAt` has confirmed the fetch counts have already stopped moving on their own.
 */
async function assertIdleAfterSettling(location: string) {
  await mountAt(location);

  expect(window.location.search, "q missing from the URL right after settling — the assertion below would be vacuous").toContain("q=Probe");
  const before = fetchCounts();
  const writesBefore = locationWriteCount();

  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

  const after = fetchCounts();
  expect(after.calendar, "production-calendar fetch count grew during a 10s idle window").toBe(before.calendar);
  expect(after.projects, "projects fetch count grew during a 10s idle window").toBe(before.projects);
  expect(locationWriteCount(), "location-store writes grew during a 10s idle window").toBe(writesBefore);
  expect(window.location.search).toContain("q=Probe");
}

describe("Dashboard search + Calendar request stability (#217 design-review, item 10)", () => {
  it("(a) the bare Calendar intent + q, from an EMPTY store -- the canonicalising rewrite runs once on settle, then stays idle", async () => {
    await assertIdleAfterSettling("/?view=calendar&q=Probe");
  });

  it("(b) no `view` param at all, a remembered kanban preference, + q", async () => {
    window.localStorage.setItem(DASHBOARD_VIEW_KEY, "kanban");
    await assertIdleAfterSettling("/?q=Probe");
  });

  it("(c) the plain list facet + q", async () => {
    await assertIdleAfterSettling("/?view=list&q=Probe");
  });
});
