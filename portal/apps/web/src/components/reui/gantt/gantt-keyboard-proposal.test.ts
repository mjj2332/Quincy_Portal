/**
 * #219 (PR A) stage 2, step 2 — the pure keyboard-nudge proposal math. Node suite
 * (`vitest.config.ts`): exercises `gantt-lib.tsx`'s `computeGanttKeyboardProposal` directly, no
 * React, no store.
 *
 * The day-or-more (`step >= 1440`) cases use `Australia/Sydney`'s 2026 DST boundaries: the
 * spring-forward day 2026-10-04 (23 real hours — clocks jump 02:00 -> 03:00) and the fall-back day
 * 2026-04-05 (25 real hours — clocks fall 03:00 -> 02:00). A raw `+= 1440 * 60000` ms step would
 * land an hour off the zoned midnight grid on either day; this pins that it does not.
 */
import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import { differenceInCalendarDays } from "date-fns";
import {
  computeGanttKeyboardProposal,
  toZoned,
  zonedStartOfDay,
} from "@/components/reui/gantt/gantt-lib";

const SYDNEY = "Australia/Sydney";
const UTC = "UTC";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(TZDate.tz(UTC, y, m, d, h, min).getTime());
const sydney = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(TZDate.tz(SYDNEY, y, m, d, h, min).getTime());

describe("computeGanttKeyboardProposal — sub-day step (minute mode, step < 1440)", () => {
  it("move: steps a timed subject forward one step, preserving duration", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 60, UTC);
    expect(result).toEqual({ start: at(2026, 0, 5, 10, 0), end: at(2026, 0, 5, 11, 0), allDay: false });
  });

  it("move: steps a timed subject backward one step", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", -1, 60, UTC);
    expect(result).toEqual({ start: at(2026, 0, 5, 8, 0), end: at(2026, 0, 5, 9, 0), allDay: false });
  });

  it("resize-end: grows by one step later", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", 1, 60, UTC);
    expect(result).toEqual({ start, end: at(2026, 0, 5, 11, 0), allDay: false });
  });

  it("resize-start: grows by one step earlier", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", -1, 60, UTC);
    expect(result).toEqual({ start: at(2026, 0, 5, 8, 0), end, allDay: false });
  });

  it("resize-end never inverts: shrinking below one step returns null", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0); // exactly one 60-minute step long
    expect(computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", -1, 60, UTC)).toBeNull();
  });

  it("resize-start never inverts: shrinking below one step returns null", () => {
    const start = at(2026, 0, 5, 9, 0);
    const end = at(2026, 0, 5, 10, 0);
    expect(computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", 1, 60, UTC)).toBeNull();
  });

  it("a milestone (start === end) moves but never resizes", () => {
    const point = at(2026, 0, 5, 9, 0);
    const moved = computeGanttKeyboardProposal({ start: point, end: point, allDay: false }, "move", 1, 60, UTC);
    expect(moved).toEqual({ start: at(2026, 0, 5, 10, 0), end: at(2026, 0, 5, 10, 0), allDay: false });
    expect(
      computeGanttKeyboardProposal({ start: point, end: point, allDay: false }, "resize-start", -1, 60, UTC),
    ).toBeNull();
    expect(
      computeGanttKeyboardProposal({ start: point, end: point, allDay: false }, "resize-end", 1, 60, UTC),
    ).toBeNull();
  });
});

