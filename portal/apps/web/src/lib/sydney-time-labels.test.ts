import { describe, expect, it } from "vitest";
import { productionCalendarZoneLabel, utcOffsetLabel } from "./sydney-time-labels";

const MINUS = "−";

describe("utcOffsetLabel", () => {
  it.each([
    [660, "UTC+11:00"],
    [600, "UTC+10:00"],
    [0, "UTC+00:00"],
    [-300, `UTC${MINUS}05:00`],
    [-330, `UTC${MINUS}05:30`],
  ])("labels %i minutes as %s", (minutes, expected) => {
    expect(utcOffsetLabel(minutes)).toBe(expected);
  });

  it("uses the U+2212 minus sign, never an ASCII hyphen", () => {
    const label = utcOffsetLabel(-600);
    expect(label.codePointAt(3)).toBe(0x2212);
    expect(label).not.toContain("-");
  });
});

describe("productionCalendarZoneLabel", () => {
  it.each([
    [{ start: "2026-07-13", end: "2026-07-20" }, "AEST"],
    [{ start: "2026-10-12", end: "2026-10-19" }, "AEDT"],
    [{ start: "2026-09-28", end: "2026-10-12" }, "AEST/AEDT"],
  ])("labels the Sydney range %o", (range, expected) => {
    expect(productionCalendarZoneLabel(range)).toBe(`Sydney time · ${expected}`);
  });
});
