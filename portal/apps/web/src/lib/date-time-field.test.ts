import { describe, expect, it } from "vitest";
import { addCivilDays, DATE_TIME_POPUP_EDGE_GAP, popupPaddingWithTopAtLeast, scrollTopClearOfFade, resolveDateTimePopupPlacement, SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding, buildShortcuts, cellToCivil, civilToCell, civilWeekday, joinCivilMinute, parseTypedTime, splitCivilMinute, sydneyToday, timeSlots, yearBounds } from "./date-time-field";
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

describe("scrollTopClearOfFade snaps (#630)", () => {
  const base = { viewport: { top: 100, bottom: 500 }, scrollTop: 0, maxScrollTop: 300, fade: 32 };
  const snaps = [0, 56, 112];
  it("stays at 0 when the item is already clear there, even though 0 is the only snap needed", () => {
    expect(scrollTopClearOfFade({ ...base, snaps, items: [{ top: 200, bottom: 236 }] })).toBe(0);
  });
  it("lands on a whole preset row instead of the least scroll when one is valid", () => {
    // Needs >= 22 (item ends at 490, band 468): least scroll is 22, which would cut a row; 56 is valid and is a row top.
    expect(scrollTopClearOfFade({ ...base, snaps, items: [{ top: 454, bottom: 490 }] })).toBe(56);
  });
  it("takes the smallest valid snap, not the one nearest where the body already is", () => {
    // Window 22..max: 56 and 112 are both valid; a body left at 112 by an earlier solve must come back to 56.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 112, snaps, items: [{ top: 342, bottom: 378 }] })).toBe(56);
  });
  it("opens at 0 when the item fits there, wherever the body was left", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 112, snaps, items: [{ top: 88, bottom: 124 }] })).toBe(0);
  });
  it("falls back to the least scroll when no snap keeps the items clear of the fade", () => {
    // Together the two items allow 22..38 only; neither 0 nor 56 is inside it.
    expect(scrollTopClearOfFade({ ...base, snaps: [0, 56], items: [{ top: 454, bottom: 490 }, { top: 170, bottom: 206 }] })).toBe(22);
  });
});

describe("scrollTopClearOfFade noSliver (#636)", () => {
  const base = { viewport: { top: 100, bottom: 500 }, scrollTop: 0, maxScrollTop: 300, fade: 32, snaps: [0, 56, 112] };
  const day = { top: 200, bottom: 236 };
  it("skips a snap that leaves the slot partly in the bottom fade", () => {
    // Slot 454..490 against the band 468..500 at 0: a sliver. At 56 it is 398..434, clear.
    expect(scrollTopClearOfFade({ ...base, items: [day], noSliver: [{ top: 454, bottom: 490 }] })).toBe(56);
  });
  it("stays at 0 when the slot is clear there", () => {
    expect(scrollTopClearOfFade({ ...base, items: [day], noSliver: [{ top: 380, bottom: 416 }] })).toBe(0);
  });
  it("treats a 0.19px overlap with the body edge as fully below (#636 browser pass: 720x900 must open at 0)", () => {
    expect(scrollTopClearOfFade({ ...base, items: [day], noSliver: [{ top: 499.81, bottom: 535.81 }] })).toBe(0);
  });
  it("still skips a snap when the slot shows a real sliver (3px inside the body)", () => {
    expect(scrollTopClearOfFade({ ...base, items: [day], noSliver: [{ top: 497, bottom: 533 }] })).toBeGreaterThan(0);
  });
  it("stays at 0 when the slot is fully below the body", () => {
    expect(scrollTopClearOfFade({ ...base, items: [day], noSliver: [{ top: 520, bottom: 556 }] })).toBe(0);
  });
  it("takes the smallest whole scroll when no snap clears the slot", () => {
    expect(scrollTopClearOfFade({ ...base, snaps: [0], items: [day], noSliver: [{ top: 454, bottom: 490 }] })).toBe(20);
  });
  it("keeps the picked day clear when the slot cannot be (the day wins)", () => {
    // The day (needs <= 10) pins the window to 0..10, where the slot is a sliver at every scroll: the #630 choice stands.
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 130, bottom: 166, required: true }, { top: 140, bottom: 176, required: true }], noSliver: [{ top: 454, bottom: 490 }] })).toBe(0);
  });
});

