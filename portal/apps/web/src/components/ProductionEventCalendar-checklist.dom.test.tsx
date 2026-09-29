/**
 * #222 step 8 — checklist writes through the event-calendar renderer, ported from
 * `ProductionCalendar-checklist.dom.test.tsx`. The vendor tree is the shared fake
 * (`testing/event-calendar-fake.tsx`): `eventCalendarFake.update` fires `onEventUpdate` with a
 * crafted proposal against the RENDERED event, exactly as the vendor would. The FullCalendar
 * `revert()` count becomes the surface's return value (`false` = snap back, `"deferred"` = the
 * controller owns it). "Refuses start resize" becomes "start-resize PATCHes the start only".
 *
 * Fixtures come from `testing/production-calendar-fixtures.ts` (schema-parsed); fetch is routed by
 * `testing/production-event-calendar-harness.tsx`, whose `rangeGets()` counts the MAIN range only
 * (the Up next rail query never sends `bounds=1`).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarEventDto, type ChecklistCalendarUnscheduledEntryDto, type ChecklistScheduleDto, type ProductionCalendarProjectBounds } from "@quincy/shared";
import { ProjectQueryRuntime } from "../lib/project-query-sync";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import {
  ASSIGNEE,
  checklistMutationBody,
  dated,
  deadlineEvent,
  deadlineSaveBody,
  dueEvent,
  dueSchedule,
  instantOf,
  PROJECT_ID,
  rangeEvent,
  rangeResponse,
  rangeSchedule,
  SUBTASK_ID,
  timed,
} from "../testing/production-calendar-fixtures";
import {
  byLabel,
  calendarState,
  chipStart,
  clickTestId,
  createHarness,
  flush,
  json,
  liveRegion,
  mainRangeQuery,
  openReschedule,
  proposeUpdate,
  setValue,
  stubCalendarFetch,
  type Harness,
} from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./reui/event-calendar/event-calendar-dnd", async () => (await import("../testing/event-calendar-fake")).eventCalendarDndModule);

const ID = `checklist:${SUBTASK_ID}`;
const at = (civil: string) => new Date(instantOf(civil));
/** A dated day's zoned Sydney midnight (the vendor's all-day instants). */
const day = (date: string) => at(`${date}T00:00`);

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

function scheduleOf(call: { body: unknown }) {
  return (call.body as { schedule: { expectedVersion: number; schedule: unknown } }).schedule;
}

async function mount(events: ChecklistCalendarEventDto[], options: { subview?: "month" | "week" | "day" | "days" | "agenda"; role?: "admin" | "external_editor"; patch?: (url: string, body: unknown) => Response | Promise<Response>; onAccessLoss?: () => void; onSettleStateChange?: (state: { pending: boolean; recoveryReason: string | null }) => void; projectBounds?: ProductionCalendarProjectBounds[] } = {}) {
  const subview = options.subview ?? "month";
  const range = rangeResponse({ events, subview, role: options.role, projectBounds: options.projectBounds });
  const fetch = stubCalendarFetch({ range, patch: options.patch ?? (() => json(checklistMutationBody(events[0]!))) });
  await h.render(calendarState(subview), { role: options.role, onAccessLoss: options.onAccessLoss, onSettleStateChange: options.onSettleStateChange });
  return fetch;
}

