import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { formatSchedule, scheduleReorderFocus, SubtaskChecklist } from "./SubtaskChecklist";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { projectDataKeys } from "../lib/project-data";
import { applyPopup, dateTimePopup, pickPopupDay, pickRangeEnd, popupButton, rangeToggles, typePopupTime, rangeMoment } from "@/testing/date-time-popup";
import { checklistScheduleToDto, normalizeChecklistSchedule } from "@quincy/shared";
import { formatCivilRange } from "../lib/date-format";
import { endMoment, momentScheduleDto, presetScheduleDto, startMoment } from "@/testing/subtask-schedule";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const floating = vi.hoisted(() => ({ modalValues: [] as Array<boolean | undefined> }));
// Without this the real better-auth client polls /api/auth/get-session over the network (#167).
// `data: null` is what these tests already ran against — the real session never resolved — so the
// capability-derived branches keep the coverage they had. A test needing a role sets one here.
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
// Records the latest `onDragEnd` (delegating to the real DndContext) so a test can drop one row onto another without layout (#377).
const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return { ...actual, DndContext: (props: Parameters<typeof actual.DndContext>[0]) => { dnd.onDragEnd = props.onDragEnd as (event: unknown) => void; return createElement(actual.DndContext, props); } };
});
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
const rangeOf = (day: string, version = 1) => presetScheduleDto(day, day, version);
const person = (id: string, name: string) => ({ id, name, roleLabel: "Editor", isExternal: false, active: true });
const nora = person("20000000-0000-4000-8000-000000000002", "Nora Jones"); const ada = person("30000000-0000-4000-8000-000000000003", "Ada Smith"); const ben = person("40000000-0000-4000-8000-000000000004", "Ben Ortiz"); const cy = person("50000000-0000-4000-8000-000000000005", "Cy Young"); const dee = person("60000000-0000-4000-8000-000000000006", "Dee Park");
let optionsResponse: { candidates: Array<{ id: string; name: string; role: string }> };
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignees: [nora], assignmentVersion: 1, dueDate: `${year}-05-30`, schedule: rangeOf(`${year}-05-30`), createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const second = { ...task, id: "task-2", title: "Prepare files", position: 2048, assignees: [], assignmentVersion: 0, dueDate: `${year}-06-01`, schedule: rangeOf(`${year}-06-01`) };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
// The checklist query now delivers a few timer ticks after mount (the retired mentionable-users request used to keep this act open long enough by itself), so wait for it to leave its loading state.
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); for (let attempt = 0; attempt < 50 && document.body.textContent?.includes("Loading checklist…"); attempt += 1) await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function keydown(element: Element, key: string) { await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }
function item(host: HTMLElement, title: string) { const result = [...host.querySelectorAll<HTMLElement>("article")].find((element) => element.textContent?.includes(title)); if (!result) throw new Error(`No item ${title}`); return result; }
function portal(id: string) { return document.getElementById(id)!; }
// TB8-07 slice 4b retired the `.button` class from the Save control (now `buttonClasses`
// Tailwind utilities) — find it by accessible name instead of a CSS class.
function dateInputs(scope: Element) { return [...scope.querySelectorAll<HTMLInputElement>('input[type="date"]')]; }
function timeInputs(scope: Element) { return [...scope.querySelectorAll<HTMLInputElement>('input[type="time"]')]; }
async function selectValue(select: HTMLSelectElement, value: string) { select.value = value; await act(async () => { select.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); }); }
async function waitFor(assertion: () => void, timeoutMs = 1500) { const start = Date.now(); for (;;) { try { assertion(); return; } catch (error) { if (Date.now() - start > timeoutMs) throw error; await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); } } }
const pickerOptions = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const optionName = (option: HTMLElement) => option.querySelector('[data-testid="assignee-option-name"]')!.textContent!.trim();
async function openAssignees(trigger: Element) { await act(async () => { trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); (trigger as HTMLElement).click(); await Promise.resolve(); }); await waitFor(() => expect(pickerOptions().map(optionName)).toContain("Dee Park")); }
async function pickAssignee(name: string) { const option = pickerOptions().find((candidate) => optionName(candidate) === name); if (!option) throw new Error(`No option ${name}`); await act(async () => { option.click(); await Promise.resolve(); }); }
async function closeAssignees() { const active = document.activeElement ?? document.body; await act(async () => { active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); }); await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull()); await flush(); }
const assigneeTrigger = (host: HTMLElement, title = "Call client") => item(host, title).querySelector<HTMLButtonElement>(`[aria-label="Assignees for ${title}"]`)!;
const stackLabels = (scope: Element) => [...scope.querySelectorAll('[role="img"]')].map((element) => element.getAttribute("aria-label"));
const popupOf = (title: string) => dateTimePopup(`Schedule for ${title}`)!;
const openSchedule = async (host: HTMLElement, title: string) => { await click(item(host, title).querySelector<HTMLButtonElement>(`[aria-label="Schedule for ${title}"]`)!); return popupOf(title); };
/** Picks a start day in the open popup and applies it: the one-step way to write a retained draft. */
/** Opens the popup unless an earlier outside press left it open. */
const ensureOpen = async (host: HTMLElement, title: string) => popupOf(title) ?? openSchedule(host, title);
const draftDay = async (popup: HTMLElement, day: string) => { await pickPopupDay(popup, day); await applyPopup(popup); await flush(); };
function saveButton(scope: Element) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply")!; }

