import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtaskChecklist } from "./SubtaskChecklist";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignee: null, assignmentVersion: 0, dueDate: "2026-08-17", createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const secondTask = { ...task, id: "task-0", title: "Prepare files", position: 2048, dueDate: null };
const thirdTask = { ...task, id: "task-2", title: "Confirm delivery", position: 3072, dueDate: null };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function change(element: HTMLInputElement | HTMLSelectElement, value: string | boolean) { await act(async () => { if (typeof value === "boolean") (element as HTMLInputElement).checked = value; else element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-2", name: "Nora", role: "editor" }] }) : Promise.resolve({ subtasks: [task, secondTask, thirdTask] }));
  apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-2", title: "New task", position: 2048 });
  apiPatchMock.mockReset().mockImplementation((_path, body) => Promise.resolve({ ...task, ...(body as object) }));
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist", () => {
  it("loads the scoped checklist, performs CRUD/reorder from server responses, and preserves literal due-date strings", async () => {
    const host = mount(); await render();
    expect(host.textContent).toContain("0/3 complete"); expect(host.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-08-17");
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { done: true });
    await change(host.querySelector<HTMLSelectElement>("select")!, "user-2"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assigneeId: "user-2" });
    apiGetMock.mockImplementationOnce(() => Promise.resolve({ subtasks: [{ ...secondTask, position: 1024 }, { ...task, position: 2048 }, thirdTask] }));
    await click(host.querySelector<HTMLButtonElement>('[data-move="down"]')!); expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1/move`, { direction: "down" });
    expect([...host.querySelectorAll<HTMLInputElement>(".subtask-checklist__title")].map((input) => input.value)).toEqual(["Prepare files", "Call client", "Confirm delivery"]);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(host.querySelector<HTMLButtonElement>('[aria-label="Move Call client down"]'));
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Delete")!); expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-0`);
  });

  it("reconciles a failed task mutation without hiding the existing item and announces the error", async () => {
    apiPatchMock.mockRejectedValueOnce(new Error("No longer allowed")); const host = mount(); await render();
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(host.textContent).toContain("Call client"); expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("No longer allowed");
  });

  it("adds a subtask from the checklist input and renders the server response", async () => {
    apiPostMock.mockResolvedValueOnce({ ...task, id: "task-new", title: "Schedule staging", position: 4096 }); const host = mount(); await render();
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-add-${projectId}`)!, "Schedule staging");
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Add task")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging" });
    expect([...host.querySelectorAll<HTMLInputElement>(".subtask-checklist__title")].map((input) => input.value)).toContain("Schedule staging");
  });
});
