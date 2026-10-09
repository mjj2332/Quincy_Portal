import { describe, expect, it } from "vitest";
import { nextShuttleRate } from "./video-shuttle";

describe("nextShuttleRate (#741 4d-ii)", () => {
  it("Space / K toggles between paused and 1x, and stops any shuttle", () => {
    expect(nextShuttleRate(0, "toggle")).toBe(1);
    expect(nextShuttleRate(1, "toggle")).toBe(0);
    expect(nextShuttleRate(8, "toggle")).toBe(0);
    expect(nextShuttleRate(-4, "toggle")).toBe(0);
  });

  it("L climbs 1x, 2x, 4x, 8x and stays at 8x", () => {
    expect([0, 1, 2, 4, 8].map((rate) => nextShuttleRate(rate, "forward"))).toEqual([1, 2, 4, 8, 8]);
  });

  it("J climbs -1x, -2x, -4x, -8x and stays at -8x", () => {
    expect([0, -1, -2, -4, -8].map((rate) => nextShuttleRate(rate, "reverse"))).toEqual([-1, -2, -4, -8, -8]);
  });

  it("the opposite key slows one step toward paused (NLE convention)", () => {
    expect([8, 4, 2, 1].map((rate) => nextShuttleRate(rate, "reverse"))).toEqual([4, 2, 1, 0]);
    expect([-8, -4, -2, -1].map((rate) => nextShuttleRate(rate, "forward"))).toEqual([-4, -2, -1, 0]);
  });
});
