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
  resolveAdjustLargerStepMinutes,
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

// ---------------------------------------------------------------------------
// #219 PR A fix item 4 (sol1) — day-unit keyboard nudge must shift the moving
// edge by a zoned civil day, preserving its wall time exactly (14:00 stays
// 14:00), never wrapping through `zonedStartOfDay`. A timed subject whose
// start and end sit on OPPOSITE sides of the 02:00-03:00 transition gap must
// have each edge shifted independently - NOT end = start + elapsed ms, which
// silently changes the end's wall time whenever the destination day's DST
// transition falls between the two wall-clock times. Upstream POINTER
// snapping is untouched by this fix (it still snaps to absolute midnight via
// its own path in gantt-dnd.tsx) - this is a documented, deliberate keyboard-
// only divergence; see gantt-lib.tsx's header and computeGanttKeyboardProposal
// doc comment.
// ---------------------------------------------------------------------------
describe("computeGanttKeyboardProposal — day-unit nudge preserves wall time exactly (sol1 item 4)", () => {
  it("timed resize-end across the spring-forward day (2026-10-04) preserves the edge's wall time, no midnight wrap", () => {
    const start = sydney(2026, 9, 3, 14, 0);
    const end = sydney(2026, 9, 4, 14, 0); // 1-day span, timed (not midnight-aligned)
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", 1, 24 * 60, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.end.getTime()).toBe(sydney(2026, 9, 5, 14, 0).getTime());
    // NOT wrapped to zoned midnight - the old (buggy) behavior.
    expect(zonedStartOfDay(grown!.end, SYDNEY).getTime()).not.toBe(grown!.end.getTime());
  });

  it("timed resize-start across the fall-back day (2026-04-05) preserves the edge's wall time, no midnight wrap", () => {
    const start = sydney(2026, 3, 4, 14, 0);
    const end = sydney(2026, 3, 6, 14, 0); // 2-day span, timed
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", -1, 24 * 60, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.start.getTime()).toBe(sydney(2026, 3, 3, 14, 0).getTime());
    expect(zonedStartOfDay(grown!.start, SYDNEY).getTime()).not.toBe(grown!.start.getTime());
  });

  it("timed move whose start and end straddle the spring-forward gap shifts each edge independently, NOT end = start + elapsed ms", () => {
    // 01:30 -> 03:30 Oct 3 (2h nominal span). Moved +1 civil day lands ON the
    // 23-hour transition day: the 02:00-03:00 gap sits strictly between the
    // two wall times, so the real elapsed time between them shrinks to 1h.
    const start = sydney(2026, 9, 3, 1, 30);
    const end = sydney(2026, 9, 3, 3, 30);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 4, 1, 30).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 4, 3, 30).getTime());
    // The real duration shrank from 2h to 1h - proof the end was re-derived
    // from its OWN wall time, not carried forward as the original elapsed ms.
    expect(r.end.getTime() - r.start.getTime()).toBe(60 * 60 * 1000);
  });

  it("timed move whose start and end straddle the fall-back gap shifts each edge independently, NOT end = start + elapsed ms", () => {
    // 01:30 -> 03:30 Apr 4 (2h nominal span). Moved +1 civil day lands ON the
    // 25-hour transition day: the repeated 02:00-03:00 hour sits between the
    // two wall times, so the real elapsed time between them grows to 3h.
    const start = sydney(2026, 3, 4, 1, 30);
    const end = sydney(2026, 3, 4, 3, 30);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 24 * 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 3, 5, 1, 30).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 3, 5, 3, 30).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it("minute-mode (sub-day) move steps by real minutes across the repeated 02:00-03:00 hour on the fall-back day, first fold to second fold", () => {
    // Australia/Sydney resolves an ambiguous local time to its LATER (standard
    // time) occurrence; the earlier (daylight) occurrence of the same wall
    // clock is exactly one real hour before it. Minute-mode uses raw ms
    // arithmetic (no zoned rounding), so stepping 60 real minutes from the
    // first fold must land exactly on the second fold's instant.
    const secondFoldMs = sydney(2026, 3, 5, 2, 30).getTime();
    const firstFoldMs = secondFoldMs - 60 * 60 * 1000;
    const start = new Date(firstFoldMs);
    const end = new Date(firstFoldMs + 30 * 60000);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, 60, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(secondFoldMs);
    expect(r.end.getTime()).toBe(firstFoldMs + 30 * 60000 + 60 * 60000);
  });
});

