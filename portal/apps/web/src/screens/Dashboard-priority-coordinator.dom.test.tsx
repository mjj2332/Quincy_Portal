import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";
import { locationStore } from "../lib/router";
import { ApiError } from "../lib/api";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ can: (capability: string) => capability === "prioritizeProjects" || capability === "adminBackend" }) }));
vi.mock("../lib/stages", () => ({ useStages: () => ({ stages: [{ key: "awaiting_raw", label: "Awaiting RAW", active: true }], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({
  // `<option value="3">` exists only so a value the (l) test's Beta fixture carries (priority 3,
  // never legitimately reachable through this mocked board's own UI) is even representable as a
  // DOM selection -- without it, an unmatched `value` prop leaves every `<option>`'s `selected`
  // untouched and a real <select> falls back to displaying its first option, silently confounding
  // that test's "was the wrong value ever selected" check with this fixture's own limits.
  ProjectKanbanBoard2: ({ projects, onPriorityChange }: { projects: Array<{ id: string; priority: number | null }>; onPriorityChange: (project: { id: string; priority: number | null }, priority: number | null) => void }) => <select aria-label="Priority" value={projects[0]?.priority ?? ""} onChange={(event) => onPriorityChange(projects[0]!, Number(event.target.value))}><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>,
}));

const project = { id: "project-1", street: "1 Priority Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };

let root: Root;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
const storage = new Map<string, string>();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

// Drains microtask hops only (a settled promise's own `.then()` chain, and any react-query
// internals chained off it) without the macrotask `setTimeout(0)` hop that `flush()` uses to let
// react-query's scheduler notify subscribers and commit a re-render. Used to let a raw fetch
// promise's resolution reach the query cache (`Query#fetch()`'s own `setData` runs inline, off
// the settled promise, with no `setTimeout` in between) while deliberately holding back the
// *next* render/effect pass that would otherwise consume it first.
async function microflush(hops = 25) {
  await act(async () => { for (let i = 0; i < hops; i += 1) await Promise.resolve(); });
}

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); runtime = new ProjectQueryRuntime(queryClient);
  apiGetMock.mockReset().mockResolvedValue({ projects: [project], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [project.id] } } });
  apiPostMock.mockReset().mockResolvedValue({ priority: 2, boardRevision: 2 });
  storage.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
});

afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); runtime.dispose(); queryClient.clear(); document.body.replaceChildren(); });

