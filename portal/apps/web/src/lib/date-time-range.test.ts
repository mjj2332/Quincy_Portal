import { describe, expect, it } from "vitest";
import { applyRangeShortcut, buildRangeShortcuts, momentLabel, type DateTimeRangeValue, type RangeShortcut } from "./date-time-range";

/** #683: a shortcut sets the ACTIVE end only; Project default is the one that sets both. Wed 7 Oct 2026 unless stated. */
const TODAY = "2026-10-07";
const moment = (localCivil: string, fold: 0 | 1 = 0) => ({ localCivil, fold });
const range = (start: string, end: string): DateTimeRangeValue => ({ start: moment(start), end: moment(end) });
const rows = (active: "start" | "end", projectDefault: DateTimeRangeValue | null = null, today = TODAY) => Object.fromEntries(buildRangeShortcuts({ today, projectDefault, active }).map((row) => [row.id, row])) as Record<string, RangeShortcut>;
const apply = (id: string, active: "start" | "end", current: { start: string | null; end: string | null }, today = TODAY, projectDefault: DateTimeRangeValue | null = null) => applyRangeShortcut(rows(active, projectDefault, today)[id]!, active, current);

describe("buildRangeShortcuts", () => {
  it("carries the full pair each shortcut used to set, and a scope", () => {
    const all = rows("start", range("2026-12-01T09:00", "2026-12-04T17:00"));
    expect(Object.keys(all)).toEqual(["today", "tomorrow", "this-week", "next-week", "project-default"]);
    expect(all.today!.pair).toEqual(range("2026-10-07T09:00", "2026-10-07T17:00"));
    expect(all.tomorrow!.pair).toEqual(range("2026-10-08T09:00", "2026-10-08T17:00"));
    expect(all["this-week"]!.pair).toEqual(range("2026-10-07T09:00", "2026-10-11T17:00"));
    expect(all["next-week"]!.pair).toEqual(range("2026-10-12T09:00", "2026-10-18T17:00"));
    expect(all["project-default"]!.pair).toEqual(range("2026-12-01T09:00", "2026-12-04T17:00"));
    expect(Object.values(all).map((row) => row.scope)).toEqual(["end", "end", "end", "end", "range"]);
  });

  it("labels each sublabel with what the shortcut sets on the active tab", () => {
    const start = rows("start", range("2026-12-01T09:00", "2026-12-04T17:00"));
    expect(Object.values(start).map((row) => row.sublabel)).toEqual(["Wed 7 Oct · 09:00", "Thu 8 Oct · 09:00", "Wed 7 Oct · 09:00", "Mon 12 Oct · 09:00", "1 Dec – 4 Dec"]);
    const end = rows("end", range("2026-12-01T09:00", "2026-12-04T17:00"));
    expect(Object.values(end).map((row) => row.sublabel)).toEqual(["Wed 7 Oct · 17:00", "Thu 8 Oct · 17:00", "Sun 11 Oct · 17:00", "Sun 18 Oct · 17:00", "1 Dec – 4 Dec"]);
  });

  it("momentLabel is the weekday, day, month and time", () => {
    expect(momentLabel("2026-10-07T09:00")).toBe("Wed 7 Oct · 09:00");
  });

  it("resolves the week shortcuts from a Sunday and a Monday", () => {
    expect(rows("end", null, "2026-10-11")["this-week"]!.pair.end.localCivil).toBe("2026-10-11T17:00");
    expect(rows("start", null, "2026-10-11")["next-week"]!.pair.start.localCivil).toBe("2026-10-12T09:00");
    expect(rows("end", null, "2026-10-12")["this-week"]!.pair.end.localCivil).toBe("2026-10-18T17:00");
    expect(rows("start", null, "2026-10-12")["next-week"]!.pair.start.localCivil).toBe("2026-10-19T09:00");
  });

  it("crosses a month boundary", () => {
    expect(rows("end", null, "2026-10-29")["next-week"]!.pair).toEqual(range("2026-11-02T09:00", "2026-11-08T17:00"));
  });

  it("has no Project default row without one", () => {
    expect(rows("start")["project-default"]).toBeUndefined();
  });
});

describe("applyRangeShortcut: a shortcut that does not collide", () => {
  it("START: sets the start and keeps the end untouched", () => {
    expect(apply("today", "start", { start: "2026-10-05T10:00", end: "2026-10-09T15:30" })).toEqual({ start: moment("2026-10-07T09:00"), end: "keep" });
  });

  it("END: sets the end and keeps the start untouched", () => {
    expect(apply("this-week", "end", { start: "2026-10-05T10:00", end: "2026-10-09T15:30" })).toEqual({ start: "keep", end: moment("2026-10-11T17:00") });
  });

  it("the owner's case: START Today on 7 Oct 18:00 to 8 Oct 17:00 gives 09:00 to the same end", () => {
    expect(apply("today", "start", { start: "2026-10-07T18:00", end: "2026-10-08T17:00" })).toEqual({ start: moment("2026-10-07T09:00"), end: "keep" });
  });
});

