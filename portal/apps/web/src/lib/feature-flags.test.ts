import { describe, expect, it } from "vitest";
import { NAVIGATION_RAIL_FLAG, navigationRailEnabled } from "./feature-flags";

describe("navigationRailEnabled", () => {
  it("is on for exactly the string \"1\"", () => {
    expect(navigationRailEnabled({ [NAVIGATION_RAIL_FLAG]: "1" })).toBe(true);
  });

  it("is off when the flag is absent, and for an absent env", () => {
    expect(navigationRailEnabled({})).toBe(false);
    expect(navigationRailEnabled(undefined)).toBe(false);
  });

  it("is off for every truthy string that is not \"1\"", () => {
    // The whole reason the check is `=== "1"`. Each of these is truthy in JS, so a `Boolean(value)`
    // or `!== "0"` implementation would turn the rail ON for someone disabling it.
    for (const value of ["0", "false", "off", "no", "true", "yes", "on", "2", " 1", "1 ", ""]) {
      expect(navigationRailEnabled({ [NAVIGATION_RAIL_FLAG]: value }), value).toBe(false);
    }
  });

  it("is off for non-string values, including the boolean true", () => {
    for (const value of [true, 1, {}, [], null, undefined]) {
      expect(navigationRailEnabled({ [NAVIGATION_RAIL_FLAG]: value })).toBe(false);
    }
  });

  it("reads only its own key", () => {
    expect(navigationRailEnabled({ VITE_QUINCY_NAV_RAIL_ENABLED: "1", OTHER: "1" })).toBe(false);
  });

  it("is pure — it reads no environment of its own", () => {
    // A regression net for the shape of this module: if someone rewrites it to read
    // `import.meta.env` internally, the parameter stops mattering and this pair diverges.
    expect(navigationRailEnabled({})).toBe(false);
    expect(navigationRailEnabled({ [NAVIGATION_RAIL_FLAG]: "1" })).toBe(true);
  });
});