describe("scrollTopClearOfFade noSliver top fade (#662)", () => {
  // The 390 time column: a 144px body, rows 44px on a 48px pitch, four slots per row. Rects are body-relative + viewport.top.
  const viewport = { top: 100, bottom: 244 };
  const rect = (rel: number, size = 44) => ({ top: viewport.top + rel, bottom: viewport.top + rel + size });
  const column = { viewport, maxScrollTop: 1004 };
  it("down8: lifts the pressed slot out from under the top fade, moving the least (r2-B3-390-02)", () => {
    // Focused 19:00 at 68..112 (scroll 796), pressed 17:00 two rows up at -28..16. Focused is clear for 796..832; the slot is inside the tolerance at >= 810 and fully clear at >= 812.
    const focused = { ...rect(68), required: true, priority: true };
    expect(scrollTopClearOfFade({ ...column, scrollTop: 796, fade: 32, items: [focused], noSliver: [rect(-28)] })).toBe(812);
  });
  it("up8 at a 32px fade: no position clears both, so the focused control wins and the body stays (r2-B3-390-06)", () => {
    const focused = { ...rect(32), required: true, priority: true };
    expect(scrollTopClearOfFade({ ...column, scrollTop: 880, fade: 32, items: [focused], noSliver: [rect(-16)] })).toBe(880);
  });
  it("up8 at a 24px fade: the adjacent-row case fits a 144px column with no overlap at all (#662 P3)", () => {
    const focused = { ...rect(32), required: true, priority: true };
    expect(scrollTopClearOfFade({ ...column, scrollTop: 880, fade: 24, items: [focused], noSliver: [rect(-16)] })).toBe(840);
  });
  it("prefers a scroll with no overlap over one inside the 2px tolerance when one is reachable (#662 P3)", () => {
    const base = { ...column, scrollTop: 500, fade: 32, items: [] as never[] };
    expect(scrollTopClearOfFade({ ...base, noSliver: [rect(30)] })).toBe(498);
  });
  it("still accepts a 2px overlap when no overlap-free scroll is reachable", () => {
    // The focused 80px control is clear only at exactly 500, so the pressed slot's 2px overlap is the best there is.
    const pinned = { ...column, scrollTop: 500, fade: 32, items: [{ ...rect(32, 80), required: true, priority: true }] };
    expect(scrollTopClearOfFade({ ...pinned, noSliver: [rect(30)] })).toBe(500);
  });
  it("lifts a 2px sliver above the body's top edge fully out when it is free to (#662 P3)", () => {
    expect(scrollTopClearOfFade({ ...column, scrollTop: 500, fade: 32, items: [], noSliver: [rect(-42)] })).toBe(502);
  });
  it("takes the nearest feasible scroll, not the smallest (no snaps)", () => {
    // Slot at -10..26 under the 32px band at scroll 200: fully clear at >= 226 (26 away) or <= 158 (42 away).
    expect(scrollTopClearOfFade({ ...column, scrollTop: 200, fade: 32, items: [], noSliver: [rect(-10, 36)] })).toBe(226);
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
  it("stops inside the body's overflow, and does not move for an item that cannot be cleared", () => {
    // 4px of overflow: at 3 the bottom band is 1 and the item ends at the 399 line.
    expect(scrollTopClearOfFade({ ...base, maxScrollTop: 4, items: [{ top: 466, bottom: 502 }] })).toBe(3);
    expect(scrollTopClearOfFade({ ...base, maxScrollTop: 4, items: [{ top: 470, bottom: 506 }] })).toBe(0);
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
  it("finds the position that clears both items when a bigger move would overshoot a shrinking band (Sol, round 3)", () => {
    // Items at 10..46 and 325..361 below the top. Moving to 15 clears the first (band 15) and the second (band 32); 20 does not.
    expect(scrollTopClearOfFade({ viewport, scrollTop: 20, maxScrollTop: 300, fade: 32, items: [{ top: 110, bottom: 146 }, { top: 425, bottom: 461 }] })).toBe(15);
  });
  it("does not move when the items want opposite directions", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146 }, { top: 454, bottom: 490 }] })).toBe(100);
  });
  it("does not move when it would push another selected item into the top fade", () => {
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 100, bottom: 136 }, { top: 454, bottom: 490 }] })).toBe(0);
  });
});

