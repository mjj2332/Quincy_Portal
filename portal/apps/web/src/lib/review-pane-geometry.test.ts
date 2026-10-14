import { describe, expect, it } from "vitest";
import { FLICK_PX_PER_MS, PHONE_QUERY, settleSheet, sheetStops } from "./review-pane-geometry";

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
    expect(s.full).toBe(700 - 200);
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
