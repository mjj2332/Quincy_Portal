import { describe, expect, it } from "vitest";
import { sydneyBusinessDate } from "../src";

describe("sydneyBusinessDate", () => {
  it("uses the Sydney calendar day, not the UTC day", () => {
    expect(sydneyBusinessDate(new Date("2026-10-01T13:30:00Z"))).toBe("2026-10-01");
    expect(sydneyBusinessDate(new Date("2026-10-01T14:30:00Z"))).toBe("2026-10-02");
  });

  it("switches day at 14:00Z under AEST and 13:00Z under AEDT", () => {
    expect(sydneyBusinessDate(new Date("2026-10-01T13:59:00Z"))).toBe("2026-10-01");
    expect(sydneyBusinessDate(new Date("2026-10-01T14:00:00Z"))).toBe("2026-10-02");
    expect(sydneyBusinessDate(new Date("2027-01-15T12:59:00Z"))).toBe("2027-01-15");
    expect(sydneyBusinessDate(new Date("2027-01-15T13:00:00Z"))).toBe("2027-01-16");
  });

  it("accepts epoch milliseconds", () => {
    expect(sydneyBusinessDate(Date.parse("2026-10-01T14:30:00Z"))).toBe("2026-10-02");
  });
});
