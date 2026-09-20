/**
 * Node test for the #219 stage 3 harness fixture builders (`fixtures.ts`). No DOM, no React — pure
 * assertions on the built `ScenarioFixture` data, per the spec's "a node test for the fixture
 * builders" requirement.
 */
import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import { buildScenario, civilDaySpan, formatZonedInstant, SYDNEY_TZ } from "./fixtures";

function projectBar(id: "dst-spring" | "dst-autumn") {
  const fixture = buildScenario(id);
  const event = fixture.events.find((candidate) => candidate.id === "project-bar");
  if (!event) throw new Error(`fixture "${id}" is missing its project-bar event`);
  return event;
}

function isZonedMidnight(date: Date): boolean {
  const zoned = new TZDate(date.getTime(), SYDNEY_TZ);
  return zoned.getHours() === 0 && zoned.getMinutes() === 0 && zoned.getSeconds() === 0 && zoned.getMilliseconds() === 0;
}

describe("dst-spring project bar (Sun 2026-10-04, Sydney's 23-hour day)", () => {
  const event = projectBar("dst-spring");

  it("start and end are exactly zoned Sydney midnights", () => {
    expect(isZonedMidnight(event.start)).toBe(true);
    expect(isZonedMidnight(event.end)).toBe(true);
  });

  it("spans exactly 3 civil days in Sydney", () => {
    const start = new TZDate(event.start.getTime(), SYDNEY_TZ);
    const end = new TZDate(event.end.getTime(), SYDNEY_TZ);
    // Y/M/D-only comparison: TZDate's own getters already read the zoned wall-clock date, so the
    // civil-day count is just the day-of-epoch delta of those wall-clock components.
    const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    expect((endDay - startDay) / 86_400_000).toBe(3);
  });

  it("spans exactly 71 real hours (24 + 23 + 24, the spring-forward day is short)", () => {
    const hours = (event.end.getTime() - event.start.getTime()) / 3_600_000;
    expect(hours).toBe(71);
  });

  it("straddles the actual transition Sunday, 2026-10-04", () => {
    const start = new TZDate(event.start.getTime(), SYDNEY_TZ);
    const end = new TZDate(event.end.getTime(), SYDNEY_TZ);
    expect(`${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`).toBe("2026-10-3");
    expect(`${end.getFullYear()}-${end.getMonth() + 1}-${end.getDate()}`).toBe("2026-10-6");
  });
});

describe("dst-autumn project bar (Sun 2026-04-05, Sydney's 25-hour day)", () => {
  const event = projectBar("dst-autumn");

  it("start and end are exactly zoned Sydney midnights", () => {
    expect(isZonedMidnight(event.start)).toBe(true);
    expect(isZonedMidnight(event.end)).toBe(true);
  });

  it("spans exactly 3 civil days in Sydney", () => {
    const start = new TZDate(event.start.getTime(), SYDNEY_TZ);
    const end = new TZDate(event.end.getTime(), SYDNEY_TZ);
    const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    expect((endDay - startDay) / 86_400_000).toBe(3);
  });

  it("spans exactly 73 real hours (24 + 25 + 24, the autumn day repeats an hour)", () => {
    const hours = (event.end.getTime() - event.start.getTime()) / 3_600_000;
    expect(hours).toBe(73);
  });

  it("straddles the actual transition Sunday, 2026-04-05", () => {
    const start = new TZDate(event.start.getTime(), SYDNEY_TZ);
    const end = new TZDate(event.end.getTime(), SYDNEY_TZ);
    expect(`${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`).toBe("2026-4-4");
    expect(`${end.getFullYear()}-${end.getMonth() + 1}-${end.getDate()}`).toBe("2026-4-7");
  });
});

describe("every scenario", () => {
  it("resolves to the month scale, with a Date anchor and a non-empty fixture set", () => {
    for (const id of ["today", "dst-spring", "dst-autumn"] as const) {
      const fixture = buildScenario(id);
      expect(fixture.scale).toBe("month");
      expect(fixture.date).toBeInstanceOf(Date);
      expect(fixture.resources.length).toBeGreaterThan(0);
      expect(fixture.events.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("carries at least three distinct event colours, all existing stage/semantic tokens", () => {
    for (const id of ["today", "dst-spring", "dst-autumn"] as const) {
      const colors = new Set(buildScenario(id).events.map((event) => event.color));
      expect(colors.size).toBeGreaterThanOrEqual(3);
      for (const color of colors) expect(color).toMatch(/^var\(--(?:greige|signal)-/);
    }
  });

  it("includes a start-locked project bar, a milestone, a completed task and an unfinished one", () => {
    for (const id of ["today", "dst-spring", "dst-autumn"] as const) {
      const fixture = buildScenario(id);
      const byId = new Map(fixture.events.map((event) => [event.id, event]));
      expect(byId.get("project-bar")?.resizableEdges).toEqual({ start: false });
      const milestone = byId.get("milestone");
      expect(milestone?.start.getTime()).toBe(milestone?.end.getTime());
      expect(byId.get("completed-task")?.progress).toBe(100);
      const overdue = byId.get("overdue-task");
      expect(overdue?.progress).toBeLessThan(100);
      expect(overdue && overdue.end.getTime() < (byId.get("project-bar")?.start.getTime() ?? 0)).toBe(true);
    }
  });
});

describe("formatZonedInstant", () => {
  it("renders ISO local date-time + UTC offset in Sydney, and the offset itself shifts across DST", () => {
    // Both instants are the SAME real moment (real UTC noon) - Sydney's wall-clock reading and its
    // offset both differ depending which side of the DST boundary that moment falls on.
    expect(formatZonedInstant(new Date(Date.UTC(2026, 6, 15, 0, 0, 0)))).toBe("2026-07-15T10:00:00+10:00");
    expect(formatZonedInstant(new Date(Date.UTC(2026, 11, 15, 0, 0, 0)))).toBe("2026-12-15T11:00:00+11:00");
  });

  it("reads a zoned Sydney midnight back as 00:00:00 with the correct side's offset", () => {
    const spring = buildScenario("dst-spring").events.find((event) => event.id === "project-bar")!;
    expect(formatZonedInstant(spring.start)).toBe("2026-10-03T00:00:00+10:00");
    expect(formatZonedInstant(spring.end)).toBe("2026-10-06T00:00:00+11:00");
  });
});

describe("civilDaySpan", () => {
  it("counts Sydney wall-clock days, not elapsed real hours", () => {
    const spring = buildScenario("dst-spring").events.find((event) => event.id === "project-bar")!;
    const autumn = buildScenario("dst-autumn").events.find((event) => event.id === "project-bar")!;
    // 71 and 73 real hours respectively (see the describe blocks above) - both read as 3 civil days.
    expect(civilDaySpan(spring.start, spring.end)).toBe(3);
    expect(civilDaySpan(autumn.start, autumn.end)).toBe(3);
  });

  it("is zero for a milestone (start === end)", () => {
    const milestone = buildScenario("today").events.find((event) => event.id === "milestone")!;
    expect(civilDaySpan(milestone.start, milestone.end)).toBe(0);
  });
});