describe("applyRangeShortcut: START collisions", () => {
  it("moves the end to keep the old duration when the new start lands on or after it", () => {
    // 2 days 6 h old range; Tomorrow START = Thu 8 Oct 09:00, which is after the end (Tue 6 Oct 15:00).
    expect(apply("tomorrow", "start", { start: "2026-10-04T09:00", end: "2026-10-06T15:00" })).toEqual({ start: moment("2026-10-08T09:00"), end: moment("2026-10-10T15:00") });
  });

  it("treats equality as a collision", () => {
    expect(apply("today", "start", { start: "2026-10-07T01:00", end: "2026-10-07T09:00" })).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-07T17:00") });
  });

  it("does not collide one minute before the end", () => {
    expect(apply("today", "start", { start: "2026-10-07T01:00", end: "2026-10-07T09:01" }).end).toBe("keep");
  });

  it("measures the duration in wall-clock minutes, so 09:00 survives a daylight-saving change", () => {
    // Sat 3 Oct 09:00 to Sun 4 Oct 09:00 is 24 civil hours (23 real: Sydney springs forward on 4 Oct). Today START = Sun 4 Oct 09:00 equals the end.
    expect(apply("today", "start", { start: "2026-10-03T09:00", end: "2026-10-04T09:00" }, "2026-10-04")).toEqual({ start: moment("2026-10-04T09:00"), end: moment("2026-10-05T09:00") });
  });
});

describe("applyRangeShortcut: END collisions", () => {
  it("sets the start to the shortcut's own start when the new end is not after it", () => {
    // Mon 5 Oct to Fri 9 Oct; END Today = Wed 7 Oct 17:00 is after the start, so no collision...
    expect(apply("today", "end", { start: "2026-10-05T09:00", end: "2026-10-09T17:00" })).toEqual({ start: "keep", end: moment("2026-10-07T17:00") });
    // ...but a start on Thu 8 Oct 18:00 collides, and takes Today's own 09:00 (never the past, never the kept duration).
    expect(apply("today", "end", { start: "2026-10-08T18:00", end: "2026-10-09T17:00" })).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-07T17:00") });
  });

  it("treats equality as a collision", () => {
    expect(apply("today", "end", { start: "2026-10-07T17:00", end: "2026-10-08T17:00" })).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-07T17:00") });
  });

  it("does not collide one minute after the start", () => {
    expect(apply("today", "end", { start: "2026-10-07T16:59", end: "2026-10-09T17:00" }).start).toBe("keep");
  });
});

describe("applyRangeShortcut: an unusable other end", () => {
  it.each([
    ["empty", null],
    ["not a civil minute", "garbage"],
  ])("START with an %s end fills it from the pair", (_name, end) => {
    expect(apply("tomorrow", "start", { start: "2026-10-05T09:00", end })).toEqual({ start: moment("2026-10-08T09:00"), end: moment("2026-10-08T17:00") });
  });

  it("END with an empty start fills it from the pair", () => {
    expect(apply("next-week", "end", { start: null, end: "2026-10-09T17:00" })).toEqual({ start: moment("2026-10-12T09:00"), end: moment("2026-10-18T17:00") });
  });

  it("an already inverted draft fills the other end from the pair on either tab", () => {
    const inverted = { start: "2026-10-20T09:00", end: "2026-10-10T17:00" };
    expect(apply("this-week", "start", inverted)).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-11T17:00") });
    expect(apply("this-week", "end", inverted)).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-11T17:00") });
  });

  it("an empty draft on START fills both ends", () => {
    expect(apply("today", "start", { start: null, end: null })).toEqual({ start: moment("2026-10-07T09:00"), end: moment("2026-10-07T17:00") });
  });
});

describe("applyRangeShortcut: Project default", () => {
  const projectDefault: DateTimeRangeValue = { start: moment("2026-12-01T01:30", 1), end: moment("2026-12-04T17:00") };

  it.each(["start", "end"] as const)("sets both ends, folds included, from the %s tab, with no collision handling", (active) => {
    expect(apply("project-default", active, { start: "2026-12-10T09:00", end: "2026-12-11T09:00" }, TODAY, projectDefault)).toEqual({ start: projectDefault.start, end: projectDefault.end });
  });
});
