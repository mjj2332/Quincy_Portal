/**
 * #219 PR B stage 3 — regression cover for the DST defect the vendored time grid shipped with.
 * Quincy-authored, not a ReUI vendored file; it lives inside the vendored directory so a
 * re-vendor trips over it (see `docs/adr/0009-*.md` on why the merge instructions live here).
 *
 * The defect, in one line: `Math.min(dayEndHour * 60, getDayTotalMinutes(day, tz))` compares a
 * WALL-CLOCK bound against an ELAPSED length. On Sydney's 25-hour autumn day that evaluated to
 * 1440 while the day genuinely runs to 1500, so a 23:15 event — elapsed start 1455 — failed the
 * `startMin < boundsEndMin` visibility filter and never rendered. The same clamp capped the drop
 * target and blanked the now-indicator for that hour.
 *
 * Reproduced in a real browser before the fix, on one identical fixture across three scenarios:
 * 5 chips on a 24-hour day, 5 on the 23-hour day, 4 on the 25-hour day.
 *
 * Every expected number below was derived independently of `@date-fns/tz` — via
 * `Intl.DateTimeFormat` offsets — and is written out longhand in the comments rather than
 * computed by the same helper under test, so this file cannot agree with a broken implementation
 * by construction.
 */
import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  elapsedMinutesAtWallClock,
  elapsedMinutesAtWallClockHour,
  getDayTotalMinutes,
  wallClockMinutesAtElapsed,
  wallClockWindow,
} from "@/components/reui/event-calendar/event-calendar-lib";

const SYDNEY = "Australia/Sydney";

/** Sydney civil midnight (month 1-based). */
const midnight = (y: number, m: number, d: number) =>
  new TZDate(y, m - 1, d, 0, 0, 0, 0, SYDNEY);

/** Sydney civil wall-clock instant (month 1-based). */
const wall = (y: number, m: number, d: number, h: number, min: number) =>
  new TZDate(y, m - 1, d, h, min, 0, 0, SYDNEY);

// The three days this suite turns on. 2026-04-05 is Sydney's autumn transition (03:00 -> 02:00,
// so the day holds 25 hours); 2026-10-04 is spring-forward (02:00 -> 03:00, 23 hours);
// 2026-09-21 is an ordinary 24-hour day used as the control.
const AUTUMN = { y: 2026, m: 4, d: 5 } as const;
const SPRING = { y: 2026, m: 10, d: 4 } as const;
const NORMAL = { y: 2026, m: 9, d: 21 } as const;

describe("getDayTotalMinutes — the vendor primitive that was already right", () => {
  it("reports the real length of each day", () => {
    expect(getDayTotalMinutes(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), SYDNEY)).toBe(1500);
    expect(getDayTotalMinutes(midnight(SPRING.y, SPRING.m, SPRING.d), SYDNEY)).toBe(1380);
    expect(getDayTotalMinutes(midnight(NORMAL.y, NORMAL.m, NORMAL.d), SYDNEY)).toBe(1440);
  });
});

describe("elapsedMinutesAtWallClockHour — hour 24 means the next zoned midnight", () => {
  it("returns the day's real length, never a flat 1440", () => {
    // This is the assertion the old `Math.min(endHour * 60, totalMinutes)` could not satisfy:
    // it could only ever go DOWN from 1440, so a longer day was unrepresentable.
    expect(elapsedMinutesAtWallClockHour(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), 24, SYDNEY)).toBe(1500);
    expect(elapsedMinutesAtWallClockHour(midnight(SPRING.y, SPRING.m, SPRING.d), 24, SYDNEY)).toBe(1380);
    expect(elapsedMinutesAtWallClockHour(midnight(NORMAL.y, NORMAL.m, NORMAL.d), 24, SYDNEY)).toBe(1440);
  });

  it("agrees with getDayTotalMinutes at hour 24 on every one of the three days", () => {
    for (const day of [AUTUMN, SPRING, NORMAL]) {
      const start = midnight(day.y, day.m, day.d);
      expect(elapsedMinutesAtWallClockHour(start, 24, SYDNEY)).toBe(
        getDayTotalMinutes(start, SYDNEY),
      );
    }
  });

  it("returns 0 at hour 0 regardless of the day's length", () => {
    for (const day of [AUTUMN, SPRING, NORMAL]) {
      expect(elapsedMinutesAtWallClockHour(midnight(day.y, day.m, day.d), 0, SYDNEY)).toBe(0);
    }
  });
});