describe("scrollTopClearOfFade, required items (#587)", () => {
  const viewport = { top: 100, bottom: 500 };
  const base = { viewport, scrollTop: 0, maxScrollTop: 300, fade: 32 };
  it("scrolls to a required item wholly below the body, where an optional one is skipped", () => {
    // The item is 120px under the body: 520..556 -> docs 420..456 at scroll 0. Clear window at s is [min(fade,s), 400 - min(fade, max-s)].
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 520, bottom: 556 }] })).toBe(0);
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 520, bottom: 556, required: true }] })).toBe(88);
  });
  it("scrolls up to a required item wholly above the body", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 200, items: [{ top: 20, bottom: 56, required: true }] })).toBe(88);
  });
  it("lets a required item win over a conflicting secondary item", () => {
    const secondary = { top: 110, bottom: 146 };
    const required = { top: 454, bottom: 490, required: true };
    // Optional alone: the two want opposite things and nothing moves. A required one is cleared regardless.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [secondary, { top: 454, bottom: 490 }] })).toBe(100);
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [secondary, required] })).toBe(100 + 22);
  });
  it("aligns a required item taller than the window to the top band", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 150, bottom: 550, required: true }] })).toBe(100 + 50 - 32);
  });
  it("keeps a non-required item's skip when a required item is present and compatible", () => {
    expect(scrollTopClearOfFade({ ...base, items: [{ top: 700, bottom: 736 }, { top: 454, bottom: 490, required: true }] })).toBe(22);
  });
  it("does not move when two required items conflict", () => {
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146, required: true }, { top: 454, bottom: 490, required: true }] })).toBe(100);
  });
  it("lets the priority item (the focused control) win when two required items conflict", () => {
    // The first wants s <= 78, the second s >= 122; the priority one is cleared alone.
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146, required: true }, { top: 454, bottom: 490, priority: true }] })).toBe(122);
    expect(scrollTopClearOfFade({ ...base, scrollTop: 100, items: [{ top: 110, bottom: 146, priority: true }, { top: 454, bottom: 490, required: true }] })).toBe(78);
  });
});

describe("scrollTopClearOfFade, rounding toward the safe side (#587)", () => {
  const viewport = { top: 100, bottom: 500 };
  // Document offsets 412.3..448.3: clearing the top fade needs s <= 380.3; clearing the bottom needs s >= 80.3.
  const doc = { top: 412.3, bottom: 448.3 };
  const at = (scrollTop: number) => ({ top: 100 + doc.top - scrollTop, bottom: 100 + doc.bottom - scrollTop, required: true });
  it("floors the target when clearing the top fade, so the browser's rounding cannot push the item into the band", () => {
    const result = scrollTopClearOfFade({ viewport, scrollTop: 500, maxScrollTop: 600, fade: 32, items: [at(500)] });
    expect(result).toBe(380);
  });
  it("ceils the target when clearing the bottom fade", () => {
    const result = scrollTopClearOfFade({ viewport, scrollTop: 0, maxScrollTop: 600, fade: 32, items: [at(0)] });
    expect(result).toBe(81);
  });
  it("leaves a scrollTop that is already inside the interval alone, fractional or not", () => {
    expect(scrollTopClearOfFade({ viewport, scrollTop: 300.5, maxScrollTop: 600, fade: 32, items: [at(300.5)] })).toBe(300.5);
  });
  it("falls back to the exact target when no whole pixel fits the interval", () => {
    // Interval [100.2, 100.8] holds no integer: the exact (unrounded) bound is returned.
    const result = scrollTopClearOfFade({ viewport, scrollTop: 0, maxScrollTop: 600, fade: 32, items: [{ top: 100 + 132.8, bottom: 100 + 468.2, required: true }] });
    expect(result).toBeCloseTo(100.2, 6);
  });
});