describe("Dashboard priority coordinator wiring", () => {
  it("keeps the Board refresh and publishes detail/activity without Calendar", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" role="admin" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    const publish = vi.spyOn(runtime, "publish");
    await act(async () => { const select = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!; select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${project.id}/priority`, { priority: 2 });
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "detail" }, { kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(false);
    const invalidatedKeys = invalidateQueries.mock.calls
      .map(([filters]) => filters?.queryKey)
      .filter((queryKey): queryKey is readonly unknown[] => Array.isArray(queryKey));
    expect(invalidatedKeys.some((queryKey) => queryKey[0] === "dashboard-projects")).toBe(false);
  });

  it("does not publish coordinator invalidations when the priority mutation is rejected", async () => {
    apiPostMock.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" role="admin" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    const publish = vi.spyOn(runtime, "publish");
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const getsBeforeMutation = apiGetMock.mock.calls.length;
    await act(async () => { const select = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!; select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${project.id}/priority`, { priority: 2 });
    expect(apiGetMock.mock.calls.length).toBeGreaterThan(getsBeforeMutation);
    expect(publish).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

// #230. `dashboardKey` (Dashboard.tsx ~:291) used to omit `committedQuery`, so
// `setProjectPriority`'s optimistic/confirmed/rollback writes (`updateProjects`, ~:396) all landed
// in a cache entry keyed WITHOUT `q` while the projects query itself (`useDashboardProjects`,
// ~:289) is keyed WITH it -- at `/?q=priority` the write updated an entry nobody was reading.
describe("Dashboard optimistic writes target the searched cache entry (#230)", () => {
  const searchedProject = { id: "project-priority", street: "1 Priority Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const otherProject = { id: "project-other", street: "2 Off List Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardPosition: 1, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const searchedKey = dashboardProjectsKey("admin-1", "admin", 0, false, "priority");
  const qLessKey = dashboardProjectsKey("admin-1", "admin", 0, false);

  beforeEach(() => {
    window.history.replaceState(null, "", "/?q=priority");
    syncDashboardSearchDraftFromLocation("priority", "admin-1");
    apiGetMock.mockReset().mockImplementation((path: string) => Promise.resolve(
      path.includes("q=")
        ? { projects: [searchedProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id] } } }
        : { projects: [searchedProject, otherProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id, otherProject.id] } } },
    ));
    apiPostMock.mockReset().mockResolvedValue({ priority: 2, boardRevision: 2 });
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  async function renderSearchedDashboard() {
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" role="admin" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    expect(select.value).toBe("1");
    return select;
  }

  // (a)/(c) need the q-LESS entry to genuinely exist (not merely be absent, which would make an
  // assertion that it's untouched vacuous) -- mounts at a bare "/" first (populating the q-less
  // cache entry from a real fetch), THEN commits the search through `locationStore().replace`, the
  // same URL-write path `ShellSearch`'s own commit uses, mirrored with
  // `syncDashboardSearchDraftFromLocation` the way `lib/app-router.tsx`'s `ShellRoute` calls it on
  // every location change. Waits on `getQueryData`, not the rendered `<select>`: the render reads
  // the `acceptedProjects` SNAPSHOT (Dashboard.tsx ~:370), gated behind `interactionBlocked`
  // (~:354, includes `pendingOrdering.size > 0`) -- a snapshot the accept effect will not update
  // while a mutation is in flight, on main today, searched or not (a separate, pre-existing
  // behaviour, not this cache-key bug -- see this file's own (a)/(c) history and the step-6 lessons
  // entry). `getQueryData` reads the react-query cache directly and is unaffected by that gate.
  async function renderUnfilteredThenSearch() {
    window.history.replaceState(null, "", "/");
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" role="admin" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(qLessKey)).toBeDefined());
    act(() => {
      locationStore().replace("/?q=priority");
      syncDashboardSearchDraftFromLocation("priority", "admin-1");
    });
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(searchedKey)).toBeDefined());
    return host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
  }

  // The POST is held open (a manually-settled promise, not `mockResolvedValue`'s already-settled
  // one) so the assertion lands deterministically between the SYNCHRONOUS optimistic write and
  // whatever the eventual response does -- `notifyManager`'s default scheduler is a real
  // `setTimeout(0)` macrotask (`@tanstack/query-core`), not a microtask, so a bare
  // `await Promise.resolve()` proves nothing about whether the cache write has reached the DOM yet;
  // `flush()`'s own `setTimeout(resolve, 0)` tick is what actually lets it land. Holding the POST
  // open is what keeps that same tick from ALSO racing the confirmed-response write, `queueDashboardRefresh`'s refetch and `invalidateProjectSurfaces` to completion first.
  function deferredPost() {
    let settle!: (value: { priority: number; boardRevision: number }) => void;
    let fail!: (reason: unknown) => void;
    apiPostMock.mockReset().mockImplementation(() => new Promise((resolve, reject) => { settle = resolve; fail = reject; }));
    return { settle: (value: { priority: number; boardRevision: number }) => settle(value), fail: (reason: unknown) => fail(reason) };
  }

  // Rescoped by the coordinator: the original (a) asserted on the rendered `<select>` "immediately"
  // showing the optimistic value, which cannot happen on main regardless of this bug (see this
  // block's shared `renderUnfilteredThenSearch` docblock) -- filed as its own, separate issue. This
  // now asserts the EXACT-KEY write contract instead: the q-aware entry gets the optimistic value,
  // and the q-less entry (loaded first, real data, not absent) is untouched while the POST is
  // pending.
  it("(a) an optimistic priority change at /?q=... writes the q-aware cache entry only -- the q-less entry (loaded first) is untouched while the POST is pending", async () => {
    deferredPost();
    const select = await renderUnfilteredThenSearch();
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    const searched = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(searchedKey);
    const qLess = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey);
    expect(searched?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    expect(qLess?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(1);
  });

  it("(b) the optimistic write lands in the cache entry keyed with the committed search", async () => {
    deferredPost();
    const select = await renderSearchedDashboard();
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    const cached = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(searchedKey);
    expect(cached?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
  });

  // Rescoped by the coordinator the same way (a) was -- the rendered `<select>` cannot observe this
  // either, for the same `acceptedProjects`-snapshot reason. Asserts the cache directly: the q-aware
  // entry holds the new value while pending and rolls back to the old one on rejection; the q-less
  // entry (loaded first) never changes at any point.
  it("(c) a rejected priority POST at /?q=... rolls back the q-aware entry only -- the q-less entry (loaded first) never changes", async () => {
    const post = deferredPost();
    const select = await renderUnfilteredThenSearch();
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(searchedKey)?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    expect(queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey)?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(1);
    await act(async () => {
      post.fail(new Error("Offline"));
      await flush();
    });
    expect(queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(searchedKey)?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(1);
    expect(queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey)?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(1);
  });

  // `queueDashboardRefresh` refetches only the ACTIVE observer's key, and
  // `invalidateProjectSurfaces(..., producer: "dashboard")` deliberately skips the in-tab Dashboard
  // scan -- so without more, the q-less entry (loaded first) keeps the OLD priority and would show
  // it the moment the search is cleared. The confirmed response must additionally fan out to every
  // EXISTING `["dashboard-projects", currentUserId, ...]` entry (precedent:
  // `removeProjectFromDashboardQueries`, `lib/dashboard-projects.ts` ~:128-136).
  //
  // Rewritten for Sol review round 1, item 1. The original (d), from this branch's own 782c5dd/
  // 5ad75cb (not a pre-existing main assertion), additionally asserted that clearing the search
  // fires NO new q-less `/api/projects` request at all. Item 1c (this same commit) supersedes that
  // half deliberately, not by accident: `invalidateQueries({ refetchType: "none" })` marks the
  // q-less entry `isInvalidated`, and `@tanstack/query-core`'s own `Query.isStaleByTime` treats
  // `isInvalidated` as stale UNCONDITIONALLY (query.js, ahead of the 15s `staleTime` check) --
  // exactly the flag `QueryObserver.setOptions` -> `shouldFetchOptionally` reads to decide whether
  // switching an observer onto a query fetches it. So "marked stale" and "never refetched when next
  // observed" cannot both be true; the self-heal item 1c exists for IS that refetch. What the
  // original (d) actually needed to protect -- the Staff member sees the CONFIRMED value
  // immediately on clearing, and the eventual refetch never regresses it -- still holds, and is
  // asserted more strongly here than before: the GET mock is now STATEFUL (once the priority POST
  // has been sent, `/api/projects` — with or without `q` — answers with the confirmed priority, the
  // way a real server would, instead of replaying the pre-mutation value forever), the self-heal
  // refetch is deferred so the cache is observed BOTH mid-flight and after it settles, and exactly
  // ONE q-less request is asserted for the clear (not zero, not more).
  it("(d) a confirmed priority change under a search also writes the q-less entry (loaded first) -- the clear-search self-heal refetch confirms it, never regresses it", async () => {
    const select = await renderUnfilteredThenSearch();

    // Swapped in only AFTER the seed load above (which needs the describe-level `beforeEach` mock's
    // priority-1 data for both keys) -- every call reaching this mock is a REFETCH of an
    // already-populated entry, not a seed.
    let qLessRequestCount = 0;
    let resolveQLessRequest: (() => void) | null = null;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      // Stateful once the priority POST has actually been sent -- a real server would already know
      // about the confirmed priority by the time anything refetches after it.
      const confirmed = apiPostMock.mock.calls.length > 0;
      const searchedWithState = confirmed ? { ...searchedProject, priority: 2, boardRevision: 2 } : searchedProject;
      if (path.includes("q=")) {
        return Promise.resolve({ projects: [searchedWithState], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id] } } });
      }
      // Deferred so the self-heal refetch triggered by clearing the search can be observed
      // mid-flight, not just after it settles.
      qLessRequestCount += 1;
      return new Promise((resolve) => {
        resolveQLessRequest = () => resolve({ projects: [searchedWithState, otherProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id, otherProject.id] } } });
      });
    });

    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    // Cache half: still searched at this point (committedQuery is still "priority", so nothing has
    // triggered a q-less refetch) -- the q-less entry already holds the confirmed value purely from
    // the fan-out write.
    const qLessAfterConfirm = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey);
    expect(qLessAfterConfirm?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    expect(qLessRequestCount).toBe(0);

    // Clear the search -- this is the self-heal item 1c exists for: the q-less entry was marked
    // `isInvalidated` by the fan-out, so switching the Dashboard's own observer back onto it fetches.
    act(() => {
      locationStore().replace("/");
      syncDashboardSearchDraftFromLocation("", "admin-1");
    });
    await flush();

    // Exactly ONE q-less request results from the clear -- the self-heal itself, not zero (item 1c
    // would be inert) and not more (no request storm).
    expect(qLessRequestCount).toBe(1);
    // Cache half, mid-flight: the deferred self-heal request has not resolved yet, but the entry
    // already holds the confirmed value from the fan-out write, not the pre-mutation one, and the
    // still-pending background refetch does not clear or regress it.
    const qLessWhilePending = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey);
    expect(qLessWhilePending?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    // Rendered half, mid-flight: `pendingOrdering` cleared once the mutation settled above (unlike
    // (a)/(c)'s still-pending POST), so this is not gated by the `acceptedProjects`-snapshot
    // mechanism (a)/(c) hit -- the accept effect can and does stamp the q-less entry's own cached
    // (already-confirmed) data under its own key. Asserted directly, not assumed: if this turns out
    // to be gated after all, the intent is to drop this assertion and keep the cache ones, not to
    // loosen it.
    const selectWhilePending = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    expect(selectWhilePending.value).toBe("2");

    // Resolve the self-heal refetch -- the server-confirmed value (this mock's stateful response)
    // must not regress what the cache/render already showed while it was pending.
    await act(async () => {
      resolveQLessRequest?.();
      await flush();
    });
    expect(qLessRequestCount).toBe(1);
    const qLessAfterSelfHeal = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey);
    expect(qLessAfterSelfHeal?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    const clearedSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    expect(clearedSelect.value).toBe("2");
  });

  // `setQueriesData`'s own contract (pinned, not merely relied on): it only touches entries that
  // ALREADY EXIST in the cache -- it must never manufacture an empty q-less entry for a Staff member
  // who deep-linked straight to a search and never had an unfiltered load at all.
  it("(e) the fan-out never creates a q-less entry that didn't already exist (deep link straight to /?q=...)", async () => {
    const select = await renderSearchedDashboard();
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(queryClient.getQueryData(qLessKey)).toBeUndefined();
  });

  // Sol review round 1, item 1. Two races the fan-out itself opens once it exists at all: (A) a
  // sibling entry's OWN refetch that started BEFORE the priority POST can still resolve AFTER the
  // fan-out write and put the stale value back; (B) a slow priority response can overwrite a
  // sibling that already holds NEWER server data. (f) covers race A, (g) covers race B, (h) covers
  // the mark-stale half of the fix.
  describe("the confirmed fan-out has freshness protection (Sol review round 1, item 1)", () => {
    // Race A. The q-less entry (loaded first, real data) has its OWN refetch already in flight when
    // the priority POST confirms -- that refetch was started (and is still pending, holding the OLD
    // priority as its eventual result) BEFORE the confirmed fan-out write lands. Without cancelling
    // it first, the late resolve overwrites the just-confirmed value back to the stale one the
    // moment it finally settles.
    it("(f) a deferred sibling (q-less) refetch in flight when the priority POST confirms -- the q-less entry ends up holding the CONFIRMED priority, not the late refetch's stale result", async () => {
      const select = await renderUnfilteredThenSearch();

      let resolveQLessRefetch!: (value: unknown) => void;
      apiGetMock.mockImplementation((path: string) => path.includes("q=")
        ? Promise.resolve({ projects: [searchedProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id] } } })
        : new Promise((resolve) => { resolveQLessRefetch = resolve; }));

      // Starts the sibling's own refetch BEFORE the priority POST -- deliberately not awaited here,
      // it settles only once `resolveQLessRefetch` is called below.
      let refetchSettled = false;
      const refetchPromise = queryClient.refetchQueries({ queryKey: qLessKey, exact: true }).then(() => { refetchSettled = true; });
      await flush();
      expect(refetchSettled).toBe(false);

      const post = deferredPost();
      await act(async () => {
        select.value = "2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });
      await act(async () => {
        post.settle({ priority: 2, boardRevision: 2 });
        await flush();
      });

      // The sibling refetch's underlying request resolves LATE, with the OLD priority -- after the
      // confirmed fan-out has already written the new one.
      await act(async () => {
        resolveQLessRefetch({ projects: [searchedProject, otherProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id, otherProject.id] } } });
        await refetchPromise;
        await flush();
      });

      const qLess = queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(qLessKey);
      expect(qLess?.find((entry) => entry.id === searchedProject.id)?.priority).toBe(2);
    });

    // Race B. The q-less entry already holds a HIGHER boardRevision than the priority response is
    // confirming (a later stage move landed there first) -- the fan-out must leave that item alone
    // rather than regress it to a response the server has since moved past.
    it("(g) the q-less entry holding a HIGHER boardRevision than the confirmed priority response is left untouched by the fan-out", async () => {
      const newerRevisionProject = { ...searchedProject, boardRevision: 5 };
      apiGetMock.mockReset().mockImplementation((path: string) => Promise.resolve(
        path.includes("q=")
          ? { projects: [searchedProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [searchedProject.id] } } }
          : { projects: [newerRevisionProject, otherProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [newerRevisionProject.id, otherProject.id] } } },
      ));
      apiPostMock.mockReset().mockResolvedValue({ priority: 2, boardRevision: 2 });

      const select = await renderUnfilteredThenSearch();
      await act(async () => {
        select.value = "2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });

      const qLess = queryClient.getQueryData<Array<{ id: string; priority: number | null; boardRevision: number }>>(qLessKey);
      const entry = qLess?.find((item) => item.id === searchedProject.id);
      expect(entry?.priority).toBe(newerRevisionProject.priority);
      expect(entry?.boardRevision).toBe(5);
    });

    // Mark-stale, not refetch-now: `queueDashboardRefresh()` only refetches the ACTIVE observer's
    // key, so the q-less entry must be left `isInvalidated` so a same-revision race self-heals the
    // next time it is actually observed -- and this must not itself fire a request for it now.
    it("(h) after a confirmed fan-out the q-less entry is marked stale, and no /api/projects request was fired for it", async () => {
      const select = await renderUnfilteredThenSearch();
      const qLessRequestsBeforeChange = apiGetMock.mock.calls.filter(([path]) => !(path as string).includes("q=")).length;
      const totalRequestsBeforeChange = apiGetMock.mock.calls.length;
      await act(async () => {
        select.value = "2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });

      expect(queryClient.getQueryState(qLessKey)?.isInvalidated).toBe(true);
      const qLessRequestsAfterChange = apiGetMock.mock.calls.filter(([path]) => !(path as string).includes("q=")).length;
      expect(qLessRequestsAfterChange).toBe(qLessRequestsBeforeChange); // no request fired for the q-less (sibling) entry
      expect(apiGetMock.mock.calls.length).toBeGreaterThan(totalRequestsBeforeChange); // the active (searched) key's own confirm-triggered refresh still fires
    });
  });
});