describe("elapsedMinutesAtWallClockHour — a non-default dayStartHour/dayEndHour is converted too", () => {
  it("resolves an afternoon hour past the transition as elapsed, not wall-clock", () => {
    // 17:00 on the 25-hour day is 18 hours of elapsed time after midnight, because the repeated
    // hour falls at 02:00-03:00, before it. `17 * 60` would say 1020 and be an hour short.
    expect(elapsedMinutesAtWallClockHour(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), 17, SYDNEY)).toBe(1080);
    // Same hour on the 23-hour day is an hour SHORT of the wall-clock figure, the opposite
    // direction — which is exactly why one blanket offset correction cannot serve both.
    expect(elapsedMinutesAtWallClockHour(midnight(SPRING.y, SPRING.m, SPRING.d), 17, SYDNEY)).toBe(960);
    expect(elapsedMinutesAtWallClockHour(midnight(NORMAL.y, NORMAL.m, NORMAL.d), 17, SYDNEY)).toBe(1020);
  });

  it("is unchanged from the wall-clock figure before the transition", () => {
    // 01:00 precedes both transitions, so all three days agree here. A fix that shifted every
    // hour uniformly would break this.
    for (const day of [AUTUMN, SPRING, NORMAL]) {
      expect(elapsedMinutesAtWallClockHour(midnight(day.y, day.m, day.d), 1, SYDNEY)).toBe(60);
    }
  });
});

describe("the visibility filter the defect actually broke", () => {
  /** What `EventCalendarDayColumn` computes, in the fixed form. */
  const boundsEndMin = (day: TZDate) => elapsedMinutesAtWallClockHour(day, 24, SYDNEY);
  /** What it computed before — kept verbatim so the regression is stated, not just implied. */
  const legacyBoundsEndMin = (day: TZDate) => Math.min(24 * 60, getDayTotalMinutes(day, SYDNEY));
  /** Elapsed start minute of an instant, the quantity `segmentOccurrence` produces. */
  const elapsedStart = (day: TZDate, instant: Date) =>
    Math.round((instant.getTime() - day.getTime()) / 60_000);

  it("renders a 23:15 event on the 25-hour day, which the old clamp hid", () => {
    const day = midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d);
    const startMin = elapsedStart(day, wall(AUTUMN.y, AUTUMN.m, AUTUMN.d, 23, 15));

    // 24h15m, not 23h15m: the repeated hour is inserted earlier in the day.
    expect(startMin).toBe(1455);

    expect(startMin < legacyBoundsEndMin(day)).toBe(false); // the defect: invisible
    expect(startMin < boundsEndMin(day)).toBe(true); // fixed: visible
  });

  it("still renders that event on the 23-hour and 24-hour days, as it always did", () => {
    const spring = midnight(SPRING.y, SPRING.m, SPRING.d);
    const springStart = elapsedStart(spring, wall(SPRING.y, SPRING.m, SPRING.d, 23, 15));
    // 22h15m — the skipped hour is removed before 23:15, so this moves the OTHER way.
    expect(springStart).toBe(1335);
    expect(springStart < legacyBoundsEndMin(spring)).toBe(true);
    expect(springStart < boundsEndMin(spring)).toBe(true);

    const normal = midnight(NORMAL.y, NORMAL.m, NORMAL.d);
    const normalStart = elapsedStart(normal, wall(NORMAL.y, NORMAL.m, NORMAL.d, 23, 15));
    expect(normalStart).toBe(1395);
    expect(normalStart < legacyBoundsEndMin(normal)).toBe(true);
    expect(normalStart < boundsEndMin(normal)).toBe(true);
  });

  it("only the 25-hour day ever differed between the two forms", () => {
    // Pins the blast radius: the fix is not a behaviour change on ordinary days.
    expect(boundsEndMin(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d))).not.toBe(
      legacyBoundsEndMin(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d)),
    );
    for (const day of [SPRING, NORMAL]) {
      const start = midnight(day.y, day.m, day.d);
      expect(boundsEndMin(start)).toBe(legacyBoundsEndMin(start));
    }
  });

  it("makes the last hour of the 25-hour day a reachable drop target", () => {
    // The drop path clamps to `boundsEndMin - slotDuration`. With the old bound a 15-minute snap
    // could reach 1425 at best; the 1440-1500 window was unreachable by pointer as well as
    // invisible.
    const day = midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d);
    const SLOT = 15;
    expect(legacyBoundsEndMin(day) - SLOT).toBe(1425);
    expect(boundsEndMin(day) - SLOT).toBe(1485);
  });
});