describe("computeGanttKeyboardProposal — day-or-more step (step >= 1440) across Australia/Sydney DST", () => {
  it("day-aligned move across the spring-forward day (2026-10-04, 23h) stays midnight-to-midnight, civil-day span unchanged", () => {
    const start = sydney(2026, 9, 3); // Oct 3 2026 00:00 Sydney
    const end = sydney(2026, 9, 4); // Oct 4 2026 00:00 Sydney - a 1-day span
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 4).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 5).getTime());
    expect(zonedStartOfDay(r.start, SYDNEY).getTime()).toBe(r.start.getTime());
    expect(zonedStartOfDay(r.end, SYDNEY).getTime()).toBe(r.end.getTime());
    expect(differenceInCalendarDays(toZoned(r.end, SYDNEY), toZoned(r.start, SYDNEY))).toBe(1);
  });

  it("day-aligned move across the fall-back day (2026-04-05, 25h) stays midnight-to-midnight, civil-day span unchanged", () => {
    const start = sydney(2026, 3, 4);
    const end = sydney(2026, 3, 5);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 3, 5).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 3, 6).getTime());
    expect(zonedStartOfDay(r.start, SYDNEY).getTime()).toBe(r.start.getTime());
    expect(zonedStartOfDay(r.end, SYDNEY).getTime()).toBe(r.end.getTime());
    expect(differenceInCalendarDays(toZoned(r.end, SYDNEY), toZoned(r.start, SYDNEY))).toBe(1);
  });

  it("a timed (non-midnight-aligned) bar moved across the spring-forward day keeps its wall-clock time and exact duration", () => {
    const start = sydney(2026, 9, 3, 14, 0); // 2pm Sydney
    const end = sydney(2026, 9, 3, 15, 0); // 3pm Sydney
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 4, 14, 0).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 4, 15, 0).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(end.getTime() - start.getTime());
  });

  it("a timed bar moved across the fall-back day keeps its wall-clock time and exact duration", () => {
    const start = sydney(2026, 3, 4, 14, 0);
    const end = sydney(2026, 3, 4, 15, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 3, 5, 14, 0).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 3, 5, 15, 0).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(end.getTime() - start.getTime());
  });

  it("resize-end steps by a civil day and never inverts below one day", () => {
    const start = sydney(2026, 9, 3);
    const end = sydney(2026, 9, 4); // 1-day span, the minimum
    expect(computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", -1, 24 * 60, SYDNEY)).toBeNull();
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", 1, 24 * 60, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.end.getTime()).toBe(sydney(2026, 9, 5).getTime());
    expect(zonedStartOfDay(grown!.end, SYDNEY).getTime()).toBe(grown!.end.getTime());
  });

  it("resize-start steps by a civil day and never inverts below one day", () => {
    const start = sydney(2026, 9, 3);
    const end = sydney(2026, 9, 4);
    expect(
      computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", 1, 24 * 60, SYDNEY),
    ).toBeNull();
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", -1, 24 * 60, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.start.getTime()).toBe(sydney(2026, 9, 2).getTime());
    expect(zonedStartOfDay(grown!.start, SYDNEY).getTime()).toBe(grown!.start.getTime());
  });

  it("a milestone moves across a civil day, preserving its wall-clock time, but never resizes", () => {
    const point = sydney(2026, 9, 3, 9, 30);
    const moved = computeGanttKeyboardProposal({ start: point, end: point, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(moved).not.toBeNull();
    expect(moved!.start.getTime()).toBe(moved!.end.getTime());
    expect(moved!.start.getTime()).toBe(sydney(2026, 9, 4, 9, 30).getTime());
    expect(
      computeGanttKeyboardProposal({ start: point, end: point, allDay: false }, "resize-end", 1, 24 * 60, SYDNEY),
    ).toBeNull();
  });

  it("an allDay subject moving across the spring-forward day stays midnight-aligned even though its own instants already were", () => {
    const start = sydney(2026, 9, 3);
    const end = sydney(2026, 9, 6); // 3-day span
    const result = computeGanttKeyboardProposal({ start, end, allDay: true }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.allDay).toBe(true);
    expect(differenceInCalendarDays(toZoned(r.end, SYDNEY), toZoned(r.start, SYDNEY))).toBe(3);
    expect(zonedStartOfDay(r.start, SYDNEY).getTime()).toBe(r.start.getTime());
  });
});
