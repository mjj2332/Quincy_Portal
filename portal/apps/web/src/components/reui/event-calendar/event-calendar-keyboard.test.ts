/**
 * #240 — the calendar's keyboard movement model, as pure functions. Quincy-authored, not a ReUI
 * vendored file; it lives here so a re-vendor trips over it (ADR 0009).
 *
 * Owner decisions this file pins (recorded on #240):
 *   - The Gantt's Adjust grammar (ADR 0009): Space enters; Arrows step; M/S/E retarget;
 *     Enter/Space commits; Escape cancels. Only what an arrow MEANS differs per geometry.
 *   - In a time grid one vertical step is ELAPSED time, so the repeated hour's second pass —
 *     which no pointer can reach since #241 — is reachable. A horizontal step is "the same clock
 *     time on the next day", never +/-1440 minutes.
 *
 * Every expected instant is written as a UTC literal worked out by hand from Sydney's offsets
 * (+11:00 in DST, +10:00 outside it; 2026-04-05 03:00 -> 02:00, 2026-10-04 02:00 -> 03:00), not
 * computed with the helpers under test.
 */
import { describe, expect, it } from "vitest";
import {
  computeKeyboardProposal,
  matchAdjustKey,
  type AdjustContext,
  type AdjustWindow,
} from "@/components/reui/event-calendar/event-calendar-keyboard";

