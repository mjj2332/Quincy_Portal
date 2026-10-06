import { describe, expect, it } from "vitest";
import { addCivilDays, DATE_TIME_POPUP_EDGE_GAP, popupPaddingWithTopAtLeast, scrollTopClearOfFade, resolveDateTimePopupPlacement, buildShortcuts, cellToCivil, civilToCell, civilWeekday, joinCivilMinute, parseTypedTime, splitCivilMinute, sydneyToday, timeSlots, yearBounds } from "./date-time-field";
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

describe("parseTypedTime (#422)", () => {
  it.each([
    ["17:07", "17:07"],
    ["9:05", "09:05"],
    ["09:05", "09:05"],
    ["0905", "09:05"],
    ["1730", "17:30"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
    ["  17:07  ", "17:07"],
  ])("accepts %s as %s, off-grid minutes included and never rounded", (text, expected) => {
    expect(parseTypedTime(text)).toEqual({ ok: true, time: expected });
  });

  it.each(["", "   ", "24:00", "7", "905", "17:7", "17:07:30", "17.07", "ab:cd", "25:00", "12:60", "-1:00", "5pm"])("rejects %j", (text) => {
    expect(parseTypedTime(text)).toEqual({ ok: false });
  });
});

describe("timeSlots (#422)", () => {
  it("is the full day in 15-minute steps, 00:00 to 23:45", () => {
    const slots = timeSlots();
    expect(slots).toHaveLength(96);
    expect(slots[0]).toBe("00:00");
    expect(slots[1]).toBe("00:15");
    expect(slots[95]).toBe("23:45");
  });
});

describe("civil date-time pieces (#422)", () => {
  it("splits and joins a Sydney civil minute", () => {
    expect(splitCivilMinute("2026-04-05T02:30")).toEqual({ day: "2026-04-05", time: "02:30" });
    expect(splitCivilMinute("not a civil")).toEqual({ day: null, time: null });
    expect(joinCivilMinute("2026-04-05", "02:30")).toBe("2026-04-05T02:30");
    expect(joinCivilMinute(null, "02:30")).toBeNull();
    expect(joinCivilMinute("2026-04-05", null)).toBeNull();
  });
});

describe("resolveDateTimePopupPlacement (#528)", () => {
  it("keeps the desktop default: no sideways fallback, 16px padding", () => {
    expect(resolveDateTimePopupPlacement({ narrow: false })).toEqual({ collisionAvoidance: { fallbackAxisSide: "none" }, collisionPadding: 16 });
  });
  it("keeps the #447 phone default: shift over the trigger", () => {
    expect(resolveDateTimePopupPlacement({ narrow: true })).toEqual({ collisionAvoidance: { side: "shift", fallbackAxisSide: "none" }, collisionPadding: 16 });
  });
  it("an override replaces the default at any width", () => {
    const avoidance = { side: "shift", align: "shift", fallbackAxisSide: "none" } as const;
    const padding = { top: 66, right: 16, bottom: 16, left: 16 };
    for (const narrow of [false, true]) {
      expect(resolveDateTimePopupPlacement({ narrow, avoidance, padding })).toEqual({ collisionAvoidance: avoidance, collisionPadding: padding });
    }
  });
  it("an undefined override never erases the default", () => {
    expect(resolveDateTimePopupPlacement({ narrow: true, avoidance: undefined, padding: undefined })).toEqual({ collisionAvoidance: { side: "shift", fallbackAxisSide: "none" }, collisionPadding: 16 });
  });
});

describe("DATE_TIME_POPUP_EDGE_GAP (#537)", () => {
  it("is --space-4 (16px) and is the default collisionPadding", () => {
    expect(DATE_TIME_POPUP_EDGE_GAP).toBe(16);
    expect(resolveDateTimePopupPlacement({ narrow: false }).collisionPadding).toBe(DATE_TIME_POPUP_EDGE_GAP);
  });
});

describe("popupPaddingWithTopAtLeast (#537)", () => {
  it("expands a number to four edges and raises only the top", () => {
    expect(popupPaddingWithTopAtLeast(16, 300)).toEqual({ top: 300, right: 16, bottom: 16, left: 16 });
  });
  it("never lowers a top that is already higher", () => {
    expect(popupPaddingWithTopAtLeast({ top: 66, right: 16 }, 40)).toEqual({ top: 66, right: 16, bottom: 0, left: 0 });
  });
});

describe("scrollTopClearOfFade (#537)", () => {
  const viewport = { top: 100, bottom: 500 };
  const base = { viewport, scrollTop: 0, maxScrollTop: 300, fade: 32 };
  it("leaves the body at 0 when nothing selected is in the bottom fade", () => {
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 200, bottom: 236 }] })).toBe(0);
  });
  it("scrolls the least amount that lifts a selected item above the bottom fade", () => {
    // fade band is 468..500; the item ends at 490, so it moves up 22px.
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 454, bottom: 490 }] })).toBe(22);
  });
  it("ignores an item wholly below the visible body (it would hide the month navigation for nothing)", () => {
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 520, bottom: 556 }] })).toBe(0);
  });
  it("cannot scroll past the end of the body", () => {
    expect(scrollTopClearOfFade({ ...base, maxScrollTop: 4, items: [{ top: 470, bottom: 506 }] })).toBe(4);
  });
  it("scrolls UP to clear an item in the top fade, using the top band at the destination", () => {
    // scrollTop 100: the top band is 32. The item's top is 10px below the body's top, so it needs 22 up.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146 }] })).toBe(78);
  });
  it("uses each edge's own band: the top band is the scrolled distance, not the full fade, near scroll 0", () => {
    // scrollTop 10: top band is only 10, so an item 12px below the top is already clear.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 10, items: [{ top: 112, bottom: 148 }] })).toBe(10);
  });
  it("uses the bottom band left at the end of the body, not the full fade", () => {
    // 10px of overflow left below: the bottom band is 10, so an item ending 12px above the bottom is clear.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 290, items: [{ top: 452, bottom: 488 }] })).toBe(290);
  });
  it("aligns the top of an item taller than the clear window to the top band, and does not oscillate", () => {
    // Clear window at scrollTop 100 is 32..368 (336px); the item is 400px tall.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 150, bottom: 550 }] })).toBe(100 + 50 - 32);
  });
  it("does not move when the items want opposite directions", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146 }, { top: 454, bottom: 490 }] })).toBe(100);
  });
  it("does not move when it would push another selected item into the top fade", () => {
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 100, bottom: 136 }, { top: 454, bottom: 490 }] })).toBe(0);
  });
});
