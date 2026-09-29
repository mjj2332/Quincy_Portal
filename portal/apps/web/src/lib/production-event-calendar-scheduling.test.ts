import { describe, expect, it } from "vitest";
import {
  mapChecklistEndResizeToCommand,
  mapChecklistMoveToCommand,
  mapChecklistStartResizeToCommand,
  mapProjectDeadlineMoveToCommand,
  resolveSydneyCivilMinute,
  type CalendarEventDto,
} from "@quincy/shared";
import {
  eventCalendarUpdateToProposal,
  type EventCalendarSchedulingResult,
  type EventCalendarUpdateLike,
} from "./production-event-calendar-scheduling";
import { toProductionEventCalendarEvent } from "./production-event-calendar-adapter";
import type { SchedulingProposal } from "./scheduling-policy";
import { dated, deadlineEvent, instantOf, rangeEvent, timed } from "../testing/production-calendar-fixtures";

const at = (localCivil: string) => new Date(instantOf(localCivil));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A vendor proposal against the adapter's own display of `dto`. */
function update(dto: CalendarEventDto, change: Partial<Omit<EventCalendarUpdateLike, "event">>): EventCalendarUpdateLike {
  const displayed = toProductionEventCalendarEvent(dto)!;
  return {
    event: { start: displayed.start, end: displayed.end },
    start: displayed.start,
    end: displayed.end,
    allDay: displayed.allDay,
    source: "drag",
    granularity: "minute",
    ...change,
  };
}

function proposal(result: EventCalendarSchedulingResult): SchedulingProposal {
  if (result.kind !== "proposal") throw new Error(`expected a proposal, got ${JSON.stringify(result)}`);
  return result.proposal;
}

function expectLegalSubview(p: SchedulingProposal) {
  expect(["month", "week"]).toContain(p.target.subview);
}

function checklistCommand(p: SchedulingProposal) {
  if (p.entity !== "checklist" || (p.kind !== "move" && p.kind !== "resize")) throw new Error("not a checklist move/resize");
  const input = { event: p.source, target: p.target, ...(p.disambiguation ? { disambiguation: p.disambiguation } : {}) };
  if (p.kind === "move") return mapChecklistMoveToCommand(input);
  return p.edge === "start" ? mapChecklistStartResizeToCommand({ ...input, edge: "start" }) : mapChecklistEndResizeToCommand({ ...input, edge: "end" });
}

const timedRange = () => rangeEvent(timed("2026-08-26T09:00"), timed("2026-08-26T11:00"));
const datedRange = () => rangeEvent(dated("2026-08-26"), dated("2026-08-28"));

