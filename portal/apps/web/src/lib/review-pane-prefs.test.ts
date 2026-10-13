import { describe, expect, it } from "vitest";
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, PLAYER_MIN, REVIEW_PANE_KEY, clampPaneWidth, normalizeReviewPane, paneCeiling } from "./review-pane-prefs";

describe("review pane prefs (#859)", () => {
  it("has one browser-wide key and the settled bounds", () => {
    expect(REVIEW_PANE_KEY).toBe("quincy:ui:review-notes-pane");
    expect([PANE_MIN, PANE_DEFAULT, PANE_MAX, PLAYER_MIN]).toEqual([280, 360, 640, 480]);
  });
  it("defaults to open at 360 for anything that is not a pane object", () => {
    for (const junk of [null, undefined, "x", 3, [], NaN, { open: "yes", width: "wide" }, { width: NaN }]) expect(normalizeReviewPane(junk)).toEqual({ open: true, width: 360 });
  });
  it("keeps a closed pane closed and rounds and clamps a stored width", () => {
    expect(normalizeReviewPane({ open: false, width: 400.4 })).toEqual({ open: false, width: 400 });
    expect(normalizeReviewPane({ open: true, width: 10 })).toEqual({ open: true, width: 280 });
    expect(normalizeReviewPane({ open: true, width: 9999 })).toEqual({ open: true, width: 640 });
    expect(normalizeReviewPane({ open: true, width: Infinity })).toEqual({ open: true, width: 360 });
  });
  it("the ceiling is the smaller of 640 and host - 480, never below the minimum, and 640 when the host is unmeasured", () => {
    expect(paneCeiling(1440)).toBe(640);
    expect(paneCeiling(1000)).toBe(520);
    expect(paneCeiling(700)).toBe(280);
    expect(paneCeiling(0)).toBe(640);
  });
  it("clamps at use time without touching the preferred width", () => {
    expect(clampPaneWidth(640, 1000)).toBe(520);
    expect(clampPaneWidth(100, 1440)).toBe(280);
    expect(clampPaneWidth(500, 1440)).toBe(500);
  });
});
