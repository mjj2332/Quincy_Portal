import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_PHONE_QUERY } from "../components/board/board-layout";
import { TABLE_NARROW_QUERY } from "./dashboard-table-model";
import { PHONE_VIEWPORT_QUERY } from "./use-media-query";

/**
 * #923 review: the Dashboard has one phone breakpoint, the meaning of Tailwind's `max-[721px]:` (width < 721), so the
 * view bar, the Table and the Board never disagree with their own classes at the edge. happy-dom's `matchMedia`
 * is no help at the edge, so this evaluates the one query shape the constant is allowed to take.
 */
function matchesAt(query: string, width: number): boolean {
  const match = /^\(width < (\d+)px\)$/.exec(query);
  if (!match) throw new Error(`not the phone spelling: ${query}`);
  return width < Number(match[1]);
}

describe("the one phone breakpoint", () => {
  it.each([
    ["the shared constant", PHONE_VIEWPORT_QUERY],
    ["the Table's TABLE_NARROW_QUERY", TABLE_NARROW_QUERY],
    ["the Board's BOARD_PHONE_QUERY", BOARD_PHONE_QUERY],
  ])("%s: 720 is phone and 721 is desktop", (_name, query) => {
    expect(matchesAt(query, 720)).toBe(true);
    expect(matchesAt(query, 721)).toBe(false);
  });

  it("the Table and the Board are the shared constant itself", () => {
    expect(TABLE_NARROW_QUERY).toBe(PHONE_VIEWPORT_QUERY);
    expect(BOARD_PHONE_QUERY).toBe(PHONE_VIEWPORT_QUERY);
  });

  it("the view bar reads the shared constant, not its own spelling", () => {
    const source = readFileSync(new URL("../screens/DashboardViewBar.tsx", import.meta.url), "utf8");
    expect(source).toContain("useMediaQuery(PHONE_VIEWPORT_QUERY)");
    expect(source).not.toMatch(/max-width:\s*721px/);
  });
});