describe("event-calendar scheduling: refusals and no-ops", () => {
  it("an api-sourced proposal is invalid", () => {
    expect(eventCalendarUpdateToProposal(timedRange(), update(timedRange(), { source: "api", granularity: undefined }))).toMatchObject({ kind: "invalid" });
  });

  it("a proposal without granularity is invalid", () => {
    const dto = timedRange();
    expect(eventCalendarUpdateToProposal(dto, update(dto, { start: at("2026-08-26T10:00"), end: at("2026-08-26T12:00"), granularity: undefined }))).toMatchObject({ kind: "invalid" });
  });

  it("a pointer resize of a Deadline is invalid", () => {
    const deadline = deadlineEvent("2026-08-27T09:00");
    expect(eventCalendarUpdateToProposal(deadline, update(deadline, { source: "resize-end", end: at("2026-08-27T11:00") }))).toMatchObject({ kind: "invalid" });
  });

  it("an unmoved drop is a no-op, at either granularity", () => {
    const dto = timedRange();
    expect(eventCalendarUpdateToProposal(dto, update(dto, {}))).toEqual({ kind: "noop" });
    expect(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day" }))).toEqual({ kind: "noop" });
    const deadline = deadlineEvent("2026-08-27T09:00");
    expect(eventCalendarUpdateToProposal(deadline, update(deadline, { granularity: "day" }))).toEqual({ kind: "noop" });
  });

  it("keyboard: no delta is a no-op; a compound range edit is invalid", () => {
    const dto = timedRange();
    expect(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard" }))).toEqual({ kind: "noop" });
    expect(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", start: at("2026-08-26T08:00"), end: at("2026-08-26T13:00") }))).toMatchObject({ kind: "invalid" });
  });

  it("keyboard: an END-only change on a Deadline is a no-op (the end is synthetic)", () => {
    const deadline = deadlineEvent("2026-08-27T09:00");
    const displayed = toProductionEventCalendarEvent(deadline)!;
    expect(eventCalendarUpdateToProposal(deadline, update(deadline, { source: "keyboard", end: new Date(displayed.end.getTime() + HOUR) }))).toEqual({ kind: "noop" });
  });
});

describe("event-calendar scheduling: checklist ranges", () => {
  it("a minute move targets week with the dropped civil minute", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { start: at("2026-08-27T13:15"), end: at("2026-08-27T15:15") })));
    expect(p).toMatchObject({ kind: "move", entity: "checklist", target: { subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T13:15" } });
    expectLegalSubview(p);
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ state: "range", start: { localCivil: "2026-08-27T13:15" }, end: { localCivil: "2026-08-27T15:15" } });
  });

  it("a day move targets month with the start's new civil date, and keeps wall time", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", start: at("2026-08-29T09:00"), end: at("2026-08-29T11:00") })));
    expect(p).toMatchObject({ kind: "move", target: { subview: "month", targetDate: "2026-08-29" } });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-08-29T09:00" }, end: { localCivil: "2026-08-29T11:00" } });
  });

  it("a timed range dropped on the all-day lane stays timed (the DTO's endpoint kind wins)", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", allDay: true, start: at("2026-08-28T00:00"), end: at("2026-08-29T00:00") })));
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { kind: "timed", localCivil: "2026-08-28T09:00" } });
  });

  it("an all-day range moved by day cells keeps its span", () => {
    const dto = datedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", start: at("2026-08-31T00:00"), end: at("2026-09-03T00:00") })));
    expect(p.target).toEqual({ subview: "month", targetDate: "2026-08-31" });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { kind: "date", localCivil: "2026-08-31" }, end: { kind: "date", localCivil: "2026-09-02" } });
  });

  it("start resize patches the start only", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "resize-start", start: at("2026-08-26T07:30") })));
    expect(p).toMatchObject({ kind: "resize", edge: "start", target: { subview: "week", targetCivilMinute: "2026-08-26T07:30", edge: "start" } });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-08-26T07:30" }, end: { localCivil: "2026-08-26T11:00" } });
  });

  it("end resize of a timed range at minute granularity", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "resize-end", end: at("2026-08-26T12:45") })));
    expect(p).toMatchObject({ kind: "resize", edge: "end", target: { subview: "week", targetDate: "2026-08-26", targetCivilMinute: "2026-08-26T12:45", edge: "end" } });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ end: { localCivil: "2026-08-26T12:45" } });
  });

  it("end resize of a timed range at day granularity keeps the end's wall time", () => {
    const dto = timedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "resize-end", granularity: "day", end: at("2026-08-28T11:00") })));
    expect(p.target).toMatchObject({ subview: "month", targetDate: "2026-08-28", targetCivilMinute: "2026-08-28T11:00", edge: "end" });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ end: { kind: "timed", localCivil: "2026-08-28T11:00" } });
  });

  it("end resize of an all-day range passes the EXCLUSIVE end", () => {
    const dto = datedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "resize-end", granularity: "day", end: at("2026-08-31T00:00") })));
    expect(p.target).toEqual({ subview: "month", targetDate: "2026-08-31", end: "2026-08-31", edge: "end" });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ end: { kind: "date", localCivil: "2026-08-30" } });
  });

  it("start resize of an all-day range targets the new start date", () => {
    const dto = datedRange();
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "resize-start", granularity: "day", start: at("2026-08-24T00:00") })));
    expect(p.target).toEqual({ subview: "month", targetDate: "2026-08-24", edge: "start" });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-08-24" }, end: { localCivil: "2026-08-28" } });
  });

  it("keyboard deltas classify like the Gantt: both edges equal → move, one edge → that resize", () => {
    const dto = timedRange();
    const move = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", start: at("2026-08-26T10:00"), end: at("2026-08-26T12:00") })));
    expect(move.kind).toBe("move");
    const startOnly = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", start: at("2026-08-26T08:00") })));
    expect(startOnly).toMatchObject({ kind: "resize", edge: "start" });
    const endOnly = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", granularity: "day", end: at("2026-08-27T11:00") })));
    expect(endOnly).toMatchObject({ kind: "resize", edge: "end", target: { subview: "month", targetDate: "2026-08-27" } });
  });
});

