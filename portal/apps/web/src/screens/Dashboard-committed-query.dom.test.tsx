// #217 build, step 4. The URL is the ONLY committed Dashboard search now: `committedQuery` is
// derived at render from `dashboardSearchOf(parsedRoute)`, never from the store. These are the
// six scenarios the design spec required to fail on the OLD code (`effectiveQuery`,
// `adoptedLocationRef`, the reconciliation effect's early return for a role without Calendar
// capability) before this refactor, and to pass after it.
import { act, createElement, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { ApiError } from "../lib/api";
import { locationStore, parseStaffLocation } from "../lib/router";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { dashboardSearchOf } from "@quincy/shared";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  getDashboardSearchSnapshotForPrincipal,
  setDashboardSearchDraft,
  subscribeDashboardSearch,
  syncDashboardSearchDraftFromLocation,
} from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #363: the List body now sits in Base UI's ScrollArea, which calls `getAnimations()` on a timer
// after mount; happy-dom lacks it. The no-op stub means "no active animations".
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authState = vi.hoisted(() => ({ role: "admin" as "admin" | "photographer" | "editor" | "external_editor" }));
// `can` is independent of the real `roleHasCapability` `Dashboard.tsx` uses for
// `canViewProductionCalendar` -- granting `moveProjectStage` here regardless of role is what lets
// (a) below exercise "has Kanban move capability AND lacks Calendar capability" at all: no REAL
// role in `packages/shared/src/capabilities.ts` combines those two (photographer, the only role
// without `viewProductionCalendar`, also lacks `moveProjectStage`).
// #217 fix round 8, Sol review, item 4c: `external_editor` is deliberately NOT the other
// no-Calendar case here -- it HAS `viewProductionCalendar` via `EXTERNAL_EDITOR_CAPABILITIES`
// (`packages/shared/src/capabilities.ts:49-61`), unlike `photographer`'s own list
// (`packages/shared/src/capabilities.ts:129-137`), which omits it.
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authState.role, capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }) }));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => ({
    stages: [{ key: "raw_review" as const, label: "RAW review", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/board/board", () => ({
  ProjectKanbanBoard2: (props: { projects: ProjectSummary[] }) => (
    <div data-testid="dashboard-board">
      {props.projects.map((project) => <button key={project.id} type="button" data-testid="board-move-to" disabled={true}>{project.street}</button>)}
    </div>
  ),
}));

function project(id: string, street: string): ProjectSummary {
  return {
    id, street, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey: "raw_review", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null,
    boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  } as ProjectSummary;
}

const fullBoard = { projects: [project("a", "Alpha Street"), project("b", "Beta Street")], board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b"] } } };
const smithBoard = { projects: [project("b", "Beta Street")], board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["b"] } } };

function projectResponseFor(path: string) {
  // The server's search counts ride on the response: `matching` of `total` active Projects.
  return path.includes("q=smith") ? { ...smithBoard, search: { query: "smith", matching: 1, total: 2 } } : fullBoard;
}

/**
 * Mirrors `lib/app-router.tsx`'s `ShellRoute`: the ONE place `syncDashboardSearchDraftFromLocation`
 * is wired, in a `useLayoutEffect` keyed on location + principal, calling it only for a Dashboard
 * route. `Dashboard.tsx` itself no longer performs any URL-to-store adoption (#217 build, step 4)
 * -- exercising the draft-sync seam at all requires this harness, not `Dashboard` standalone.
 *
 * #427: the search input is the Dashboard toolbar's own `DashboardSearch` now (it used to be a rail
 * `ShellSearch` mounted beside the Dashboard), so the real `<input>` a Staff member types into is
 * already inside `Dashboard` — `[data-testid="dashboard-search"]` — and Escape below is a real
 * `keydown` on it. `ShellRoute` is not exported (`lib/app-router.tsx`'s `rootRoute` wires it as a
 * TanStack Router leaf component coupled to `ShellIdentityContext` and `RailedShell`), so this
 * harness only carries the one thing of it these tests exercise.
 *
 * "The search is active" is observed through the header summary's "x of y" (the response carries the
 * server's search counts for `q=smith`), which is derived from the route at render like the request
 * is, so it has no intermediate commit to excuse.
 */
