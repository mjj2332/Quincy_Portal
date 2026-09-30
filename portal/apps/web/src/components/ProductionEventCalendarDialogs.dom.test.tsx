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
import {
  PRODUCTION_CALENDAR_ZONE,
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "11111111-1111-4111-8111-111111111111", street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false };
const person = { id: "22222222-2222-4222-8222-222222222222", name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });

const deadline: ProjectDeadlineCalendarEventDto = {
  id: "project-deadline:11111111-1111-4111-8111-111111111111", kind: "project_deadline", title: "Deadline", project,
  timing: { allDay: false, start: "2026-08-10T23:30:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
  permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-11T09:30", deadlineVersion: 7, reminderOffsetsMinutes: [1440, 60],
};

const dueEvent: ChecklistCalendarEventDto = { id: "checklist:33333333-3333-4333-8333-333333333333", kind: "checklist", title: "Select hero images", project, assignee: person, assignees: [person], otherAssigneeCount: 0, timing: { allDay: true, start: "2026-08-20", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: dateEndpoint("2026-08-20"), end: dateEndpoint("2026-08-20"), due: "2026-08-20" }, permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true } };

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

  it("seeds inputs from Sydney civil components and names the street", async () => {
    await renderMove();
    expect(input("Deadline date").value).toBe("2026-08-11");
    expect(input("Deadline time").value).toBe("09:30");
    expect(byTestId("event-calendar-move-dialog")?.textContent).toContain("12 Harbour Street");
  });

  it("disables submit for a malformed civil value", async () => {
    await renderMove({ initialCivil: "not-a-civil" });
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(true);
  });

  it("requires a fold choice and passes the civil value plus disambiguation, without also cancelling", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    await renderMove({ foldChoices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }], onSubmit, onCancel });
    expect(document.body.textContent).toContain("Earlier occurrence (UTC+11:00)");
    expect(document.body.textContent).toContain("Later occurrence (UTC+10:00)");
    expect(byTestId<HTMLButtonElement>("event-calendar-move-submit")?.disabled).toBe(true);
    const later = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((radio) => radio.value === "later")!;
    await click(later);
    await click(byTestId("event-calendar-move-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("2026-08-11T09:30", "later");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("labels a negative occurrence offset with U+2212, like the fold choice (#222)", async () => {
    await renderMove({ foldChoices: [{ disambiguation: "earlier", utcOffsetMinutes: -240 }, { disambiguation: "later", utcOffsetMinutes: -300 }] });
    expect(document.body.textContent).toContain("Earlier occurrence (UTC\u221204:00)");
    expect(document.body.textContent).toContain("Later occurrence (UTC\u221205:00)");
    expect(document.body.textContent).not.toContain("UTC-");
  });

  it("edits date and time before submitting", async () => {
    const onSubmit = vi.fn();
    await renderMove({ onSubmit });
    await change(input("Deadline date"), "2026-08-20");
    await change(input("Deadline time"), "15:45");
    await click(byTestId("event-calendar-move-submit")!);
    expect(onSubmit).toHaveBeenCalledWith("2026-08-20T15:45", undefined);
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
  const modeSelect = () => document.body.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!;
  async function renderSheet(props: Partial<ComponentProps<typeof ProductionEventCalendarScheduleEditorSheet>> = {}) {
    const onSubmit = props.onSubmit ?? vi.fn();
    await render(<ProductionEventCalendarScheduleEditorSheet open event={dueEvent} onSubmit={onSubmit} onCancel={vi.fn()} {...props} />);
    return onSubmit;
  }

  it("offers no state picker: start and end, plus one endpoint mode select (#340)", async () => {
    await renderSheet();
    const sheet = byTestId("event-calendar-schedule-editor")!;
    expect(sheet.textContent).toContain("Schedule checklist item");
    expect(sheet.textContent).toContain("12 Harbour Street");
    expect(document.body.querySelector('[aria-label="Checklist schedule state"]')).toBeNull();
    expect(document.body.querySelectorAll("select")).toHaveLength(1);
    expect([...document.body.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!.options].map((option) => option.value)).toEqual(["date", "timed"]);
    expect(input("Checklist start date").value).toBe("2026-08-20");
    expect(input("Checklist end date").value).toBe("2026-08-20");
  });

  it("surfaces local preflight errors and does not submit", async () => {
    const onSubmit = await renderSheet();
    await change(document.body.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!, "timed");
    await change(input("Checklist start date"), "2026-08-20"); await change(input("Checklist start time"), "10:00");
    await change(input("Checklist end date"), "2026-08-20"); await change(input("Checklist end time"), "09:00");
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("start must be before");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("asks for a fold choice at the endpoint that repeats, then submits it", async () => {
    const onSubmit = await renderSheet();
    await change(document.body.querySelector<HTMLSelectElement>('[aria-label="Checklist endpoint mode"]')!, "timed");
    await change(input("Checklist start date"), "2026-04-05"); await change(input("Checklist start time"), "02:30");
    await change(input("Checklist end date"), "2026-04-05"); await change(input("Checklist end time"), "04:00");
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(onSubmit).not.toHaveBeenCalled();
    await click(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="earlier"]')!);
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(onSubmit).toHaveBeenCalledWith({ state: "range", start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-04-05T04:00" } });
  });

  it("reopens with a retained draft and its server validation error", async () => {
    await renderSheet({ initialSchedule: { state: "range", start: { kind: "date", localCivil: "2026-08-25" }, end: { kind: "date", localCivil: "2026-08-25" } }, validationError: { code: "subtask_schedule_invalid_order", message: "" } });
    expect(input("Checklist start date").value).toBe("2026-08-25");
    expect(input("Checklist end date").value).toBe("2026-08-25");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("start must be before");
  });

  const radios = () => [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

  it("keeps endpoint mode to one select and reports a nonexistent spring-forward time", async () => {
    await renderSheet();
    await change(modeSelect(), "timed");
    expect(document.body.querySelectorAll('select[aria-label="Checklist endpoint mode"]')).toHaveLength(1);
    await change(input("Checklist start date"), "2026-10-04"); await change(input("Checklist start time"), "02:30");
    await change(input("Checklist end date"), "2026-10-04"); await change(input("Checklist end time"), "04:00");
    await click(byTestId("event-calendar-schedule-submit")!);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("does not exist");
  });

  it("collects independent fold choices for both range endpoints", async () => {
    const onSubmit = await renderSheet();
    await change(modeSelect(), "timed");
    await change(input("Checklist start date"), "2026-04-05"); await change(input("Checklist start time"), "02:30");
    await change(input("Checklist end date"), "2026-04-05"); await change(input("Checklist end time"), "02:30");
    const folds = radios();
    expect(folds).toHaveLength(4);
    await click(folds[0]!); await click(folds[3]!);
    await click(byTestId("event-calendar-schedule-submit")!);
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
    await renderSheet({ event });
    await change(modeSelect(), "timed");
    expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="earlier"]')?.checked).toBe(true);
    expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')?.checked).toBe(false);
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
    expect(input("Deadline date").value).toBe("2026-08-12");
    await click(byTestId("event-calendar-move-submit")!);
    expect(wired.submitMoveDialog).toHaveBeenCalledWith("2026-08-12T10:00", undefined);
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
    expect(wired.submitScheduleEditor).toHaveBeenCalledWith({ state: "range", start: { kind: "date", localCivil: "2026-08-20" }, end: { kind: "date", localCivil: "2026-08-20" } });
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
