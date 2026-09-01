import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, resolveSydneyCivilMinute, type ChecklistCalendarEventDto, type ChecklistCalendarUnscheduledEntryDto } from "@quincy/shared";
import { ProductionCalendarScheduleEditor } from "./ProductionCalendarScheduleEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "11111111-1111-4111-8111-111111111111", street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
const person = { id: "22222222-2222-4222-8222-222222222222", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const timedEndpoint = (localCivil: string) => ({ kind: "timed" as const, localCivil, instant: "2026-08-20T00:00:00.000Z", utcOffsetMinutes: 600, fold: 0 as const, resolution: "stored" as const });
const dueEvent: ChecklistCalendarEventDto = { id: "checklist:33333333-3333-4333-8333-333333333333", kind: "checklist", title: "Select hero images", project, assignee: person, timing: { allDay: true, start: "2026-08-20", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "due_only", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: dateEndpoint("2026-08-20"), due: "2026-08-20" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
const legacyEntry: ChecklistCalendarUnscheduledEntryDto = { id: "checklist:legacy", kind: "checklist", title: "Repair this date", project, assignee: null, reason: "schedule_needs_attention", attentionReason: "legacy_unresolved", schedule: { state: "legacy_unresolved", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: "2026-08-20T09:00", error: { code: "subtask_schedule_legacy_unresolved", reason: "repeated_local_time" } }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };

describe("ProductionCalendarScheduleEditor", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

  async function render(event: ChecklistCalendarEventDto | ChecklistCalendarUnscheduledEntryDto = dueEvent, rangesEnabled = true, onSubmit = vi.fn()) {
    await act(async () => { root.render(<ProductionCalendarScheduleEditor open event={event} rangesEnabled={rangesEnabled} onSubmit={onSubmit} onCancel={vi.fn()} />); await Promise.resolve(); });
    return onSubmit;
  }

  function select(label: string): HTMLSelectElement {
    return document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  }

  async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  }

  it("offers the three states and disables Range in inert mode", async () => {
    await render(dueEvent, false);
    const range = [...select("Checklist schedule state").options].find((option) => option.value === "range")!;
    expect(range.disabled).toBe(true);
    expect(document.body.textContent).toContain("Timed · Australia/Sydney");
  });

  it("keeps endpoint mode homogeneous and surfaces local preflight errors", async () => {
    await render();
    await change(select("Checklist schedule state"), "range");
    await change(select("Checklist endpoint mode"), "timed");
    const startDate = document.querySelector<HTMLInputElement>('[aria-label="Checklist start date"]')!;
    const endDate = document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!;
    const startTime = document.querySelector<HTMLInputElement>('[aria-label="Checklist start time"]')!;
    const endTime = document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')!;
    expect(document.querySelectorAll('select[aria-label="Checklist endpoint mode"]')).toHaveLength(1);
    await change(startDate, "2026-08-20"); await change(startTime, "10:00"); await change(endDate, "2026-08-20"); await change(endTime, "09:00");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("start must be before");
    await change(startDate, "2026-10-04"); await change(startTime, "02:30"); await change(endDate, "2026-10-04"); await change(endTime, "04:00");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("does not exist");
  });

  it("asks for a fold choice independently at the endpoint that repeats", async () => {
    const onSubmit = await render(dueEvent, true);
    await change(select("Checklist schedule state"), "range"); await change(select("Checklist endpoint mode"), "timed");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start date"]')!, "2026-04-05"); await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start time"]')!, "02:30");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-04-05"); await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')!, "04:00");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain("Earlier"); expect(document.body.textContent).toContain("Later"); expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="radio"][value="earlier"]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-04-05T04:00" } });
  });

  it("collects independent fold choices for both range endpoints", async () => {
    const onSubmit = await render(dueEvent, true);
    await change(select("Checklist schedule state"), "range"); await change(select("Checklist endpoint mode"), "timed");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start date"]')!, "2026-04-05"); await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist start time"]')!, "02:30");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-04-05"); await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')!, "02:30");
    const folds = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(folds).toHaveLength(4);
    await act(async () => { folds[0]!.click(); folds[3]!.click(); await Promise.resolve(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } });
  });

  it("seeds a stored fold with the matching endpoint occurrence selected", async () => {
    const resolved = resolveSydneyCivilMinute("2026-04-05T02:30", "earlier");
    if (!resolved.ok) throw new Error("fold fixture did not resolve");
    const event = {
      ...dueEvent,
      id: "checklist:stored-fold",
      timing: { allDay: false as const, start: resolved.value.instant, end: null },
      schedule: {
        ...dueEvent.schedule,
        due: "2026-04-05T02:30",
        end: { kind: "timed" as const, localCivil: "2026-04-05T02:30", instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: 0 as const, resolution: "stored" as const },
      },
    };
    await render(event);
    await change(select("Checklist endpoint mode"), "timed");
    expect(document.querySelector<HTMLInputElement>('input[type="radio"][value="earlier"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')?.checked).toBe(false);
  });

  it("seeds a legacy unresolved entry for complete replacement and cancels", async () => {
    const onSubmit = await render(legacyEntry);
    expect(select("Checklist schedule state").value).toBe("due_only");
    expect(select("Checklist endpoint mode").value).toBe("timed");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')?.value).toBe("2026-08-20");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')?.value).toBe("09:00");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-cancel"]')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a complete legacy replacement as a version-zero schedule command", async () => {
    const requests: unknown[] = [];
    const onSubmit = vi.fn((schedule) => requests.push({ schedule: { expectedVersion: legacyEntry.schedule.version, schedule } }));
    await render(legacyEntry, true, onSubmit);
    await change(select("Checklist schedule state"), "due_only");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end date"]')!, "2026-08-25");
    await change(document.querySelector<HTMLInputElement>('[aria-label="Checklist end time"]')!, "09:00");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-schedule-submit"]')!.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(requests).toEqual([{ schedule: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "timed", localCivil: "2026-08-25T09:00" } } } }]);
    expect(JSON.stringify(requests[0])).not.toContain("dueDate");
  });
});
