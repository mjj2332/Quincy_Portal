import { describe, expect, it } from "vitest";
import { addCivilDays, buildShortcuts, cellToCivil, civilToCell, civilWeekday, sydneyToday, yearBounds } from "./date-time-field";
import { formatCivilDay } from "./date-format";

const resolved = (today: string, clearable = false) =>
  Object.fromEntries(buildShortcuts({ today, clearable }).map((row) => [row.id, row.resolve()]));

describe("sydneyToday", () => {
  it("reads the Sydney calendar day, not the UTC day", () => {
    // 13:30Z on 5 Oct is already 00:30 on 6 Oct in Sydney (AEDT, +11).
    expect(sydneyToday(Date.parse("2026-10-05T13:30:00Z"))).toBe("2026-10-06");
    expect(sydneyToday(Date.parse("2026-10-05T12:59:59Z"))).toBe("2026-10-05");
  });

  it("holds through the spring-forward day (2026-10-04)", () => {
    expect(sydneyToday(Date.parse("2026-10-03T15:59:59Z"))).toBe("2026-10-04"); // 01:59:59 AEST
    expect(sydneyToday(Date.parse("2026-10-03T16:00:00Z"))).toBe("2026-10-04"); // 03:00 AEDT
    expect(sydneyToday(Date.parse("2026-10-04T12:59:59Z"))).toBe("2026-10-04"); // 23:59:59 AEDT
    expect(sydneyToday(Date.parse("2026-10-04T13:00:00Z"))).toBe("2026-10-05");
  });

  it("holds through the fall-back day (2026-04-05)", () => {
    expect(sydneyToday(Date.parse("2026-04-04T13:00:00Z"))).toBe("2026-04-05"); // 00:00 AEDT
    expect(sydneyToday(Date.parse("2026-04-05T13:59:59Z"))).toBe("2026-04-05"); // 23:59:59 AEST
    expect(sydneyToday(Date.parse("2026-04-05T14:00:00Z"))).toBe("2026-04-06");
  });
});

describe("civil arithmetic", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addCivilDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCivilDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCivilDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addCivilDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addCivilDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("is not moved by a DST transition day", () => {
    expect(addCivilDays("2026-10-04", 1)).toBe("2026-10-05");
    expect(addCivilDays("2026-10-03", 1)).toBe("2026-10-04");
    expect(addCivilDays("2026-04-05", 1)).toBe("2026-04-06");
  });

  it("gives the weekday, Monday = 1 .. Sunday = 7", () => {
    const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
    expect(week.map(civilWeekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(civilWeekday("2028-02-28")).toBe(1);
    expect(civilWeekday("2027-02-28")).toBe(7);
  });

  it("round-trips a civil day through a calendar cell", () => {
    for (const day of ["2026-01-01", "2026-10-04", "2028-02-29", "2026-12-31"]) {
      expect(cellToCivil(civilToCell(day))).toBe(day);
    }
    const cell = civilToCell("2026-10-04");
    expect([cell.getFullYear(), cell.getMonth(), cell.getDate()]).toEqual([2026, 9, 4]);
  });
});

describe("buildShortcuts", () => {
  it.each([
    ["Mon", "2026-09-28", { today: "2026-09-28", tomorrow: "2026-09-29", "later-this-week": "2026-10-01", "next-week": "2026-10-05" }],
    ["Tue", "2026-09-29", { today: "2026-09-29", tomorrow: "2026-09-30", "later-this-week": "2026-10-01", "next-week": "2026-10-05" }],
    ["Wed", "2026-09-30", { today: "2026-09-30", tomorrow: "2026-10-01", "later-this-week": "2026-10-01", "next-week": "2026-10-05" }],
    ["Thu", "2026-10-01", { today: "2026-10-01", tomorrow: "2026-10-02", "next-week": "2026-10-05" }],
    ["Fri", "2026-10-02", { today: "2026-10-02", tomorrow: "2026-10-03", "next-week": "2026-10-05" }],
    ["Sat", "2026-10-03", { today: "2026-10-03", tomorrow: "2026-10-04", "next-week": "2026-10-05" }],
    ["Sun", "2026-10-04", { today: "2026-10-04", tomorrow: "2026-10-05", "next-week": "2026-10-05" }],
  ])("resolves every shortcut on a %s (%s); Later this week is offered Mon-Wed only", (_name, today, expected) => {
    expect(resolved(today)).toEqual(expected);
  });

  it("crosses a year boundary", () => {
    expect(resolved("2026-12-31")).toEqual({ today: "2026-12-31", tomorrow: "2027-01-01", "next-week": "2027-01-04" });
  });

  it("crosses a leap-day boundary", () => {
    expect(resolved("2028-02-28")).toMatchObject({ tomorrow: "2028-02-29", "later-this-week": "2028-03-02", "next-week": "2028-03-06" });
  });

  it("resolves on the Sydney day, not the UTC day", () => {
    const today = sydneyToday(Date.parse("2026-10-05T13:30:00Z"));
    expect(resolved(today)).toMatchObject({ today: "2026-10-06", tomorrow: "2026-10-07", "later-this-week": "2026-10-08", "next-week": "2026-10-12" });
  });

  it("offers No date only when clearable, and it resolves to null", () => {
    expect(Object.keys(resolved("2026-10-01"))).not.toContain("no-date");
    expect(resolved("2026-10-01", true)["no-date"]).toBeNull();
    expect(buildShortcuts({ today: "2026-10-01", clearable: true }).at(-1)?.id).toBe("no-date");
  });

  it("labels each row with its resolved weekday (and the date for Next week)", () => {
    const rows = buildShortcuts({ today: "2026-09-28", clearable: true });
    expect(rows.map((row) => [row.label, row.sublabel])).toEqual([
      ["Today", "Mon"],
      ["Tomorrow", "Tue"],
      ["Later this week", "Thu"],
      ["Next week", "Mon 5 Oct"],
      ["No date", ""],
    ]);
  });
});

describe("yearBounds", () => {
  it("spans ten years either side of today", () => {
    expect(yearBounds("2026-10-01", null)).toEqual({ startYear: 2016, endYear: 2036 });
  });

  it("widens to include the selected value's year", () => {
    expect(yearBounds("2026-10-01", "2005-03-02")).toEqual({ startYear: 2005, endYear: 2036 });
    expect(yearBounds("2026-10-01", "2050-03-02")).toEqual({ startYear: 2016, endYear: 2050 });
  });

  it("ignores a value that is not a canonical civil day", () => {
    expect(yearBounds("2026-10-01", "Thursday, 17 Sep, 2026")).toEqual({ startYear: 2016, endYear: 2036 });
  });
});

describe("formatCivilDay", () => {
  it("formats from fixed tables, so September is never 'Sept'", () => {
    expect(formatCivilDay("2026-09-17")).toBe("Thu 17 Sep 2026");
    expect(formatCivilDay("2026-10-04")).toBe("Sun 4 Oct 2026");
    expect(formatCivilDay("2028-02-29")).toBe("Tue 29 Feb 2028");
  });
});
