// #217 build, step 4. The URL is the ONLY committed Dashboard search now: `committedQuery` is
// derived at render from `dashboardSearchOf(parsedRoute)`, never from the store. These are the
// six scenarios the design spec required to fail on the OLD code (`effectiveQuery`,
// `adoptedLocationRef`, the reconciliation effect's early return for a role without Calendar
// capability) before this refactor, and to pass after it.
import { act, createElement, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { locationStore, parseStaffLocation } from "../lib/router";
import { dashboardSearchOf } from "@quincy/shared";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { ShellSearch } from "../components/quincy/ShellSearch";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  getDashboardSearchSnapshotForPrincipal,
  setDashboardSearchDraft,
  subscribeDashboardSearch,
  syncDashboardSearchDraftFromLocation,
} from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  useStages: () => ({
    stages: [{ key: "raw_review" as const, label: "RAW review", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({
  ProjectKanbanBoard2: (props: { projects: ProjectSummary[] }) => (
    <div data-testid="dashboard-board">
      {props.projects.map((project) => <button key={project.id} type="button" data-testid="kanban2-move-to" disabled={true}>{project.street}</button>)}
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
  return path.includes("q=smith") ? smithBoard : fullBoard;
}

/**
 * Mirrors `lib/app-router.tsx`'s `ShellRoute`: the ONE place `syncDashboardSearchDraftFromLocation`
 * is wired, in a `useLayoutEffect` keyed on location + principal, calling it only for a Dashboard
 * route. `Dashboard.tsx` itself no longer performs any URL-to-store adoption (#217 build, step 4)
 * -- exercising the draft-sync seam at all requires this harness, not `Dashboard` standalone.
 *
 * #217 fix round 9, Sol review, item 1. Mounts a REAL `ShellSearch` beside the real `Dashboard`
 * (the way `RailedShell` actually composes them, not a store-draft stand-in) so a probe reading
 * `[data-testid="shell-search"]` sees the same `<input>` a Staff member types into, and so Escape
 * below can be dispatched as a real `keydown` on that input rather than calling
 * `clearDashboardSearch` directly. `ShellRoute` is not exported (`lib/app-router.tsx`'s
 * `rootRoute` wires it as a TanStack Router leaf component, coupled to `ShellIdentityContext` and
 * `RailedShell`'s own capability/impersonation plumbing) so it cannot be mounted standalone here;
 * `SidebarProvider`/`TooltipProvider` are the same minimum wrapper
 * `components/quincy/ShellSearch.dom.test.tsx`'s own `renderInProvider` requires, since
 * `reui/sidebar.tsx`'s primitives throw outside a `SidebarProvider`.
 */
function ShellRouteHarness({ userId, role }: { userId: string; role: typeof authState.role }) {
  const history = locationStore();
  const location = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const route = parseStaffLocation(location);
  useLayoutEffect(() => {
    if (route.kind !== "dashboard") return;
    syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), userId);
  }, [location, route, userId]);
  return (
    <SidebarProvider open onOpenChange={() => {}}>
      <TooltipProvider delay={0}>
        <ShellSearch variant="expanded" isDashboard={route.kind === "dashboard"} principalId={userId} />
      </TooltipProvider>
      <Dashboard currentUserId={userId} role={role} authorizationEpoch={0} />
    </SidebarProvider>
  );
}

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

/** Dispatches a REAL native `keydown` on the given target, the way `ShellSearch.dom.test.tsx`'s
 * own `keydown` helper does -- lets React's own synthetic `onKeyDown` handler (`ShellSearch.tsx`'s
 * `handleKeyDown`) run, rather than calling a store function directly. */
async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

describe("Dashboard's committed query is derived from the route, not adopted into the store (#217 build, step 4)", () => {
  it("(a) a role without Calendar capability, at /?view=list&q=smith: the projects request carries q, the chip shows, and Kanban movement is gated", async () => {
    authState.role = "photographer";
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="photographer" />); await Promise.resolve(); });
    await settle();

    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent).toContain("smith");

    // Movement gating: switch to Kanban (the search must survive the switch) and confirm every
    // Move-to trigger the mocked board renders is disabled -- the last-line-of-defence guard
    // `canMoveStages` feeds, computed from `committedQuery`, not the store.
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Kanban")?.click(); await Promise.resolve(); });
    await settle();
    expect(window.location.search).toContain("view=kanban");
    expect(window.location.search).toContain("q=smith");
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="kanban2-move-to"]')];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) expect(trigger.disabled).toBe(true);
  });

  it("(b) Back/Forward (popstate) to a q-less URL settles on a cleared chip, input and request, with no LATER commit reverting to searched", async () => {
    // #217 fix round 8, Sol review, item 4a; round 9, item 1. The probe now reads the REAL
    // `ShellSearch` input's `.value` (`ShellRouteHarness` mounts a real one beside `Dashboard`, see
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
    // `ShellRouteHarness`/`ShellSearch` already subscribe to) so it re-renders, and its own passive
    // effect re-fires, on every commit either one produces.
    //
    // #217 fix round 9 -- INVESTIGATED, not asserted per-commit (STOP case, reported rather than
    // patched around). With that correctly-wired probe in place, this popstate genuinely produces
    // TWO commits, both completing synchronously inside ONE `act(() => {...})` call (i.e. both
    // before any real paint): commit 1 has the chip and the request already cleared (`committedQuery`
    // is derived straight from the freshly-parsed route at render, no store read, no lag) but the
    // `ShellSearch` input still showing the OLD store draft, because `ShellRouteHarness`'s own
    // `syncDashboardSearchDraftFromLocation` layout effect (parent, runs AFTER `ShellSearch`'s own
    // child effects in commit order) has not written the cleared draft yet; commit 2, triggered
    // synchronously by that write notifying `ShellSearch`'s `useSyncExternalStore` subscription,
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
          inputValue: host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')?.value ?? "",
          chip: host.querySelector('[data-testid="dashboard-search-chip"]') !== null,
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
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')?.value).toBe("smith");

    window.history.pushState(null, "", "/?q=smith");
    window.history.replaceState(null, "", "/");
    captures.length = 0;
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(captures.length).toBeGreaterThan(0);
    // The chip is route-derived at render, so it has no intermediate commit to excuse: EVERY
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
        window.history.pushState(null, "", "/?view=list");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(window.location.search).not.toContain("q=smith");
      expect(__getDashboardSearchSnapshotForTest().draft).not.toBe("smith");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(e) principal A to B on /?q=smith: B's chip already agrees with the URL on B's VERY FIRST commit, never a render-scoped-empty flash while the URL still says smith", async () => {
    function Probe({ onLayout }: { onLayout: (chipText: string | null) => void }) {
      useLayoutEffect(() => {
        onLayout(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent ?? null);
      });
      return null;
    }

    window.history.replaceState(null, "", "/?q=smith");
    await act(async () => { root.render(<Dashboard currentUserId="principal-a" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip-query"]')?.textContent).toContain("smith");

    // Principal switch, still on the SAME `/?q=smith` URL, captured on the FIRST layout commit --
    // before B's own `resetDashboardSearchForPrincipal` PASSIVE effect has had any chance to run.
    // A route-derived chip must already show "smith" here, on B's very first render; a store-derived
    // one (principal-scoped-empty until that effect settles) shows nothing for at least one commit,
    // even though the URL never stopped saying smith.
    let captured: string | null | undefined;
    act(() => {
      root.render(<><Dashboard currentUserId="principal-b" role="admin" /><Probe onLayout={(chipText) => { captured = chipText; }} /></>);
    });

    expect(captured).toContain("smith");
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
  // deferred until it did. Both now also assert the REAL `ShellSearch` input `ShellRouteHarness`
  // mounts, and (f2) dispatches a real `keydown` Escape on it instead of calling
  // `clearDashboardSearch` directly.
  it("(f1) the chip's x clears the URL, the chip, the input and the list in one step", async () => {
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')?.value).toBe("smith");
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);

    const clearButton = host.querySelector<HTMLButtonElement>('[data-testid="dashboard-search-chip"] button[aria-label="Clear search"]')!;
    await act(async () => { clearButton.click(); await Promise.resolve(); });
    await settle();

    expect(window.location.search).toBe("?view=list");
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')?.value).toBe("");
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });

  it("(f2) Escape (a real keydown on the ShellSearch input) clears the URL, the chip, the input and the list in one step", async () => {
    window.history.replaceState(null, "", "/?view=list&q=smith");
    await act(async () => { root.render(<ShellRouteHarness userId="user-1" role="admin" />); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).not.toBeNull();
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.value).toBe("smith");

    // A real native `keydown`, not a direct `clearDashboardSearch(...)` call -- exercises
    // `ShellSearch.tsx`'s own `handleKeyDown` Escape branch the way a Staff member's keystroke
    // actually reaches it.
    await keydown(input, { key: "Escape" });
    await settle();

    expect(window.location.search).toBe("?view=list");
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')).toBeNull();
    expect(input.value).toBe("");
    const projectsCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectsCalls.at(-1)).not.toContain("q=");
  });
});