describe("ProductionEventCalendar checklist writes", () => {
  it("PATCHes the bare subtask id, never the checklist: entity id (#226)", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-15"), 3))) });
    expect(await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true })).toBe("deferred");
    await flush(10);
    expect(fetch.patches().map((call) => call.url)).toEqual([`/api/projects/${PROJECT_ID}/subtasks/${SUBTASK_ID}`]);
  });

  it("announces invalid, without a request, for a checklist id that isn't a prefixed entity id (#226)", async () => {
    const event = dueEvent(dated("2026-08-12"), { id: "checklist:" });
    const fetch = await mount([event]);
    await proposeUpdate("checklist:", { start: day("2026-08-15"), allDay: true });
    await flush(5);
    expect(fetch.patches()).toHaveLength(0);
    expect(liveRegion()).toContain("That schedule change isn't valid.");
    // Cancel's revert cleared the pending hold: the chip is back on its own day.
    expect(chipStart("checklist:")).toBe(day("2026-08-12").toISOString());
  });

  it("routes the null-id editor path through the finish: flushes a queued refetch and closes the editor (#226 round 1)", async () => {
    const event = dueEvent(dated("2026-08-12"), { id: "checklist:" });
    const fetch = await mount([event]);
    expect(fetch.rangeGets()).toHaveLength(1);
    await openReschedule("checklist:");
    expect(byLabel("Checklist schedule state")).toBeNull();
    expect(byLabel("Checklist endpoint mode")).not.toBeNull();

    h.client.setQueryData(mainRangeQuery(h.client).queryKey, rangeResponse({ events: [{ ...event, title: "Queued update" }] }));
    await flush(0);

    await clickTestId("event-calendar-schedule-submit");
    expect(fetch.patches()).toHaveLength(0);
    expect(liveRegion()).toContain("That schedule change isn't valid.");
    expect(document.querySelector('[data-testid="event-calendar-schedule-editor"]')?.hasAttribute("data-open") ?? false).toBe(false);
    expect(document.querySelector('[data-testid="event-calendar-fold-submit"]')).toBeNull();
    await flush(10);
    expect(fetch.rangeGets()).toHaveLength(2);
  });

  it("adopts a scheduled PATCH result (bare id in the response) as exactly one event keyed by the entity id (#226)", async () => {
    const event = dueEvent(dated("2026-08-12"));
    let release!: () => void;
    let gets = 0;
    const range = rangeResponse({ events: [event] });
    stubCalendarFetch({
      range: (url) => {
        if (!url.includes("bounds=1")) return json(range);
        gets += 1;
        return gets === 1 ? json(range) : new Promise<Response>((resolve) => { release = () => resolve(json(range)); });
      },
      patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-15"), 3))),
    });
    await h.render(calendarState("month"));
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(5);
    expect(eventCalendarFake.lastProps?.events).toHaveLength(1);
    expect(eventCalendarFake.lastProps?.events?.[0]?.id).toBe(ID);
    release();
    await flush(10);
  });

  it("maps a due-only Month drag to a date-only versioned PATCH", async () => {
    const event = dueEvent(dated("2026-08-12"), { version: 4 });
    const fetch = await mount([event], { patch: () => json({ ...checklistMutationBody(event, dueSchedule(dated("2026-08-15"), 5)), futureWorkerField: "additive" }) });
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
    expect(scheduleOf(fetch.patches()[0]!)).toEqual({ expectedVersion: 4, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-15" } } });
  });

  it("maps a due-only Week drag with a Sydney 15-minute civil snap", async () => {
    const event = dueEvent(timed("2026-08-12T10:00"));
    const fetch = await mount([event], { subview: "week", patch: () => json(checklistMutationBody(event, dueSchedule(timed("2026-08-13T10:00"), 3))) });
    await proposeUpdate(ID, { start: at("2026-08-13T10:07"), allDay: false, granularity: "minute" });
    await flush(5);
    expect(scheduleOf(fetch.patches()[0]!).schedule).toEqual({ state: "due_only", end: { kind: "timed", localCivil: "2026-08-13T10:00" } });
  });

  it("shifts both range endpoints by the same civil-day delta from a day cell, keeping wall times", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-13T11:30"));
    const fetch = await mount([event], { patch: () => json(checklistMutationBody(event, rangeSchedule(timed("2026-08-15T10:00"), timed("2026-08-16T11:30"), 4))) });
    await proposeUpdate(ID, { start: at("2026-08-15T10:00"), allDay: false, granularity: "day" });
    await flush(5);
    expect(scheduleOf(fetch.patches()[0]!).schedule).toEqual({ state: "range", start: { kind: "timed", localCivil: "2026-08-15T10:00" }, end: { kind: "timed", localCivil: "2026-08-16T11:30" } });
  });

  it("shifts both range endpoints by a civil-minute delta in Week", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:30"));
    const fetch = await mount([event], { subview: "week", patch: () => json(checklistMutationBody(event, rangeSchedule(timed("2026-08-12T11:00"), timed("2026-08-12T12:30"), 4))) });
    await proposeUpdate(ID, { start: at("2026-08-12T11:07"), allDay: false, granularity: "minute" });
    await flush(5);
    expect(scheduleOf(fetch.patches()[0]!).schedule).toEqual({ state: "range", start: { kind: "timed", localCivil: "2026-08-12T11:00" }, end: { kind: "timed", localCivil: "2026-08-12T12:30" } });
  });

  it("passes the all-day exclusive end so D+2 becomes inclusive D+1", async () => {
    const event = rangeEvent(dated("2026-08-12"), dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json(checklistMutationBody(event, rangeSchedule(dated("2026-08-12"), dated("2026-08-13"), 4))) });
    await proposeUpdate(ID, { start: day("2026-08-12"), end: day("2026-08-14"), allDay: true, source: "resize-end", granularity: "day" });
    await flush(5);
    expect(scheduleOf(fetch.patches()[0]!).schedule).toEqual({ state: "range", start: { kind: "date", localCivil: "2026-08-12" }, end: { kind: "date", localCivil: "2026-08-13" } });
  });

  it("maps a timed END resize at a 15-minute civil snap, leaving the start", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"));
    const fetch = await mount([event], { subview: "week", patch: () => json(checklistMutationBody(event, rangeSchedule(timed("2026-08-12T10:00"), timed("2026-08-12T11:30"), 4))) });
    await proposeUpdate(ID, { start: at("2026-08-12T10:00"), end: at("2026-08-12T11:37"), allDay: false, source: "resize-end", granularity: "minute" });
    await flush(5);
    const schedule = scheduleOf(fetch.patches()[0]!).schedule as { start: { localCivil: string }; end: { localCivil: string } };
    expect(schedule.start.localCivil).toBe("2026-08-12T10:00");
    expect(schedule.end).toEqual({ kind: "timed", localCivil: "2026-08-12T11:30" });
  });

  it("start-resize PATCHes the start only (the FullCalendar renderer refused it)", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"));
    const fetch = await mount([event], { subview: "week", patch: () => json(checklistMutationBody(event, rangeSchedule(timed("2026-08-12T09:30"), timed("2026-08-12T11:00"), 4))) });
    await proposeUpdate(ID, { start: at("2026-08-12T09:30"), end: at("2026-08-12T11:00"), allDay: false, source: "resize-start", granularity: "minute" });
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
    const schedule = scheduleOf(fetch.patches()[0]!).schedule as { start: { localCivil: string }; end: { localCivil: string } };
    expect(schedule.start.localCivil).toBe("2026-08-12T09:30");
    expect(schedule.end.localCivil).toBe("2026-08-12T11:00");
  });

  it("returns false (the vendor snaps back) and sends nothing for a no-op or an invalid proposal", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"));
    const fetch = await mount([event], { subview: "week" });
    expect(await proposeUpdate(ID, { start: at("2026-08-12T10:00"), allDay: false, granularity: "minute" })).toBe(false);
    expect(await proposeUpdate(ID, { start: at("2026-08-12T10:00"), allDay: false, source: "api" })).toBe(false);
    expect(await proposeUpdate(ID, { start: at("2026-08-12T09:00"), end: at("2026-08-12T12:00"), allDay: false, source: "keyboard", granularity: "minute" })).toBe(false);
    await flush(5);
    expect(fetch.patches()).toHaveLength(0);
    expect(liveRegion()).toBe("");
  });

  it("holds the dropped chip where it landed while the PATCH is in flight", async () => {
    const event = dueEvent(dated("2026-08-12"));
    let resolvePatch!: (response: Response) => void;
    await mount([event], { patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }) });
    await proposeUpdate(ID, { start: day("2026-08-15"), allDay: true });
    expect(chipStart(ID)).toBe(day("2026-08-15").toISOString());
    resolvePatch(json(checklistMutationBody(event, dueSchedule(dated("2026-08-15"), 3))));
    await flush(10);
  });

  it("warns (never blocks) when an out-of-range move is saved: the PATCH is sent and the saved announcement carries the warning", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], {
      projectBounds: [{ projectId: PROJECT_ID, shootDate: "2026-08-01", createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: "2026-08-14T17:00" }],
      patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-20"), 3))),
    });
    expect(await proposeUpdate(ID, { start: day("2026-08-20"), allDay: true })).toBe("deferred");
    await flush(20);
    expect(fetch.patches()).toHaveLength(1);
    expect(liveRegion()).toContain("Warning: Due after the project deadline.");
  });

  it("#288: warns when a due_only is moved before the shoot date (the Gantt's rule), and still sends the PATCH", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], {
      projectBounds: [{ projectId: PROJECT_ID, shootDate: "2026-08-11", createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: null }],
      patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-10"), 3))),
    });
    expect(await proposeUpdate(ID, { start: day("2026-08-10"), allDay: true })).toBe("deferred");
    await flush(20);
    expect(fetch.patches()).toHaveLength(1);
    expect(liveRegion()).toContain("Warning: Due before the shoot date.");
  });

  it("#288: with no shoot date, falls back to the Sydney created date as the lower bound, and still sends the PATCH", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], {
      // 2026-08-11T14:00Z is 2026-08-12T00:00 in Sydney (AEST, +10): the lower bound is the 12th.
      projectBounds: [{ projectId: PROJECT_ID, shootDate: null, createdAt: "2026-08-11T14:00:00.000Z", deadlineLocalCivil: null }],
      patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-11"), 3))),
    });
    expect(await proposeUpdate(ID, { start: day("2026-08-11"), allDay: true })).toBe("deferred");
    await flush(20);
    expect(fetch.patches()).toHaveLength(1);
    expect(liveRegion()).toContain("Warning: Due before the project was created.");
  });

  it("keeps checklist collaboration role-based on server permissions, not admin-only", async () => {
    const base = dueEvent(dated("2026-08-12"));
    const external = { ...base, project: { ...base.project, stageKey: "editing" as const }, assignee: { ...ASSIGNEE, isExternal: true, roleLabel: "External Editor" } } as ChecklistCalendarEventDto;
    const schedule = dueSchedule(dated("2026-08-13"), 3);
    const body = { ...checklistMutationBody(external, schedule), assignee: external.assignee, assignmentVersion: 1, dueDate: schedule.due, createdBy: external.assignee, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    const fetch = await mount([external], { role: "external_editor", patch: () => json(body) });
    expect(eventCalendarFake.event(ID)?.draggable).toBe(true);
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
  });

  it("preserves richer external assignee metadata through a no-op PATCH (editor save)", async () => {
    const base = dueEvent(dated("2026-08-12"));
    const assignee = { ...ASSIGNEE, isExternal: true, roleLabel: "External Editor" };
    const event = { ...base, assignee } as ChecklistCalendarEventDto;
    const fetch = await mount([event], { patch: () => json(checklistMutationBody(event, event.schedule)) });
    await openReschedule(ID);
    await clickTestId("event-calendar-schedule-submit");
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
    const rendered = eventCalendarFake.event(ID)?.data as { dto: ChecklistCalendarEventDto } | undefined;
    expect(rendered?.dto.assignee).toEqual(assignee);
  });

  it("mutually locks the Deadline confirmation and checklist commands", async () => {
    const deadline = deadlineEvent("2026-08-12T10:00");
    const event = dueEvent(dated("2026-08-12"));
    const range = rangeResponse({ events: [deadline, event] });
    let fetch = stubCalendarFetch({ range, patch: () => { throw new Error("checklist PATCH should be locked"); }, put: () => json(deadlineSaveBody("2026-08-13T10:00")) });
    await h.render(calendarState("month"));
    await proposeUpdate(deadline.id, { start: day("2026-08-13"), allDay: false, granularity: "day" });
    expect(liveRegion()).toContain("Confirmation required");
    // The confirmation holds the gate: the chip is not draggable, the vendor snaps it back.
    expect(await proposeUpdate(ID, { start: day("2026-08-14"), allDay: true })).toBe(false);
    expect(chipStart(ID)).toBe(day("2026-08-12").toISOString());
    expect(fetch.patches()).toHaveLength(0);
    expect(fetch.puts()).toHaveLength(0);
    expect(fetch.rangeGets()).toHaveLength(1);
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(5);

    await h.unmount();
    let resolvePatch!: (response: Response) => void;
    fetch = stubCalendarFetch({ range, patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }), put: () => json(deadlineSaveBody("2026-08-13T10:00")) });
    await h.render(calendarState("month"));
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await proposeUpdate(deadline.id, { start: day("2026-08-14"), allDay: false, granularity: "day" });
    expect(fetch.patches()).toHaveLength(1);
    expect(fetch.puts()).toHaveLength(0);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')).toBeNull();
    resolvePatch(json(checklistMutationBody(event, event.schedule)));
    await flush(10);
  });

  it("keeps Agenda checklist entries editor-only", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { subview: "agenda" });
    expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).not.toBeNull();
    expect(await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true })).toBe(false);
    expect(fetch.patches()).toHaveLength(0);
  });

  it("flushes one queued refetch but does not settle or publish for a semantic no-op response", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const settleStates: boolean[] = [];
    const runtime = new ProjectQueryRuntime(h.client, "event-calendar-noop-tab");
    const publish = vi.spyOn(runtime, "publish");
    let resolvePatch!: (response: Response) => void;
    const fetch = await mount([event], { patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }), onSettleStateChange: (state) => settleStates.push(state.pending) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    h.client.setQueryData(mainRangeQuery(h.client).queryKey, rangeResponse({ events: [{ ...event, title: "Queued update" }] }));
    await flush(0);
    resolvePatch(json(checklistMutationBody(event, event.schedule)));
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(fetch.rangeGets()).toHaveLength(2);
    expect(settleStates).not.toContain(true);
    expect(publish).not.toHaveBeenCalled();
    expect(liveRegion()).toContain("No change.");
    runtime.dispose();
  });

  it("asks for an endpoint-specific fold choice, then remaps at the same source version (lesson #241)", async () => {
    const event = dueEvent(timed("2026-04-04T10:00"), { version: 6 });
    const later = { kind: "timed" as const, localCivil: "2026-04-05T02:30", instant: "2026-04-04T16:30:00.000Z", utcOffsetMinutes: 600, fold: "later" as const, resolution: "stored" as const };
    const fetch = await mount([event], { subview: "week", patch: () => json(checklistMutationBody(event, dueSchedule(later as never, 7))) });
    // The EARLIER 02:30 instant: the dropped instant must not pick the occurrence.
    await proposeUpdate(ID, { start: at("2026-04-05T02:30"), allDay: false, granularity: "minute" });
    expect(fetch.patches()).toHaveLength(0);
    expect(document.body.textContent).toContain("occurs twice");
    await act(async () => { byLabel("end later occurrence")!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-fold-submit");
    await flush(5);
    expect(fetch.patches()).toHaveLength(1);
    const sent = scheduleOf(fetch.patches()[0]!) as { expectedVersion: number; schedule: { end: { disambiguation?: string } } };
    expect(sent.expectedVersion).toBe(6);
    expect(sent.schedule.end.disambiguation).toBe("later");
  });

  it("keeps the fold choice rendering after the move dialog has been used (sibling open-token keys)", async () => {
    const deadline = deadlineEvent("2026-04-04T11:00");
    const event = dueEvent(timed("2026-04-04T10:00"));
    const fetch = stubCalendarFetch({ range: rangeResponse({ events: [deadline, event], subview: "week", date: "2026-04-04" }) });
    const consoleError = vi.spyOn(console, "error");
    try {
      await h.render(calendarState("week", "2026-04-04"));
      for (let round = 0; round < 2; round += 1) {
        await openReschedule(deadline.id);
        await clickTestId("event-calendar-move-cancel");
        await flush(0);
        await proposeUpdate(ID, { start: at("2026-04-05T02:30"), allDay: false, granularity: "minute" });
        expect(document.querySelector('[data-testid="event-calendar-fold-submit"]')).not.toBeNull();
        await clickTestId("event-calendar-fold-cancel");
        await flush(0);
      }
      expect(document.querySelectorAll('[data-testid="event-calendar-move-dialog"]').length).toBeLessThanOrEqual(1);
      expect(fetch.patches()).toHaveLength(0);
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("two children with the same key");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("re-PATCHes a dual-fold range editor save with both choices and the source version", async () => {
    const event = rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-12T11:00"), { version: 7 });
    const fetch = await mount([event]);
    await openReschedule(ID);
    await setValue(byLabel<HTMLSelectElement>("Checklist endpoint mode"), "timed");
    await setValue(byLabel("Checklist start date"), "2026-04-05");
    await setValue(byLabel("Checklist start time"), "02:30");
    await setValue(byLabel("Checklist end date"), "2026-04-05");
    await setValue(byLabel("Checklist end time"), "02:30");
    const folds = [...document.querySelectorAll<HTMLInputElement>('[data-testid="event-calendar-schedule-editor"] input[type="radio"]')];
    expect(folds).toHaveLength(4);
    await act(async () => { folds[0]!.click(); folds[3]!.click(); await Promise.resolve(); });
    await clickTestId("event-calendar-schedule-submit");
    expect(fetch.patches()).toHaveLength(1);
    expect(fetch.patches()[0]!.body).toEqual({ schedule: { expectedVersion: 7, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" }, end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } } } });
    expect(JSON.stringify(fetch.patches()[0]!.body)).not.toContain("dueDate");
  });

  it("opens a due-only entry as a one-day range and saves the extended range (#340)", async () => {
    const event = dueEvent(dated("2026-08-12"), { version: 4 });
    const fetch = await mount([event], { patch: () => json(checklistMutationBody(event, rangeSchedule(dated("2026-08-12"), dated("2026-08-13"), 5))) });
    await openReschedule(ID);
    expect(byLabel("Checklist start date")?.value).toBe("2026-08-12");
    expect(byLabel("Checklist end date")?.value).toBe("2026-08-12");
    await setValue(byLabel("Checklist end date"), "2026-08-13");
    await clickTestId("event-calendar-schedule-submit");
    expect(scheduleOf(fetch.patches()[0]!)).toEqual({ expectedVersion: 4, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-12" }, end: { kind: "date", localCivil: "2026-08-13" } } });
  });

  it("retains the editor draft after a schedule-version conflict and never retries", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json({ code: "subtask_schedule_version_conflict", message: "conflict" }, 409) });
    await openReschedule(ID);
    await setValue(byLabel("Checklist end date"), "2026-08-15");
    await clickTestId("event-calendar-schedule-submit");
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(byLabel("Checklist end date")?.value).toBe("2026-08-15");
    expect(liveRegion()).toContain("changed elsewhere");
  });

  it("adopts/refetches the current item after an item conflict without retrying", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json({ code: "subtask_item_conflict", message: "item conflict", current: event.schedule, currentSubtask: checklistMutationBody(event) }, 409) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(liveRegion()).toContain("changed elsewhere");
  });

  it("treats schedule reload_required as a mapping defect and never uses dueDate", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json({ code: "subtask_schedule_reload_required", message: "reload required" }, 400) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(fetch.patches()[0]!.body).not.toHaveProperty("dueDate");
    expect(liveRegion()).toContain("could not be applied");
  });

  it("refuses a checklist command while its schedule editor owns the shared lock", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event]);
    await openReschedule(ID);
    await proposeUpdate(ID, { start: day("2026-08-14"), allDay: true });
    expect(fetch.patches()).toHaveLength(0);
    await clickTestId("event-calendar-schedule-cancel");
  });

  it("marks a storage-invalid response read-only and never opens its editor", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json({ code: "subtask_schedule_storage_invalid", message: "invalid" }, 422) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(10);
    expect(h.host.textContent).toContain("Schedule data needs attention");
    expect(h.host.textContent).toContain("Repair is unavailable");
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).toBeNull();
    expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
    expect(fetch.patches()).toHaveLength(1);
  });

  it("flushes a queued invalidation after a storage-invalid failure and keeps the item marked", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const invalidEntry: ChecklistCalendarUnscheduledEntryDto = {
      id: event.id, kind: "checklist", reason: "schedule_needs_attention", attentionReason: "invalid", title: event.title, project: event.project, assignee: event.assignee,
      schedule: { state: "invalid", version: event.schedule.version, zone: null, start: null, end: null, due: event.schedule.due, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false },
    } as ChecklistCalendarUnscheduledEntryDto;
    const valid = rangeResponse({ events: [event] });
    const invalid = rangeResponse({ events: [], unscheduled: [invalidEntry] });
    let gets = 0;
    let resolvePatch!: (response: Response) => void;
    const fetch = stubCalendarFetch({
      range: (url) => {
        if (!url.includes("bounds=1")) return json(valid);
        gets += 1;
        return json(gets === 1 ? valid : invalid);
      },
      patch: () => new Promise<Response>((resolve) => { resolvePatch = resolve; }),
    });
    await h.render(calendarState("month"));
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    h.client.setQueryData(mainRangeQuery(h.client).queryKey, rangeResponse({ events: [{ ...event, title: "Queued update" }] }));
    await flush(10);
    resolvePatch(json({ error: "invalid", code: "subtask_schedule_storage_invalid", current: invalidEntry.schedule }, 422));
    await flush(50);
    expect(fetch.rangeGets()).toHaveLength(2);
    expect(h.host.querySelector('[data-unscheduled-id][data-attention="true"]')).not.toBeNull();
    expect(h.host.textContent).toContain("Repair is unavailable in Calendar");
    expect(liveRegion()).toContain("This checklist schedule needs attention. Repair is unavailable in Calendar.");
  });

  it("heals a storage-invalid marker when a later authoritative refetch returns a valid event", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const fetch = await mount([event], { patch: () => json({ code: "subtask_schedule_storage_invalid", message: "invalid" }, 422) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(10);
    expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
    expect(h.host.textContent).toContain("Schedule data needs attention");
    await act(async () => { await h.client.refetchQueries({ queryKey: mainRangeQuery(h.client).queryKey }); await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); });
    await flush(0);
    expect(fetch.rangeGets().length).toBeGreaterThanOrEqual(2);
    expect(eventCalendarFake.event(ID)?.draggable).toBe(true);
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).not.toBeNull();
  });

  it("sets the settle gate only for a changed response, then clears it after one refetch", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const states: boolean[] = [];
    let gets = 0;
    let release!: () => void;
    const runtime = new ProjectQueryRuntime(h.client, "event-calendar-changed-tab");
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(h.client, "invalidateQueries");
    const range = rangeResponse({ events: [event] });
    const fetch = stubCalendarFetch({
      range: (url) => {
        if (!url.includes("bounds=1")) return json(range);
        gets += 1;
        return gets === 1 ? json(range) : new Promise<Response>((resolve) => { release = () => resolve(json(range)); });
      },
      patch: () => json(checklistMutationBody(event, dueSchedule(dated("2026-08-13"), 3))),
    });
    await h.render(calendarState("month"), { onSettleStateChange: (state) => states.push(state.pending) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(5);
    expect(states).toContain(true);
    release();
    await flush(10);
    expect(states.at(-1)).toBe(false);
    expect(fetch.rangeGets()).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining(["project-data-invalidated", "production-calendar-invalidated", "production-gantt-invalidated"]));
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(false);
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "production-calendar")).toBe(false);
    runtime.dispose();
  });

  it("sends no second request after access loss", async () => {
    const event = dueEvent(dated("2026-08-12"));
    const onAccessLoss = vi.fn();
    const fetch = await mount([event], { onAccessLoss, patch: () => json({ code: "forbidden", message: "forbidden" }, 403) });
    await proposeUpdate(ID, { start: day("2026-08-13"), allDay: true });
    await flush(10);
    expect(fetch.patches()).toHaveLength(1);
    expect(onAccessLoss).toHaveBeenCalledTimes(1);
  });

  it("keeps the grid mounted while the next month's range loads (no skeleton flash)", async () => {
    const event = dueEvent(dated("2026-08-12"));
    let release!: () => void;
    stubCalendarFetch({
      range: (url) => url.includes("date=2026-09-12") && url.includes("bounds=1")
        ? new Promise<Response>((resolve) => { release = () => resolve(json(rangeResponse({ date: "2026-09-12" }))); })
        : json(rangeResponse({ events: [event] })),
    });
    await h.render(calendarState("month"));
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).not.toBeNull();
    await h.rerender(calendarState("month", "2026-09-12"));
    await flush(5);
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).not.toBeNull();
    expect(h.host.querySelector('[data-testid="event-calendar-loading"]')).toBeNull();
    expect(eventCalendarFake.lastProps?.loading).toBe(true);
    release();
    await flush(10);
    expect(eventCalendarFake.lastProps?.loading).toBe(false);
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).not.toBeNull();
  });

  it("returns focus to the chip button around the chip content after a cancelled command", async () => {
    const event = dueEvent(dated("2026-08-12"));
    await mount([event]);
    await openReschedule(ID);
    await clickTestId("event-calendar-schedule-cancel");
    await flush(5);
    const active = document.activeElement as HTMLElement | null;
    expect(active?.tagName).toBe("BUTTON");
    expect(active?.querySelector("[data-event-id]")?.getAttribute("data-event-id")).toBe(ID);
  });
});

describe("ProductionEventCalendar checklist editor Range option", () => {
  it("offers no state picker in the editor and never renders an invalid-entry action", async () => {
    const event = rangeEvent(dated("2026-08-12"), dated("2026-08-13"));
    const invalid = {
      id: "checklist:55555555-5555-4555-8555-555555555555", kind: "checklist", reason: "schedule_needs_attention", attentionReason: "invalid", title: "Broken", project: event.project, assignee: null,
      schedule: { state: "invalid", version: 4, zone: null, start: null, end: null, due: null, error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } },
      permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false },
    } as ChecklistCalendarUnscheduledEntryDto;
    stubCalendarFetch({ range: rangeResponse({ events: [event], unscheduled: [invalid] }) });
    await h.render(calendarState("month"));
    await openReschedule(ID);
    expect(byLabel("Checklist schedule state")).toBeNull();
    expect(byLabel("Checklist start date")).not.toBeNull();
    expect(byLabel("Checklist end date")).not.toBeNull();
    expect(h.host.querySelector(`[data-unscheduled-id="${invalid.id}"] button`)).toBeNull();
  });
});
