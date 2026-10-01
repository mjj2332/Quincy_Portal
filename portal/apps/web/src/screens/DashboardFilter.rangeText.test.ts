import { describe, expect, it } from "vitest";
import { rangeText } from "./DashboardFilter";

describe("rangeText (#429)", () => {
  it("shows a placeholder until a range is picked", () => {
    expect(rangeText([])).toBe("Select dates");
    expect(rangeText(["2026-06-01"])).toBe("Select dates");
  });
  it("formats a picked range", () => {
    const text = rangeText(["2026-06-01", "2026-06-03"]);
    expect(text).toContain(" – ");
    expect(text).not.toBe("Select dates");
  });
});
