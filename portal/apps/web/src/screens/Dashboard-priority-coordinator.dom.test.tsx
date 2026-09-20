import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";
import { locationStore } from "../lib/router";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ can: (capability: string) => capability === "prioritizeProjects" || capability === "adminBackend" }) }));
vi.mock("../lib/stages", () => ({ useStages: () => ({ stages: [{ key: "awaiting_raw", label: "Awaiting RAW", active: true }], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({
  ProjectKanbanBoard2: ({ projects, onPriorityChange }: { projects: Array<{ id: string; priority: number | null }>; onPriorityChange: (project: { id: string; priority: number | null }, priority: number | null) => void }) => <select aria-label="Priority" value={projects[0]?.priority ?? ""} onChange={(event) => onPriorityChange(projects[0]!, Number(event.target.value))}><option value="1">1</option><option value="2">2</option></select>,
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
