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

// `filterFacets.myTasksUserId` is `z.string().uuid()`, NOT nullable
// (`packages/shared/src/production-calendar.ts:586`) -- a real UUID here, not `null`
// (`Dashboard-calendar-intent.dom.test.tsx`'s own fixture uses the same invalid `null` and never
// noticed, because none of ITS assertions depend on a successfully decoded response; this file's
// DO, so a `null` here silently cost three retries per cold load, exactly the noise item 1 needed
// to see past to find the real defect).
const noOneId = "00000000-0000-4000-8000-000000000000";

function calendarResponse(date: string) {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-24", end: "2026-08-31", date, subview: "week", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "Probe", myTasks: false } },
    events: [], unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: noOneId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
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

function calendarCallPaths() {
  return apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/production-calendar"));
}

/**
 * Settles until BOTH fetch counts stop moving for two consecutive 1s checks, not a fixed number
 * of passes: StrictMode's synthetic mount-cleanup-mount replay, on top of the lazy Calendar
 * chunk's own module-resolution microtasks (one commit further out than the canonicalising
 * replace itself, same as `Dashboard-calendar-intent.dom.test.tsx`), settles across a few seconds
 * of fake time here, not a handful of milliseconds -- capturing "before" any earlier read genuine
 * post-mount settling as if it were idle-window growth. Capped at 8 checks (8s): returns whether
 * it actually reached two consecutive stable checks, so a genuine loop that NEVER stabilises
 * within the cap fails loudly (as "never settled") instead of silently taking whatever count the
 * cap happened to catch it at as "before".
 */
async function mountAt(location: string) {
  window.history.replaceState(null, "", location);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Dashboard, { currentUserId: "user-1", role: "admin", authorizationEpoch: 0 })));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
  });
  let previous = fetchCounts();
  let stableChecks = 0;
  for (let check = 0; check < 8 && stableChecks < 2; check += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const current = fetchCounts();
    stableChecks = current.calendar === previous.calendar && current.projects === previous.projects ? stableChecks + 1 : 0;
    previous = current;
  }
  return stableChecks;
}

/**
 * `refetchInterval` for both endpoints in play (`production-calendar-query.ts`,
 * `dashboard-projects.ts`) is 30_000ms; 10_000ms is a genuinely idle window under either, measured
 * from AFTER `mountAt` has confirmed the fetch counts have already stopped moving on their own.
 *
 * `calendarCeiling`/`projectsCeiling`: an EXPLAINED ceiling on the cold-load count, not just "did
 * not grow further".
 *
 * Calendar: StrictMode's synthetic mount-cleanup-mount replay is ONE identity (principal + role +
 * authorizationEpoch + calendar/search key) double-invoked once, so a cold load that seeds its
 * FIRST fetch with the right search key correctly needs AT MOST 2 production-calendar requests
 * (identity × StrictMode replay) -- design-fix round 2, item 1 seeds `calendarState`'s initial
 * `useState` with the route's own `q` for exactly this reason, and every request below is also
 * checked to carry `q=Probe`, not just the count: a climbing sequence of DIFFERENT query keys (an
 * empty-search request self-correcting into a second, different, q=Probe request) could satisfy a
 * bare count ceiling while still being the defect item 1 found and fixed.
 *
 * Projects: `search.query` (fed to `useDashboardProjects`) is read from the external
 * `dashboard-search-store`, adopted from the route's own `q` only inside a PASSIVE effect
 * (`adoptDashboardSearchFromUrl`, further down in `Dashboard.tsx`) -- unlike `calendarState`,
 * there is no local `useState` initializer here to seed synchronously, so the first commit's
 * query key is genuinely `q:""` until that effect runs. Ceiling is 3, not 2: 2 empty-search
 * requests (identity × StrictMode replay) + 1 corrected request once the effect adopts `q=Probe`.
 * This is the SAME shape of defect item 1 fixed for the Calendar (a wasted empty-search request
 * before self-correcting), left UNFIXED here -- see the build report for why: unlike
 * `calendarState`'s own local `useState`, `search.query` is a value from a store shared across
 * every route (not just Dashboard's own calendar branch), read through `useSyncExternalStore`,
 * and closing this gap by seeding it synchronously at first render risked a real behavioural
 * regression in the store's own carefully-timed principal-scoping (`Dashboard.tsx`'s own "#217
 * fix round 4/5" comments) that this test file has no standing to restructure.
 */
async function assertIdleAfterSettling(location: string, calendarCeiling: number, projectsCeiling: number) {
  const stableChecks = await mountAt(location);
  expect(stableChecks, "fetch counts never reached two consecutive stable 1s checks within the 8s settle cap — that is the loop").toBe(2);

  expect(window.location.search, "q missing from the URL right after settling — the assertion below would be vacuous").toContain("q=Probe");
  const before = fetchCounts();
  expect(before.calendar, "more production-calendar cold-load requests than one identity × StrictMode replay explains").toBeLessThanOrEqual(calendarCeiling);
  expect(before.projects, "more projects cold-load requests than one identity × StrictMode replay explains").toBeLessThanOrEqual(projectsCeiling);
  // Every production-calendar request made, not just the LAST one -- a self-correcting sequence
  // (an initial empty-search request followed by a second, different, q=Probe request) would still
  // satisfy "q is in the URL now" without this, and is exactly the defect design-fix round 2, item
  // 1 found: the first calendar request seeded with no `q` at all.
  for (const path of calendarCallPaths()) {
    expect(path, `a production-calendar request went out without q=Probe: ${path}`).toContain("q=Probe");
  }
  const writesBefore = locationWriteCount();

  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

  const after = fetchCounts();
  expect(after.calendar, "production-calendar fetch count grew during a 10s idle window").toBe(before.calendar);
  expect(after.projects, "projects fetch count grew during a 10s idle window").toBe(before.projects);
  expect(locationWriteCount(), "location-store writes grew during a 10s idle window").toBe(writesBefore);
  expect(window.location.search).toContain("q=Probe");
}

describe("Dashboard search + Calendar request stability (#217 design-review, item 10; hardened #217 design-fix round 2, item 1)", () => {
  it("(a) the bare Calendar intent + q, from an EMPTY store -- the canonicalising rewrite runs once on settle, then stays idle", async () => {
    // calendar: 2 (identity × StrictMode replay; the fix seeds q=Probe into the FIRST of the two,
    // so both carry it -- see `calendarCallPaths()` below). projects: 3 (identity × StrictMode
    // replay = 2 empty-search requests + 1 corrected once the route's own `q` is adopted into the
    // search store -- see the doc comment above `assertIdleAfterSettling` for why this one is not
    // also 2).
    await assertIdleAfterSettling("/?view=calendar&q=Probe", 2, 3);
  });

  it("(b) no `view` param at all, a remembered kanban preference, + q", async () => {
    window.localStorage.setItem(DASHBOARD_VIEW_KEY, "kanban");
    // No Calendar view at all in this scenario, so no calendar ceiling to prove -- the Kanban
    // board mounts instead, `production-calendar` should never be requested. projects: 3, same
    // derivation as scenario (a).
    await assertIdleAfterSettling("/?q=Probe", 0, 3);
  });

  it("(c) the plain list facet + q", async () => {
    // projects: 3, same derivation as scenario (a).
    await assertIdleAfterSettling("/?view=list&q=Probe", 0, 3);
  });
});
