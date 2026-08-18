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
const currentYear = new Date().getFullYear();
const nextYear = currentYear + 1;
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignee: { id: "user-2", name: "Nora Jones" }, assignmentVersion: 0, dueDate: `${currentYear}-05-30`, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const secondTask = { ...task, id: "task-0", title: "Prepare files", position: 2048, assignee: null, dueDate: null };
const thirdTask = { ...task, id: "task-2", title: "Confirm delivery", position: 3072, assignee: null, dueDate: `${nextYear}-05-30T14:30` };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function keydown(element: Element, key: string) { await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function change(element: HTMLInputElement | HTMLSelectElement, value: string | boolean) { await act(async () => { if (typeof value === "boolean") (element as HTMLInputElement).checked = value; else { const prototype = element instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); } element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }
function item(host: HTMLElement, title: string) { const result = [...host.querySelectorAll<HTMLElement>(".subtask-checklist__item")].find((element) => element.textContent?.includes(title)); if (!result) throw new Error(`No item ${title}`); return result; }
async function edit(host: HTMLElement, title: string) { await click(item(host, title).querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!); return item(host, title); }

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [{ id: "user-2", name: "Nora Jones", role: "editor" }] }) : Promise.resolve({ subtasks: [task, secondTask, thirdTask] }));
  apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-new", title: "Schedule staging", position: 4096 });
  apiPatchMock.mockReset().mockImplementation((path, body) => Promise.resolve({ ...(path.includes("task-0") ? secondTask : path.includes("task-2") ? thirdTask : task), ...(body as object) }));
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist", () => {
  it("is an open accordion with a safe native progress bar and retains a live failure notice while collapsed", async () => {
    const host = mount(); await render();
    const toggle = host.querySelector<HTMLButtonElement>(".subtask-checklist__toggle")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    const progress = toggle.querySelector<HTMLProgressElement>("progress")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); expect(panel.classList.contains("is-collapsed")).toBe(false);
    expect(toggle.textContent).toContain("0 of 3 complete · 0%"); expect(progress.value).toBe(0); expect(progress.max).toBe(3); expect(progress.getAttribute("aria-hidden")).toBe("true");
    await click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(panel.getAttribute("aria-hidden")).toBe("true"); expect(panel.classList.contains("is-collapsed")).toBe(true);
    await click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click(item(host, "Call client").querySelector<HTMLInputElement>('input[type="checkbox"]')!); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(toggle.textContent).toContain("1 of 3 complete · 33%");
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users") ? Promise.reject(new Error("no assignees")) : Promise.resolve({ subtasks: [] }));
    const empty = mount(); await render();
    const emptyToggle = empty.querySelector<HTMLButtonElement>(".subtask-checklist__toggle")!;
    expect(emptyToggle.querySelector<HTMLProgressElement>("progress")!.max).toBe(1); expect(emptyToggle.textContent).toContain("0 of 0 complete · 0%");
    await click(emptyToggle); expect(empty.querySelector(".subtask-checklist__notice")?.textContent).toContain("Assignees could not be loaded.");
  });

  it("renders compact rows with literal due formatting and accessible assignee badges until explicit edit activation", async () => {
    const host = mount(); await render();
    const first = item(host, "Call client"); const third = item(host, "Confirm delivery");
    expect(first.querySelector(".subtask-checklist__title-trigger")?.textContent).toBe("Call client"); expect(host.querySelector('input[type="date"]')).toBeNull(); expect(host.querySelector("select")).toBeNull();
    expect(first.querySelector("time")?.textContent).toContain("Due 30 May"); expect(third.querySelector("time")?.textContent).toContain(`30 May ${nextYear} · 14:30`);
    expect(first.querySelector(".subtask-checklist__assignee")?.getAttribute("title")).toBe("Nora Jones"); expect(first.querySelector(".subtask-checklist__assignee")?.textContent).toContain("NJ"); expect(first.querySelector(".subtask-checklist__assignee .sr-only")?.textContent).toBe("Assigned to Nora Jones");
    await edit(host, "Call client");
    expect(document.activeElement).toBe(first.querySelector(".subtask-checklist__title")); expect(first.querySelector("time")).toBeNull(); expect(first.querySelector(".subtask-checklist__assignee")).toBeNull(); expect(first.querySelector('input[type="date"]')).not.toBeNull(); expect(first.querySelector("select")).not.toBeNull();
  });

  it("only opens title editing by activation, supports keyboard activation, and preserves current title/due/assignee PATCH calls", async () => {
    const host = mount(); await render();
    const triggers = host.querySelectorAll<HTMLButtonElement>(".subtask-checklist__title-trigger");
    triggers[0]!.focus(); triggers[1]!.focus(); expect(host.querySelector(".subtask-checklist__title")).toBeNull();
    await keydown(triggers[1]!, "Enter");
    const second = item(host, "Prepare files");
    expect(document.activeElement).toBe(second.querySelector(".subtask-checklist__title"));
    await change(second.querySelector<HTMLSelectElement>("select")!, "user-2"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-0`, { assigneeId: "user-2" });
    await change(second.querySelector<HTMLInputElement>('input[type="date"]')!, "2026-08-20"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-0`, { dueDate: "2026-08-20" }); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const time = second.querySelector<HTMLInputElement>('input[type="time"]')!; await change(time, "09:00"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-0`, { dueDate: "2026-08-20T09:00" });
    await keydown(triggers[2]!, " ");
    expect(document.activeElement).toBe(item(host, "Confirm delivery").querySelector(".subtask-checklist__title"));
  });

  it("keeps compact title triggers in tab order without opening their edit controls", async () => {
    const host = mount(); await render();
    const triggers = [...host.querySelectorAll<HTMLButtonElement>(".subtask-checklist__title-trigger")];
    const add = host.querySelector<HTMLInputElement>(`#subtask-add-${projectId}`)!;
    const tabStops = [...host.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')].filter((element) => element.tabIndex >= 0);
    expect(triggers.every((trigger) => trigger.tabIndex === 0)).toBe(true); expect(tabStops.indexOf(triggers[0]!)).toBeLessThan(tabStops.indexOf(triggers[1]!)); expect(tabStops.indexOf(triggers[1]!)).toBeLessThan(tabStops.indexOf(triggers[2]!)); expect(tabStops.indexOf(triggers[2]!)).toBeLessThan(tabStops.indexOf(add));
    for (const trigger of triggers) { trigger.focus(); expect(document.activeElement).toBe(trigger); expect(host.querySelector(".subtask-checklist__title")).toBeNull(); }
    add.focus(); expect(document.activeElement).toBe(add); expect(host.querySelector(".subtask-checklist__title")).toBeNull();
  });

  it("cancels title edits without PATCH and allows a later legitimate blur save", async () => {
    const host = mount(); await render(); const first = await edit(host, "Call client"); const input = first.querySelector<HTMLInputElement>(".subtask-checklist__title")!;
    await typeInto(input, "Discarded title"); apiPatchMock.mockClear();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(escape); await Promise.resolve(); });
    expect(escape.defaultPrevented).toBe(true); expect(apiPatchMock).not.toHaveBeenCalled(); expect(first.querySelector(".subtask-checklist__title-trigger")?.textContent).toBe("Call client");
    const reentered = await edit(host, "Call client"); const secondInput = reentered.querySelector<HTMLInputElement>(".subtask-checklist__title")!;
    await typeInto(secondInput, "Saved title"); await act(async () => { secondInput.blur(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { title: "Saved title" });
  });

  it("keeps overflow actions inline, closes and restores focus on Escape/outside interaction, and moves through its disclosed group", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); const trigger = first.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")!;
    expect(trigger.tabIndex).toBe(0); await click(trigger);
    const group = first.querySelector<HTMLElement>(".subtask-checklist__overflow-actions")!;
    expect(group.getAttribute("aria-label")).toBe("Actions for Call client"); expect(group.previousElementSibling).toBe(first.querySelector(".subtask-checklist__summary")); expect(first.classList.contains("is-menu-open")).toBe(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => { group.dispatchEvent(escape); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(escape.defaultPrevented).toBe(true); expect(first.querySelector(".subtask-checklist__overflow-actions")).toBeNull(); expect(document.activeElement).toBe(trigger);
    await click(trigger);
    apiGetMock.mockImplementationOnce(() => Promise.resolve({ subtasks: [{ ...secondTask, position: 1024 }, { ...task, position: 2048 }, thirdTask] }));
    await click(first.querySelector<HTMLButtonElement>('[data-move="down"]')!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1/move`, { direction: "down" });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const moved = item(host, "Call client"); expect(moved.querySelector(".subtask-checklist__overflow-actions")).toBeNull(); expect(document.activeElement).toBe(moved.querySelector("[data-subtask-actions-trigger]"));
    await click(moved.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")!); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await act(async () => { await Promise.resolve(); }); expect(moved.querySelector(".subtask-checklist__overflow-actions")).toBeNull();
  });

  it("closes an open overflow menu when focus leaves its item", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); await click(first.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")!);
    const group = first.querySelector<HTMLElement>(".subtask-checklist__overflow-actions")!;
    const outside = item(host, "Prepare files").querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!;
    await act(async () => { group.querySelector<HTMLButtonElement>("button")!.focus(); outside.focus(); group.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })); await Promise.resolve(); });
    expect(first.querySelector(".subtask-checklist__overflow-actions")).toBeNull();
  });

  it("leaves a menu open after move failure, clears it after delete, and restores focus to the next compact title", async () => {
    const host = mount(); await render(); const first = item(host, "Call client"); await click(first.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")!);
    apiPostMock.mockRejectedValueOnce(new Error("move failed")); await click(first.querySelector<HTMLButtonElement>('[data-move="down"]')!);
    expect(first.querySelector(".subtask-checklist__overflow-actions")).not.toBeNull();
    const second = item(host, "Prepare files"); await click(second.querySelector<HTMLButtonElement>("[data-subtask-actions-trigger]")!); await click(second.querySelector<HTMLButtonElement>(".subtask-checklist__overflow-actions button:last-child")!);
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-0`); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(item(host, "Confirm delivery").querySelector(".subtask-checklist__title-trigger"));
  });

  it("adds a compact task and does not permit a busy title trigger to enter edit mode", async () => {
    let resolvePatch: ((value: unknown) => void) | undefined;
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));
    const host = mount(); await render(); const first = item(host, "Call client");
    await click(first.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const title = first.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!; expect(title.disabled).toBe(true); await click(title); expect(first.querySelector(".subtask-checklist__title")).toBeNull(); resolvePatch?.({ ...task, done: true }); await act(async () => { await Promise.resolve(); });
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-add-${projectId}`)!, "Schedule staging"); await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Add task")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging" }); expect(item(host, "Schedule staging").querySelector(".subtask-checklist__title-trigger")).not.toBeNull();
  });

  it("reconciles a failed task mutation without hiding the existing item and announces the error", async () => {
    apiPatchMock.mockRejectedValueOnce(new Error("No longer allowed")); const host = mount(); await render(); const first = item(host, "Call client");
    await click(first.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(host.textContent).toContain("Call client"); expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain("No longer allowed");
  });

  it("reports a fully complete checklist without a fractional progress value", async () => {
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [] }) : Promise.resolve({ subtasks: [{ ...task, done: true }, { ...secondTask, done: true }, { ...thirdTask, done: true }] }));
    const host = mount(); await render(); const toggle = host.querySelector<HTMLButtonElement>(".subtask-checklist__toggle")!;
    expect(toggle.textContent).toContain("3 of 3 complete · 100%"); expect(toggle.querySelector<HTMLProgressElement>("progress")!.value).toBe(3); expect(toggle.querySelector<HTMLProgressElement>("progress")!.max).toBe(3);
  });
});
