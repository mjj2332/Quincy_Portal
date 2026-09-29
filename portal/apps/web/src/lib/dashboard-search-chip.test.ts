import { describe, expect, it } from "vitest";
import { searchChipCountText } from "./dashboard-search-chip";

describe("searchChipCountText (#260)", () => {
  it("reads as the search count alone when no view reports what it shows", () => {
    expect(searchChipCountText({ matching: 2, total: 31 }, null)).toBe("2 of 31 projects · ");
  });

  it("singularises a one-project total", () => {
    expect(searchChipCountText({ matching: 1, total: 1 }, null)).toBe("1 of 1 project · ");
  });

  it("names both numbers when the view's filters hide some matches", () => {
    expect(searchChipCountText({ matching: 2, total: 31 }, 1)).toBe("2 of 31 projects match · 1 shown · ");
  });

  it("stays the plain search count when the view shows every match", () => {
    expect(searchChipCountText({ matching: 2, total: 31 }, 2)).toBe("2 of 31 projects · ");
  });

  it("names a view that shows none of the matches", () => {
    expect(searchChipCountText({ matching: 2, total: 31 }, 0)).toBe("2 of 31 projects match · 0 shown · ");
  });
});