const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({
  key: k,
  repeat: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe("matchAdjustKey — one matcher for the whole grammar", () => {
  it("idle: only Space enters; everything else is left to the browser", () => {
    expect(matchAdjustKey(key(" "), false, false)).toEqual({ type: "enter" });
    expect(matchAdjustKey(key("Enter"), false, false)).toBeNull();
    expect(matchAdjustKey(key("ArrowDown"), false, false)).toBeNull();
    expect(matchAdjustKey(key("m"), false, false)).toBeNull();
  });

  it("adjusting: arrows step, Shift makes the step large", () => {
    expect(matchAdjustKey(key("ArrowDown"), true, false)).toEqual({ type: "step", axis: "y", dir: 1, large: false });
    expect(matchAdjustKey(key("ArrowUp", { shiftKey: true }), true, false)).toEqual({ type: "step", axis: "y", dir: -1, large: true });
    expect(matchAdjustKey(key("ArrowRight"), true, false)).toEqual({ type: "step", axis: "x", dir: 1, large: false });
  });

  it("adjusting: a horizontal arrow follows the reading direction", () => {
    expect(matchAdjustKey(key("ArrowRight"), true, true)).toEqual({ type: "step", axis: "x", dir: -1, large: false });
    expect(matchAdjustKey(key("ArrowLeft"), true, true)).toEqual({ type: "step", axis: "x", dir: 1, large: false });
  });

  it("adjusting: Home/End, PageUp/PageDown, M/S/E, Enter/Space, Escape", () => {
    expect(matchAdjustKey(key("Home"), true, false)).toEqual({ type: "edge", dir: -1 });
    expect(matchAdjustKey(key("End"), true, false)).toEqual({ type: "edge", dir: 1 });
    expect(matchAdjustKey(key("PageUp"), true, false)).toEqual({ type: "page", dir: -1 });
    expect(matchAdjustKey(key("PageDown"), true, false)).toEqual({ type: "page", dir: 1 });
    expect(matchAdjustKey(key("m"), true, false)).toEqual({ type: "retarget", target: "move" });
    expect(matchAdjustKey(key("S"), true, false)).toEqual({ type: "retarget", target: "start" });
    expect(matchAdjustKey(key("e"), true, false)).toEqual({ type: "retarget", target: "end" });
    expect(matchAdjustKey(key("Enter"), true, false)).toEqual({ type: "commit" });
    expect(matchAdjustKey(key(" "), true, false)).toEqual({ type: "commit" });
    expect(matchAdjustKey(key("Escape"), true, false)).toEqual({ type: "cancel" });
  });

  it("a HELD Space or Enter is swallowed, never a second decision; held arrows still step", () => {
    // Space held a beat too long would otherwise enter Adjust and at once commit "no change"
    expect(matchAdjustKey(key(" ", { repeat: true }), true, false)).toEqual({ type: "swallow" });
    expect(matchAdjustKey(key("Enter", { repeat: true }), true, false)).toEqual({ type: "swallow" });
    expect(matchAdjustKey(key(" ", { repeat: true }), false, false)).toBeNull();
    expect(matchAdjustKey(key("ArrowDown", { repeat: true }), true, false)).toMatchObject({ type: "step" });
  });

  it("never claims a chord the browser or OS owns", () => {
    expect(matchAdjustKey(key("ArrowLeft", { altKey: true }), true, false)).toBeNull();
    expect(matchAdjustKey(key("s", { ctrlKey: true }), true, false)).toBeNull();
    expect(matchAdjustKey(key("e", { metaKey: true }), true, false)).toBeNull();
    expect(matchAdjustKey(key("Tab"), true, false)).toEqual({ type: "leave" });
  });
});

const SYDNEY = "Australia/Sydney";
const ctx = (over: Partial<AdjustContext>): AdjustContext => ({
  geometry: "time",
  target: "move",
  timeZone: SYDNEY,
  snapDuration: 15,
  startHour: 0,
  endHour: 24,
  weekStartsOn: 0,
  resourceIds: [],
  ...over,
});
const win = (start: string, end: string, extra: Partial<AdjustWindow> = {}): AdjustWindow => ({
  start: new Date(start),
  end: new Date(end),
  allDay: false,
  ...extra,
});
const iso = (r: ReturnType<typeof computeKeyboardProposal>) =>
  // via getTime(): a TZDate prints its own offset from toISOString(), and these are UTC literals
  r.ok ? [r.window.start, r.window.end].map((d) => new Date(d.getTime()).toISOString()) : r.reason;

const DOWN = { type: "step", axis: "y", dir: 1, large: false } as const;
const UP = { type: "step", axis: "y", dir: -1, large: false } as const;
const RIGHT = { type: "step", axis: "x", dir: 1, large: false } as const;
const LEFT = { type: "step", axis: "x", dir: -1, large: false } as const;

describe("time grid — vertical steps are elapsed time", () => {
  it("moves by snapDuration, or by an hour with Shift", () => {
    // Mon 2026-09-21 09:00-10:00 +10:00
    const w = win("2026-09-20T23:00:00.000Z", "2026-09-21T00:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({})))).toEqual(["2026-09-20T23:15:00.000Z", "2026-09-21T00:15:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, { ...UP, large: true }, ctx({})))).toEqual(["2026-09-20T22:00:00.000Z", "2026-09-20T23:00:00.000Z"]);
  });

  it("steps INTO the repeated hour's second pass, which no pointer can reach", () => {
    // first-pass 02:45-03:00 is +11:00 -> 15:45Z-16:00Z. One step down is 16:00Z, which the clock
    // calls 02:00 again (+10:00).
    const w = win("2026-04-04T15:45:00.000Z", "2026-04-04T16:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({})))).toEqual(["2026-04-04T16:00:00.000Z", "2026-04-04T16:15:00.000Z"]);
  });

  it("refuses to step off the day's bounds rather than wrapping to another day", () => {
    // Mon 2026-09-21 23:30-24:00
    const w = win("2026-09-21T13:30:00.000Z", "2026-09-21T14:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({})))).toBe("bounds");
    // 00:00-00:30 upward
    expect(iso(computeKeyboardProposal(win("2026-09-20T14:00:00.000Z", "2026-09-20T14:30:00.000Z"), UP, ctx({})))).toBe("bounds");
    // and against a 08:00-18:00 working day
    expect(iso(computeKeyboardProposal(win("2026-09-20T22:00:00.000Z", "2026-09-20T23:00:00.000Z"), UP, ctx({ startHour: 8, endHour: 18 })))).toBe("bounds");
  });

  it("resizes one edge, never below one snap", () => {
    const w = win("2026-09-20T23:00:00.000Z", "2026-09-20T23:30:00.000Z"); // 09:00-09:30
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({ target: "end" })))).toEqual(["2026-09-20T23:00:00.000Z", "2026-09-20T23:45:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({ target: "start" })))).toEqual(["2026-09-20T23:15:00.000Z", "2026-09-20T23:30:00.000Z"]);
    const short = win("2026-09-20T23:00:00.000Z", "2026-09-20T23:15:00.000Z");
    expect(iso(computeKeyboardProposal(short, UP, ctx({ target: "end" })))).toBe("min-duration");
    expect(iso(computeKeyboardProposal(short, DOWN, ctx({ target: "start" })))).toBe("min-duration");
  });

  it("moves a block that already crosses midnight: only its START is held inside the day", () => {
    // Mon 2026-09-21 22:00 -> Tue 00:30 (+10:00). Its end is past Monday's bound before any key.
    const w = win("2026-09-21T12:00:00.000Z", "2026-09-21T14:30:00.000Z");
    expect(iso(computeKeyboardProposal(w, UP, ctx({})))).toEqual(["2026-09-21T11:45:00.000Z", "2026-09-21T14:15:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, DOWN, ctx({})))).toEqual(["2026-09-21T12:15:00.000Z", "2026-09-21T14:45:00.000Z"]);
    // and a block that fits is still not pushed across midnight one snap at a time
    const late = win("2026-09-21T13:00:00.000Z", "2026-09-21T14:00:00.000Z"); // 23:00-24:00
    expect(iso(computeKeyboardProposal(late, DOWN, ctx({})))).toBe("bounds");
  });

  it("Home/End send the target to the day's bound", () => {
    const w = win("2026-09-20T23:00:00.000Z", "2026-09-21T00:00:00.000Z"); // 09:00-10:00
    const c = ctx({ startHour: 8, endHour: 18 });
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: -1 }, c))).toEqual(["2026-09-20T22:00:00.000Z", "2026-09-20T23:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: 1 }, c))).toEqual(["2026-09-21T07:00:00.000Z", "2026-09-21T08:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: 1 }, { ...c, target: "end" }))).toEqual(["2026-09-20T23:00:00.000Z", "2026-09-21T08:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: -1 }, { ...c, target: "start" }))).toEqual(["2026-09-20T22:00:00.000Z", "2026-09-21T00:00:00.000Z"]);
  });
});

