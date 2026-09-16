import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { scheduleReorderFocus, SubtaskChecklist } from "./SubtaskChecklist";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { projectDataKeys } from "../lib/project-data";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const floating = vi.hoisted(() => ({ modalValues: [] as Array<boolean | undefined> }));
// Without this the real better-auth client polls /api/auth/get-session over the network (#167).
// `data: null` is what these tests already ran against — the real session never resolved — so the
// capability-derived branches keep the coverage they had. A test needing a role sets one here.
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("@floating-ui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/react")>();
  return {
    ...actual,
    FloatingFocusManager: (props: Parameters<typeof actual.FloatingFocusManager>[0]) => {
      floating.modalValues.push(props.modal);
      return createElement(actual.FloatingFocusManager, props);
    },
  };
});

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => { const actual = await importOriginal<typeof import("../lib/api")>(); return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) }; });

const projectId = "11111111-1111-4111-8111-111111111111";
const year = new Date().getFullYear();
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignee: { id: "user-2", name: "Nora Jones" }, assignmentVersion: 0, dueDate: `${year}-05-30`, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const second = { ...task, id: "task-2", title: "Prepare files", position: 2048, assignee: null, dueDate: null };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function keydown(element: Element, key: string) { await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }
function item(host: HTMLElement, title: string) { const result = [...host.querySelectorAll<HTMLElement>("article")].find((element) => element.textContent?.includes(title)); if (!result) throw new Error(`No item ${title}`); return result; }
function portal(id: string) { return document.getElementById(id)!; }
// TB8-07 slice 4b retired the `.button` class from the Save control (now `buttonClasses`
// Tailwind utilities) — find it by accessible name instead of a CSS class.
function saveButton(scope: Element) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!; }

