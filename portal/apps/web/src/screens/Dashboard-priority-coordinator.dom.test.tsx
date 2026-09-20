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
});
