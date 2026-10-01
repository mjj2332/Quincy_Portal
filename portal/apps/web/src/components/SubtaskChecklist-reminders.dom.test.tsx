/**
 * Seam E wiring (#425), Checklist row and composer: the range popup carries the Subtask's reminder set. The row saves it through
 * the schedule PATCH; the composer holds it as local state until Add posts it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { SubtaskChecklist } from "./SubtaskChecklist";
import { applyPopup, dateTimePopup, pickPopupDay, popupButton } from "@/testing/date-time-popup";
import { presetScheduleDto, subtaskReminders } from "@/testing/subtask-schedule";

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => { const actual = await importOriginal<typeof import("../lib/api")>(); return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: vi.fn() }; });

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const projectId = "11111111-1111-4111-8111-111111111111";
const year = new Date().getFullYear();
const task = { id: "task-1", title: "Call client", done: false, position: 1024, assignees: [], assignmentVersion: 0, dueDate: `${year}-05-30`, schedule: presetScheduleDto(`${year}-05-30`, `${year}-05-30`, 1), reminders: subtaskReminders([1440]), createdBy: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
let root: Root | null = null;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render() { await act(async () => { root!.render(<SubtaskChecklist projectId={projectId} />); await Promise.resolve(); }); for (let attempt = 0; attempt < 5; attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }
const popupOf = (label: string) => dateTimePopup(label)!;
const chip = (popup: HTMLElement, name: string) => popupButton(popup, name)!;
const scheduleTrigger = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)!;

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path) => Promise.resolve(path.includes("subtask-assignee-options") ? { candidates: [] } : { subtasks: [task] }));
  apiPostMock.mockReset().mockResolvedValue({ ...task, id: "task-new", title: "New", position: 2048 });
  apiPatchMock.mockReset().mockResolvedValue(task);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("Checklist reminders editing (#425)", () => {
  it("the row's popup shows the stored set and saves a reminders-only edit at the row's version", async () => {
    const host = mount(); await render();
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const popup = popupOf("Schedule for Call client");
    expect(chip(popup, "1 day").getAttribute("aria-pressed")).toBe("true");
    await click(chip(popup, "4 hours"));
    await applyPopup(popup);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 1, schedule: { state: "range", start: { localCivil: `${year}-05-30T09:00` }, end: { localCivil: `${year}-05-30T17:00` } }, reminderOffsetsMinutes: [1440, 240] } });
  });

  it("a range-only edit leaves the offsets out of the request, so a concurrently changed set is never clobbered", async () => {
    const host = mount(); await render();
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const popup = popupOf("Schedule for Call client");
    await pickPopupDay(popup, `${year}-06-02`);
    await applyPopup(popup);
    const body = apiPatchMock.mock.calls[0]![1] as { schedule: Record<string, unknown> };
    expect(body.schedule).not.toHaveProperty("reminderOffsetsMinutes");
  });

  it("a schedule conflict shows the latest reminders, and Use latest schedule adopts them", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-06-10`, `${year}-06-10`, 2), reminders: subtaskReminders([60]) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_version_conflict", current: latest.schedule, currentSubtask: latest }));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    await click(chip(popupOf("Schedule for Call client"), "4 hours"));
    await applyPopup(popupOf("Schedule for Call client"));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const conflict = popupOf("Schedule for Call client");
    expect(conflict.textContent).toContain("Latest schedule · v2");
    expect(conflict.textContent).toContain("Reminders: 1 hour, Due now");
    await click(chip(conflict, "Use latest schedule (discard draft)"));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const reopened = popupOf("Schedule for Call client");
    expect(chip(reopened, "1 hour").getAttribute("aria-pressed")).toBe("true");
    expect(chip(reopened, "1 day").getAttribute("aria-pressed")).toBe("false");
  });

  it("reapplying a conflicted reminders draft sends the retained offsets at the latest version", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-05-30`, `${year}-05-30`, 2), reminders: subtaskReminders([60]) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_version_conflict", current: latest.schedule, currentSubtask: latest }));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    await click(chip(popupOf("Schedule for Call client"), "4 hours"));
    await applyPopup(popupOf("Schedule for Call client"));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const conflict = popupOf("Schedule for Call client");
    expect(chip(conflict, "4 hours").getAttribute("aria-pressed")).toBe("true");
    expect(chip(conflict, "1 day").getAttribute("aria-pressed")).toBe("true");
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    await applyPopup(conflict);
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/subtasks/task-1`, { schedule: { expectedVersion: 2, schedule: { state: "range", start: { localCivil: `${year}-05-30T09:00` }, end: { localCivil: `${year}-05-30T17:00` } }, reminderOffsetsMinutes: [1440, 240] } });
  });

  it("a range-only conflict then reapply sends no offsets and the reopened popup shows the latest set, so another user's reminders survive", async () => {
    const host = mount(); await render();
    const latest = { ...task, schedule: presetScheduleDto(`${year}-05-30`, `${year}-05-30`, 2), reminders: subtaskReminders([60]) };
    apiPatchMock.mockRejectedValueOnce(new ApiError("Schedule changed", 409, { code: "subtask_schedule_version_conflict", current: latest.schedule, currentSubtask: latest }));
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const first = popupOf("Schedule for Call client");
    await pickPopupDay(first, `${year}-06-02`);
    await applyPopup(first);
    await click(scheduleTrigger(host, "Schedule for Call client"));
    const conflict = popupOf("Schedule for Call client");
    expect(chip(conflict, "1 hour").getAttribute("aria-pressed")).toBe("true");
    expect(chip(conflict, "1 day").getAttribute("aria-pressed")).toBe("false");
    await applyPopup(conflict);
    expect(apiPatchMock).toHaveBeenCalledTimes(2);
    const body = apiPatchMock.mock.calls[1]![1] as { schedule: Record<string, unknown> };
    expect(body.schedule.expectedVersion).toBe(2);
    expect(body.schedule).not.toHaveProperty("reminderOffsetsMinutes");
  });

  it("the composer sets reminders locally and Add posts them with the title, hiding the next-reminder line", async () => {
    const host = mount(); await render();
    await click(document.getElementById(`subtask-add-${projectId}`)!);
    await click(scheduleTrigger(host, "Schedule for new subtask"));
    const popup = popupOf("Schedule for new subtask");
    expect(popup.textContent).not.toContain("Next reminder");
    expect(popup.textContent).not.toContain("Currently saved");
    await pickPopupDay(popup, `${year}-06-02`);
    await click(chip(popup, "4 hours"));
    await applyPopup(popup);
    expect(apiPostMock).not.toHaveBeenCalled();
    const input = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Stage"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtasks`, { title: "Stage", schedule: { state: "range", start: { localCivil: `${year}-06-02T09:00` }, end: { localCivil: `${year}-06-02T17:00` } }, reminderOffsetsMinutes: [1440, 240] });
  });

  it("Cancel resets the composer's reminders to the default", async () => {
    const host = mount(); await render();
    await click(document.getElementById(`subtask-add-${projectId}`)!);
    await click(scheduleTrigger(host, "Schedule for new subtask"));
    await click(chip(popupOf("Schedule for new subtask"), "4 hours"));
    await applyPopup(popupOf("Schedule for new subtask"));
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    await click(document.getElementById(`subtask-add-${projectId}`)!);
    await click(scheduleTrigger(host, "Schedule for new subtask"));
    const popup = popupOf("Schedule for new subtask");
    expect(chip(popup, "1 day").getAttribute("aria-pressed")).toBe("true");
    expect(chip(popup, "4 hours").getAttribute("aria-pressed")).toBe("false");
  });
});