beforeEach(() => { floating.modalValues.length = 0; apiGetMock.mockReset().mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-2", name: "Nora Jones", role: "editor" }, { id: "user-3", name: "Ada Smith", role: "photographer" }] }) : Promise.resolve({ subtasks: [task, second] })); apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-new", title: "Schedule staging", position: 3072 }); apiPatchMock.mockReset().mockImplementation((path, body) => { const base = path.includes("task-2") ? second : task; return Promise.resolve({ ...base, ...("schedule" in (body as object) ? {} : body as object) }); }); apiDeleteMock.mockReset().mockResolvedValue({ ok: true }); confirmMock.mockReset().mockResolvedValue(true); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist", () => {
  it("preserves accordion/progress, literal schedule badges, and compact title edit/Escape behavior", async () => {
    const host = mount(); await render(); const toggle = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes("Checklist"))!;
    expect(toggle.textContent).toContain("0 of 2 complete · 0%"); expect(toggle.querySelector("progress")?.max).toBe(2); expect(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')?.textContent).toContain("Due 30 May");
    expect(host.querySelector("select")).toBeNull(); expect([...host.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Move "))).toBe(false);
    const title = item(host, "Call client").querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!; await click(title); const input = item(host, "Call client").querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; await typeInto(input, "Discarded"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true); expect(apiPatchMock).not.toHaveBeenCalled(); const reopened = item(host, "Call client").querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!; reopened.focus(); await keydown(reopened, " "); const saveInput = item(host, "Call client").querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; await typeInto(saveInput, "Saved title"); await keydown(saveInput, "Enter"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { title: "Saved title" });
  });

  it("keeps the checklist popover non-modal by default", async () => {
    const host = mount(); await render();
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    expect(floating.modalValues.at(-1)).toBe(false);
  });

  it("patches a saved schedule locally and flushes its deferred invalidation once", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-schedule-owner-test");
    const subtasksKey = projectDataKeys.subtasks(projectId);
    const updated = {
      ...task,
      schedule: { state: "due_only" as const, version: 1, zone: "Australia/Sydney" as const, start: null, end: { kind: "date" as const, localCivil: `${year}-06-15`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: `${year}-06-15` },
    };
    queryClient.setQueryData(subtasksKey, [task, second]);
    let patchSettled = false;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({ subtasks: patchSettled ? [updated, second] : [task, second] });
    });
    let resolvePatch!: (value: unknown) => void;
    apiPatchMock.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const publish = vi.spyOn(runtime, "publish");
    const originalRequestInvalidation = runtime.requestInvalidation.bind(runtime);
    const requestInvalidation = vi.spyOn(runtime, "requestInvalidation");
    const requestOwnership: boolean[] = [];
    requestInvalidation.mockImplementation((queryKey) => {
      if (JSON.stringify(queryKey) === JSON.stringify(subtasksKey)) requestOwnership.push(runtime.isOwned(subtasksKey));
      return originalRequestInvalidation(queryKey);
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });

    const schedule = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!;
    await click(schedule);
    expect(runtime.isOwned(subtasksKey)).toBe(true);
    await click(saveButton(portal("subtask-popover-task-1-schedule")));
    await flush();

    expect(runtime.isOwned(subtasksKey)).toBe(true);
    expect(requestOwnership).toEqual([]);
    expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(subtasksKey))).toHaveLength(0);
    patchSettled = true;
    resolvePatch(updated);
    await flush();
    expect(apiPatchMock).toHaveBeenCalled();
    expect(queryClient.getQueryData<typeof updated[]>(subtasksKey)?.find((entry) => entry.id === task.id)).toMatchObject({ schedule: { due: `${year}-06-15` } });
    expect(requestOwnership).toEqual([true]);
    expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(subtasksKey))).toHaveLength(1);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(false);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
    expect(runtime.isOwned(subtasksKey)).toBe(false);
    runtime.dispose(); queryClient.clear();
  });

  it("edits exact-minute schedule state and clears explicitly, while retaining the assignee popover", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); const schedule = first.querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!; const assignee = first.querySelector<HTMLButtonElement>('[aria-label="Assignee for Call client"]')!;
    await click(schedule); const group = portal("subtask-popover-task-1-schedule"); expect(group).not.toBeNull(); const state = group.querySelector<HTMLSelectElement>("select")!; expect(group.querySelectorAll("select")).toHaveLength(2); state.value = "due_only"; state.dispatchEvent(new Event("change", { bubbles: true })); await click(saveButton(group));
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "date", localCivil: `${year}-05-30` } } } });
    await click(schedule); const editor = portal("subtask-popover-task-1-schedule"); const kind = editor.querySelectorAll<HTMLSelectElement>("select")[1]!; kind.value = "timed"; kind.dispatchEvent(new Event("change", { bubbles: true })); const date = editor.querySelector<HTMLInputElement>('input[type="date"]')!; const time = editor.querySelector<HTMLInputElement>('input[type="time"]')!; expect(time.step).toBe("60"); await typeInto(date, `${year}-06-01`); await typeInto(time, "09:30"); await click(saveButton(editor));
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "timed", localCivil: `${year}-06-01T09:30` } } } });
    await click(schedule); const clear = portal("subtask-popover-task-1-schedule"); const clearState = clear.querySelector<HTMLSelectElement>("select")!; clearState.value = "unscheduled"; clearState.dispatchEvent(new Event("change", { bubbles: true })); await click(saveButton(clear)); expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 0, schedule: { state: "unscheduled" } } });
    await click(assignee); expect(portal("subtask-popover-task-1-assignee")).not.toBeNull(); const search = portal("subtask-popover-task-1-assignee").querySelector<HTMLInputElement>('input[type="search"]')!; await typeInto(search, "Ada"); expect(portal("subtask-popover-task-1-assignee").textContent).toContain("Ada Smith"); await click([...portal("subtask-popover-task-1-assignee").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Ada Smith"))!); expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assigneeId: "user-3" });
  });

  it("keeps one Delete-only popover and restores deletion focus", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); const actions = first.querySelector<HTMLButtonElement>('[aria-label="Actions for Call client"]')!; await click(actions); const group = portal("subtask-popover-task-1-actions"); expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Delete"]);
    confirmMock.mockResolvedValueOnce(false); await click(group.querySelector("button")!); expect(apiDeleteMock).not.toHaveBeenCalled(); expect(portal("subtask-popover-task-1-actions")).not.toBeNull(); await click(group.querySelector("button")!); await flush(); expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`); expect(document.activeElement).toBe(item(host, "Prepare files").querySelector('[data-testid="subtask-checklist-title"]'));
  });

  it("removes a deleted item from the exact cache and broadcasts the committed resource", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-delete-test");
    const publish = vi.spyOn(runtime, "publish");
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [task, second]);
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
    let deleted = false;
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [] }) : Promise.resolve({ subtasks: deleted ? [second] : [task, second] }));
    apiDeleteMock.mockImplementation(async () => { deleted = true; return { ok: true }; });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Actions for Call client"]')!);
    await click(portal("subtask-popover-task-1-actions").querySelector("button")!);
    await flush();
    expect(queryClient.getQueryData<typeof task[]>(projectDataKeys.subtasks(projectId))?.map((entry) => entry.id)).toEqual(["task-2"]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }] }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "production-calendar-invalidated" }));
    runtime.dispose(); queryClient.clear();
  });

  it("shows the full authoritative item on an item conflict with explicit discard and reapply choices", async () => {
    const host = mount(); await render();
    const latest = { ...task, title: "Authoritative title", done: true, assignee: { id: "user-3", name: "Ada Smith" }, schedule: { state: "due_only", version: 2, zone: "Australia/Sydney", start: null, end: { kind: "date", localCivil: `${year}-06-10`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: `${year}-06-10` } };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Checklist item changed", 409, { code: "subtask_item_conflict", current: latest.schedule, currentSubtask: latest }));
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    const draft = portal("subtask-popover-task-1-schedule"); await typeInto(draft.querySelector<HTMLInputElement>('input[type="date"]')!, `${year}-06-20`); await click(saveButton(draft));
    await flush();
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    const conflict = portal("subtask-popover-task-1-schedule");
    expect(conflict.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe(`${year}-06-20`); expect(conflict.textContent).toContain("Authoritative title"); expect(conflict.textContent).toContain("Complete"); expect(conflict.textContent).toContain("Ada Smith"); expect(conflict.textContent).toContain("Use latest item (discard draft)"); expect(conflict.textContent).toContain("Save reapplies your retained schedule draft; Cancel discards it.");
    await click([...conflict.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use latest item (discard draft)")!); expect(item(host, "Authoritative title")).not.toBeNull();
  });

  it("keeps a retained schedule conflict draft when an unrelated Done update succeeds", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: { state: "due_only" as const, version: 2, zone: "Australia/Sydney" as const, start: null, end: { kind: "date" as const, localCivil: `${year}-06-10`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: `${year}-06-10` } };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: latest.schedule }));
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    const editor = portal("subtask-popover-task-1-schedule"); await typeInto(editor.querySelector<HTMLInputElement>('input[type="date"]')!, `${year}-06-20`); await click(saveButton(editor)); await flush();
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    expect(portal("subtask-popover-task-1-schedule").querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe(`${year}-06-20`);
    await click(item(host, "Call client").querySelector<HTMLInputElement>('input[type="checkbox"]')!); await flush();
    expect(portal("subtask-popover-task-1-schedule").textContent).toContain("Latest schedule · v2");
    expect(portal("subtask-popover-task-1-schedule").querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe(`${year}-06-20`);
  });

  it("preserves an open schedule draft when a late authoritative refresh arrives", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-refresh-test");
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [task, second]);
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
    const schedule = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!;
    await click(schedule);
    const editor = portal("subtask-popover-task-1-schedule"); const state = editor.querySelector<HTMLSelectElement>("select")!;
    state.value = "due_only"; state.dispatchEvent(new Event("change", { bubbles: true }));
    await typeInto(editor.querySelector<HTMLInputElement>('input[type="date"]')!, `${year}-06-15`);
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [{ ...task, title: "Late authoritative title", dueDate: `${year}-07-01` }, second]);
    await flush();
    expect(portal("subtask-popover-task-1-schedule").querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe(`${year}-06-15`);
    runtime.dispose(); queryClient.clear();
  });

  it("submits the schedule version captured at editor open after a late versioned refresh", async () => {
    const versionOne = { ...task, schedule: { state: "due_only" as const, version: 1, zone: "Australia/Sydney" as const, start: null, end: { kind: "timed" as const, localCivil: `${year}-06-01T09:00`, instant: "2026-06-01T23:00:00.000Z", utcOffsetMinutes: 600, fold: 0 as const, resolution: "stored" as const }, due: `${year}-06-01T09:00` } };
    const versionTwo = { ...versionOne, title: "Late version 2", dueDate: `${year}-06-02T09:00`, schedule: { ...versionOne.schedule, version: 2, end: { ...versionOne.schedule.end, localCivil: `${year}-06-02T09:00`, instant: "2026-06-02T23:00:00.000Z" }, due: `${year}-06-02T09:00` } };
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-2", name: "Nora Jones", role: "editor" }] }) : Promise.resolve({ subtasks: [versionOne, second] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-version-refresh-test");
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [versionOne, second]);
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')!);
    const editor = portal("subtask-popover-task-1-schedule");
    await typeInto(editor.querySelector<HTMLInputElement>('input[type="time"]')!, "10:00");
    await act(async () => { queryClient.setQueryData(projectDataKeys.subtasks(projectId), [versionTwo, second]); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await flush();
    expect(item(host, "Late version 2")).not.toBeNull();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: versionTwo.schedule }));
    await click(saveButton(portal("subtask-popover-task-1-schedule")));
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "timed", localCivil: `${year}-06-01T10:00` } } } });
    await flush();
    await click(item(host, "Late version 2").querySelector<HTMLButtonElement>('[aria-label="Schedule for Late version 2"]')!);
    const conflict = portal("subtask-popover-task-1-schedule");
    expect(conflict.textContent).toContain("Latest schedule · v2");
    expect(conflict.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("10:00");
    runtime.dispose(); queryClient.clear();
  });

  it("uses one canonical schedule POST from the compact composer and preserves a failed draft", async () => {
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!); const input = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for new subtask"]')!); const editor = portal("subtask-popover-composer-schedule"); const state = editor.querySelector<HTMLSelectElement>("select")!; state.value = "due_only"; state.dispatchEvent(new Event("change", { bubbles: true })); const date = editor.querySelector<HTMLInputElement>('input[type="date"]')!; await typeInto(date, `${year}-06-02`); await click(saveButton(editor)); await typeInto(input, "Schedule staging"); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging", schedule: { state: "due_only", end: { kind: "date", localCivil: `${year}-06-02` } } });
    await click(document.getElementById(`subtask-add-${projectId}`)!); const retry = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(retry, "Retry"); apiPostMock.mockRejectedValueOnce(new Error("No network")); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(retry.value).toBe("Retry"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => retry.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(true); expect(document.getElementById(`subtask-add-${projectId}`)).not.toBeNull();
  });

  it("resets composer metadata on Cancel", async () => {
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!); const composer = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(composer, "Discard me"); await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for new subtask"]')!); const editor = portal("subtask-popover-composer-schedule"); const state = editor.querySelector<HTMLSelectElement>("select")!; state.value = "due_only"; state.dispatchEvent(new Event("change", { bubbles: true })); await typeInto(editor.querySelector<HTMLInputElement>('input[type="date"]')!, `${year}-06-04`); await click(saveButton(editor)); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
    await click(document.getElementById(`subtask-add-${projectId}`)!); expect(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for new subtask"]')?.textContent).toContain("◷");
  });

  it("derives pure reorder neighbors and mounts grip-only activators", async () => {
    expect(reorderNeighbors(["a", "b", "c"], "c", "a")).toMatchObject({ beforeId: null, afterId: "a" }); expect(reorderNeighbors(["a", "b", "c"], "a", "b")).toMatchObject({ beforeId: "b", afterId: "c" }); expect(reorderNeighbors(["a", "b", "c"], "b", "c")).toMatchObject({ beforeId: "c", afterId: null }); expect(reorderNeighbors(["a", "b"], "a", null)).toBeNull(); expect(reorderNeighbors(["a", "b"], "a", "a")).toBeNull();
    const host = mount(); await render(); const row = item(host, "Call client"); const grip = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; expect(grip.getAttribute("aria-roledescription")).toBe("sortable"); expect(grip.getAttribute("aria-describedby")).toMatch(/^DndDescribedBy-/); for (const control of [row.querySelector("input"), row.querySelector('[data-testid="subtask-checklist-title"]'), row.querySelector('[aria-label="Schedule for Call client"]'), row.querySelector('[aria-label="Assignee for Call client"]'), row.querySelector('[aria-label="Actions for Call client"]')]) { expect(control?.getAttribute("aria-roledescription")).toBeNull(); expect(control?.getAttribute("aria-describedby")).toBeNull(); }
    const surviving = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; scheduleReorderFocus(new Map([["task-1", surviving]]), "task-1", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(surviving);
    const nearest = document.createElement("button"); const last = document.createElement("button"); document.body.append(nearest, last); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(nearest); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 99, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(last);
  });

  it("moves the Assignee popover's keyboard highlight with Arrow keys and selects with Enter (§10.3)", async () => {
    // Regression coverage for the keyboard-highlight tracking added to `AssigneeControl` (round
    // 3) — it previously had no `activeIndex`/Arrow-key wiring at all, unlike `TeamPicker`.
    const host = mount(); await render();
    const trigger = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Assignee for Call client"]')!;
    await click(trigger);
    const popover = portal("subtask-popover-task-1-assignee");
    const members = () => [...popover.querySelectorAll<HTMLButtonElement>('[role="option"]')];

    expect(members().map((member) => member.textContent)).toEqual(["Nora Joneseditor", "Ada Smithphotographer"]);
    expect(members()[0]?.getAttribute("aria-current")).toBe("true");
    expect(members()[1]?.getAttribute("aria-current")).toBeNull();
    // The current assignee (Nora Jones, `task.assignee.id === "user-2"`) is marked selected.
    expect(members()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(members()[1]?.getAttribute("aria-selected")).toBe("false");

    await keydown(popover, "ArrowDown");
    expect(members()[0]?.getAttribute("aria-current")).toBeNull();
    expect(members()[1]?.getAttribute("aria-current")).toBe("true");

    await keydown(popover, "ArrowUp");
    expect(members()[0]?.getAttribute("aria-current")).toBe("true");
    expect(members()[1]?.getAttribute("aria-current")).toBeNull();

    // Enter activates the highlighted (first) member — toggling the current assignee off, since
    // `AssigneeControl`'s `onSelect` treats re-selecting the current assignee as unassignment.
    await keydown(popover, "Enter");
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assigneeId: null });
  });

  it("does not reload the checklist when a parent re-render passes a new onAccessFailure identity", async () => {
    const host = document.createElement("div"); document.body.appendChild(host); const localRoot = createRoot(host);
    try {
      await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => {}} />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1);
      for (let index = 0; index < 5; index += 1) await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => {}} />); await Promise.resolve(); });
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1); expect(apiGetMock.mock.calls.filter(([path]) => path.includes("mentionable-users")).length).toBe(1);
    } finally { await act(async () => localRoot.unmount()); }
  });
});