// #241 — the week view paints every column on ONE wall-clock axis so the shared hour gutter is
// right for all seven days. Elapsed minutes stay the unit for data and gestures; these three
// functions are the only crossing points. Sydney's autumn day repeats 02:00-03:00 (elapsed
// 120-180 is the first pass, 180-240 the second); its spring day skips 02:00-03:00 (elapsed 120
// is already 03:00). Every literal below is read off that clock by hand.
describe("wallClockMinutesAtElapsed — where an elapsed minute sits on the 24-hour gutter (#241)", () => {
  it("is the identity on an ordinary day", () => {
    const day = midnight(NORMAL.y, NORMAL.m, NORMAL.d);
    expect(wallClockMinutesAtElapsed(day, 0, SYDNEY)).toBe(0);
    expect(wallClockMinutesAtElapsed(day, 1395, SYDNEY)).toBe(1395);
    expect(wallClockMinutesAtElapsed(day, 1440, SYDNEY)).toBe(1440);
  });

  it("puts the 25-hour day's 23:15 event beside the 23:15 label, and its end at 24:00", () => {
    const day = midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d);
    expect(wallClockMinutesAtElapsed(day, 90, SYDNEY)).toBe(90); // 01:30, before the repeat
    expect(wallClockMinutesAtElapsed(day, 150, SYDNEY)).toBe(150); // first 02:30
    expect(wallClockMinutesAtElapsed(day, 210, SYDNEY)).toBe(150); // second 02:30
    expect(wallClockMinutesAtElapsed(day, 240, SYDNEY)).toBe(180); // 03:00
    expect(wallClockMinutesAtElapsed(day, 1455, SYDNEY)).toBe(1395); // 23:15
    expect(wallClockMinutesAtElapsed(day, 1500, SYDNEY)).toBe(1440); // next midnight
  });

  it("leaves the skipped hour empty on the 23-hour day", () => {
    const day = midnight(SPRING.y, SPRING.m, SPRING.d);
    expect(wallClockMinutesAtElapsed(day, 90, SYDNEY)).toBe(90); // 01:30
    expect(wallClockMinutesAtElapsed(day, 120, SYDNEY)).toBe(180); // 03:00 — 02:xx never happens
    expect(wallClockMinutesAtElapsed(day, 1335, SYDNEY)).toBe(1395); // 23:15
    expect(wallClockMinutesAtElapsed(day, 1380, SYDNEY)).toBe(1440);
  });
});

describe("elapsedMinutesAtWallClock — what instant a pointer on the gutter's axis means (#241)", () => {
  it("is the identity on an ordinary day", () => {
    const day = midnight(NORMAL.y, NORMAL.m, NORMAL.d);
    expect(elapsedMinutesAtWallClock(day, 1395, SYDNEY)).toBe(1395);
    expect(elapsedMinutesAtWallClock(day, 1440, SYDNEY)).toBe(1440);
  });

  it("resolves the repeated hour to its FIRST pass, and everything after it an hour later", () => {
    const day = midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d);
    expect(elapsedMinutesAtWallClock(day, 90, SYDNEY)).toBe(90);
    expect(elapsedMinutesAtWallClock(day, 150, SYDNEY)).toBe(150); // 02:30 -> the first one
    expect(elapsedMinutesAtWallClock(day, 180, SYDNEY)).toBe(240); // 03:00
    expect(elapsedMinutesAtWallClock(day, 1395, SYDNEY)).toBe(1455); // 23:15
    expect(elapsedMinutesAtWallClock(day, 1440, SYDNEY)).toBe(1500);
  });

  it("resolves a pointer inside the skipped hour to the instant the gap closes", () => {
    const day = midnight(SPRING.y, SPRING.m, SPRING.d);
    expect(elapsedMinutesAtWallClock(day, 90, SYDNEY)).toBe(90);
    expect(elapsedMinutesAtWallClock(day, 120, SYDNEY)).toBe(120); // 02:00 does not exist -> 03:00
    expect(elapsedMinutesAtWallClock(day, 150, SYDNEY)).toBe(120); // nor does 02:30
    expect(elapsedMinutesAtWallClock(day, 180, SYDNEY)).toBe(120); // 03:00 itself
    expect(elapsedMinutesAtWallClock(day, 1020, SYDNEY)).toBe(960); // 17:00
    expect(elapsedMinutesAtWallClock(day, 1440, SYDNEY)).toBe(1380);
  });
});

