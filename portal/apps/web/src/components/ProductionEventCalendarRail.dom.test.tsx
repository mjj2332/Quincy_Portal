/**
 * #222 step 6 — the event-calendar rail: mini month (busy dots, day select → civil date), Up next
 * (a read-only agenda list). Guard F: Quincy `data-testid`s.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type CalendarEventDto } from "@quincy/shared";
import { ProductionEventCalendarRail, upNextEvents } from "./ProductionEventCalendarRail";
import { startMoment, endMoment } from "@/testing/subtask-schedule";
import { subtaskReminders } from "@/testing/subtask-schedule";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "11111111-1111-4111-8111-111111111111", street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 2 }, delivered: false, archived: false };
const status = { overdue: false, delivered: false, completed: false as const, sameAssigneeOverlap: false as const };

function deadline(id: string, start: string, civil: string): CalendarEventDto {
  return { id: `project-deadline:${id}`, kind: "project_deadline", title: "Deadline", project: { ...project, street: `${id} Street` }, timing: { allDay: false, start, end: null }, status, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: civil, deadlineVersion: 1, reminderOffsetsMinutes: [] };
}
function range(id: string, start: string, end: string): CalendarEventDto {
  return { id: `checklist:${id}`, kind: "checklist", title: `Task ${id}`, project, assignees: [], otherAssigneeCount: 0, timing: { allDay: true, start, end }, status: { ...status, completed: false }, schedule: { state: "range", version: 1, zone: PRODUCTION_CALENDAR_ZONE, start: startMoment(start), end: endMoment(end), due: end }, reminders: subtaskReminders(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true } } as CalendarEventDto;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); });

type Props = ComponentProps<typeof ProductionEventCalendarRail>;
async function render(overrides: Partial<Props> = {}) {
  const props: Props = {
    date: "2026-08-12", onDateChange: vi.fn(), events: [], nowCivil: "2026-08-12T08:00",
    upNext: { status: "ready", events: [] }, onOpenUpNext: vi.fn(),
    ...overrides,
  };
  await act(async () => { root.render(<ProductionEventCalendarRail {...props} />); await Promise.resolve(); });
  return props;
}

const day = (civil: string) => host.querySelector<HTMLElement>(`[data-testid="event-calendar-rail-day-${civil}"]`);

describe("ProductionEventCalendarRail — mini month", () => {
  it("paints the selected date's month and marks it selected", async () => {
    await render();
    expect(host.querySelector('[data-testid="event-calendar-rail-month"]')?.textContent).toContain("August 2026");
    expect(day("2026-08-12")?.dataset.selectedSingle).toBe("true");
  });

  it("marks busy days from the events — every day of an all-day range (exclusive end) and a timed Deadline's Sydney day", async () => {
    await render({ events: [range("a", "2026-08-03", "2026-08-06"), deadline("b", "2026-08-19T14:30:00.000Z", "2026-08-20T00:30")] });
    expect(["2026-08-03", "2026-08-04", "2026-08-05"].map((civil) => day(civil)?.dataset.busy)).toEqual(["true", "true", "true"]);
    expect(day("2026-08-06")?.dataset.busy).toBeUndefined();
    // 14:30Z on the 19th is 00:30 on the 20th in Sydney (UTC+10): the dot follows Sydney, not UTC.
    expect(day("2026-08-20")?.dataset.busy).toBe("true");
    expect(day("2026-08-19")?.dataset.busy).toBeUndefined();
  });

  it("selecting a day hands back its civil date", async () => {
    const props = await render();
    await act(async () => { day("2026-08-21")!.click(); await Promise.resolve(); });
    expect(props.onDateChange).toHaveBeenCalledWith("2026-08-21");
  });
});

describe("ProductionEventCalendarRail — Up next", () => {
  it("lists the soonest events from now, labelled in Sydney civil time, and opens one", async () => {
    const early = deadline("early", "2026-08-13T00:00:00.000Z", "2026-08-13T10:00");
    const late = deadline("late", "2026-08-14T00:00:00.000Z", "2026-08-14T10:00");
    const past = deadline("past", "2026-08-11T00:00:00.000Z", "2026-08-11T10:00");
    const props = await render({ upNext: { status: "ready", events: [late, past, early] } });
    const items = [...host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-up-next-item"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("early Street"),
      expect.stringContaining("late Street"),
    ]);
    expect(items[0]!.textContent).toContain("Thu 13 Aug");
    expect(items[0]!.textContent).toContain("10:00");
    await act(async () => { items[1]!.click(); });
    expect(props.onOpenUpNext).toHaveBeenCalledWith(late);
  });

  it("shows the end, not the start, for a range that began before today and is still running", async () => {
    // now = Wed 12 Aug 2026 08:00 Sydney. An all-day range 2026-08-10 .. exclusive 2026-08-15 ends on Fri 14 Aug.
    const allDay = range("run", "2026-08-10", "2026-08-15");
    const timed = { ...deadline("t", "2026-08-10T23:00:00.000Z", "2026-08-11T09:00"), kind: "checklist", timing: { allDay: false, start: "2026-08-10T23:00:00.000Z", end: "2026-08-14T07:00:00.000Z" } } as unknown as CalendarEventDto;
    const future = range("future", "2026-08-13", "2026-08-15");
    await render({ upNext: { status: "ready", events: [allDay, timed, future] } });
    const text = [...host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-up-next-item"]')].map((item) => item.textContent ?? "");
    expect(text.find((t) => t.includes("Task run"))).toContain("Until Fri 14 Aug · All day");
    expect(text.find((t) => t.includes("t Street") || t.includes("Deadline"))).toContain("Until Fri 14 Aug · 17:00");
    expect(text.find((t) => t.includes("Task future"))).toContain("Thu 13 Aug · All day");
    expect(text.find((t) => t.includes("Task future"))).not.toContain("Until");
  });

  it("says loading, unavailable and nothing scheduled", async () => {
    await render({ upNext: { status: "pending", events: [] } });
    expect(host.querySelector('[data-testid="event-calendar-up-next"]')?.textContent).toContain("Loading");
    await render({ upNext: { status: "error", events: [] } });
    expect(host.querySelector('[data-testid="event-calendar-up-next"]')?.textContent).toContain("unavailable");
    await render({ upNext: { status: "ready", events: [] } });
    expect(host.querySelector('[data-testid="event-calendar-up-next"]')?.textContent).toContain("Nothing scheduled");
  });

  it("upNextEvents keeps an all-day item until its exclusive end and caps the list", () => {
    const allDay = range("today", "2026-08-12", "2026-08-13");
    const ended = range("ended", "2026-08-10", "2026-08-12");
    const many = Array.from({ length: 8 }, (_, index) => deadline(`n${index}`, `2026-08-${String(13 + index).padStart(2, "0")}T00:00:00.000Z`, `2026-08-${String(13 + index).padStart(2, "0")}T10:00`));
    const result = upNextEvents([ended, allDay, ...many], "2026-08-12T08:00", 5);
    expect(result.map((event) => event.id)).toEqual(["checklist:today", "project-deadline:n0", "project-deadline:n1", "project-deadline:n2", "project-deadline:n3"]);
  });
});
