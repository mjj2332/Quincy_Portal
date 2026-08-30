import { describe, expect, it } from "vitest";
import { formatSydneyCivilMinute, resolveSydneyCivilMinute } from "@quincy/shared";
import { fullCalendarCallbackToSydneyCivil } from "./production-calendar-fullcalendar";

describe("fullCalendarCallbackToSydneyCivil", () => {
  it("agrees with the shared resolver through the April fold and October gap", () => {
    const cases = [
      { instant: "2026-04-04T15:30:00.000Z", disambiguation: "earlier" as const },
      { instant: "2026-04-04T16:30:00.000Z", disambiguation: "later" as const },
      { instant: "2026-10-03T15:30:00.000Z" },
      { instant: "2026-10-03T16:30:00.000Z" },
    ];

    for (const testCase of cases) {
      const localCivil = formatSydneyCivilMinute(testCase.instant);
      const resolved = resolveSydneyCivilMinute(localCivil, testCase.disambiguation);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;

      expect(fullCalendarCallbackToSydneyCivil({
        allDay: false,
        date: new Date(testCase.instant),
        dateStr: localCivil,
      })).toEqual({
        allDay: false,
        date: testCase.instant,
        localCivil,
        utcOffsetMinutes: resolved.value.utcOffsetMinutes,
      });
    }

    expect(resolveSydneyCivilMinute("2026-10-04T02:30")).toMatchObject({ code: "nonexistent_local_time" });
  });

  it("preserves validated all-day callback text and never converts it through Date", () => {
    expect(fullCalendarCallbackToSydneyCivil({ allDay: true, date: new Date("1999-01-01T00:00:00Z"), dateStr: "2026-10-04" })).toEqual({
      allDay: true,
      date: "2026-10-04",
    });
    expect(() => fullCalendarCallbackToSydneyCivil({ allDay: true, date: new Date("invalid"), dateStr: "2026-02-30" })).toThrow(RangeError);
  });
});
