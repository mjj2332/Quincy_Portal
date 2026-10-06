/**
 * Guard (#652): the Up next meta line (label + detail) is one line on a phone. `ItemDescription` inherits a
 * two-line clamp that wrapped it at 320px; the rail overrides it with `line-clamp-1`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = readFileSync(new URL("./ProductionEventCalendarRail.tsx", import.meta.url), "utf8");

describe("Up next meta line clamp (#652)", () => {
  it("the Up next ItemDescription carries line-clamp-1", () => {
    const match = file.match(/<ItemDescription className="([^"]*)">\{upNextLabel/);
    expect(match, "Up next ItemDescription not found").not.toBeNull();
    expect(match![1]!.split(/\s+/)).toContain("line-clamp-1");
  });
});