describe("scrollTopClearOfFade, over a grid of inputs (#537)", () => {
  const H = 400;
  const fade = 32;
  /** Independent of the closed form: judge an item at a destination `s` straight from the band definition. */
  const clearAt = (item: { docTop: number; docBottom: number }, s: number, max: number) =>
    item.docTop - s >= Math.min(fade, s) - 1e-9 && item.docBottom - s <= H - Math.min(fade, max - s) + 1e-9;

  it("returns a valid position whenever one exists, and the nearest one to the current scrollTop", () => {
    let checked = 0;
    for (const max of [0, 10, 64, 300]) {
      for (const scrollTop of [0, 5, 20, 31, 32, 100, 290, 300].filter((value) => value <= max)) {
        for (const first of [0, 10, 40, 150, 330, 364]) {
          for (const second of [null, 0, 12, 200, 340, 364]) {
            const rels = [first, ...(second === null ? [] : [second])];
            const items = rels.map((rel) => ({ top: 100 + rel, bottom: 100 + rel + 36 }));
            const docs = rels.map((rel) => ({ docTop: rel + scrollTop, docBottom: rel + 36 + scrollTop }));
            const result = scrollTopClearOfFade({ viewport: { top: 100, bottom: 500 }, scrollTop, maxScrollTop: max, fade, items });
            const valid: number[] = [];
            for (let s = 0; s <= max; s += 0.5) if (docs.every((doc) => clearAt(doc, s, max))) valid.push(s);
            checked += 1;
            if (valid.length === 0) { expect(result).toBe(scrollTop); continue; }
            expect(docs.every((doc) => clearAt(doc, result, max))).toBe(true);
            const best = Math.min(...valid.map((s) => Math.abs(s - scrollTop)));
            expect(Math.abs(result - scrollTop)).toBeLessThanOrEqual(best + 0.5);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("shell-aware placement (#528, #587)", () => {
  it("shifts on both axes and never flips a side", () => {
    expect(SHELL_AWARE_SHIFT_AVOIDANCE).toEqual({ side: "shift", align: "shift", fallbackAxisSide: "none" });
  });
  it("puts the top below the shell header (0 when there is none) and keeps the 16px edge gap elsewhere", () => {
    expect(shellAwarePopupPadding()).toEqual({ top: 16, right: 16, bottom: 16, left: 16 });
  });
});

describe("scrollTopClearOfFade fade-aware snaps and the active chip (#674)", () => {
  // The measured Table-view Deadline cell at 390 (#673 item 4): body 119..763, 24px fade, preset rows at 14/74/134 (52px tall, two to a row),
  // the pressed 17:00 slot at 736..780 when the body is at 0, the picked day at 420..464.
  const base = { viewport: { top: 119, bottom: 763 }, scrollTop: 0, maxScrollTop: 400, fade: 24, snaps: [0, 14, 74, 134, 194], items: [{ top: 420, bottom: 464, required: true }] };
  const slot = { top: 736, bottom: 780 };
  const band = (s: number) => Math.min(base.fade, s);
  it("rests a preset row clear of the top band, not flush under it (a raw snap of 74 put the Next week row under the fade)", () => {
    const landed = scrollTopClearOfFade({ ...base, noSliver: [slot] });
    expect(landed).toBe(50);
    // Every row whose top is on screen sits below the top fade; the pressed slot is clear of the bottom fade (body 644 tall, band starts at 620).
    for (const top of [14, 74, 134]) if (top - landed >= 0) expect(top - landed).toBeGreaterThanOrEqual(band(landed));
    expect(780 - 119 - landed).toBeLessThanOrEqual(644 - base.fade);
  });
  it("never lands a row's top inside the band at any snap", () => {
    for (const snap of [14, 74, 134, 194]) {
      const landed = scrollTopClearOfFade({ ...base, snaps: [0, snap], items: [] });
      if (snap - landed >= 0) expect(snap - landed).toBeGreaterThanOrEqual(band(landed));
    }
  });
  it("keeps snap 0 at 0", () => {
    expect(scrollTopClearOfFade({ ...base, noSliver: [{ top: 300, bottom: 344 }] })).toBe(0);
  });
  it("(b) does not leave the active chip in the top fade: Today active in row 1 lifts the body past it", () => {
    const chip = { top: 119 + 14, bottom: 119 + 14 + 52 };
    const landed = scrollTopClearOfFade({ ...base, noSliver: [slot, chip] });
    const top = chip.top - 119 - landed;
    const bottom = chip.bottom - 119 - landed;
    // Fully above the body or fully below the top band: never a sliver in it.
    expect(bottom <= 2 || top >= band(landed) - 2).toBe(true);
    expect(landed).toBe(110);
  });
});
