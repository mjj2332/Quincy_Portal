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
  elapsedMinutesAtWallClockHour,
  getDayTotalMinutes,
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