describe("time grid — a horizontal step is the same clock time on the next day", () => {
  it("is 25 real hours across the autumn transition, not 24", () => {
    // Sat 2026-04-04 09:00-10:00 +11:00  ->  Sun 2026-04-05 09:00-10:00 +10:00
    const w = win("2026-04-03T22:00:00.000Z", "2026-04-03T23:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, RIGHT, ctx({})))).toEqual(["2026-04-04T23:00:00.000Z", "2026-04-05T00:00:00.000Z"]);
  });

  it("lands on the instant the gap closes when that clock time does not exist", () => {
    // Sat 2026-10-03 02:30-03:30 +10:00 -> Sun 2026-10-04 has no 02:30; 03:00 +11:00 is 16:00Z.
    const w = win("2026-10-02T16:30:00.000Z", "2026-10-02T17:30:00.000Z");
    expect(iso(computeKeyboardProposal(w, RIGHT, ctx({})))).toEqual(["2026-10-03T16:00:00.000Z", "2026-10-03T17:00:00.000Z"]);
  });

  it("is refused for a resize edge, and PageUp/PageDown mean nothing here", () => {
    const w = win("2026-09-20T23:00:00.000Z", "2026-09-21T00:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, LEFT, ctx({ target: "end" })))).toBe("axis");
    expect(iso(computeKeyboardProposal(w, { type: "page", dir: 1 }, ctx({})))).toBe("axis");
  });
});

describe("month grid — days across, weeks down", () => {
  const month = (over: Partial<AdjustContext> = {}) => ctx({ geometry: "month", ...over });

  it("moves a timed event a week down at the same clock time across a transition", () => {
    // Wed 2026-04-01 09:00-10:00 +11:00 -> Wed 2026-04-08 09:00-10:00 +10:00
    const w = win("2026-03-31T22:00:00.000Z", "2026-03-31T23:00:00.000Z");
    expect(iso(computeKeyboardProposal(w, DOWN, month()))).toEqual(["2026-04-07T23:00:00.000Z", "2026-04-08T00:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, RIGHT, month()))).toEqual(["2026-04-01T22:00:00.000Z", "2026-04-01T23:00:00.000Z"]);
  });

  it("Home/End send an all-day event to the ends of its week row", () => {
    // all-day Wed 2026-04-08 (+10:00): 14:00Z Apr 7 -> 14:00Z Apr 8. Week row is Sun Apr 5..Sat Apr 11;
    // Sun Apr 5 00:00 is still +11:00 (13:00Z Apr 4), Mon Apr 6 00:00 is +10:00.
    const w = win("2026-04-07T14:00:00.000Z", "2026-04-08T14:00:00.000Z", { allDay: true });
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: -1 }, month()))).toEqual(["2026-04-04T13:00:00.000Z", "2026-04-05T14:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: 1 }, month()))).toEqual(["2026-04-10T14:00:00.000Z", "2026-04-11T14:00:00.000Z"]);
    // Monday week start: the row is Mon Apr 6..Sun Apr 12
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: -1 }, month({ weekStartsOn: 1 })))).toEqual(["2026-04-05T14:00:00.000Z", "2026-04-06T14:00:00.000Z"]);
  });

  it("PageDown moves a month, clamping to the shorter month's last day", () => {
    // all-day Sat 2026-01-31 (+11:00) -> Sat 2026-02-28
    const w = win("2026-01-30T13:00:00.000Z", "2026-01-31T13:00:00.000Z", { allDay: true });
    expect(iso(computeKeyboardProposal(w, { type: "page", dir: 1 }, month()))).toEqual(["2026-02-27T13:00:00.000Z", "2026-02-28T13:00:00.000Z"]);
  });

  it("resizes a bar's edge by days, never to less than one day, and only across", () => {
    // all-day Tue Sep 22 .. Wed Sep 23 (two days): 14:00Z Sep 21 -> 14:00Z Sep 23
    const w = win("2026-09-21T14:00:00.000Z", "2026-09-23T14:00:00.000Z", { allDay: true });
    expect(iso(computeKeyboardProposal(w, RIGHT, month({ target: "end" })))).toEqual(["2026-09-21T14:00:00.000Z", "2026-09-24T14:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, RIGHT, month({ target: "start" })))).toEqual(["2026-09-22T14:00:00.000Z", "2026-09-23T14:00:00.000Z"]);
    const oneDay = win("2026-09-21T14:00:00.000Z", "2026-09-22T14:00:00.000Z", { allDay: true });
    expect(iso(computeKeyboardProposal(oneDay, LEFT, month({ target: "end" })))).toBe("min-duration");
    expect(iso(computeKeyboardProposal(oneDay, RIGHT, month({ target: "start" })))).toBe("min-duration");
    expect(iso(computeKeyboardProposal(w, DOWN, month({ target: "end" })))).toBe("axis");
  });
});

