import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { projectDataKeys, type ProjectMember } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import "../styles/index.css";
import { ProjectTeamControl } from "./ProjectTeamControl";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPutWithStatus: (path: string) => apiPutMock(path), apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const photographer = { id: "22222222-2222-4222-8222-222222222222", name: "Ari Photographer", email: "ari@example.test", globalRole: "photographer" as const, active: true as const };
const editor = { id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", email: "eli@example.test", globalRole: "editor" as const, active: true as const };
const members = [{ id: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", roleOnProject: "editor" as const, name: "Inactive Editor", email: "inactive@example.test", globalRole: "editor" as const, active: false, assignedSubtaskCount: 2 }];

let root: Root | null = null;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(rounds = 1) {
  await act(async () => { for (let index = 0; index < rounds; index += 1) { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); } });
}

// `AnchoredPopover` delays its own unmount by 120ms (`--dur-fast`) after `open` goes false, so
// it can animate closed (§7.2) — a closed popover is still in the DOM until that transition
// completes.
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

async function mount(currentMembers: ProjectMember[] = members) {
  const host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><ProjectTeamControl projectId={projectId} members={currentMembers} canEdit /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
  await flush();
  return host;
}

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ photographers: [photographer], editors: [editor] });
  apiPutMock.mockReset().mockResolvedValue({ status: 201, data: { outcome: "created", membership: { ...members[0], id: "66666666-6666-4666-8666-666666666666", userId: photographer.id, roleOnProject: "photographer", name: photographer.name, email: photographer.email, globalRole: photographer.globalRole, active: true, assignedSubtaskCount: 0 } } });
  apiDeleteMock.mockReset().mockResolvedValue({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
  confirmMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; runtime.dispose(); queryClient.clear(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectTeamControl", () => {
  it("keeps the role picker and search draft open after selecting a candidate", async () => {
    const host = await mount([]);
    const publish = vi.spyOn(runtime, "publish");
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!;
    await act(async () => { trigger.click(); await Promise.resolve(); });
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(search, "ari"); search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "ari" })); await Promise.resolve(); });
    expect(search.value).toBe("ari");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Ari Photographer");
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="option"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[role="dialog"][aria-label^="Add "]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("ari");
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${photographer.id}`);
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
  });

  // The responsive fixed bottom-sheet treatment is covered by the plan's manual QA matrix (items 1–2, picker-phone-bottom-sheet.png).
  it("keeps the role picker dialog accessible and returns focus on close", async () => {
    apiGetMock.mockResolvedValue({ photographers: [photographer, { ...photographer, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Bea Photographer" }], editors: [editor] });
    const host = await mount([]);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!;
    trigger.focus();
    await act(async () => { trigger.click(); await Promise.resolve(); });
    await flush(2);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const listbox = dialog.querySelector<HTMLElement>('[role="listbox"]')!;
    const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Add Photographer");
    expect(listbox.getAttribute("aria-label")).toBe("Photographer candidates");
    expect(document.activeElement).toBe(search);

    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await Promise.resolve(); });
    expect(dialog.querySelectorAll<HTMLElement>('[role="option"]')[1]?.getAttribute("aria-current")).toBe("true");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitForClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("disables only the pending cell while another role remains actionable", async () => {
    let resolvePut!: (value: unknown) => void;
    apiPutMock.mockReturnValueOnce(new Promise((resolve) => { resolvePut = resolve; }));
    const host = await mount([]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!.click(); await Promise.resolve(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="option"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Add Editor"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true);
    resolvePut({ status: 201, data: { outcome: "created", membership: { ...members[0], id: "77777777-7777-4777-8777-777777777777", userId: photographer.id, roleOnProject: "photographer", name: photographer.name, email: photographer.email, globalRole: photographer.globalRole, active: true, assignedSubtaskCount: 0 } } });
    await flush();
  });

  it("probes final-role removal before opening the real confirmation with the server count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 })).mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    const unknown = { ...members[0]! } as unknown as ProjectMember;
    delete (unknown as Partial<ProjectMember>).assignedSubtaskCount;
    const host = await mount([unknown]);
    const publish = vi.spyOn(runtime, "publish");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Remove and unassign", message: expect.stringContaining("2 checklist items") }));
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(apiDeleteMock.mock.calls[1]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 });
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }, { kind: "subtasks" }]))).toBe(true);
  });

  it("shows a generic error and stops when the confirmation response omits its assignment count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("malformed confirmation response", 422, { code: "subtask_assignment_confirmation_required" }));
    const host = await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Assignment could not be removed.");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
  });

  it("requires fresh confirmation when the assignment count changes between retries", async () => {
    const unknown = { ...members[0]! } as unknown as ProjectMember;
    delete (unknown as Partial<ProjectMember>).assignedSubtaskCount;
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockRejectedValueOnce(new ApiError("changed", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 3 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: unknown.id, userId: unknown.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 3 });
    const host = await mount([unknown]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(6);
    expect(confirmMock.mock.calls.map(([options]) => (options as { message: string }).message)).toEqual([
      expect.stringContaining("2 checklist items"),
      expect.stringContaining("3 checklist items"),
    ]);
    expect(apiDeleteMock.mock.calls.map(([, body]) => body)).toEqual([
      { membershipCycle: unknown.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 },
      { membershipCycle: unknown.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 },
      { membershipCycle: unknown.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 3 },
    ]);
  });

  it("always probes before confirming, even with a cached known count", async () => {
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    const host = await mount(members);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(3);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(apiDeleteMock.mock.calls[1]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 });
  });

  it("merges a DELETE 409 membership into only its cell, refetches, and leaves the picker open", async () => {
    const other = { ...members[0]!, id: "88888888-8888-4888-8888-888888888888", userId: editor.id, name: editor.name, email: editor.email, globalRole: editor.globalRole, roleOnProject: "photographer" as const, assignedSubtaskCount: 0 } as ProjectMember;
    const current = { ...members[0]!, id: "99999999-9999-4999-8999-999999999999", name: "Current Editor", email: "current@example.test" } as ProjectMember;
    apiDeleteMock.mockRejectedValueOnce(new ApiError("stale", 409, { code: "membership_cycle_changed", currentMembership: current }));
    const host = await mount([members[0]!, other]);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { id: projectId, street: "Test", suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [members[0]!, other] });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!.click(); await Promise.resolve(); });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const editorRow = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    await act(async () => { editorRow.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    const detail = queryClient.getQueryData<{ members: Array<{ id: string; userId: string; roleOnProject: string }> }>(projectDataKeys.detail(projectId));
    expect(detail?.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: current.id, userId: current.userId, roleOnProject: "editor" }), expect.objectContaining({ id: other.id, userId: other.userId, roleOnProject: "photographer" })]));
    expect(detail?.members).toHaveLength(2);
    expect(document.querySelector('[role="dialog"][aria-label^="Add "]')).not.toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId), exact: true }));
  });

  it("rolls back only the failed cell and keeps an ordinary failure local", async () => {
    const other = { ...members[0]!, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: editor.id, name: editor.name, email: editor.email, globalRole: editor.globalRole, roleOnProject: "photographer" as const, assignedSubtaskCount: 0 } as ProjectMember;
    const detail = { id: projectId, street: "Test", suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review" as const, rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [members[0]!, other] };
    apiDeleteMock.mockRejectedValueOnce(new Error("No network"));
    const host = await mount([members[0]!, other]);
    queryClient.setQueryData(projectDataKeys.detail(projectId), detail);
    const editorRow = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    await act(async () => { editorRow.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(queryClient.getQueryData<typeof detail>(projectDataKeys.detail(projectId))?.members).toEqual(expect.arrayContaining([members[0], other]));
    expect(editorRow.textContent).toContain("No network");
    expect(host.querySelector(`[data-testid="project-member-photographer:${other.userId}"]`)).not.toBeNull();
  });

  it("shows inactive roster members truthfully and never offers them as new candidates", async () => {
    const host = await mount(members);
    expect(host.querySelector(`[data-testid="project-member-editor:${members[0]!.userId}"]`)?.textContent).toContain("Inactive");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')?.disabled).toBe(false);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add Editor"]')!.click(); await Promise.resolve(); });
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).not.toContain(expect.stringContaining("Inactive Editor"));
  });

  it("returns focus from the narrow role picker to its trigger on Escape", async () => {
    const host = await mount([]);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!;
    await act(async () => { trigger.click(); await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
    const search = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label^="Add "] input[type="search"]')!;
    expect(document.activeElement).toBe(search);
    await act(async () => { document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Add "]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    await waitForClose();
    expect(document.querySelector('[role="dialog"][aria-label^="Add "]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("disables and marks the search field invalid when the candidates query errors", async () => {
    // A plain `Error` retries twice with exponential backoff (`projectQueryRetry`) before
    // `isError` settles — a 4xx `ApiError` (not 408/429) fails fast with no retry.
    apiGetMock.mockReset().mockRejectedValue(new ApiError("Candidates unavailable", 400));
    const host = await mount([]);
    await flush(4);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Add Photographer"]')!.click(); await Promise.resolve(); });
    const search = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label^="Add "] input[type="search"]')!;
    expect(search.disabled).toBe(true);
    expect(search.getAttribute("aria-invalid")).toBe("true");
  });
});