function ShellRouteHarness({ userId, role }: { userId: string; role: typeof authState.role }) {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), userId);
  }, [location, route, userId]);
  return <Dashboard currentUserId={userId} role={role} authorizationEpoch={0} />;
}

const searchSummary = () => host.querySelector('[data-testid="dashboard-summary"]')?.textContent ?? "";
const searchShown = () => / of \d+ active/.test(searchSummary());

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authState.role = "admin";
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path) => Promise.resolve(path.startsWith("/api/projects") ? projectResponseFor(path) : {}));
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Dispatches a REAL native `keydown` on the given target, the way `DashboardSearch.dom.test.tsx`'s
 * own `keydown` helper does -- lets React's own synthetic `onKeyDown` handler (`DashboardSearch.tsx`'s
 * `handleKeyDown`) run, rather than calling a store function directly. */
async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

describe("Dashboard's committed query is derived from the route, not adopted into the store (#217 build, step 4)", () => {
  it("(a) a role without Calendar capability, at /?view=table&q=smith: the projects request carries q, the summary names the search, and Kanban movement is gated", async () => {
    authState.role = "photographer";
    window.history.replaceState(null, "", "/?view=table&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="photographer" />); await Promise.resolve(); });
    await settle();

    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);
    expect(searchShown()).toBe(true);
    expect(searchSummary()).toContain("1 of 2 active project");

    // Movement gating: switch to Kanban (the search must survive the switch) and confirm every
    // Move-to trigger the mocked board renders is disabled -- the last-line-of-defence guard
    // `canMoveStages` feeds, computed from `committedQuery`, not the store.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Board")?.click(); await Promise.resolve(); });
    await settle();
    expect(window.location.search).toContain("view=board");
    expect(window.location.search).toContain("q=smith");
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="board-move-to"]')];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) expect(trigger.disabled).toBe(true);
  });

  it("(b) Back/Forward (popstate) to a q-less URL settles on a cleared summary, input and request, with no LATER commit reverting to searched", async () => {
    // #217 fix round 8, Sol review, item 4a; round 9, item 1. The probe now reads the REAL
    // `DashboardSearch` input's `.value` (the Dashboard renders a real one, see
    // its own docblock above), not the store's `draft` as a stand-in, and `requestQ` is actually
    // ASSERTED (it used to be captured but never checked). `requestQ` reads the MOST RECENT
    // `/api/projects` call, not `.some()` over every call ever made: the initial `/?q=smith` load
    // genuinely did request `q=smith` once, so `.some()` would stay stuck `true` forever regardless
    // of what the popstate below does -- the only meaningful question is whether the LATEST request
    // still carries the stale `q`.
    //
    // `Probe` is mounted from the START, alongside `ShellRouteHarness`, and stays mounted (never
    // re-added via a fragment swap that would tear the tree down and rebuild it): a probe added
    // only at popstate time, as a NEW sibling in the SAME `root.render()` call that also changes
    // `ShellRouteHarness`'s position in the tree, forces React to UNMOUNT and REMOUNT the entire
    // subtree instead of updating it in place. `Probe` subscribes to both `locationStore()` and
    // `subscribeDashboardSearch` directly (the SAME two external stores
    // `ShellRouteHarness`/`DashboardSearch` already subscribe to) so it re-renders, and its own passive
    // effect re-fires, on every commit either one produces.
    //
    // #217 fix round 9 -- INVESTIGATED, not asserted per-commit (STOP case, reported rather than
    // patched around). With that correctly-wired probe in place, this popstate genuinely produces
    // TWO commits, both completing synchronously inside ONE `act(() => {...})` call (i.e. both
    // before any real paint): commit 1 has the summary and the request already cleared (`committedQuery`
    // is derived straight from the freshly-parsed route at render, no store read, no lag) but the
    // `DashboardSearch` input still showing the OLD store draft, because `ShellRouteHarness`'s own
    // `syncDashboardSearchDraftFromLocation` layout effect (parent, runs AFTER `DashboardSearch`'s own
    // child effects in commit order) has not written the cleared draft yet; commit 2, triggered
    // synchronously by that write notifying `DashboardSearch`'s `useSyncExternalStore` subscription,
    // completes before `act` returns and shows the input cleared too. Per React's own layout-effect
    // contract ("a layout effect's state update is applied before the browser paints"), a Staff
    // member never sees commit 1 -- there is no paint between the two. Asserting EVERY captured
    // commit (as an earlier draft of this test did) fails on commit 1's non-paintable intermediate
    // input value; that is a probe granularity finer than anything a real browser ever shows, not a
    // production regression, so this asserts the SETTLED (final) capture instead -- still strictly
    // stronger than round 8's version (a real input, and `requestQ` actually checked) -- and keeps
    // the multi-commit evidence in this comment for whoever revisits it.
    const captures: Array<{ inputValue: string; chip: boolean; requestQ: boolean }> = [];
    function Probe({ userId }: { userId: string }) {
      const history = locationStore();
      useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
      useSyncExternalStore(subscribeDashboardSearch, () => getDashboardSearchSnapshotForPrincipal(userId).draft, () => "");
      useEffect(() => {
        const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
        captures.push({
          inputValue: host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')?.value ?? "",
          chip: searchShown(),
          requestQ: (projectsCalls.at(-1) ?? "").includes("q=smith"),
        });
      });
      return null;
    }

    window.history.replaceState(null, "", "/?q=smith");
    window.history.pushState(null, "", "/");
    window.history.replaceState(null, "", "/?q=smith");
    await act(async () => {
      root.render(<><ShellRouteHarness userId="user-1" role="admin" /><Probe userId="user-1" /></>);
      await Promise.resolve();
    });
    await settle();
    expect(searchShown()).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')?.value).toBe("smith");

    window.history.pushState(null, "", "/?q=smith");
    window.history.replaceState(null, "", "/");
    captures.length = 0;
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(captures.length).toBeGreaterThan(0);
    // The summary is route-derived at render, so it has no intermediate commit to excuse: EVERY
    // captured commit after the popstate must already show it gone. Only the input (a store draft,
    // written by the layout-effect sync) is allowed the pre-paint catch-up commit described above.
    // Nor has the request: network activity is not paint-dependent, so a stale `q` on ANY commit
    // would be a real unfiltered-vs-filtered request bug even if its render is never painted.
    for (const capture of captures) { expect(capture.chip).toBe(false); expect(capture.requestQ).toBe(false); }
    const settled = captures.at(-1)!;
    expect(settled.chip).toBe(false);
    expect(settled.inputValue).toBe("");
    expect(settled.requestQ).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("(c) type then popstate within 300ms: no q reappears after 1s of fake time", async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, "", "/");
      await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });

      act(() => { setDashboardSearchDraft("smith", "user-1"); });
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

      // Back to a DIFFERENT, q-less location within the 300ms debounce window.
      act(() => {
        window.history.pushState(null, "", "/?view=table");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(window.location.search).not.toContain("q=smith");
      expect(__getDashboardSearchSnapshotForTest().draft).not.toBe("smith");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(e) principal A to B on /?q=smith: B's FIRST projects request already carries the URL's q, never a render-scoped-empty one while the URL still says smith", async () => {
    window.history.replaceState(null, "", "/?q=smith");
    await act(async () => { root.render(<Dashboard currentUserId="principal-a" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);

    // Principal switch, still on the SAME `/?q=smith` URL. The committed query is derived from the
    // route at render (never from the principal-scoped store, which is empty for B until its own
    // reset has run), so B's first request must already carry it.
    apiGetMock.mockClear();
    await act(async () => { root.render(<Dashboard currentUserId="principal-b" role="admin" />); await Promise.resolve(); });
    await settle();
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.length).toBeGreaterThan(0);
    expect(projectsCalls[0]).toContain("q=smith");
    expect(projectsCalls.every((path) => path.includes("q=smith"))).toBe(true);
  });

  // #217 fix round 8, Sol review, item 4b; round 9, item 1. (f) "the chip's x and Escape both
  // clear the URL and the list in one step" was deliberately left uncovered here -- investigating
  // it at the time surfaced a real, narrow regression this exact commit's own scope could not fix
  // without reaching into step 5's territory: once `syncDashboardSearchDraftFromLocation` (step 3)
  // was the ONLY thing keeping the store's `draft` in step with the URL, the store's
  // `query`/`lastWritten` fields were never updated by it (only `commit()` itself still wrote
  // them) -- so after landing on a URL that already carried a `q`, `query`/`lastWritten` stayed at
  // their cold-module default `""`. Clearing called `commit()` with a normalised draft of `""`,
  // which collided with that stale default and tripped `commit()`'s OWN no-op guard (`normalized
  // === query && normalized === lastWritten`) before the writer was ever called -- the clear
  // button silently did nothing. Step 5 (already shipped -- `dashboard-search-store.ts` carries no
  // `query`/`lastWritten` fields any more, `commit()` writes through the writer unconditionally)
  // fixed the underlying bug this scenario exercises; these two cases add the coverage that was
  // deferred until it did. Both now also assert the REAL `DashboardSearch` input the Dashboard
  // renders, and (f2) dispatches a real `keydown` Escape on it instead of calling
  // `clearDashboardSearch` directly.
  // #217 design review (browser pass 3), reshaped by #427. The committed query is capped at 200 code
  // points, not 200 pixels. The old chip echoed it in a truncating badge; the field now holds it and
  // the header summary never echoes it, so the page's geometry cannot depend on the query. This pins
  // both halves: the input carries the whole 200 characters, the summary carries none of them.
  it("(g) a 200-character committed query fills the input and is never echoed into the header summary", async () => {
    const long = "a".repeat(200);
    window.history.replaceState(null, "", `/?q=${long}`);
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')?.value).toBe(long);
    expect(searchSummary()).not.toContain("aaaa");
    expect(host.querySelector('[data-testid="dashboard-header"]')!.textContent).not.toContain("aaaa");
  });

  it("(f1) the in-field clear button clears the URL, the summary, the input and the list in one step, and focus stays in the input", async () => {
    window.history.replaceState(null, "", "/?view=table&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(searchShown()).toBe(true);
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    expect(input.value).toBe("smith");
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);

    const clearButton = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
    // Clear removes the very button that holds focus. Focus stays in the INPUT (which survives the
    // clear), never falling back to `document.body`, from where the next Tab restarts in the page chrome.
    clearButton.focus();
    expect(document.activeElement).toBe(clearButton);
    await act(async () => { clearButton.click(); await Promise.resolve(); });
    await settle();
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });

    expect(document.activeElement).toBe(input);
    expect(window.location.search).toBe("?view=table");
    expect(searchShown()).toBe(false);
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();
    expect(input.value).toBe("");
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });

  it("(f2) Escape (a real keydown on the DashboardSearch input) clears the URL, the summary, the input and the list in one step", async () => {
    window.history.replaceState(null, "", "/?view=table&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(searchShown()).toBe(true);
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    expect(input.value).toBe("smith");

    // A real native `keydown`, not a direct `clearDashboardSearch(...)` call -- exercises
    // `DashboardSearch.tsx`'s own `handleKeyDown` Escape branch the way a Staff member's keystroke
    // actually reaches it.
    await keydown(input, { key: "Escape" });
    await settle();

    expect(window.location.search).toBe("?view=table");
    expect(searchShown()).toBe(false);
    expect(input.value).toBe("");
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });
});

