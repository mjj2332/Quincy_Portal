import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

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
