import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { clearPrincipalProjectData, projectDataKeys, purgeProjectCollaborationData } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { SubtaskChecklist } from "./SubtaskChecklist";

const apiGetMock = vi.hoisted(() => vi.fn());
// Without this the real better-auth client polls /api/auth/get-session over the network (#167).
// `data: null` is what these tests already ran against — the real session never resolved — so the
// capability-derived branches keep the coverage they had. A test needing a role sets one here.
const session = vi.hoisted(() => ({ role: null as string | null }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: session.role ? { user: { role: session.role } } : null, isPending: false }) }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

const projectId = "11111111-1111-4111-8111-111111111111";
const task = { id: "task-1", title: "Prepare delivery", done: false, position: 1024, assignee: null, assignees: [], assignmentVersion: 0, dueDate: null, createdBy: "u1", createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
let runtime: ProjectQueryRuntime | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); }); }

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host?.remove(); host = null; runtime?.dispose(); runtime = null; queryClient?.clear(); queryClient = null; apiGetMock.mockReset(); session.role = null;
});

describe("SubtaskChecklist access-generation boundary", () => {
  it.each([401, 403, 404] as const)("ignores a late assignee-options response after a %s access loss", async (status) => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient, `checklist-${status}`);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { private: "detail" });
    type Options = { candidates: Array<{ id: string; name: string; role: string }>; multiAssignee: boolean };
    let resolveOptions!: (value: Options) => void;
    apiGetMock.mockImplementation((path: string) => path.includes("subtask-assignee-options")
      ? new Promise<Options>((resolve) => { resolveOptions = resolve; })
      : Promise.resolve({ subtasks: [task] }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime!}><QueryClientProvider client={queryClient!}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("Prepare delivery");
    // The people load only once the picker opens.
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Assignees for Prepare delivery"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); await Promise.resolve(); }); await flush();
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtask-assignee-options`);
    if (status === 401) await clearPrincipalProjectData(queryClient);
    else await purgeProjectCollaborationData(queryClient, projectId);
    resolveOptions({ candidates: [{ id: "late-user", name: "Late private user", role: "editor" }], multiAssignee: true });
    await flush();
    expect(document.body.textContent).not.toContain("Late private user");
    expect(queryClient.getQueryData(projectDataKeys.subtaskAssigneeOptions(projectId))).toBeUndefined();
    if (status === 401) expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toBeUndefined();
    else expect(queryClient.getQueryData(projectDataKeys.detail(projectId))).toEqual({ private: "detail" });
  });

  it.each([401, 403, 404] as const)("ignores a late checklist response after a %s access loss", async (status) => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient, `checklist-body-${status}`);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { private: "detail" });
    let resolveChecklist!: (value: { subtasks: typeof task[] }) => void;
    apiGetMock.mockImplementation((path: string) => path.includes("subtask-assignee-options")
      ? Promise.resolve({ candidates: [], multiAssignee: false })
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

  it("an External Editor sees the named team assignee and only a count of the rest, with no hidden text anywhere", async () => {
    session.role = "external_editor";
    const person = { id: "22222222-2222-4222-8222-222222222222", name: "Ada Smith", roleLabel: "Photographer", isExternal: false, active: true };
    const endpoint = { kind: "date" as const, localCivil: "2026-09-01", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const };
    const external = {
      id: "33333333-3333-4333-8333-333333333333", title: "Prepare delivery", done: false, position: 1024, assignee: person, assignees: [person], otherAssigneeCount: 2, assignmentVersion: 3, dueDate: null,
      schedule: { state: "range" as const, version: 1, zone: "Australia/Sydney" as const, start: endpoint, end: endpoint, due: "2026-09-01" },
      createdBy: person, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
    };
    apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("subtask-assignee-options") ? { candidates: [person], multiAssignee: false } : { subtasks: [external] }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); }); await flush();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Assignees for Prepare delivery"]')!;
    expect([...trigger.querySelectorAll('[role="img"]')].map((element) => element.getAttribute("aria-label"))).toEqual(["Ada Smith", "2 others not shown"]);
    expect(trigger.textContent).toContain("+2 others");
    expect(trigger.textContent).toContain("AS");
    // Nothing else about the two hidden people can be in the page: only a count reached the client.
    expect(host.textContent).not.toMatch(/hidden/i);
    expect([...host.querySelectorAll("[title]")].map((element) => element.getAttribute("title"))).not.toContain("+2 others");
  });
});