// Sol review round 1, item 2. On a committed-query change, `useDashboardProjects`'s own
// `placeholderData` (`lib/dashboard-projects.ts`) serves the PREVIOUS dataset while the new fetch is
// in flight (`isPlaceholderData === true`). `Dashboard.tsx`'s accept effect used to stamp that
// placeholder into `acceptedProjects` under the NEW `dashboardKeyString` regardless -- so if the new
// fetch went on to fail, `hasAcceptedDashboard` suppressed the error state and the WRONG query's rows
// stayed on screen as though they were the new key's own confirmed result.
describe("Dashboard never accepts placeholder rows as the new committed query's own result (Sol review round 1, item 2)", () => {
  it("(i) a committed search whose fetch is DEFERRED still renders the previous rows while pending, then the error state (not the previous rows) once it's REJECTED", async () => {
    window.history.replaceState(null, "", "/?view=table");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect([...host.querySelectorAll('[data-testid="project-table-row-link"]')]).toHaveLength(2);

    let rejectSmith!: (reason: unknown) => void;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      if (path.startsWith("/api/projects") && path.includes("q=smith")) return new Promise((_resolve, reject) => { rejectSmith = reject; });
      return Promise.resolve(path.startsWith("/api/projects") ? projectResponseFor(path) : {});
    });

    act(() => {
      window.history.pushState(null, "", "/?view=table&q=smith");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();

    // Still pending: no error/empty state, and the PREVIOUS rows are still what's rendered -- the
    // fallback to `queryProjects` (placeholder data), not an accepted stamp.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect([...host.querySelectorAll('[data-testid="project-table-row-link"]')]).toHaveLength(2);

    // A 400 `ApiError`, not a bare `Error` -- `projectQueryRetry` (`lib/project-data.ts`) retries any
    // non-`ApiError`/non-4xx failure (including a bare `Error`, and 5xx/408/429) up to twice with a
    // real backoff delay, which this test's short, fake-timer-free `settle()` never reaches; a 4xx
    // `ApiError` outside 408/429 is the one class `projectQueryRetry` never retries, so the query
    // settles to `status: "error"` deterministically within one `settle()`.
    await act(async () => { rejectSmith(new ApiError("Offline", 400)); await settle(); });

    // `settle()`'s single `setTimeout(0)` hop can end before the 400 rejection's own re-render
    // lands -- the same artefact commit 69d8ac4 documents on this file's sibling
    // (`Dashboard-priority-coordinator.dom.test.tsx`'s test (m)): a rejection settling via
    // `queryFn`'s own throw is one more microtask hop removed than a resolved value, occasionally
    // enough to still be mid-flight (the PREVIOUS rows, no alert) when `settle()` returns. Confirmed
    // under CPU load (4 parallel loops of this file): `host.querySelector('[role="alert"]')` reads
    // null, not a wrong terminal state -- still the loading/previous-rows render from just above,
    // one commit behind. Wait for the error alert to land before asserting on it.
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });

    // Rejected: the error state shows -- the previous (Alpha/Beta) rows must NOT still be presented
    // as though they were smith's own result.
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="project-table-row-link"]')).toHaveLength(0);
  });

  it("(j) a committed search whose fetch is DEFERRED then RESOLVED replaces the previous rows with the new ones and accepts them", async () => {
    // #230 Sol review round 2, item 4: a `QueryClientProvider` this test itself owns, rather than
    // `Dashboard`'s own internal `StandaloneDashboard` fallback (`Dashboard.tsx`'s exported
    // `Dashboard` uses whatever `QueryClientContext` it finds, falling back to a private one only
    // when there is none) -- needed below to reach into the cache directly and prove ACCEPTANCE,
    // not just that the new rows rendered (they could be rendering through the direct-query
    // fallback, indistinguishable from acceptance by content alone -- see that item's own Dashboard.
    // tsx fix and its test (m) for the full mechanism this reuses).
    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.history.replaceState(null, "", "/?view=table");
    await act(async () => {
      root.render(<QueryClientProvider client={testQueryClient}><ShellRouteHarness userId="user-1" role="admin" /></QueryClientProvider>);
      await Promise.resolve();
    });
    await settle();
    expect([...host.querySelectorAll('[data-testid="project-table-row-link"]')]).toHaveLength(2);

    let resolveSmith!: (value: unknown) => void;
    let smithCalls = 0;
    let rejectSecondSmith!: (reason: unknown) => void;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      if (path.startsWith("/api/projects") && path.includes("q=smith")) {
        smithCalls += 1;
        if (smithCalls === 1) return new Promise((resolve) => { resolveSmith = resolve; });
        // The forced re-fetch below, after smith's own cache entry is evicted.
        return new Promise((_resolve, reject) => { rejectSecondSmith = reject; });
      }
      return Promise.resolve(path.startsWith("/api/projects") ? projectResponseFor(path) : {});
    });

    act(() => {
      window.history.pushState(null, "", "/?view=table&q=smith");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await settle();
    expect([...host.querySelectorAll('[data-testid="project-table-row-link"]')]).toHaveLength(2);

    await act(async () => { resolveSmith(smithBoard); await settle(); });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    const rows = [...host.querySelectorAll('[data-testid="project-table-row-link"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Beta Street");

    // Strengthened (#230 Sol review round 2, item 4): prove smith's row above was truly ACCEPTED,
    // not merely rendered through the direct-query fallback that happens to carry the same content.
    // Evict smith's own cache entry entirely (a legitimate, public `queryClient` operation -- the
    // same thing a `gcTime` expiry does in production) and force a fresh fetch that FAILS. An
    // accepted key's rows survive this (#232: Dashboard renders an accepted snapshot, not the
    // cache) -- an UN-accepted key, with no cached data of its own left either, shows the error
    // state instead, exactly as test (i) shows for a key that was never accepted at all.
    const smithKey = dashboardProjectsKey("user-1", "admin", 0, { archived: "hide" }, "smith");
    await act(async () => {
      // Not awaited -- `resetQueries()`'s own promise resolves only once the refetch it triggers
      // settles, and this test holds that refetch open deliberately (below).
      void testQueryClient.resetQueries({ queryKey: smithKey, exact: true });
      await settle();
    });
    expect(smithCalls).toBe(2);

    await act(async () => { rejectSecondSmith(new ApiError("Offline", 400)); await settle(); });

    // Same artefact as test (i)'s own fix above, and commit 69d8ac4's original on
    // `Dashboard-priority-coordinator.dom.test.tsx`'s test (m): `settle()`'s single `setTimeout(0)`
    // hop can end before this rejection's own re-render lands. Confirmed under CPU load (4 parallel
    // loops of this file): the failure reads `rowsAfterEviction` as length 0, not a wrong row count
    // or an unexpected alert -- the loading skeleton (no rows accepted-snapshot fallback painted
    // yet, no alert either) one commit behind. Wait for either terminal state -- the error alert
    // (buggy: B's accepted snapshot did not survive) or a row actually rendering (fixed) -- before
    // asserting on which one it is.
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]') ?? host.querySelector('[data-testid="project-table-row-link"]')).not.toBeNull();
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    const rowsAfterEviction = [...host.querySelectorAll('[data-testid="project-table-row-link"]')];
    expect(rowsAfterEviction).toHaveLength(1);
    expect(rowsAfterEviction[0]?.textContent).toContain("Beta Street");
  });
});