describe("the time grid's all-day row — days across, nothing down", () => {
  it("moves across and refuses the vertical axis", () => {
    const w = win("2026-09-21T14:00:00.000Z", "2026-09-22T14:00:00.000Z", { allDay: true });
    const c = ctx({ geometry: "day-bar" });
    expect(iso(computeKeyboardProposal(w, RIGHT, c))).toEqual(["2026-09-22T14:00:00.000Z", "2026-09-23T14:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(w, DOWN, c))).toBe("axis");
    expect(iso(computeKeyboardProposal(w, { type: "page", dir: 1 }, c))).toBe("axis");
  });

  it("refuses Home/End: a week-row jump would leave a day view's only column", () => {
    const w = win("2026-09-21T14:00:00.000Z", "2026-09-22T14:00:00.000Z", { allDay: true });
    const c = ctx({ geometry: "day-bar" });
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: 1 }, c))).toBe("axis");
    expect(iso(computeKeyboardProposal(w, { type: "edge", dir: -1 }, { ...c, target: "start" }))).toBe("axis");
  });
});

describe("resource view — across means the next resource, and the day never changes", () => {
  const c = ctx({ geometry: "resource", resourceIds: ["cam-a", "cam-b", "cam-c"] });
  const w = win("2026-09-20T23:00:00.000Z", "2026-09-21T00:00:00.000Z", { resourceId: "cam-b" });

  it("moves to the neighbouring resource with the time untouched", () => {
    const right = computeKeyboardProposal(w, RIGHT, c);
    expect(right.ok && right.window.resourceId).toBe("cam-c");
    expect(iso(right)).toEqual(["2026-09-20T23:00:00.000Z", "2026-09-21T00:00:00.000Z"]);
    const left = computeKeyboardProposal(w, LEFT, c);
    expect(left.ok && left.window.resourceId).toBe("cam-a");
  });

  it("refuses past the last resource, and steps time vertically like any time grid", () => {
    expect(iso(computeKeyboardProposal({ ...w, resourceId: "cam-c" }, RIGHT, c))).toBe("bounds");
    const down = computeKeyboardProposal(w, DOWN, c);
    expect(iso(down)).toEqual(["2026-09-20T23:15:00.000Z", "2026-09-21T00:15:00.000Z"]);
    expect(down.ok && down.window.resourceId).toBe("cam-b");
  });

  it("an all-day booking changes resource only: no key may change its day", () => {
    const allDay = win("2026-09-21T14:00:00.000Z", "2026-09-22T14:00:00.000Z", { allDay: true, resourceId: "cam-b" });
    const right = computeKeyboardProposal(allDay, RIGHT, c);
    expect(right.ok && right.window.resourceId).toBe("cam-c");
    expect(iso(right)).toEqual(["2026-09-21T14:00:00.000Z", "2026-09-22T14:00:00.000Z"]);
    expect(iso(computeKeyboardProposal(allDay, { type: "edge", dir: 1 }, c))).toBe("axis");
    expect(iso(computeKeyboardProposal(allDay, { type: "edge", dir: -1 }, c))).toBe("axis");
    expect(iso(computeKeyboardProposal(allDay, { type: "page", dir: 1 }, c))).toBe("axis");
    expect(iso(computeKeyboardProposal(allDay, DOWN, c))).toBe("axis");
  });
});
