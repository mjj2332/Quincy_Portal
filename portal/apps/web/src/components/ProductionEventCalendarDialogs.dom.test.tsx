/**
 * #222 step 5 — the event-calendar renderer's dialogs: move (Deadline), fold choice, schedule
 * editor (sheet) and the Deadline confirm, as `reui/alert-dialog` / `reui/sheet` shells. Ports the
 * validation / fold / reminder / draft assertions of `ProductionCalendarMoveDialog.dom.test.tsx`,
 * `ProductionCalendarScheduleEditor.dom.test.tsx` and `ProductionCalendarMoveConfirmation.dom.test.tsx`
 * onto the new shells.
 *
 * Guard F (`test-seam.guard.test.ts`): no vendor `data-slot` selectors — every hook is a
 * `data-testid` these components author, or an accessible name.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PRODUCTION_CALENDAR_ZONE,
  checklistScheduleToDto,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  type ChecklistCalendarEventDto,
  type ProjectDeadlineCalendarEventDto,
} from "@quincy/shared";
import {
  civilParts,
  validCivil,
  ProductionEventCalendarDialogs,
  ProductionEventCalendarFoldChoice,
  ProductionEventCalendarMoveDialog,
  ProductionEventCalendarScheduleEditorSheet,
  type ProductionEventCalendarDialogCommands,
} from "./ProductionEventCalendarDialogs";
import { Sheet } from "./reui/sheet";
import { applyPopup, dateTimePopup, openFieldPopup, openMoveDialogField, pickPopupDateTime, pickPopupDay, pickRangeEnd, popupButton, popupDraft, pressInPopup, pressRangeFold, rangeFoldPressed, rangeToggles, typePopupTime, rangeMoment } from "@/testing/date-time-popup";
import { startMoment, endMoment } from "@/testing/subtask-schedule";
import { subtaskReminders } from "@/testing/subtask-schedule";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "11111111-1111-4111-8111-111111111111", street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false, archived: false };
const person = { id: "22222222-2222-4222-8222-222222222222", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };

const deadline: ProjectDeadlineCalendarEventDto = {
  id: "project-deadline:11111111-1111-4111-8111-111111111111", kind: "project_deadline", title: "Deadline", project,
  timing: { allDay: false, start: "2026-08-10T23:30:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
  permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-11T09:30", deadlineVersion: 7, reminderOffsetsMinutes: [1440, 60],
};

const dueEvent: ChecklistCalendarEventDto = { id: "checklist:33333333-3333-4333-8333-333333333333", kind: "checklist", title: "Select hero images", project, assignees: [person], otherAssigneeCount: 0, timing: { allDay: true, start: "2026-08-20", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startMoment("2026-08-20"), end: endMoment("2026-08-20"), due: "2026-08-20" }, reminders: subtaskReminders(), permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true } };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); document.body.replaceChildren(); });

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); await Promise.resolve(); await Promise.resolve(); });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`);
}

function input(label: string): HTMLInputElement {
  return document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); });
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
}

describe("ProductionEventCalendarMoveDialog (alert-dialog shell)", () => {
  async function renderMove(props: Partial<ComponentProps<typeof ProductionEventCalendarMoveDialog>> = {}) {
    await render(<ProductionEventCalendarMoveDialog open event={deadline} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />);
  }

  it("seeds the date-time field from the event's Sydney civil time and names the street", async () => {
    await renderMove();
    const popup = await openMoveDialogField();
    expect(popupDraft(popup)).toEqual({ day: "2026-08-11", time: "09:30" });
    expect(byTestId("event-calendar-move-dialog")?.textContent).toContain("12 Harbour Street");
    expect(byTestId("event-calendar-move-dialog")?.querySelector('input[type="date"], input[type="time"]')).toBeNull();
  });

  it("disables submit for a malformed civil value", async () => {
    await renderMove({ initialCivil: "not-a-civil" });
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(true);
  });

  it("asks Earlier or Later for a repeated Sydney time, and passes the civil value, disambiguation and reminders, without also cancelling", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    await renderMove({ initialCivil: "2026-04-05T02:30", onSubmit, onCancel });
    // The draft has no choice yet, so it cannot be submitted.
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(true);
    const popup = await openMoveDialogField();
    expect(popup.textContent).toContain("Earlier (UTC+11:00)");
    expect(popup.textContent).toContain("Later (UTC+10:00)");
    await pressInPopup(popup, "Later (UTC+10:00)");
    await applyPopup(popup);
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(false);
    await click(byTestId("event-calendar-move-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("2026-04-05T02:30", "later", [1440, 60]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("starts an unresolved repeated time with neither Earlier nor Later chosen, and blocks Apply until one is pressed", async () => {
    const onSubmit = vi.fn();
    // A drag onto 02:30 on the fall-back day arrives with no disambiguation at all.
    await renderMove({ initialCivil: "2026-04-05T02:30", onSubmit });
    const popup = await openMoveDialogField();
    expect(popupButton(popup, "Earlier (UTC+11:00)")?.getAttribute("aria-pressed")).toBe("false");
    expect(popupButton(popup, "Later (UTC+10:00)")?.getAttribute("aria-pressed")).toBe("false");
    // Touch the draft (a reminder), so Apply would hand it back; it still needs a choice.
    await pressInPopup(popup, "4 hours");
    expect(popupButton(popup, "Apply")?.disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(true);
    await pressInPopup(popup, "Earlier (UTC+11:00)");
    expect(popupButton(popup, "Apply")?.disabled).toBe(false);
  });

  it("keeps the stored occurrence selected when the draft is the stored repeated time", async () => {
    const resolved = resolveSydneyCivilMinute("2026-04-05T02:30", "later");
    if (!resolved.ok) throw new Error("fold fixture did not resolve");
    const stored = { ...deadline, deadlineLocalCivil: "2026-04-05T02:30", timing: { allDay: false as const, start: resolved.value.instant, end: null } };
    await renderMove({ event: stored });
    const popup = await openMoveDialogField();
    expect(popupButton(popup, "Later (UTC+10:00)")?.getAttribute("aria-pressed")).toBe("true");
    expect(popupButton(popup, "Earlier (UTC+11:00)")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("loads the stored next reminder on a cold cache, and does not reseed an open draft when it arrives", async () => {
    let release: (detail: unknown) => void = () => undefined;
    apiGetMock.mockReset().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(<QueryClientProvider client={client}><ProductionEventCalendarMoveDialog open event={deadline} onSubmit={vi.fn()} onCancel={vi.fn()} /></QueryClientProvider>);
    const popup = await openMoveDialogField();
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${deadline.project.id}`);
    expect(popup.textContent).not.toContain("next reminder");
    await pressInPopup(popup, "4 hours");
    await act(async () => { release({ deadlineSchedule: { nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-08-10T09:30:00.000Z" } } }); await Promise.resolve(); await Promise.resolve(); });
    expect(popup.textContent).toContain("Currently saved: next reminder");
    expect(popup.textContent).toContain("1 day");
    // The draft the user was editing is untouched by the arrival.
    expect(popupButton(popup, "4 hours")?.getAttribute("aria-pressed")).toBe("true");
    client.clear();
  });

  it("starts a retry on the attempted fold and reminders", async () => {
    const onSubmit = vi.fn();
    await renderMove({ initialCivil: "2026-04-05T02:30", initialDisambiguation: "earlier", initialReminderOffsets: [240], onSubmit });
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(false);
    await click(byTestId("event-calendar-move-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("2026-04-05T02:30", "earlier", [240]);
  });

  it("edits date, time and reminders before submitting", async () => {
    const onSubmit = vi.fn();
    await renderMove({ onSubmit });
    const popup = await openMoveDialogField();
    await pickPopupDateTime(popup, "2026-08-20T15:45");
    await pressInPopup(popup, "4 hours");
    await applyPopup(popup);
    await click(byTestId("event-calendar-move-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("2026-08-20T15:45", undefined, [1440, 240, 60]);
  });

  it("keeps the dialog open when the field's popup is applied or dismissed with Escape", async () => {
    const onCancel = vi.fn();
    await renderMove({ onCancel });
    const popup = await openMoveDialogField();
    await pickPopupDay(popup, "2026-08-20");
    // A real key press lands on the focused control inside the popup.
    const target = popup.contains(document.activeElement) ? document.activeElement! : popup;
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    expect(dateTimePopup("Deadline")).toBeNull();
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    // The discarded draft left the dialog's own value alone.
    expect(popupDraft(await openMoveDialogField()).day).toBe("2026-08-11");
    await applyPopup(dateTimePopup("Deadline")!);
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels through Cancel and through Escape", async () => {
    const onCancel = vi.fn();
    await renderMove({ onCancel });
    await click(byTestId("event-calendar-move-cancel")!);
    expect(onCancel).toHaveBeenCalledOnce();
    await act(async () => { byTestId("event-calendar-move-dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("renders its scrim inside the shell's closed Sheet", async () => {
    await render(<Sheet open={false}><ProductionEventCalendarMoveDialog open event={deadline} onSubmit={vi.fn()} onCancel={vi.fn()} /></Sheet>);
    expect(byTestId("alert-dialog-scrim")).not.toBeNull();
  });
});

describe("ProductionEventCalendarFoldChoice (alert-dialog shell)", () => {
  it("requires a choice, submits it once, and cancels", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    await render(<ProductionEventCalendarFoldChoice open endpoint="end" eyebrow="12 Harbour Street" choices={[{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }]} onSubmit={onSubmit} onCancel={onCancel} />);
    const dialog = byTestId("event-calendar-fold-choice")!;
    expect(dialog.textContent).toContain("End occurs twice in Sydney");
    expect(dialog.textContent).toContain("Earlier occurrence (UTC+11:00)");
    expect(byTestId<HTMLButtonElement>("event-calendar-fold-submit")?.disabled).toBe(true);
    await click(document.body.querySelector<HTMLInputElement>('[aria-label="end earlier occurrence"]')!);
    await click(byTestId("event-calendar-fold-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("earlier");
    expect(onCancel).not.toHaveBeenCalled();
    await click(byTestId("event-calendar-fold-cancel")!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("ProductionEventCalendarScheduleEditorSheet (sheet shell)", () => {
  async function renderSheet(props: Partial<ComponentProps<typeof ProductionEventCalendarScheduleEditorSheet>> = {}) {
    const onSubmit = props.onSubmit ?? vi.fn();
    await render(<ProductionEventCalendarScheduleEditorSheet open event={dueEvent} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />);
    return onSubmit;
  }

  it("offers no state picker, no mode select and no native inputs: one range field of two moments (#423)", async () => {
    await renderSheet();
    const sheet = byTestId("event-calendar-schedule-editor")!;
    expect(sheet.textContent).toContain("Schedule checklist item");
    expect(sheet.textContent).toContain("12 Harbour Street");
    expect(document.body.querySelector('[aria-label="Checklist schedule state"]')).toBeNull();
    expect(document.body.querySelectorAll("select")).toHaveLength(0);
    expect(document.body.querySelectorAll('input[type="date"], input[type="time"], input[type="radio"]')).toHaveLength(0);
    const popup = await openFieldPopup("Schedule");
    expect(rangeToggles(popup)).toEqual({ active: "Start", start: rangeMoment("2026-08-20", "09:00"), end: rangeMoment("2026-08-20", "17:00") });
  });

  it("refuses an end at or before the start in the popup, so nothing invalid reaches the draft", async () => {
    const onSubmit = await renderSheet();
    const popup = await openFieldPopup("Schedule");
    await pickRangeEnd(popup, "End"); await typePopupTime(popup, "08:00");
    expect(popup.textContent).toContain("Start must be before end.");
    expect(popupButton(popup, "Apply")!.disabled).toBe(true);
    await pressInPopup(popup, "Cancel");
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-08-20T09:00" }, end: { localCivil: "2026-08-20T17:00" } });
  });

  it("asks for a fold choice at the end that repeats, then submits it", async () => {
    const onSubmit = await renderSheet();
    const popup = await openFieldPopup("Schedule");
    await pickPopupDay(popup, "2026-04-05"); await pickPopupDay(popup, "2026-04-05"); await pickRangeEnd(popup, "Start"); await typePopupTime(popup, "02:30");
    expect(popupButton(popup, "Apply")!.disabled).toBe(true);
    await pickRangeEnd(popup, "End"); await typePopupTime(popup, "04:00");
    await pressRangeFold(popup, "Start", "Earlier");
    await applyPopup(popup);
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { localCivil: "2026-04-05T04:00" } });
  });

  it("reopens with a retained draft and its server validation error", async () => {
    await renderSheet({ initialSchedule: { state: "range", start: { localCivil: "2026-08-25T09:00" }, end: { localCivil: "2026-08-25T17:00" } }, validationError: { code: "subtask_schedule_invalid_order", message: "" } });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("start must be before");
    const popup = await openFieldPopup("Schedule");
    expect(rangeToggles(popup)).toEqual({ active: "Start", start: rangeMoment("2026-08-25", "09:00"), end: rangeMoment("2026-08-25", "17:00") });
  });

  describe("reminders (#425)", () => {
    const strip = (popup: HTMLElement, name: string) => popupButton(popup, name)!;

    it("shows the event's stored set in the popup, and a reminders-only draft is saved with the unchanged range", async () => {
      const onSubmit = await renderSheet({ event: { ...dueEvent, reminders: subtaskReminders([60]) } });
      const popup = await openFieldPopup("Schedule");
      expect(strip(popup, "1 hour").getAttribute("aria-pressed")).toBe("true");
      await click(strip(popup, "4 hours"));
      await applyPopup(popup);
      await click(byTestId("event-calendar-schedule-submit")!);
      expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-08-20T09:00" }, end: { localCivil: "2026-08-20T17:00" } }, [240, 60]);
    });

    it("a range-only draft submits no offsets", async () => {
      const onSubmit = await renderSheet();
      const popup = await openFieldPopup("Schedule");
      await pickPopupDay(popup, "2026-08-21");
      await applyPopup(popup);
      await click(byTestId("event-calendar-schedule-submit")!);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(vi.mocked(onSubmit).mock.calls[0]).toHaveLength(1);
    });

    it("keeps the applied offsets when the popup is reopened, still stating the saved schedule", async () => {
      await renderSheet({ event: { ...dueEvent, reminders: subtaskReminders([1440], { kind: "advance", offsetMinutes: 1440, firesAt: "2026-08-18T23:00:00.000Z" }) } });
      let popup = await openFieldPopup("Schedule");
      expect(popup.textContent).toContain("Currently saved: next reminder");
      await click(strip(popup, "4 hours"));
      await applyPopup(popup);
      popup = await openFieldPopup("Schedule");
      expect(strip(popup, "4 hours").getAttribute("aria-pressed")).toBe("true");
      expect(strip(popup, "1 day").getAttribute("aria-pressed")).toBe("true");
      expect(popup.textContent).toContain("Currently saved: next reminder");
    });

    it("reopens with the retained offsets of a failed save", async () => {
      const onSubmit = await renderSheet({ initialSchedule: { state: "range", start: { localCivil: "2026-08-25T09:00" }, end: { localCivil: "2026-08-25T17:00" } }, initialReminderOffsets: [240, 1440] });
      const popup = await openFieldPopup("Schedule");
      expect(strip(popup, "4 hours").getAttribute("aria-pressed")).toBe("true");
      await pressInPopup(popup, "Cancel");
      await click(byTestId("event-calendar-schedule-submit")!);
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ state: "range" }), [240, 1440]);
    });
  });

  it("reports a nonexistent spring-forward time in the popup and blocks Apply", async () => {
    await renderSheet();
    const popup = await openFieldPopup("Schedule");
    await pickPopupDay(popup, "2026-10-04"); await pickRangeEnd(popup, "Start"); await typePopupTime(popup, "02:30");
    expect(popup.textContent).toContain("does not exist");
    expect(popupButton(popup, "Apply")!.disabled).toBe(true);
  });

  it("collects independent fold choices for both range ends", async () => {
    const onSubmit = await renderSheet();
    const popup = await openFieldPopup("Schedule");
    await pickPopupDay(popup, "2026-04-05"); await pickPopupDay(popup, "2026-04-05"); await pickRangeEnd(popup, "Start"); await typePopupTime(popup, "02:30");
    await pickRangeEnd(popup, "End"); await typePopupTime(popup, "02:30");
    await pressRangeFold(popup, "Start", "Earlier"); await pressRangeFold(popup, "End", "Later");
    await applyPopup(popup);
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { localCivil: "2026-04-05T02:30", disambiguation: "later" } });
  });

  it("seeds a stored fold with the matching end occurrence selected", async () => {
    const stored = normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-04-05T00:00" }, end: { localCivil: "2026-04-05T02:30", disambiguation: "earlier" } }, 4);
    if (!stored.ok) throw new Error("fold fixture did not normalize");
    const schedule = checklistScheduleToDto(stored.value);
    const event = { ...dueEvent, id: "checklist:stored-fold", timing: { allDay: false as const, start: schedule.start.instant, end: schedule.end.instant }, schedule };
    await renderSheet({ event });
    const popup = await openFieldPopup("Schedule");
    expect(rangeFoldPressed(popup, "End")).toBe("Earlier");
  });
});

describe("civilParts / validCivil", () => {
  it("accepts Feb 29 only in a leap year", () => {
    expect(validCivil("2028-02-29T10:00")).toBe(true);
    expect(validCivil("2027-02-29T10:00")).toBe(false);
  });

  it("rejects an out-of-range day, hour or minute, and a malformed value", () => {
    expect(validCivil("2026-04-31T10:00")).toBe(false);
    expect(validCivil("2026-04-30T10:00")).toBe(true);
    expect(validCivil("2026-08-11T24:00")).toBe(false);
    expect(validCivil("2026-08-11T23:60")).toBe(false);
    expect(validCivil("2026-13-01T10:00")).toBe(false);
    expect(validCivil("not-a-civil")).toBe(false);
  });

  it("splits a well-formed civil value and returns empty parts otherwise", () => {
    expect(civilParts("2026-08-11T09:30")).toEqual({ date: "2026-08-11", time: "09:30" });
    expect(civilParts("2026-08-11")).toEqual({ date: "", time: "" });
    expect(civilParts("")).toEqual({ date: "", time: "" });
  });
});

describe("ProductionEventCalendarDialogs (wired to the scheduling controller's dialog state)", () => {
  function commands(overrides: Partial<ProductionEventCalendarDialogCommands> = {}): ProductionEventCalendarDialogCommands {
    return {
      moveDialog: null, scheduleEditor: null, checklistFold: null,
      submitMoveDialog: vi.fn(), cancelMoveDialog: vi.fn(),
      submitScheduleEditor: vi.fn(), cancelScheduleEditor: vi.fn(),
      submitChecklistFold: vi.fn(), cancelChecklistFold: vi.fn(),
      ...overrides,
    };
  }
  const moveState = { event: deadline, snapshot: {} as never, initialCivil: "2026-08-12T10:00" };
  const foldState = { proposal: { source: dueEvent } as never, disambiguation: {}, endpoint: "start" as const, choices: [{ disambiguation: "earlier" as const, utcOffsetMinutes: 660 }, { disambiguation: "later" as const, utcOffsetMinutes: 600 }] };
  const editorState = { source: dueEvent, snapshot: {} as never };

  it("renders nothing until the controller opens a dialog", async () => {
    await render(<ProductionEventCalendarDialogs commands={commands()} deadlineConfirm={null} />);
    expect(byTestId("event-calendar-move-dialog")).toBeNull();
    expect(byTestId("event-calendar-fold-choice")).toBeNull();
    expect(byTestId("event-calendar-schedule-editor")).toBeNull();
    expect(byTestId("gantt-deadline-confirm")).toBeNull();
  });

  it("wires the move dialog to submitMoveDialog / cancelMoveDialog", async () => {
    const wired = commands({ moveDialog: moveState });
    await render(<ProductionEventCalendarDialogs commands={wired} deadlineConfirm={null} />);
    expect(popupDraft(await openMoveDialogField()).day).toBe("2026-08-12");
    await applyPopup(dateTimePopup("Deadline")!);
    await click(byTestId("event-calendar-move-submit")!);
    expect(wired.submitMoveDialog).toHaveBeenCalledWith("2026-08-12T10:00", undefined, [1440, 60]);
    await click(byTestId("event-calendar-move-cancel")!);
    expect(wired.cancelMoveDialog).toHaveBeenCalledOnce();
  });

  it("wires the fold choice and the schedule editor", async () => {
    const wired = commands({ checklistFold: foldState, scheduleEditor: editorState });
    await render(<ProductionEventCalendarDialogs commands={wired} deadlineConfirm={null} />);
    expect(byTestId("event-calendar-fold-choice")?.textContent).toContain("Start occurs twice in Sydney");
    await click(document.body.querySelector<HTMLInputElement>('[aria-label="start later occurrence"]')!);
    await click(byTestId("event-calendar-fold-submit")!);
    expect(wired.submitChecklistFold).toHaveBeenCalledWith("later");
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(wired.submitScheduleEditor).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-08-20T09:00" }, end: { localCivil: "2026-08-20T17:00" } });
  });

  it("forwards a changed reminder set from the schedule editor to submitScheduleEditor (#425)", async () => {
    const wired = commands({ scheduleEditor: editorState });
    await render(<ProductionEventCalendarDialogs commands={wired} deadlineConfirm={null} />);
    const popup = await openFieldPopup("Schedule");
    await click(popupButton(popup, "4 hours")!);
    await applyPopup(popup);
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(wired.submitScheduleEditor).toHaveBeenCalledWith({ state: "range", start: { localCivil: "2026-08-20T09:00" }, end: { localCivil: "2026-08-20T17:00" } }, [1440, 240]);
  });

  it("reuses the Deadline confirm with no preview and shows each reminder consequence", async () => {
    const resolve = vi.fn();
    const state = {
      street: "12 Harbour Street", oldCivil: "2026-08-10T09:30", newCivil: "2026-08-20T09:30", scheduling: false, preview: null,
      consequences: [
        { offsetMinutes: 1440, label: "future" as const, oldFireAt: "old", newFireAt: "new", oldLocalCivil: "2026-08-09T09:30", newLocalCivil: "2026-08-19T09:30" },
        { offsetMinutes: 120, label: "elapsed_at_save" as const, oldFireAt: "old-2", newFireAt: "new-2", oldLocalCivil: "2026-08-10T07:30", newLocalCivil: "2026-08-20T07:30" },
        { offsetMinutes: 60, label: "shifted_wall_clock_hour" as const, oldFireAt: "old-3", newFireAt: "new-3", oldLocalCivil: "2026-04-05T09:00", newLocalCivil: "2026-10-04T08:00" },
      ],
    };
    await render(<ProductionEventCalendarDialogs commands={commands()} deadlineConfirm={{ state, resolve }} />);
    const confirmation = byTestId("calendar-move-confirmation")!.textContent;
    expect(confirmation).toContain("2026-08-10 09:30");
    expect(confirmation).toContain("1 day before");
    expect(confirmation).toContain("will have already passed when saved");
    expect(confirmation).toContain("fires an hour earlier/later (daylight-saving)");
    expect(byTestId("gantt-deadline-confirm-affected")).toBeNull();
    await click(byTestId("gantt-deadline-confirm-action")!);
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it("empty reminders read as none set", async () => {
    const state = { street: "12 Harbour Street", oldCivil: "2026-08-10T09:30", newCivil: "2026-08-20T09:30", scheduling: false, preview: null, consequences: [] };
    await render(<ProductionEventCalendarDialogs commands={commands()} deadlineConfirm={{ state, resolve: vi.fn() }} />);
    expect(byTestId("calendar-move-confirmation")!.textContent).toContain("No reminders are set.");
  });

  // #463: the Timeline's "inline" presentation draws only the Due cell's own sessions; its menu's
  // Edit schedule… opens a non-inline session, which is the sheet at every width.
  it("under the inline presentation, a non-inline schedule session renders the sheet and an inline one does not (#463)", async () => {
    await render(<ProductionEventCalendarDialogs commands={commands({ scheduleEditor: { ...editorState, inline: true } })} deadlineConfirm={null} scheduleEditorPresentation="inline" />);
    expect(byTestId("event-calendar-schedule-editor")).toBeNull();
    await render(<ProductionEventCalendarDialogs commands={commands({ scheduleEditor: editorState })} deadlineConfirm={null} scheduleEditorPresentation="inline" />);
    expect(byTestId("event-calendar-schedule-editor")).not.toBeNull();
  });

  it("under the sheet presentation, an inline session still renders the sheet, as before (#463)", async () => {
    await render(<ProductionEventCalendarDialogs commands={commands({ scheduleEditor: { ...editorState, inline: true } })} deadlineConfirm={null} />);
    expect(byTestId("event-calendar-schedule-editor")).not.toBeNull();
  });

  // docs/lessons.md "Sibling retained dialogs must namespace their open-token keys": every
  // retained sibling reaches token 1 on its first open; un-prefixed, React drops one of them.
  it("keeps sibling retained dialogs apart once each has opened (prefixed open-token keys)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await render(<ProductionEventCalendarDialogs commands={commands({ moveDialog: moveState })} deadlineConfirm={null} />);
      await render(<ProductionEventCalendarDialogs commands={commands()} deadlineConfirm={null} />);
      await render(<ProductionEventCalendarDialogs commands={commands({ checklistFold: foldState })} deadlineConfirm={null} />);
      await render(<ProductionEventCalendarDialogs commands={commands()} deadlineConfirm={null} />);
      await render(<ProductionEventCalendarDialogs commands={commands({ scheduleEditor: editorState })} deadlineConfirm={null} />);
      expect(byTestId("event-calendar-schedule-editor")).not.toBeNull();
      expect(errors.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});