describe("event-calendar scheduling: Deadlines", () => {
  it("a timed Deadline moved by day cells keeps its wall time through the shared mapper", () => {
    const event = deadlineEvent("2026-08-27T09:00");
    const p = proposal(eventCalendarUpdateToProposal(event, update(event, { granularity: "day", start: at("2026-08-29T09:00"), end: at("2026-08-29T09:30") })));
    expect(p).toMatchObject({ kind: "deadline", entity: "project_deadline", target: { subview: "month", targetDate: "2026-08-29" } });
    if (p.kind !== "deadline") throw new Error("unreachable");
    const command = mapProjectDeadlineMoveToCommand({ event: p.event, target: p.target });
    expect(command.ok && command.value.deadline?.localCivil).toBe("2026-08-29T09:00");
  });

  it("a Deadline moved in the time grid targets week with the dropped minute; its end is ignored", () => {
    const event = deadlineEvent("2026-08-27T09:00");
    const p = proposal(eventCalendarUpdateToProposal(event, update(event, { start: at("2026-08-27T14:30"), end: at("2026-08-27T23:00") })));
    expect(p.target).toEqual({ subview: "week", targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T14:30" });
  });

  it("a keyboard START change on a Deadline is a move even when the end moved differently", () => {
    const event = deadlineEvent("2026-08-27T09:00");
    const p = proposal(eventCalendarUpdateToProposal(event, update(event, { source: "keyboard", start: at("2026-08-27T10:00"), end: at("2026-08-27T13:00") })));
    expect(p).toMatchObject({ kind: "deadline", target: { subview: "week", targetCivilMinute: "2026-08-27T10:00" } });
  });

  it("a one-day dated range moves by its display start and stays a one-day range", () => {
    const dto = rangeEvent(dated("2026-08-27"), dated("2026-08-27"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", start: at("2026-08-30T00:00"), end: at("2026-08-31T00:00") })));
    expect(p).toMatchObject({ kind: "move", target: { subview: "month", targetDate: "2026-08-30" } });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ state: "range", start: { kind: "date", localCivil: "2026-08-30" }, end: { kind: "date", localCivil: "2026-08-30" } });
  });
});

describe("event-calendar scheduling: DST (both 2026 Sydney transitions)", () => {
  it("fall-back week: a day move keeps wall time across the 25h day", () => {
    const dto = rangeEvent(timed("2026-04-03T09:00"), timed("2026-04-03T11:00"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", start: at("2026-04-06T09:00"), end: at("2026-04-06T11:00") })));
    expect(p.target).toEqual({ subview: "month", targetDate: "2026-04-06" });
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-04-06T09:00" }, end: { localCivil: "2026-04-06T11:00" } });
  });

  it("spring-forward week: a day move keeps wall time across the 23h day", () => {
    const deadline = deadlineEvent("2026-10-03T17:00");
    const p = proposal(eventCalendarUpdateToProposal(deadline, update(deadline, { granularity: "day", start: at("2026-10-05T17:00"), end: at("2026-10-05T17:30") })));
    if (p.kind !== "deadline") throw new Error("unreachable");
    const command = mapProjectDeadlineMoveToCommand({ event: p.event, target: p.target });
    expect(command.ok && command.value.deadline?.localCivil).toBe("2026-10-05T17:00");
  });

  it("spring-forward week: an all-day range across the 23h day keeps its dates", () => {
    const dto = rangeEvent(dated("2026-10-02"), dated("2026-10-03"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { granularity: "day", start: at("2026-10-04T00:00"), end: at("2026-10-06T00:00") })));
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-10-04" }, end: { localCivil: "2026-10-05" } });
  });

  // Keyboard Adjust in month view shifts each endpoint by calendar days on its own, so when only one
  // endpoint crosses the transition the two millisecond deltas differ by an hour. That is still a
  // move, not a compound edit.
  it("fall-back: a keyboard +1 day on a dated range whose END crosses the 25h day is a move", () => {
    const dto = rangeEvent(dated("2026-04-03"), dated("2026-04-04"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", granularity: "day", start: at("2026-04-04T00:00"), end: at("2026-04-06T00:00") })));
    expect(p.kind).toBe("move");
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-04-04" }, end: { localCivil: "2026-04-05" } });
  });

  it("spring-forward: a keyboard +1 day on a dated range whose END crosses the 23h day is a move", () => {
    const dto = rangeEvent(dated("2026-10-02"), dated("2026-10-03"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", granularity: "day", start: at("2026-10-03T00:00"), end: at("2026-10-05T00:00") })));
    expect(p.kind).toBe("move");
    const command = checklistCommand(p);
    expect(command.ok && command.value.schedule).toMatchObject({ start: { localCivil: "2026-10-03" }, end: { localCivil: "2026-10-04" } });
  });

  it("fall-back: a keyboard END-only +1 day across the 25h day is still an end resize", () => {
    const dto = rangeEvent(dated("2026-04-03"), dated("2026-04-04"));
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { source: "keyboard", granularity: "day", end: at("2026-04-06T00:00") })));
    expect(p).toMatchObject({ kind: "resize", edge: "end" });
  });

  it("never derives fold disambiguation from the dropped instant (lesson #241): the second-pass 02:30 still asks", () => {
    const secondPass = resolveSydneyCivilMinute("2026-04-05T02:30", "later");
    if (!secondPass.ok) throw new Error("fixture");
    const dto = rangeEvent(timed("2026-04-04T16:00"), timed("2026-04-04T16:30"));
    const dropped = new Date(secondPass.value.instant);
    const p = proposal(eventCalendarUpdateToProposal(dto, update(dto, { start: dropped, end: new Date(dropped.getTime() + 30 * 60_000) })));
    expect(p.target).toMatchObject({ subview: "week", targetCivilMinute: "2026-04-05T02:30" });
    expect("disambiguation" in p).toBe(false);
    const command = checklistCommand(p);
    expect(command.ok).toBe(false);
    if (command.ok) return;
    expect(command.error.choices?.length).toBe(2);
  });
});
