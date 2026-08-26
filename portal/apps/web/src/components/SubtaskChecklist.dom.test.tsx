import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleReorderFocus, SubtaskChecklist } from "./SubtaskChecklist";
import { reorderNeighbors } from "../lib/reorder-neighbors";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>(); const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>(); const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>(); const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => { const actual = await importOriginal<typeof import("../lib/api")>(); return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) }; });
const projectId = "11111111-1111-4111-8111-111111111111"; const year = new Date().getFullYear();
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignee: { id: "user-2", name: "Nora Jones" }, assignmentVersion: 0, dueDate: `${year}-05-30`, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const second = { ...task, id: "task-2", title: "Prepare files", position: 2048, assignee: null, dueDate: null };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function keydown(element: Element, key: string) { await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }
function item(host: HTMLElement, title: string) { const result = [...host.querySelectorAll<HTMLElement>(".subtask-checklist__item")].find((element) => element.textContent?.includes(title)); if (!result) throw new Error(`No item ${title}`); return result; }
function portal(id: string) { return document.getElementById(id)!; }
beforeEach(() => { apiGetMock.mockReset().mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-2", name: "Nora Jones", role: "editor" }, { id: "user-3", name: "Ada Smith", role: "photographer" }] }) : Promise.resolve({ subtasks: [task, second] })); apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-new", title: "Schedule staging", position: 3072 }); apiPatchMock.mockReset().mockImplementation((path, body) => Promise.resolve({ ...(path.includes("task-2") ? second : task), ...(body as object) })); apiDeleteMock.mockReset().mockResolvedValue({ ok: true }); confirmMock.mockReset().mockResolvedValue(true); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist", () => {
  it("preserves accordion/progress, literal due badges, and compact title edit/Escape behavior without legacy controls", async () => {
    const host = mount(); await render(); const toggle = host.querySelector<HTMLButtonElement>(".subtask-checklist__toggle")!;
    expect(toggle.textContent).toContain("0 of 2 complete · 0%"); expect(toggle.querySelector("progress")?.max).toBe(2); expect(item(host, "Call client").querySelector("time")?.textContent).toContain("Due 30 May");
    expect(host.querySelector("select")).toBeNull(); expect([...host.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Move "))).toBe(false);
    const title = item(host, "Call client").querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!; await click(title); const input = item(host, "Call client").querySelector<HTMLInputElement>(".subtask-checklist__title")!; await typeInto(input, "Discarded"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true); expect(apiPatchMock).not.toHaveBeenCalled(); const reopened = item(host, "Call client").querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!; reopened.focus(); await keydown(reopened, " "); const saveInput = item(host, "Call client").querySelector<HTMLInputElement>(".subtask-checklist__title")!; await typeInto(saveInput, "Saved title"); await keydown(saveInput, "Enter"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { title: "Saved title" });
  });

  it("uses tabbable due and assignee popovers with cancellation, date save/remove, search assignment, and unassignment", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); const secondRow = item(host, "Prepare files");
    for (const button of [first.querySelector<HTMLButtonElement>('[aria-label="Due date for Call client"]')!, first.querySelector<HTMLButtonElement>('[aria-label="Assignee for Call client"]')!, secondRow.querySelector<HTMLButtonElement>('[aria-label="Due date for Prepare files"]')!, secondRow.querySelector<HTMLButtonElement>('[aria-label="Assignee for Prepare files"]')!]) { expect(button.tabIndex).toBe(0); button.focus(); expect(button.closest("article")?.contains(document.activeElement)).toBe(true); }
    const due = first.querySelector<HTMLButtonElement>('[aria-label="Due date for Call client"]')!; await click(due); expect(portal("subtask-popover-task-1-due")).not.toBeNull(); await keydown(due, "Escape"); expect(document.getElementById("subtask-popover-task-1-due")).toBeNull(); expect(apiPatchMock).not.toHaveBeenCalled();
    await click(due); await click(due); expect(document.getElementById("subtask-popover-task-1-due")).toBeNull(); await click(due); await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await Promise.resolve(); }); expect(document.getElementById("subtask-popover-task-1-due")).toBeNull(); await click(due); const focusGuard = document.querySelector<HTMLElement>("[data-floating-ui-focus-guard]"); expect(focusGuard).not.toBeNull(); await act(async () => { focusGuard!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); await Promise.resolve(); }); expect(document.getElementById("subtask-popover-task-1-due")).not.toBeNull(); document.body.focus(); document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); await act(async () => { await Promise.resolve(); }); expect(document.getElementById("subtask-popover-task-1-due")).toBeNull(); expect(apiPatchMock).not.toHaveBeenCalled();
    await click(due); const date = portal("subtask-popover-task-1-due").querySelector<HTMLInputElement>('input[type="date"]')!; const time = portal("subtask-popover-task-1-due").querySelector<HTMLInputElement>('input[type="time"]')!; await typeInto(date, `${year}-06-01`); await typeInto(time, "09:30"); await click(portal("subtask-popover-task-1-due").querySelector<HTMLButtonElement>(".button")!); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { dueDate: `${year}-06-01T09:30` });
    await click(due); await click([...portal("subtask-popover-task-1-due").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { dueDate: null });
    await click(due); const assignee = secondRow.querySelector<HTMLButtonElement>('[aria-label="Assignee for Prepare files"]')!; await click(assignee); expect(document.getElementById("subtask-popover-task-1-due")).toBeNull(); expect(document.getElementById("subtask-popover-task-2-assignee")).not.toBeNull(); const search = portal("subtask-popover-task-2-assignee").querySelector<HTMLInputElement>('input[type="search"]')!; expect(document.activeElement).toBe(search); search.focus(); document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); await act(async () => { await Promise.resolve(); }); expect(document.getElementById("subtask-popover-task-2-assignee")).toBeNull(); await click(assignee); await typeInto(portal("subtask-popover-task-2-assignee").querySelector<HTMLInputElement>('input[type="search"]')!, "Ada"); expect(portal("subtask-popover-task-2-assignee").textContent).toContain("Ada Smith"); expect(portal("subtask-popover-task-2-assignee").textContent).not.toContain("Nora Jones"); await click([...portal("subtask-popover-task-2-assignee").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Ada Smith"))!); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-2`, { assigneeId: "user-3" });
    const assigned = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Assignee for Call client"]')!; await click(assigned); await click([...portal("subtask-popover-task-1-assignee").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Nora Jones"))!); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assigneeId: null });
  });

  it("keeps one Delete-only popover and restores deletion focus to the next row or the closed Add button", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); const actions = first.querySelector<HTMLButtonElement>('[aria-label="Actions for Call client"]')!; await click(actions); const group = portal("subtask-popover-task-1-actions"); expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Delete"]);
    confirmMock.mockResolvedValueOnce(false); await click(group.querySelector("button")!); expect(apiDeleteMock).not.toHaveBeenCalled(); expect(document.getElementById("subtask-popover-task-1-actions")).not.toBeNull();
    await click(group.querySelector("button")!); expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(item(host, "Prepare files").querySelector(".subtask-checklist__title-trigger"));
    await click(item(host, "Prepare files").querySelector<HTMLButtonElement>('[aria-label="Actions for Prepare files"]')!); await click(portal("subtask-popover-task-2-actions").querySelector("button")!); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
  });

  it("keeps the delete popover open for pointer and focus events inside the portalled confirmation", async () => {
    const host = mount(); await render();
    const actions = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Actions for Call client"]')!;
    await click(actions);
    const group = portal("subtask-popover-task-1-actions");
    let settle!: (value: boolean) => void;
    confirmMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    await click(group.querySelector("button")!);

    const confirmPortal = document.createElement("div");
    confirmPortal.dataset.confirmModalRoot = "";
    const confirmButton = document.createElement("button");
    confirmPortal.append(confirmButton); document.body.append(confirmPortal);
    confirmButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    confirmButton.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(document.getElementById("subtask-popover-task-1-actions")).not.toBeNull();

    settle(false); await flush();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(document.getElementById("subtask-popover-task-1-actions")).not.toBeNull();

    confirmMock.mockResolvedValueOnce(true);
    await click(group.querySelector("button")!);
    await flush();
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`);
    expect(document.getElementById("subtask-popover-task-1-actions")).toBeNull();
  });

  it("uses the closed composer, its popovers, one metadata POST, reset focus, and preserves a failed draft", async () => {
    const host = mount(); await render(); const add = document.getElementById(`subtask-add-${projectId}`)!; await click(add); const input = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; expect(document.activeElement).toBe(input); await click(host.querySelector<HTMLButtonElement>('[aria-label="Assignee for new subtask"]')!); await click([...portal("subtask-popover-composer-assignee").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Ada Smith"))!); await click(host.querySelector<HTMLButtonElement>('[aria-label="Due date for new subtask"]')!); const date = portal("subtask-popover-composer-due").querySelector<HTMLInputElement>('input[type="date"]')!; await typeInto(date, `${year}-06-02`); await click(portal("subtask-popover-composer-due").querySelector<HTMLButtonElement>(".button")!); await typeInto(input, "Schedule staging"); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging", assigneeId: "user-3", dueDate: `${year}-06-02` }); expect(apiPatchMock).not.toHaveBeenCalled(); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
    await click(document.getElementById(`subtask-add-${projectId}`)!); const retry = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(retry, "Retry"); apiPostMock.mockRejectedValueOnce(new Error("No network")); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(retry.value).toBe("Retry"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => retry.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(true); expect(document.getElementById(`subtask-add-${projectId}`)).not.toBeNull();
  });

  it("resets composer metadata on Cancel and focuses its input when deletion empties the list", async () => {
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-3", name: "Ada Smith", role: "photographer" }] }) : Promise.resolve({ subtasks: [second] }));
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!); const composer = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(composer, "Discard me"); await click(host.querySelector<HTMLButtonElement>('[aria-label="Assignee for new subtask"]')!); await click(portal("subtask-popover-composer-assignee").querySelector("button")!); await click(host.querySelector<HTMLButtonElement>('[aria-label="Due date for new subtask"]')!); await typeInto(portal("subtask-popover-composer-due").querySelector<HTMLInputElement>('input[type="date"]')!, `${year}-06-04`); await click(portal("subtask-popover-composer-due").querySelector<HTMLButtonElement>(".button")!); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
    await click(document.getElementById(`subtask-add-${projectId}`)!); const reset = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; expect(reset.value).toBe(""); expect(host.querySelector('[aria-label="Assignee for new subtask"]')?.textContent).not.toContain("AS"); expect(host.querySelector('[aria-label="Due date for new subtask"] time')).toBeNull();
    await click(item(host, "Prepare files").querySelector<HTMLButtonElement>('[aria-label="Actions for Prepare files"]')!); await click(portal("subtask-popover-task-2-actions").querySelector("button")!); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(reset);
  });

  it("derives pure reorder neighbors and mounts grip-only activators", async () => {
    expect(reorderNeighbors(["a", "b", "c"], "c", "a")).toMatchObject({ beforeId: null, afterId: "a" }); expect(reorderNeighbors(["a", "b", "c"], "a", "b")).toMatchObject({ beforeId: "b", afterId: "c" }); expect(reorderNeighbors(["a", "b", "c"], "b", "c")).toMatchObject({ beforeId: "c", afterId: null }); expect(reorderNeighbors(["a", "b"], "a", null)).toBeNull(); expect(reorderNeighbors(["a", "b"], "a", "a")).toBeNull();
    const host = mount(); await render(); const row = item(host, "Call client"); const grip = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; expect(grip.getAttribute("aria-roledescription")).toBe("sortable"); expect(grip.getAttribute("aria-describedby")).toMatch(/^DndDescribedBy-/); for (const control of [row.querySelector("input"), row.querySelector(".subtask-checklist__title-trigger"), row.querySelector('[aria-label="Due date for Call client"]'), row.querySelector('[aria-label="Assignee for Call client"]'), row.querySelector('[aria-label="Actions for Call client"]')]) { expect(control?.getAttribute("aria-roledescription")).toBeNull(); expect(control?.getAttribute("aria-describedby")).toBeNull(); }
    const surviving = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; scheduleReorderFocus(new Map([["task-1", surviving]]), "task-1", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(surviving);
    const nearest = document.createElement("button"); const last = document.createElement("button"); document.body.append(nearest, last); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(nearest); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 99, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(last);
    vi.useFakeTimers(); try { let busy = true; const focus = vi.spyOn(surviving, "focus"); scheduleReorderFocus(new Map([["task-1", surviving]]), "task-1", 0, false, null, projectId, () => busy); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(focus).not.toHaveBeenCalled(); busy = false; await act(async () => { await vi.advanceTimersByTimeAsync(16); await vi.advanceTimersByTimeAsync(0); }); expect(focus).toHaveBeenCalledTimes(1); } finally { vi.useRealTimers(); }
    scheduleReorderFocus(new Map(), "missing", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
  });

  it("does not reload the checklist when a parent re-render passes a new onAccessFailure identity", async () => {
    const host = document.createElement("div"); document.body.appendChild(host); const localRoot = createRoot(host);
    try {
      await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => {}} />); await Promise.resolve(); await Promise.resolve(); });
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1);
      // A parent that re-renders on every keystroke (e.g. a comment composer) allocates a fresh
      // onAccessFailure closure each time; that identity change must never re-trigger the load effect.
      for (let index = 0; index < 5; index += 1) {
        await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => { /* re-render */ }} />); await Promise.resolve(); });
      }
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1);
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("mentionable-users")).length).toBe(1);
    } finally {
      await act(async () => localRoot.unmount());
    }
  });
});