// #230 Sol review round 2, item 1 (HIGH). `isSiblingDashboardQuery` (Dashboard.tsx ~:1153) used to
// close over the CLICK-time `dashboardKeyString`. If the committed search changes while the POST is
// still pending, the fan-out at confirmation reaches the WRONG key: the newly ACTIVE entry (which
// nobody has patched) gets its own in-flight fetch cancelled and is marked stale with no refetch,
// while the origin entry -- now inactive -- is spared the cancel/mark-stale treatment every other
// inactive sibling gets.
describe("the sibling predicate uses the key ACTIVE at confirmation, not the key at click time (#230 Sol review round 2, item 1)", () => {
  const kProject = { id: "project-k", street: "1 K Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const qLessKey = dashboardProjectsKey("admin-1", "admin", 0, false);
  const keyA = dashboardProjectsKey("admin-1", "admin", 0, false, "alpha");
  const keyB = dashboardProjectsKey("admin-1", "admin", 0, false, "beta");

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  it("(k) load unfiltered, commit search A, click priority with the POST deferred, then commit search B while the POST and B's own fetch are both pending -- B is never cancelled/invalidated, A (now inactive) is fanned out to and marked stale", async () => {
    let resolveBeta!: (value: unknown) => void;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      if (path.includes("q=beta")) return new Promise((resolve) => { resolveBeta = resolve; });
      return Promise.resolve({ projects: [kProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [kProject.id] } } });
    });

    window.history.replaceState(null, "", "/");
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" role="admin" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(qLessKey)).toBeDefined());

    // Commit search A.
    act(() => {
      locationStore().replace("/?q=alpha");
      syncDashboardSearchDraftFromLocation("alpha", "admin-1");
    });
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(keyA)).toBeDefined());

    // Click priority while at A -- the POST is held open (a manually-settled promise, the same
    // pattern as this file's own `deferredPost()`).
    let settlePost!: (value: { priority: number; boardRevision: number }) => void;
    apiPostMock.mockReset().mockImplementation(() => new Promise((resolve) => { settlePost = resolve; }));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    // Commit search B while the POST is still pending -- B's own `/api/projects` fetch starts and is
    // held open too.
    act(() => {
      locationStore().replace("/?q=beta");
      syncDashboardSearchDraftFromLocation("beta", "admin-1");
    });
    await flush();
    expect(queryClient.getQueryState(keyB)?.fetchStatus).toBe("fetching");

    // Resolve the POST -- the fan-out runs now, with B active and A no longer active. `finally`
    // clears `pendingOrdering`, which flips `interactionBlocked` off and lets the queued-refresh
    // effect (item 2, ~:696) call `projectsQuery.refetch()` on B, the still-active key, in the same
    // settle window.
    await act(async () => {
      settlePost({ priority: 2, boardRevision: 2 });
      await flush();
    });

    // B (the newly ACTIVE key) must never have been cancelled. `Query.fetch()` returns the SAME
    // in-flight retryer promise (no new network call) when a query is refetched while it is already
    // fetching -- only a query that was cancelled back to `fetchStatus: "idle"` fetches AGAIN when
    // the queued-refresh effect's `refetch()` reaches it a tick later. So a genuinely uncancelled B
    // still shows exactly the ONE request this test itself started; a cancelled-then-reactively-
    // refetched B shows a second one.
    const betaRequestsAfterConfirm = apiGetMock.mock.calls.filter(([path]) => (path as string).includes("q=beta")).length;
    expect(betaRequestsAfterConfirm).toBe(1);
    expect(queryClient.getQueryState(keyB)?.isInvalidated).toBe(false);

    // A (the origin key, no longer active) holds the confirmed priority and is marked stale, like
    // any other inactive sibling.
    expect(queryClient.getQueryData<Array<{ id: string; priority: number | null }>>(keyA)?.find((entry) => entry.id === kProject.id)?.priority).toBe(2);
    expect(queryClient.getQueryState(keyA)?.isInvalidated).toBe(true);

    // B's own fetch, left uncancelled, completes normally with the server's real data.
    await act(async () => {
      resolveBeta({ projects: [kProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [kProject.id] } } });
      await flush();
    });
    expect(queryClient.getQueryState(keyB)?.fetchStatus).toBe("idle");
    expect(queryClient.getQueryData(keyB)).toBeDefined();
  });
});

