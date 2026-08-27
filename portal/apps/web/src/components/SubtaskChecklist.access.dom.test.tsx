import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { clearPrincipalProjectData, projectDataKeys, purgeProjectCollaborationData } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { SubtaskChecklist } from "./SubtaskChecklist";

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

const projectId = "11111111-1111-4111-8111-111111111111";
const task = { id: "task-1", title: "Prepare delivery", done: false, position: 1024, assignee: null, assignmentVersion: 0, dueDate: null, createdBy: "u1", createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
let runtime: ProjectQueryRuntime | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); }); }

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host?.remove(); host = null; runtime?.dispose(); runtime = null; queryClient?.clear(); queryClient = null; apiGetMock.mockReset();
});

describe("SubtaskChecklist access-generation boundary", () => {
  it.each([401, 403, 404] as const)("ignores a late assignee response after a %s access loss", async (status) => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient, `checklist-${status}`);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { private: "detail" });
    let resolveUsers!: (value: { users: Array<{ id: string; name: string; role: "editor" }> }) => void;
    apiGetMock.mockImplementation((path: string) => path.includes("mentionable-users")
      ? new Promise<{ users: Array<{ id: string; name: string; role: "editor" }> }>((resolve) => { resolveUsers = resolve; })
      : Promise.resolve({ subtasks: [task] }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime!}><QueryClientProvider client={queryClient!}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("Prepare delivery");
    if (status === 401) await clearPrincipalProjectData(queryClient);
    else await purgeProjectCollaborationData(queryClient, projectId);
    resolveUsers({ users: [{ id: "late-user", name: "Late private user", role: "editor" }] });
    await flush();
    expect(host.textContent).not.toContain("Late private user");
    if (status === 401) expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toBeUndefined();
    else expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toEqual({ private: "detail" });
  });

  it.each([401, 403, 404] as const)("ignores a late checklist response after a %s access loss", async (status) => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient, `checklist-body-${status}`);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { private: "detail" });
    let resolveChecklist!: (value: { subtasks: typeof task[] }) => void;
    apiGetMock.mockImplementation((path: string) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [] })
      : new Promise<{ subtasks: typeof task[] }>((resolve) => { resolveChecklist = resolve; }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime!}><QueryClientProvider client={queryClient!}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); }); await flush();
    if (status === 401) await clearPrincipalProjectData(queryClient);
    else await purgeProjectCollaborationData(queryClient, projectId);
    resolveChecklist({ subtasks: [task] });
    await flush();
    expect(host.textContent).not.toContain("Prepare delivery");
    if (status === 401) expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toBeUndefined();
    else expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toEqual({ private: "detail" });
  });
});