// ---------------------------------------------------------------------------
// #219 PR A (Adjust mode) — Shift+Arrow's "larger unit". Decision: a civil-day-or-more base step
// (week/month/quarter/year, or the day scale at a whole-day snap) takes a 7-civil-day larger step;
// a sub-day base step takes 1 hour when the snap is under an hour, otherwise 1 civil day.
// ---------------------------------------------------------------------------
describe("resolveAdjustLargerStepMinutes — pure step-size table", () => {
  it.each([
    // [baseStepMinutes, expected larger step]
    [15, 60], // day scale, 15-min snap -> 1 hour
    [30, 60], // day scale, 30-min snap -> 1 hour
    [59, 60], // just under an hour -> 1 hour
    [60, 24 * 60], // exactly an hour -> 1 civil day (not "1 more hour")
    [90, 24 * 60], // day scale, 90-min snap -> 1 civil day
    [24 * 60 - 1, 24 * 60], // just under a day -> 1 civil day
    [24 * 60, 7 * 24 * 60], // day scale, whole-day snap -> 7 civil days
    [7 * 24 * 60, 7 * 24 * 60], // week scale -> 7 civil days
    [30 * 24 * 60, 7 * 24 * 60], // month scale -> 7 civil days
    [365 * 24 * 60, 7 * 24 * 60], // year scale -> 7 civil days
  ])("base step %i minutes -> larger step %i minutes", (base, expected) => {
    expect(resolveAdjustLargerStepMinutes(base)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// #219 PR A (Adjust mode) — the 7-civil-day larger step through
// computeGanttKeyboardProposal itself (step = 10080), across both Australia/Sydney DST dates.
// Mirrors the existing single-civil-day (sol1 item 4) tests above, at 7x the step.
// ---------------------------------------------------------------------------
describe("computeGanttKeyboardProposal — 7-civil-day step (Adjust mode Shift+Arrow) across Australia/Sydney DST", () => {
  const SEVEN_DAYS = 7 * 24 * 60;

  it("day-aligned move by 7 civil days across the spring-forward week stays midnight-to-midnight, span unchanged", () => {
    const start = sydney(2026, 9, 1); // Oct 1 2026 00:00 Sydney
    const end = sydney(2026, 9, 2); // 1-day span
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, SEVEN_DAYS, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 8).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 9).getTime());
    expect(zonedStartOfDay(r.start, SYDNEY).getTime()).toBe(r.start.getTime());
    expect(differenceInCalendarDays(toZoned(r.end, SYDNEY), toZoned(r.start, SYDNEY))).toBe(1);
  });

  it("day-aligned move by 7 civil days across the fall-back week stays midnight-to-midnight, span unchanged", () => {
    const start = sydney(2026, 3, 1);
    const end = sydney(2026, 3, 2);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, SEVEN_DAYS, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 3, 8).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 3, 9).getTime());
    expect(zonedStartOfDay(r.start, SYDNEY).getTime()).toBe(r.start.getTime());
  });

  it("a timed bar moved 7 civil days across the spring-forward transition keeps its wall-clock time and exact duration", () => {
    const start = sydney(2026, 9, 1, 14, 0);
    const end = sydney(2026, 9, 1, 15, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, SEVEN_DAYS, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 8, 14, 0).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 8, 15, 0).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(end.getTime() - start.getTime());
  });

  it("a timed bar moved 7 civil days across the fall-back transition keeps its wall-clock time and exact duration", () => {
    const start = sydney(2026, 3, 1, 14, 0);
    const end = sydney(2026, 3, 1, 15, 0);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, SEVEN_DAYS, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 3, 8, 14, 0).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 3, 8, 15, 0).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(end.getTime() - start.getTime());
  });

  it("resize-end by 7 civil days across the spring-forward week, minimum duration stays ONE day (not seven)", () => {
    const start = sydney(2026, 9, 1);
    const end = sydney(2026, 9, 2); // 1-day span, the minimum
    // Shrinking by 7 days would invert far past a single day - still null, same bound as the
    // 1-day step, proving the minimum-duration bound does not scale with the step size.
    expect(
      computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", -1, SEVEN_DAYS, SYDNEY),
    ).toBeNull();
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-end", 1, SEVEN_DAYS, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.end.getTime()).toBe(sydney(2026, 9, 9).getTime());
  });

  it("resize-start by 7 civil days across the fall-back week, minimum duration stays ONE day (not seven)", () => {
    const start = sydney(2026, 3, 1);
    const end = sydney(2026, 3, 2);
    expect(
      computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", 1, SEVEN_DAYS, SYDNEY),
    ).toBeNull();
    const grown = computeGanttKeyboardProposal({ start, end, allDay: false }, "resize-start", -1, SEVEN_DAYS, SYDNEY);
    expect(grown).not.toBeNull();
    expect(grown!.start.getTime()).toBe(sydney(2026, 2, 25).getTime());
  });

  it("a timed move whose start and end straddle the spring-forward gap, 7 days later, shifts each edge independently and the real duration shrinks exactly as the single-day case does", () => {
    // Sep 27 (a normal 24h day) + 7 civil days lands ON Oct 4, the 23-hour spring-forward day -
    // same gap-straddling shape as the existing single-day test above, at 7x the step. The wall
    // clock lands identically (01:30 -> 03:30); the real elapsed time shrinks the same way (2h
    // nominal -> 1h real) because the 02:00-03:00 gap sits between the two wall times on the
    // LANDING day, regardless of how many civil days the step crossed to get there.
    const start = sydney(2026, 8, 27, 1, 30); // Sep 27 2026, one week before the transition day
    const end = sydney(2026, 8, 27, 3, 30);
    const result = computeGanttKeyboardProposal({ start, end, allDay: false }, "move", 1, SEVEN_DAYS, SYDNEY);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.start.getTime()).toBe(sydney(2026, 9, 4, 1, 30).getTime());
    expect(r.end.getTime()).toBe(sydney(2026, 9, 4, 3, 30).getTime());
    expect(r.end.getTime() - r.start.getTime()).toBe(60 * 60 * 1000);
  });
});