// #230 Sol review round 2, item 2 (MEDIUM). The queued-refresh effect's own `projectsQuery.refetch()`
// (Dashboard.tsx ~:706) accepts whatever `QueryObserverResult` its `.then()` receives with no key or
// placeholder check at all. `QueryObserver#fetch()`'s own `.then()` reads `this.#currentResult`
// AFTER the underlying fetch settles -- if the committed search changed while this refetch was
// pending, that is the OBSERVER's CURRENT (possibly placeholder) result for whatever key is active
// NOW, not necessarily the key this refetch was issued for. Dashboard's own `.then()` handler is a
// stale closure bound to `acceptDashboardProjects` from the render that issued it -- accepting
// unconditionally stamps that newer result under the STALE key.
//
// Investigated (and worth recording): `@tanstack/query-core`'s `QueryObserver#removeObserver`
// cancels+reverts an abandoned query's own in-flight fetch (`#abortSignalConsumed` is true here --
// `useDashboardProjects`'s `queryFn` passes `{ signal }` to `apiGet`, which reads the getter) the
// MOMENT Dashboard's single observer switches away from it -- so in the common case (nothing else
// watching the old key), the stale refetch settles via that revert path almost immediately, with
// `isPlaceholderData: true` and the OLD key's own last-known content (tautologically correct when
// later re-observed under that same key -- `keepPreviousData` is a pure passthrough). To exercise
// the OTHER half of this bug -- a stale refetch that settles with the NEW key's own REAL, DIFFERENT
// data, per this comment's own "possibly placeholder data" wording -- this suite keeps a SECOND
// observer subscribed to key A (`KeepAliveObserver`) so `removeObserver` never sees a zero count and
// never cancels it, letting the stale refetch stay genuinely in flight until the test resolves it.
describe("the queued-refresh effect's own refetch does not bypass the key/placeholder guard (#230 Sol review round 2, item 2)", () => {
  const alphaProject = { id: "proj-alpha", street: "1 Alpha Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const betaProject = { id: "proj-beta", street: "9 Beta Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 3, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const qLessProject = { id: "proj-q", street: "0 Unfiltered Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const keyA = dashboardProjectsKey("admin-1", "admin", 0, false, "alpha");
  const keyB = dashboardProjectsKey("admin-1", "admin", 0, false, "beta");

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  function KeepAliveObserver({ queryKey }: { queryKey: readonly unknown[] }) {
    // `enabled: false` so this component's own subscription never itself issues a fetch --
    // `QueryObserver#onSubscribe` calls `addObserver` unconditionally, before checking `enabled`, so
    // merely mounting this keeps the target query's observer count above zero.
    useQuery({ queryKey: queryKey as unknown[], queryFn: () => Promise.resolve([]), enabled: false });
    return null;
  }

  it("(l) a queued refresh (issued for A, after a confirmed priority save) that settles AFTER the committed search has moved on to B, with B's own real data already in, must not stamp B's rows as accepted under A's key", async () => {
    let alphaCalls = 0;
    let resolveStaleAlphaRefetch!: (value: unknown) => void;
    let resolveBeta!: (value: unknown) => void;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      if (path.includes("q=alpha")) {
        alphaCalls += 1;
        if (alphaCalls === 1) return Promise.resolve({ projects: [alphaProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [alphaProject.id] } } });
        // The queued-refresh effect's OWN refetch (issued after the priority save clears
        // `pendingOrdering`) -- held open so the committed search can move on to B while it's
        // still pending. `KeepAliveObserver` (mounted below) keeps this from being silently
        // cancelled+reverted the moment Dashboard's own observer leaves key A for key B.
        return new Promise((resolve) => { resolveStaleAlphaRefetch = resolve; });
      }
      if (path.includes("q=beta")) return new Promise((resolve) => { resolveBeta = resolve; });
      return Promise.resolve({ projects: [qLessProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [qLessProject.id] } } });
    });
    apiPostMock.mockReset().mockResolvedValue({ priority: 2, boardRevision: 2 });

    window.history.replaceState(null, "", "/");
    await act(async () => {
      root.render(
        <ProjectQueryRuntimeProvider runtime={runtime}>
          <QueryClientProvider client={queryClient}>
            <Dashboard currentUserId="admin-1" role="admin" />
            <KeepAliveObserver queryKey={keyA} />
          </QueryClientProvider>
        </ProjectQueryRuntimeProvider>,
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull());
    await flush();

    // Commit search A.
    act(() => {
      locationStore().replace("/?q=alpha");
      syncDashboardSearchDraftFromLocation("alpha", "admin-1");
    });
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(keyA)).toBeDefined());

    // Click priority on the alpha project. The POST resolves immediately, but `pendingOrdering` is
    // still populated when `queueDashboardRefresh()` runs inside `setProjectPriority`'s `try` block,
    // so that call only sets the `queuedRefreshRef` flag -- the queued-refresh EFFECT itself issues
    // the actual `refetch()` once `finally` clears `pendingOrdering` a tick later. That refetch is
    // this test's SECOND `q=alpha` call, held open above.
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(alphaCalls).toBe(2); // the queued-refresh effect's own refetch is in flight, held open

    // Commit search B while that refetch is still pending.
    act(() => {
      locationStore().replace("/?q=beta");
      syncDashboardSearchDraftFromLocation("beta", "admin-1");
    });
    await flush();

    // Let B's own fetch resolve for real, but only drain MICROtasks here, not the macrotask hop
    // `flush()` uses. `Query#fetch()` writes the resolved data into the cache inline, off the
    // settled promise -- no `setTimeout` involved -- but react-query's scheduler notifies
    // subscribers (and so React re-renders and B's own accept effect runs) via a `setTimeout(0)`.
    // Holding that back keeps B's own (correctly-keyed) accept from running yet, so it can't
    // consume `acceptedQueryUpdatedAtRef`'s dedupe slot for B's `dataUpdatedAt` before the stale
    // alpha refetch (below) gets a chance to -- which would otherwise make `acceptDashboardProjects`
    // silently no-op the very call this test exists to catch, for a reason unrelated to the fix.
    await microflush();
    await act(async () => {
      resolveBeta({ projects: [betaProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [betaProject.id] } } });
      await Promise.resolve();
    });
    await microflush();
    expect(queryClient.getQueryData(keyB)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "proj-beta" })]));

    // NOW resolve the stale alpha refetch -- with alpha's OWN CONFIRMED content (priority 2), the
    // way a real server re-queried for alpha would answer AFTER the priority save, not the original
    // pre-mutation payload (that would regress key A's cache via this fetch's own ordinary
    // `Query#setData`, a confound unrelated to this bug). `KeepAliveObserver` has kept key A's own
    // observer count above zero this whole time, so `Query#fetch()` never went through the
    // cancel+revert path; `QueryObserver#fetch()`'s own `.then()` reads `this.#currentResult`
    // (recomputed via `updateResult()`) once this settles -- `#currentQuery` is already B's (the
    // observer's `setOptions()` already ran, synchronously, when the component re-rendered for the
    // search change above), and B's cache now holds real, non-placeholder data (just written above,
    // still un-notified) -- so this resolves with B's REAL result regardless of what this response
    // itself carries. Dashboard's own `.then()` handler here is the STALE closure bound to the
    // render that issued this refetch (still at key A). Still microtask-only: B's own accept effect
    // must not run before this does.
    const confirmedAlphaProject = { ...alphaProject, priority: 2, boardRevision: 2 };

    // Sol review round 3, item 1. Both the corrupted `.then()` above (a guard-less accept would fire
    // here) AND B's own legitimate primary accept effect resolve through plain microtask chains, not
    // react-query's `setTimeout(0)` notify scheduler: `useQuery`'s `useSyncExternalStore` re-reads a
    // FRESH cache snapshot on every render, for ANY reason, not only when its own subscribe callback
    // fires -- so the very re-render the corrupted accept's own `setAcceptedProjects` triggers already
    // observes B's real (already-cached, un-notified) data, and B's primary accept effect self-heals
    // `acceptedProjects` back to key B as a passive effect off THAT SAME render. Measured empirically
    // (hop-by-hop instrumentation, #230 round 3): the corrupted accept itself lands within ~4
    // microtask hops of resolving this promise; B's self-heal follows within ~9-10. Both happen
    // inside ONE continuous flush -- `act()` fully drains all pending work, including every
    // subsequent effect, before its own call resolves, so there is no external "pause partway
    // through" available from a SEPARATE, later `act()`/`microflush()` call: by the time any later
    // call is reached, both the corruption and its self-heal have already happened, and this test
    // would pass even with the guard above removed (this is exactly what round 3 review caught).
    //
    // The only way to observe the transient corrupted `{key:A, rows:B}` snapshot is to return to
    // search A from INSIDE this same, still-open `act()` call, timed to land after the corrupted
    // accept but before B's self-heal -- both the probe installation and the return to A happen here,
    // not in a later block.
    //
    // React-DOM's controlled `<select>` never writes `select.value` directly, on mount OR update --
    // both paths (`ReactDOMSelect`'s wrapper) set each `<option>`'s own `.selected` PROPERTY to match
    // the desired value. Instrumenting `HTMLSelectElement.prototype.value`'s setter (tried first,
    // empirically) catches nothing, ever, matching value or not -- the correct low-level hook is
    // `HTMLOptionElement.prototype.selected`'s setter, which fires on every commit that changes which
    // option is selected, regardless of whether the element itself was freshly mounted.
    const originalSelectedDescriptor = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected")!;
    const observedSelections: string[] = [];
    Object.defineProperty(HTMLOptionElement.prototype, "selected", {
      configurable: true,
      get() { return originalSelectedDescriptor.get!.call(this); },
      set(v: boolean) {
        if (v) observedSelections.push(this.value);
        originalSelectedDescriptor.set!.call(this, v);
      },
    });
    try {
      await act(async () => {
        resolveStaleAlphaRefetch({ projects: [confirmedAlphaProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [confirmedAlphaProject.id] } } });
        // 6 hops: comfortably inside the measured window (corrupted accept by ~4, B's self-heal not
        // until ~9-10) -- see the comment above for how this was calibrated and why a fixed hop count,
        // rather than a `flush()`/`microflush()` call boundary, is the only way to land inside it.
        for (let hop = 0; hop < 6; hop += 1) await Promise.resolve();
        locationStore().replace("/?q=alpha");
        syncDashboardSearchDraftFromLocation("alpha", "admin-1");
      });
    } finally {
      Object.defineProperty(HTMLOptionElement.prototype, "selected", originalSelectedDescriptor);
    }

    // Beta's priority (3) must never have been selected while displaying the alpha search, even
    // fleetingly, on any commit before the self-heal lands. A positive check too, not only a
    // negative one: the probe must have observed the legitimate "2" selection somewhere in this same
    // window -- otherwise a future change to how React writes controlled <select> selections could
    // make the "never '3'" assertion pass vacuously, by the probe observing nothing at all.
    expect(observedSelections).toContain("2");
    expect(observedSelections).not.toContain("3");

    // Let anything still outstanding (a macrotask-scheduled react-query notification, if any) settle
    // before the final read.
    await flush();

    // The mocked Board only ever renders `projects[0]`'s priority; Beta's is 3, Alpha's own
    // (confirmed) priority is 2 -- the settled state, after any self-heal, must land on Alpha's own.
    const alphaSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]');
    expect(alphaSelect?.value).toBe("2");
  });
});