describe("wallClockWindow — the painted extent of an elapsed window (#241)", () => {
  it("paints the fixtures' transition-spanning events between their wall-clock labels", () => {
    // 01:30 -> 03:30 on both days: three elapsed hours in autumn, one in spring, two on the axis.
    expect(wallClockWindow(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), 90, 270, SYDNEY)).toEqual([90, 210]);
    expect(wallClockWindow(midnight(SPRING.y, SPRING.m, SPRING.d), 90, 150, SYDNEY)).toEqual([90, 210]);
  });

  it("never collapses a window the repeated hour folds back on itself", () => {
    const day = midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d);
    // first 02:15 -> second 02:15: zero tall on the axis, so it keeps its elapsed length instead.
    expect(wallClockWindow(day, 135, 195, SYDNEY)).toEqual([135, 195]);
    // first 02:30 -> second 02:10 would be NEGATIVE on the axis.
    expect(wallClockWindow(day, 150, 190, SYDNEY)).toEqual([150, 190]);
  });
});

// Code review of #241. Not every zone changes its clocks at 02:00: Chile springs forward AT
// midnight, so 2026-09-06 in America/Santiago has no 00:00-01:00 at all — the day's first instant
// already reads 01:00. Offsets: -04:00 before, -03:00 after; 23-hour day.
describe("a DST gap that swallows midnight itself (#241 review)", () => {
  const SANTIAGO = "America/Santiago";
  const day = new TZDate(2026, 8, 6, 12, 0, 0, 0, SANTIAGO);

  it("puts the day's first minute at 01:00 on the axis, leaving the 12 AM slot empty", () => {
    expect(getDayTotalMinutes(new Date("2026-09-06T04:00:00.000Z"), SANTIAGO)).toBe(1380);
    expect(wallClockMinutesAtElapsed(day, 0, SANTIAGO)).toBe(60);
    expect(wallClockMinutesAtElapsed(day, 60, SANTIAGO)).toBe(120);
    expect(wallClockMinutesAtElapsed(day, 1380, SANTIAGO)).toBe(1440);
    // 01:00-02:00 is one hour tall beside the 1 AM label, not two hours from the top.
    expect(wallClockWindow(day, 0, 60, SANTIAGO)).toEqual([60, 120]);
  });

  it("resolves a pointer anywhere in the missing first hour to the day's first instant", () => {
    expect(elapsedMinutesAtWallClock(day, 0, SANTIAGO)).toBe(0);
    expect(elapsedMinutesAtWallClock(day, 30, SANTIAGO)).toBe(0);
    expect(elapsedMinutesAtWallClock(day, 60, SANTIAGO)).toBe(0);
    expect(elapsedMinutesAtWallClock(day, 120, SANTIAGO)).toBe(60);
  });
});

describe("a day bound set ON the repeated hour (#241 review)", () => {
  it("means the hour's first pass, the same answer a pointer there gets", () => {
    // dayStartHour = 2 on Sydney's 25-hour day: the column's top edge is the 2 AM label, and the
    // first 02:00 is elapsed 120. 180 (the second pass) would hide the whole first pass under a
    // slot the gutter still shows.
    expect(elapsedMinutesAtWallClockHour(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), 2, SYDNEY)).toBe(120);
    expect(elapsedMinutesAtWallClockHour(midnight(AUTUMN.y, AUTUMN.m, AUTUMN.d), 3, SYDNEY)).toBe(240);
    // dayStartHour = 2 on the 23-hour day: 02:00 never happens, the gap closes at elapsed 120.
    expect(elapsedMinutesAtWallClockHour(midnight(SPRING.y, SPRING.m, SPRING.d), 2, SYDNEY)).toBe(120);
  });
});

