import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, defaultScheduler, focusManager, notifyManager, onlineManager, useQueryClient } from "@tanstack/react-query";
import { ProjectWorkspace } from "../screens/ProjectWorkspace";
import { ApiError } from "./api";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "./project-query-sync";
import { projectDataKeys, useProjectCollaborationSummaryQuery, type ProjectCollaborationSummary } from "./project-data";
import { createQuincyQueryClient, QuincyQueryProvider } from "./query-client";

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiGet: apiGetMock }));
vi.mock("./auth", () => ({ useSession: () => ({ data: { user: { id: "u1", role: "editor" } }, isPending: false }) }));

const summary: ProjectCollaborationSummary = {
  project: { id: "p", street: "Private Lane", stageKey: "raw_review" },
  members: [{ id: "m1", userId: "u1", roleOnProject: "editor", name: "Editor", active: true }],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
let workspaceQueryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
let runtime: ProjectQueryRuntime | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: React.ReactNode) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

async function flush(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

function SummaryProbe() {
  const query = useProjectCollaborationSummaryQuery("p", true);
  return <span data-status={query.status} data-street={query.data?.project.street ?? "none"} />;
}

function WorkspaceClientCapture() {
  workspaceQueryClient = useQueryClient();
  return null;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host?.remove(); host = null;
  runtime?.dispose(); runtime = null;
  queryClient?.clear(); queryClient = null;
  workspaceQueryClient = null;
  apiGetMock.mockReset();
  focusManager.setFocused(true); onlineManager.setOnline(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
});

describe("collaboration-summary polling boundary", () => {
  it("polls every 30 seconds while visible, pauses when hidden, and refetches on focus and reconnect", async () => {
    vi.useFakeTimers(); focusManager.setFocused(true); onlineManager.setOnline(true);
    queryClient = createQuincyQueryClient(); runtime = new ProjectQueryRuntime(queryClient, "summary-polling-tab");
    apiGetMock.mockResolvedValue(summary);
    await render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SummaryProbe /></QueryClientProvider></ProjectQueryRuntimeProvider>);
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    focusManager.setFocused(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    apiGetMock.mockClear(); focusManager.setFocused(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    apiGetMock.mockClear();
    await queryClient.invalidateQueries({ queryKey: projectDataKeys.collaborationSummary("p"), exact: true, refetchType: "none" });
    onlineManager.setOnline(false); await act(async () => { await Promise.resolve(); });
    onlineManager.setOnline(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("automatically purges collaboration data when ProjectWorkspace polling loses access", async () => {
    vi.useFakeTimers(); notifyManager.setScheduler((callback) => callback()); focusManager.setFocused(true); onlineManager.setOnline(true);
    const project = { id: "p", street: "Private Lane", suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [{ id: "raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 0 }], members: [], deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false } };
    let summaryCalls = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p") return Promise.resolve(project);
      if (path.includes("/collaboration-summary")) { summaryCalls += 1; return summaryCalls === 1 ? Promise.resolve(summary) : Promise.reject(new ApiError("No longer assigned", 403)); }
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p", street: "Private Lane" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p", marker: null, latest: null, unreadCount: 0 });
      if (path.endsWith("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 0, mismatch: false });
      return Promise.resolve({ photographers: [], editors: [] });
    });
    await render(<QuincyQueryProvider principalId="u1" role="editor"><ProjectWorkspace projectId="p" /><WorkspaceClientCapture /></QuincyQueryProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(workspaceQueryClient?.getQueryData(projectDataKeys.collaborationSummary("p"))).toEqual(summary);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await vi.advanceTimersByTimeAsync(0); for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
    expect(summaryCalls).toBe(2);
    expect(workspaceQueryClient?.getQueryData(projectDataKeys.collaborationSummary("p"))).toBeUndefined();
    expect(host?.textContent).toContain("Collaboration unavailable.");
  });
});
