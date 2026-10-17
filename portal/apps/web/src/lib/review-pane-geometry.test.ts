import { describe, expect, it } from "vitest";
import { FLICK_PX_PER_MS, PANE_DEFAULT, PANE_MAX, PANE_MIN, PICTURE_MIN, PHONE_QUERY, PLAYER_MIN, TABLET_MAX, clampPaneWidth, paneCeiling, releaseVelocity, resolvePaneOpen, settleSheet, sheetStops } from "./review-pane-geometry";

describe("review sheet geometry (#879)", () => {
  it("names the phone query once", () => {
    expect(PHONE_QUERY).toBe("(width < 721px)");
    expect(FLICK_PX_PER_MS).toBe(0.5);
  });

  const base = { available: 700, collapsed: 127, filmAspect: 16 / 9, width: 390, transport: 90 };

  it("landscape half is the picture plus the transport, leaving the rest to the sheet", () => {
    const s = sheetStops(base);
    // film area = 390/(16/9) + 90 = 309.1 -> 309; the sheet is what is left
    expect(s.half).toBe(700 - 309);
    expect(s.collapsed).toBe(127);
    // The phone player has no gap between the picture and the transport (#879 PR 3a), so the floor is the picture and the transport alone.
    expect(s.full).toBe(700 - (PICTURE_MIN + 90));
  });

  it("the full stop leaves the picture at least PICTURE_MIN above the measured transport", () => {
    const s = sheetStops({ ...base, available: 844 - 77, transport: 100 });
    expect(844 - 77 - s.full).toBe(PICTURE_MIN + 100);
    expect(844 - 77 - s.full - 100).toBeGreaterThanOrEqual(110);
  });

  it("caps the landscape film area at 65% of the space", () => {
    const s = sheetStops({ ...base, available: 400, width: 800 });
    expect(s.half).toBe(400 - 260);
  });

  it("a portrait film takes 65% of the space", () => {
    const s = sheetStops({ ...base, filmAspect: 9 / 16, available: 700 });
    expect(s.half).toBe(700 - 455);
  });

  it("keeps the stops in order when there is hardly any room", () => {
    const s = sheetStops({ ...base, available: 150 });
    expect(s.collapsed).toBeLessThanOrEqual(s.half);
    expect(s.half).toBeLessThanOrEqual(s.full);
    expect(s.full).toBeLessThanOrEqual(150);
  });

  const stops = { collapsed: 127, half: 391, full: 500 };
  it("a slow release settles at the nearest stop; a tap stays at its origin", () => {
    expect(settleSheet({ stops, height: 200, velocity: 0.1 })).toBe("collapsed");
    expect(settleSheet({ stops, height: 300, velocity: -0.2 })).toBe("half");
    expect(settleSheet({ stops, height: 391, velocity: 0 })).toBe("half");
  });
  it("a flick moves to the next stop in its direction, never beyond the ends", () => {
    expect(settleSheet({ stops, height: 391, velocity: 0.8 })).toBe("full");
    expect(settleSheet({ stops, height: 500, velocity: -0.8 })).toBe("half");
    expect(settleSheet({ stops, height: 127, velocity: -0.8 })).toBe("collapsed");
    expect(settleSheet({ stops, height: 500, velocity: 0.9 })).toBe("full");
    expect(settleSheet({ stops, height: 391, velocity: -0.8 })).toBe("collapsed");
  });
});

describe("releaseVelocity (#879)", () => {
  it("is the finger's speed between the last two samples, positive when the sheet grows", () => {
    expect(releaseVelocity({ y: 400, t: 0 }, { y: 300, t: 100 })).toBe(1);
    expect(releaseVelocity({ y: 300, t: 100 }, { y: 400, t: 200 })).toBe(-1);
  });
  it("a pause before lifting reads as slow: the release sample is the other end of the interval", () => {
    const v = releaseVelocity({ y: 300, t: 100 }, { y: 300, t: 900 });
    expect(v).toBe(0);
    expect(Math.abs(releaseVelocity({ y: 300, t: 100 }, { y: 296, t: 900 }))).toBeLessThan(FLICK_PX_PER_MS);
  });
  it("no elapsed time is no velocity", () => { expect(releaseVelocity({ y: 1, t: 5 }, { y: 9, t: 5 })).toBe(0); });
});

describe("desktop pane bounds (#881)", () => {
  it("are the prototype's 300 / 380 / 560, the player keeps 480, and a tablet is at most 1366 wide", () => {
    expect([PANE_MIN, PANE_DEFAULT, PANE_MAX, PLAYER_MIN, TABLET_MAX]).toEqual([300, 380, 560, 480, 1366]);
  });
  it("the ceiling is the smaller of 560 and host - 480, never below the minimum, and 560 when the host is unmeasured", () => {
    expect(paneCeiling(1440)).toBe(560);
    expect(paneCeiling(1000)).toBe(520);
    expect(paneCeiling(700)).toBe(300);
    expect(paneCeiling(0)).toBe(560);
  });
  it("clamps at use time without touching the preferred width", () => {
    expect(clampPaneWidth(560, 1000)).toBe(520);
    expect(clampPaneWidth(100, 1440)).toBe(300);
    expect(clampPaneWidth(500, 1440)).toBe(500);
    expect(clampPaneWidth(500.6, 1440)).toBe(501);
  });
});

describe("resolvePaneOpen (#881, D18)", () => {
  it("with no remembered choice a portrait tablet starts collapsed and anything else open", () => {
    expect(resolvePaneOpen(null, true)).toBe(false);
    expect(resolvePaneOpen(null, false)).toBe(true);
  });
  it("a remembered choice wins either way", () => {
    expect(resolvePaneOpen(true, true)).toBe(true);
    expect(resolvePaneOpen(false, false)).toBe(false);
    expect(resolvePaneOpen(true, false)).toBe(true);
    expect(resolvePaneOpen(false, true)).toBe(false);
  });
});