beforeEach(() => { optionsResponse = { candidates: [{ id: "20000000-0000-4000-8000-000000000002", name: "Nora Jones", role: "editor" }, { id: "30000000-0000-4000-8000-000000000003", name: "Ada Smith", role: "photographer" }, { id: "40000000-0000-4000-8000-000000000004", name: "Ben Ortiz", role: "editor" }, { id: "50000000-0000-4000-8000-000000000005", name: "Cy Young", role: "editor" }, { id: "60000000-0000-4000-8000-000000000006", name: "Dee Park", role: "editor" }] }; floating.modalValues.length = 0; apiGetMock.mockReset().mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: [task, second] })); apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-new", title: "Schedule staging", position: 3072 }); apiPatchMock.mockReset().mockImplementation((path, body) => { const base = path.includes("task-2") ? second : task; return Promise.resolve({ ...base, ...("schedule" in (body as object) || "assignees" in (body as object) ? {} : body as object) }); }); apiDeleteMock.mockReset().mockResolvedValue({ ok: true }); confirmMock.mockReset().mockResolvedValue(true); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist", () => {
  it("in the rail layout puts each row's title and its meta controls on separate lines (#377)", async () => {
    const host = mount(); await render(); const first = item(host, "Call client");
    expect(first.getAttribute("data-row-layout")).toBe("two-line");
    const title = first.querySelector<HTMLElement>('[data-testid="subtask-checklist-title"]')!; const meta = first.querySelector<HTMLElement>('[data-testid="subtask-checklist-meta"]')!;
    expect(meta.contains(title)).toBe(false);
    for (const label of ["Schedule for Call client", "Assignees for Call client", "Actions for Call client"]) expect(meta.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    expect(title.parentElement).toBe(meta.parentElement);
  });
  it("in the stacked layout keeps the single-line desktop row (no two-line marker)", async () => {
    const host = mount(); await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} layout="stacked" />); await Promise.resolve(); });
    await act(async () => { const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Expand checklist"]'); toggle?.click(); await Promise.resolve(); });
    for (let attempt = 0; attempt < 50 && document.body.textContent?.includes("Loading checklist…"); attempt += 1) await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); });
    const first = item(host, "Call client"); expect(first.getAttribute("data-row-layout")).toBeNull();
  });
  it("preserves accordion/progress, literal schedule badges, and compact title edit/Escape behavior", async () => {
    const host = mount(); await render(); const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse checklist"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); expect(host.querySelector('[data-testid="subtask-checklist-count"]')!.textContent).toContain("0 / 2"); expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax")).toBe("2"); expect(item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Schedule for Call client"]')?.textContent).toContain("30 May");
    expect(host.querySelector("select")).toBeNull(); expect([...host.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Move "))).toBe(false);
    const title = item(host, "Call client").querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!; await click(title); const input = item(host, "Call client").querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; await typeInto(input, "Discarded"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true); expect(apiPatchMock).not.toHaveBeenCalled(); const reopened = item(host, "Call client").querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!; reopened.focus(); await keydown(reopened, " "); const saveInput = item(host, "Call client").querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; await typeInto(saveInput, "Saved title"); await keydown(saveInput, "Enter"); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { title: "Saved title" });
  });

  it("keeps the checklist popover non-modal by default", async () => {
    const host = mount(); await render();
    const popup = await openSchedule(host, "Call client");
    expect(popup).not.toBeNull();
    expect(popup.getAttribute("aria-modal")).not.toBe("true");
  });

  it("patches a saved schedule locally and flushes its deferred invalidation once", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-schedule-owner-test");
    const subtasksKey = projectDataKeys.subtasks(projectId);
    const updated = { ...task, schedule: presetScheduleDto(`${year}-06-15`, `${year}-06-15`, 2) };
    queryClient.setQueryData(subtasksKey, [task, second]);
    let patchSettled = false;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("subtask-assignee-options")) return Promise.resolve(optionsResponse);
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

    const popup = await openSchedule(host, "Call client");
    expect(runtime.isOwned(subtasksKey)).toBe(true);
    await draftDay(popup, `${year}-06-15`);

    expect(runtime.isOwned(subtasksKey)).toBe(true);
    expect(requestOwnership).toEqual([]);
    expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(subtasksKey))).toHaveLength(0);
    patchSettled = true;
    resolvePatch(updated);
    await flush();
    expect(apiPatchMock).toHaveBeenCalled();
    expect(queryClient.getQueryData<typeof updated[]>(subtasksKey)?.find((entry) => entry.id === task.id)).toMatchObject({ schedule: { due: `${year}-06-15T17:00` } });
    expect(requestOwnership).toEqual([true]);
    expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(subtasksKey))).toHaveLength(1);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(false);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
    expect(runtime.isOwned(subtasksKey)).toBe(false);
    runtime.dispose(); queryClient.clear();
  });

  it("edits a one-day range row and a timed range, and never offers a mode picker (start = end is one day)", async () => {
    const host = mount(); await render(); const assignee = item(host, "Call client").querySelector<HTMLButtonElement>('[aria-label="Assignees for Call client"]')!;
    const group = await openSchedule(host, "Call client"); expect(group).not.toBeNull();
    // A Subtask is always a range of two moments: no Date / Timed choice, no Due only, no Unscheduled.
    expect(group.textContent).not.toContain("Date or time"); expect(group.textContent).not.toContain("Due only"); expect(group.textContent).not.toContain("Unscheduled"); expect(group.querySelectorAll("input[type=date]")).toHaveLength(0);
    expect(rangeToggles(group)).toEqual({ active: "Start", start: rangeMoment(`${year}-05-30`, "09:00"), end: rangeMoment(`${year}-05-30`, "17:00") });
    // Nothing changed: Apply only closes.
    await applyPopup(group); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled(); expect(popupOf("Call client")).toBeNull();
    // An end at or before the start is refused, by time of day within one day.
    const editor = await openSchedule(host, "Call client"); await pickRangeEnd(editor, "End"); await typePopupTime(editor, "08:00");
    expect(editor.textContent).toContain("Start must be before end."); expect(popupButton(editor, "Apply")!.disabled).toBe(true);
    await typePopupTime(editor, "09:30"); expect(popupButton(editor, "Apply")!.disabled).toBe(false); await applyPopup(editor); await flush();
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: `${year}-05-30T09:00` }, end: { localCivil: `${year}-05-30T09:30` } } } });
    await openAssignees(assignee); await pickAssignee("Ada Smith"); await closeAssignees(); expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assignees: { expectedVersion: 1, add: ["30000000-0000-4000-8000-000000000003"], remove: [] } });
  });

  it("lets an existing range be edited: the control is enabled, shows both moments, and saves a versioned range PATCH", async () => {
    const rangeTask = { ...task, id: "range-1", title: "Existing range", position: 512, dueDate: `${year}-06-02T17:00`, schedule: presetScheduleDto(`${year}-06-01`, `${year}-06-02`, 1) };
    apiGetMock.mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: [rangeTask, second] }));
    apiPatchMock.mockResolvedValue(rangeTask);
    const host = mount(); await render();
    const control = item(host, "Existing range").querySelector<HTMLButtonElement>('[aria-label="Schedule for Existing range"]')!;
    expect(control.disabled).toBe(false);
    expect(control.textContent).toContain("1 Jun");
    const editor = await openSchedule(host, "Existing range");
    expect(rangeToggles(editor)).toEqual({ active: "Start", start: rangeMoment(`${year}-06-01`, "09:00"), end: rangeMoment(`${year}-06-02`, "17:00") });
    await pickRangeEnd(editor, "End"); await typePopupTime(editor, "18:00"); await applyPopup(editor); await flush();
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/range-1`, { schedule: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: `${year}-06-01T09:00` }, end: { localCivil: `${year}-06-02T18:00` } } } });
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
    apiGetMock.mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: deleted ? [second] : [task, second] }));
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
    const latest = { ...task, title: "Authoritative title", done: true, assignees: [ada], schedule: presetScheduleDto(`${year}-06-10`, `${year}-06-10`, 2) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Checklist item changed", 409, { code: "subtask_item_conflict", current: latest.schedule, currentSubtask: latest }));
    await draftDay(await openSchedule(host, "Call client"), `${year}-06-20`);
    const conflict = await openSchedule(host, "Call client");
    expect(rangeToggles(conflict).start).toBe(rangeMoment(`${year}-06-20`, "09:00")); expect(conflict.textContent).toContain("Authoritative title"); expect(conflict.textContent).toContain("Complete"); expect(conflict.textContent).toContain("Ada Smith"); expect(conflict.textContent).toContain("Use latest item (discard draft)"); expect(conflict.textContent).toContain("Apply reapplies your retained schedule draft; Cancel discards it.");
    await click([...conflict.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use latest item (discard draft)")!);
    // The authoritative item is done, so it now sits in the collapsed "Completed" group (#377).
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Completed ("))!); expect(item(host, "Authoritative title")).not.toBeNull();
  });

  it("keeps a retained schedule conflict draft when an unrelated Done update succeeds", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-06-10`, `${year}-06-10`, 2) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: latest.schedule }));
    await draftDay(await openSchedule(host, "Call client"), `${year}-06-20`);
    expect(rangeToggles(await openSchedule(host, "Call client")).start).toBe(rangeMoment(`${year}-06-20`, "09:00"));
    await click(item(host, "Call client").querySelector<HTMLInputElement>('input[type="checkbox"]')!); await flush();
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { done: true });
    // Done moves the row into the collapsed "Completed" group (#377); open it to reach the row.
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Completed ("))!);
    // An outside press closed the popup, but the retained draft and the conflict survive the remount: reopen it.
    const reopened = await ensureOpen(host, "Call client");
    expect(reopened.textContent).toContain("Latest schedule · v2");
    expect(rangeToggles(reopened).start).toBe(rangeMoment(`${year}-06-20`, "09:00"));
  });

  it("keeps the retained schedule draft when Done moves the row to Completed and the editor is reopened (#377)", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-06-10`, `${year}-06-10`, 2) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: latest.schedule }));
    await draftDay(await openSchedule(host, "Call client"), `${year}-06-20`);
    expect(rangeToggles(await openSchedule(host, "Call client")).start).toBe(rangeMoment(`${year}-06-20`, "09:00"));
    await keydown(popupOf("Call client"), "Escape"); await flush();
    await click(item(host, "Call client").querySelector<HTMLInputElement>('input[type="checkbox"]')!); await flush();
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Completed ("))!);
    const reopened = await openSchedule(host, "Call client");
    expect(reopened.textContent).toContain("Latest schedule · v2");
    expect(rangeToggles(reopened).start).toBe(rangeMoment(`${year}-06-20`, "09:00"));
    // Apply reapplies the draft against the latest version the conflict named, not the stored dates.
    apiPatchMock.mockResolvedValueOnce({ ...latest, done: true, schedule: presetScheduleDto(`${year}-06-20`, `${year}-06-20`, 3) });
    await applyPopup(reopened); await flush();
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, expect.objectContaining({ schedule: expect.objectContaining({ expectedVersion: 2 }) }));
  });

  it("keeps a retained schedule conflict draft when an unrelated rename succeeds", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-06-10`, `${year}-06-10`, 2) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: latest.schedule }));
    await draftDay(await openSchedule(host, "Call client"), `${year}-06-20`);
    await openSchedule(host, "Call client");
    await waitFor(() => expect(rangeToggles(popupOf("Call client")).start).toBe(rangeMoment(`${year}-06-20`, "09:00")));
    // An unrelated write landing (a rename). A Done tick used to be the unrelated write, but it now moves the row into the
    // "Completed" group, which remounts it and discards the popover draft by design (#377).
    await click(item(host, "Call client").querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!); const renameInput = item(host, "Call client").querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; await typeInto(renameInput, "Renamed item"); await keydown(renameInput, "Enter"); await flush();
    await waitFor(() => expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { title: "Renamed item" }));
    const reopened = await ensureOpen(host, "Renamed item");
    expect(reopened.textContent).toContain("Latest schedule · v2");
    expect(rangeToggles(reopened).start).toBe(rangeMoment(`${year}-06-20`, "09:00"));
  });

  it("preserves an open schedule draft when a late authoritative refresh arrives", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-refresh-test");
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [task, second]);
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
    const editor = await openSchedule(host, "Call client");
    await pickPopupDay(editor, `${year}-06-15`);
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [{ ...task, title: "Late authoritative title", dueDate: `${year}-07-01` }, second]);
    await flush();
    expect(rangeToggles(portal("subtask-popover-task-1-schedule")).start).toBe(rangeMoment(`${year}-06-15`, "09:00"));
    runtime.dispose(); queryClient.clear();
  });

  it("submits the schedule version captured at editor open after a late versioned refresh", async () => {
    const versionOne = { ...task, schedule: momentScheduleDto(`${year}-06-01T00:00`, `${year}-06-01T09:00`, 1) };
    const versionTwo = { ...versionOne, title: "Late version 2", dueDate: `${year}-06-02T09:00`, schedule: momentScheduleDto(`${year}-06-01T00:00`, `${year}-06-02T09:00`, 2) };
    apiGetMock.mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: [versionOne, second] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "subtask-version-refresh-test");
    queryClient.setQueryData(projectDataKeys.subtasks(projectId), [versionOne, second]);
    const host = mount();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
    const editor = await openSchedule(host, "Call client");
    // A stored range opens with its own start and end; the user moves the end to 10:00.
    expect(rangeToggles(editor)).toEqual({ active: "Start", start: rangeMoment(`${year}-06-01`, "00:00"), end: rangeMoment(`${year}-06-01`, "09:00") });
    await pickRangeEnd(editor, "End"); await typePopupTime(editor, "10:00");
    await act(async () => { queryClient.setQueryData(projectDataKeys.subtasks(projectId), [versionTwo, second]); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await flush();
    expect(item(host, "Late version 2")).not.toBeNull();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_conflict", current: versionTwo.schedule }));
    await applyPopup(popupOf("Late version 2")); await flush();
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: `${year}-06-01T00:00` }, end: { localCivil: `${year}-06-01T10:00` } } } });
    const conflict = await openSchedule(host, "Late version 2");
    expect(conflict.textContent).toContain("Latest schedule · v2");
    expect(rangeToggles(conflict).end).toBe(rangeMoment(`${year}-06-01`, "10:00"));
    runtime.dispose(); queryClient.clear();
  });

  it.each([[0 as const, "earlier" as const, 660], [1 as const, "later" as const, 600]])("seeds a timed range endpoint's stored fold %s into the popover as the %s Sydney occurrence", async (fold, disambiguation, offset) => {
    // 02:30 on 2026-04-05 happens twice in Sydney (DST ends): fold 0 is +11:00, fold 1 is +10:00.
    const stored = normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-04-05T00:00" }, end: { localCivil: "2026-04-05T02:30", disambiguation } }, 1);
    if (!stored.ok) throw new Error(stored.error.code);
    const repeated = { ...task, dueDate: "2026-04-05T02:30", schedule: checklistScheduleToDto(stored.value) };
    expect(repeated.schedule.end.utcOffsetMinutes).toBe(offset); expect(repeated.schedule.end.fold).toBe(fold);
    apiGetMock.mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: [repeated, second] }));
    const host = mount(); await render();
    const editor = await openSchedule(host, "Call client");
    expect(rangeToggles(editor)).toEqual({ active: "Start", start: rangeMoment(`${year}-04-05`, "00:00"), end: rangeMoment(`${year}-04-05`, "02:30") });
    // The End's Earlier / Later choice is seeded from the stored fold.
    const pressed = [...editor.querySelectorAll<HTMLButtonElement>('[aria-label="Which Sydney time, end"] button')].find((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed?.textContent?.startsWith(disambiguation === "earlier" ? "Earlier" : "Later")).toBe(true);
    // Moving only the start keeps the end's fold.
    await typePopupTime(editor, "00:30"); await applyPopup(editor); await flush();
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: "2026-04-05T00:30" }, end: { localCivil: "2026-04-05T02:30", disambiguation } } } });
  });

  it("uses one canonical schedule POST from the compact composer and preserves a failed draft", async () => {
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!); const input = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await click(host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')!); const editor = dateTimePopup("Schedule for new subtask")!; await pickPopupDay(editor, `${year}-06-02`); await applyPopup(editor); await typeInto(input, "Schedule staging"); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging", schedule: { state: "range", start: { localCivil: `${year}-06-02T09:00` }, end: { localCivil: `${year}-06-02T17:00` } } });
    await click(document.getElementById(`subtask-add-${projectId}`)!); const retry = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(retry, "Retry"); apiPostMock.mockRejectedValueOnce(new Error("No network")); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!); expect(retry.value).toBe("Retry"); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => retry.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(true); expect(document.getElementById(`subtask-add-${projectId}`)).not.toBeNull();
  });

  it("resets composer metadata on Cancel", async () => {
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!); const composer = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(composer, "Discard me"); await click(host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')!); const editor = dateTimePopup("Schedule for new subtask")!; await pickPopupDay(editor, `${year}-06-04`); await applyPopup(editor); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!); expect(document.activeElement).toBe(document.getElementById(`subtask-add-${projectId}`));
    await click(document.getElementById(`subtask-add-${projectId}`)!); expect(host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')?.textContent).toContain("Project default");
    // The reset returns to the Project default, not the stale range choice: an untouched Add sends no schedule.
    const retitled = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!; await typeInto(retitled, "After cancel"); await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks`, { title: "After cancel" });
  });

  it("shows the Project default on the composer trigger and posts no schedule when none was chosen", async () => {
    const projectDefaultRange = { start: { localCivil: `${year}-11-02T09:00`, fold: 0 as const }, end: { localCivil: `${year}-11-06T17:00`, fold: 0 as const } };
    const created = { ...task, id: "task-default", title: "Plain", position: 3072, dueDate: `${year}-11-06T17:00`, schedule: presetScheduleDto(`${year}-11-02`, `${year}-11-06`, 1) };
    let posted = false;
    apiGetMock.mockImplementation((path) => path.includes("subtask-assignee-options") ? Promise.resolve(optionsResponse) : Promise.resolve({ subtasks: posted ? [task, second, created] : [task, second], projectDefaultRange }));
    apiPostMock.mockImplementationOnce(() => { posted = true; return Promise.resolve(created); });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = mount(); await act(async () => { root!.render(<QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    for (let attempt = 0; attempt < 50 && document.body.textContent?.includes("Loading checklist…"); attempt += 1) await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); });
    await click(document.getElementById(`subtask-add-${projectId}`)!);
    const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')!;
    const defaultText = formatCivilRange(projectDefaultRange);
    expect(trigger().textContent).toContain(defaultText); expect(trigger().textContent).not.toContain("◷"); expect(trigger().getAttribute("aria-label")).toBe(`Schedule for new subtask: ${defaultText}`);
    // The popup seeds from the default, so its toggles already show the Project's range.
    await click(trigger()); expect(rangeToggles(dateTimePopup("Schedule for new subtask")!)).toMatchObject({ start: rangeMoment(`${year}-11-02`, "09:00"), end: rangeMoment(`${year}-11-06`, "17:00") }); await click(popupButton(dateTimePopup("Schedule for new subtask")!, "Cancel")!);
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!, "Plain");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Plain" });
    await waitFor(() => expect(item(host, "Plain").textContent).toContain(formatSchedule(created.schedule)));
  });

  it("sends a chosen range from the composer, and cannot choose Unscheduled (Apply waits for both ends)", async () => {
    const host = mount(); await render(); await click(document.getElementById(`subtask-add-${projectId}`)!);
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!, "Chosen range");
    await click(host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')!);
    const editor = dateTimePopup("Schedule for new subtask")!;
    expect(rangeToggles(editor)).toEqual({ active: "Start", start: "Not set", end: "Not set" });
    await pickPopupDay(editor, `${year}-06-04`); expect(rangeToggles(editor)).toEqual({ active: "End", start: rangeMoment(`${year}-06-04`, "09:00"), end: rangeMoment(`${year}-06-04`, "17:00") });
    await pickPopupDay(editor, `${year}-06-06`); expect(popupButton(editor, "Apply")!.disabled).toBe(false); await applyPopup(editor);
    expect(host.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new subtask"]')?.textContent).not.toContain("Project default");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Chosen range", schedule: { state: "range", start: { localCivil: `${year}-06-04T09:00` }, end: { localCivil: `${year}-06-06T17:00` } } });
  });

  it("derives pure reorder neighbors and mounts grip-only activators", async () => {
    expect(reorderNeighbors(["a", "b", "c"], "c", "a")).toMatchObject({ beforeId: null, afterId: "a" }); expect(reorderNeighbors(["a", "b", "c"], "a", "b")).toMatchObject({ beforeId: "b", afterId: "c" }); expect(reorderNeighbors(["a", "b", "c"], "b", "c")).toMatchObject({ beforeId: "c", afterId: null }); expect(reorderNeighbors(["a", "b"], "a", null)).toBeNull(); expect(reorderNeighbors(["a", "b"], "a", "a")).toBeNull();
    const host = mount(); await render(); const row = item(host, "Call client"); const grip = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; expect(grip.getAttribute("aria-roledescription")).toBe("sortable"); expect(grip.getAttribute("aria-describedby")).toMatch(/^DndDescribedBy-/); for (const control of [row.querySelector("input"), row.querySelector('[data-testid="subtask-checklist-title"]'), row.querySelector('[aria-label="Schedule for Call client"]'), row.querySelector('[aria-label="Assignees for Call client"]'), row.querySelector('[aria-label="Actions for Call client"]')]) { expect(control?.getAttribute("aria-roledescription")).toBeNull(); expect(control?.getAttribute("aria-describedby")).toBeNull(); }
    const surviving = row.querySelector<HTMLButtonElement>('[aria-label="Reorder Call client"]')!; scheduleReorderFocus(new Map([["task-1", surviving]]), "task-1", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(surviving);
    const nearest = document.createElement("button"); const last = document.createElement("button"); document.body.append(nearest, last); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 0, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(nearest); scheduleReorderFocus(new Map([["next", nearest], ["last", last]]), "missing", 99, false, null, projectId); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); }); expect(document.activeElement).toBe(last);
  });

  it("moves the picker's highlight with Arrow keys and toggles with Enter, committing once on Escape (§10.3)", async () => {
    const host = mount(); await render();
    await openAssignees(assigneeTrigger(host));
    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search people…"]')!;
    expect(pickerOptions().map(optionName)).toEqual(["Nora Jones", "Ada Smith", "Ben Ortiz", "Cy Young", "Dee Park"]);
    // The current assignee is listed first and checked.
    expect(pickerOptions()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(pickerOptions()[1]?.getAttribute("aria-selected")).toBe("false");
    // ArrowDown highlights the first row (the current assignee); Enter unpicks her.
    await keydown(search, "ArrowDown"); await keydown(search, "Enter");
    await waitFor(() => expect(pickerOptions()[0]?.getAttribute("aria-selected")).toBe("false"));
    // The next row is picked the same way.
    await keydown(search, "ArrowDown"); await keydown(search, "Enter");
    await waitFor(() => expect(pickerOptions()[1]?.getAttribute("aria-selected")).toBe("true"));
    expect(apiPatchMock).not.toHaveBeenCalled();
    await closeAssignees();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { assignees: { expectedVersion: 1, add: ["30000000-0000-4000-8000-000000000003"], remove: ["20000000-0000-4000-8000-000000000002"] } });
  });

  it("does not reload the checklist when a parent re-render passes a new onAccessFailure identity", async () => {
    const host = document.createElement("div"); document.body.appendChild(host); const localRoot = createRoot(host);
    try {
      await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => {}} />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1);
      for (let index = 0; index < 5; index += 1) await act(async () => { localRoot.render(<SubtaskChecklist projectId={projectId} onAccessFailure={() => {}} />); await Promise.resolve(); });
      expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1); expect(apiGetMock.mock.calls.filter(([path]) => path.includes("subtask-assignee-options")).length).toBe(0);
    } finally { await act(async () => localRoot.unmount()); }
  });
});

describe("SubtaskChecklist assignees (#368)", () => {
  const withAssignees = (people: typeof nora[], version = 1) => ({ ...task, assignees: people, assignmentVersion: version });
  const patchUrl = `/api/projects/${projectId}/subtasks/task-1`;

  it("returns focus to the trigger after Escape commits a changed selection, while the save is in flight and after it settles (#368)", async () => {
    const host = mount(); await render();
    let settle!: (value: unknown) => void;
    apiPatchMock.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const trigger = assigneeTrigger(host);
    await act(async () => { trigger.focus(); });
    await openAssignees(trigger);
    await pickAssignee("Ada Smith");
    await closeAssignees();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(assigneeTrigger(host)).toBe(trigger);
    expect(trigger.disabled).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await act(async () => { settle(withAssignees([nora, ada], 2)); await Promise.resolve(); });
    await flush();
    expect(assigneeTrigger(host)).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("picks four people and commits one PATCH on close; the trigger then shows two avatars and +3", async () => {
    const host = mount(); await render();
    apiPatchMock.mockResolvedValueOnce(withAssignees([nora, ada, ben, cy, dee], 2));
    await openAssignees(assigneeTrigger(host));
    for (const name of ["Ada Smith", "Ben Ortiz", "Cy Young", "Dee Park"]) await pickAssignee(name);
    expect(apiPatchMock).not.toHaveBeenCalled();
    await closeAssignees();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(patchUrl, { assignees: { expectedVersion: 1, add: ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004", "50000000-0000-4000-8000-000000000005", "60000000-0000-4000-8000-000000000006"], remove: [] } });
    await flush();
    expect(stackLabels(assigneeTrigger(host))).toEqual(["Nora Jones", "Ada Smith", "3 more Assignees"]);
  });

  it("shows two avatars and +2 for four assignees", async () => {
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("subtask-assignee-options") ? optionsResponse : { subtasks: [withAssignees([nora, ada, ben, cy]), second] }));
    const host = mount(); await render();
    expect(stackLabels(assigneeTrigger(host))).toEqual(["Nora Jones", "Ada Smith", "2 more Assignees"]);
    expect(assigneeTrigger(host).textContent).toContain("+2");
  });

  it("unchecking one person commits one PATCH that only removes them", async () => {
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("subtask-assignee-options") ? optionsResponse : { subtasks: [withAssignees([nora, ada]), second] }));
    const host = mount(); await render();
    apiPatchMock.mockResolvedValueOnce(withAssignees([nora], 2));
    await openAssignees(assigneeTrigger(host));
    await pickAssignee("Ada Smith");
    await closeAssignees();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(patchUrl, { assignees: { expectedVersion: 1, add: [], remove: ["30000000-0000-4000-8000-000000000003"] } });
  });

  it("ticking Done sends exactly one PATCH for the Subtask, however many assignees it has", async () => {
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("subtask-assignee-options") ? optionsResponse : { subtasks: [withAssignees([nora, ada, ben]), second] }));
    const host = mount(); await render();
    apiPatchMock.mockResolvedValueOnce({ ...withAssignees([nora, ada, ben]), done: true });
    await click(item(host, "Call client").querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(patchUrl, { done: true });
  });

  async function mountWithClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = mount();
    await act(async () => { root!.render(<QueryClientProvider client={client}><SubtaskChecklist projectId={projectId} /></QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); });
    for (let attempt = 0; attempt < 50 && document.body.textContent?.includes("Loading checklist…"); attempt += 1) await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 5)); });
    return { host, client };
  }

  it("closing an untouched picker sends nothing when another user's assignment landed while it was open (#368 review)", async () => {
    const { host, client } = await mountWithClient();
    await openAssignees(assigneeTrigger(host));
    await act(async () => { client.setQueryData(projectDataKeys.subtasks(projectId), [withAssignees([nora, ben], 2), second]); await Promise.resolve(); }); await flush();
    // The refetch reached the open picker (selected people list first): the stale-diff the old code sent from is in place.
    await waitFor(() => expect(pickerOptions().map(optionName).slice(0, 2)).toEqual(["Nora Jones", "Ben Ortiz"]));
    await closeAssignees();
    await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    // The refetch really landed (so the old code had a stale-diff to send).
    expect(stackLabels(assigneeTrigger(host))).toEqual(["Nora Jones", "Ben Ortiz"]);
  });

  it("a user edit after another user's assignment landed is sent at the version it opened on, so the conflict path shows the latest", async () => {
    const { host, client } = await mountWithClient();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Assignees changed", 409, { code: "subtask_assignment_version_conflict", currentSubtask: withAssignees([nora, ben, ada], 3) }));
    await openAssignees(assigneeTrigger(host));
    await act(async () => { client.setQueryData(projectDataKeys.subtasks(projectId), [withAssignees([nora, ben], 2), second]); await Promise.resolve(); }); await flush();
    await pickAssignee("Ada Smith");
    await closeAssignees();
    await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(patchUrl, { assignees: { expectedVersion: 1, add: ["30000000-0000-4000-8000-000000000003"], remove: [] } });
    expect(host.textContent).toContain("Assignees changed elsewhere — showing the latest.");
  });

  it("an assignment-version conflict shows the latest assignees and says so", async () => {
    const host = mount(); await render();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Assignees changed", 409, { code: "subtask_assignment_version_conflict", currentSubtask: withAssignees([ada, cy], 4) }));
    await openAssignees(assigneeTrigger(host));
    await pickAssignee("Ben Ortiz");
    await closeAssignees();
    await flush();
    expect(stackLabels(assigneeTrigger(host))).toEqual(["Ada Smith", "Cy Young"]);
    expect(host.textContent).toContain("Assignees changed elsewhere — showing the latest.");
  });

  it("an item conflict from a lost assignee write refetches the checklist and keeps the user informed", async () => {
    const host = mount(); await render();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Checklist item changed; review the latest item before saving.", 409, { code: "subtask_item_conflict", current: task.schedule, currentSubtask: withAssignees([nora, dee], 3) }));
    await openAssignees(assigneeTrigger(host));
    await pickAssignee("Ben Ortiz");
    await closeAssignees();
    await flush();
    expect(host.textContent).toContain("Checklist item changed");
    expect(stackLabels(assigneeTrigger(host))).toEqual(["Nora Jones", "Dee Park"]);
  });

  it("the composer sends every picked person as assigneeIds", async () => {
    const host = mount(); await render();
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ Add an item")!);
    const composerTrigger = host.querySelector<HTMLButtonElement>('[aria-label="Assignees for new subtask"]')!;
    await openAssignees(composerTrigger);
    await pickAssignee("Ada Smith"); await pickAssignee("Ben Ortiz");
    await closeAssignees();
    expect(stackLabels(composerTrigger)).toEqual(["Ada Smith", "Ben Ortiz"]);
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="Add a subtask…"]')!, "Schedule staging");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Schedule staging", assigneeIds: ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"] });
  });

  it("the composer omits assigneeIds when nobody is picked", async () => {
    const host = mount(); await render();
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ Add an item")!);
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="Add a subtask…"]')!, "Plain");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Plain" });
  });
});

describe("formatSchedule", () => {
  it("names a same-day range's date once, with both times", () => {
    expect(formatSchedule(momentScheduleDto("2026-10-08T09:00", "2026-10-08T17:00"))).toBe("Thu 8 Oct 09:00 → 17:00");
    expect(formatSchedule(momentScheduleDto("2026-10-08T13:00", "2026-10-08T14:00"))).toBe("Thu 8 Oct 13:00 → 14:00");
  });
  it("keeps a multi-day range as two full moments", () => {
    expect(formatSchedule(momentScheduleDto("2026-10-08T09:00", "2026-10-10T17:00"))).toBe("Thu 8 Oct 09:00 → Sat 10 Oct 17:00");
    expect(formatSchedule(momentScheduleDto("2026-10-08T13:00", "2026-10-09T09:00"))).toBe("Thu 8 Oct 13:00 → Fri 9 Oct 09:00");
  });
});