// #230 Sol review round 2, item 3 (MEDIUM). `acceptedQueryUpdatedAtRef` (Dashboard.tsx ~:382)
// dedupes `acceptDashboardProjects` calls by `dataUpdatedAt` ALONE, a bare millisecond timestamp.
// Two different keys' results can carry the identical millisecond (system clock resolution, or two
// fetches racing to resolve in the same tick) -- a genuinely new key's own first-ever result is then
// silently deduped away, and `acceptedProjects` never picks up that key at all.
describe("acceptedQueryUpdatedAtRef dedupes by key AND updatedAt, not updatedAt alone (#230 Sol review round 2, item 3)", () => {
  const alphaProject = { id: "proj-alpha", street: "1 Alpha Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const betaProject = { id: "proj-beta", street: "9 Beta Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 3, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const qLessProject = { id: "proj-q", street: "0 Unfiltered Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: 1, boardPosition: 0, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null };
  const keyB = dashboardProjectsKey("admin-1", "admin", 0, false, "beta");

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    vi.restoreAllMocks();
  });

  it("(m) key A's accept and key B's first-ever accept resolve with the identical millisecond dataUpdatedAt -- B's rows are still accepted, surviving a later cache eviction + failed refetch the way an accepted key always does", async () => {
    // A direct `Date.now` spy, not `vi.useFakeTimers`/`setSystemTime` -- those set an OFFSET from
    // the real clock, not an absolute freeze, and this test's own `await`s and `vi.waitFor` polling
    // below take enough real wall-clock time (tens of ms, observed) to drift two re-pinned
    // `setSystemTime` calls apart by the time each fetch's `Query#dispatch` actually reads it. A
    // direct spy is the one way to GUARANTEE the collision this test exists to exercise, rather than
    // race for it. `Query#dispatch`'s own `dataUpdatedAt: dataUpdatedAt ?? Date.now()` is the exact
    // call this pins -- `flush()`/`microflush()`'s real `setTimeout` is untouched.
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    let betaCalls = 0;
    let rejectSecondBeta!: (reason: unknown) => void;
    apiGetMock.mockReset().mockImplementation((path: string) => {
      if (path.includes("q=alpha")) return Promise.resolve({ projects: [alphaProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [alphaProject.id] } } });
      if (path.includes("q=beta")) {
        betaCalls += 1;
        if (betaCalls === 1) return Promise.resolve({ projects: [betaProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [betaProject.id] } } });
        // The forced re-fetch below, after key B's cache entry is evicted -- rejecting it is what
        // makes `queryProjects` (not just the accepted snapshot) go empty for B, the same mechanism
        // test (i) uses: a key with no accepted snapshot AND no cached data of its own shows the
        // error state, not stale rows.
        return new Promise((_resolve, reject) => { rejectSecondBeta = reject; });
      }
      return Promise.resolve({ projects: [qLessProject], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [qLessProject.id] } } });
    });

    window.history.replaceState(null, "", "/");
    await act(async () => {
      root.render(
        <ProjectQueryRuntimeProvider runtime={runtime}>
          <QueryClientProvider client={queryClient}>
            <Dashboard currentUserId="admin-1" role="admin" />
          </QueryClientProvider>
        </ProjectQueryRuntimeProvider>,
      );
      await Promise.resolve();
    });
    await flush();

    // Commit search A -- its accept stamps `acceptedQueryUpdatedAtRef.current` with this frozen
    // millisecond (buggy: a bare number; fixed: `{ key: A, updatedAt: <the millisecond> }`).
    act(() => {
      locationStore().replace("/?q=alpha");
      syncDashboardSearchDraftFromLocation("alpha", "admin-1");
    });
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(dashboardProjectsKey("admin-1", "admin", 0, false, "alpha"))).toBeDefined());

    // Commit search B -- a BRAND NEW key, never fetched before. Its first-ever fetch ALSO resolves
    // at the identical frozen millisecond. Buggy: `acceptedQueryUpdatedAtRef.current` already equals
    // that millisecond (from A, above) -- `acceptDashboardProjects` dedupes this call away and
    // `acceptedProjects` never becomes key B's. Fixed: different key, same millisecond -- accepted.
    act(() => {
      locationStore().replace("/?q=beta");
      syncDashboardSearchDraftFromLocation("beta", "admin-1");
    });
    await flush();
    await vi.waitFor(() => expect(queryClient.getQueryData(keyB)).toBeDefined());
    expect(betaCalls).toBe(1);

    // Evict key B's cache entry entirely (a legitimate, public `queryClient` operation -- the same
    // thing a `gcTime` expiry does in production) and force a fresh fetch for it. With no cached
    // data of its own left, `queryProjects` for B goes back to `undefined` until this fetch settles
    // -- exactly test (i)'s "first-ever fetch, still pending" shape, engineered deliberately rather
    // than waited for, so the failure this test provokes is B's OWN accepted-snapshot resilience,
    // not a fresh race.
    await act(async () => {
      // Not awaited -- `resetQueries()`'s own promise resolves only once the refetch it triggers
      // SETTLES, and this test holds that refetch open deliberately (below).
      void queryClient.resetQueries({ queryKey: keyB, exact: true });
      await flush();
    });
    expect(betaCalls).toBe(2);

    // A 400 `ApiError`, not a bare `Error` -- `projectQueryRetry` (`lib/project-data.ts`) retries any
    // non-`ApiError`/non-4xx failure up to twice with a real backoff delay this test's short,
    // fake-Date-only `flush()` never reaches; a 4xx `ApiError` outside 408/429 is the one class
    // `projectQueryRetry` never retries, so the query settles to `status: "error"` deterministically.
    await act(async () => {
      rejectSecondBeta(new ApiError("Offline", 400));
      await flush();
    });

    // Fixed: B was accepted above, so its accepted snapshot survives this cache eviction + failed
    // refetch the same way #232 documents Dashboard rendering an accepted snapshot, not the cache --
    // Beta's own (accepted) row still renders, no error. Buggy: B was NEVER accepted (deduped away
    // by the colliding millisecond), so once its own cache is ALSO gone, nothing is left to fall
    // back on -- the error state shows instead, exactly as an un-accepted, data-less key does in
    // test (i).
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const betaSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Priority"]');
    expect(betaSelect?.value).toBe("3");
  });
});
