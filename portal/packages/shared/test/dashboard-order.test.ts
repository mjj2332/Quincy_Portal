import { describe, expect, it } from "vitest";
import { compareByStreetThenId } from "../src/dashboard-order";

describe("compareByStreetThenId", () => {
  it("sorts by en-AU street collation, then by relational id comparison", () => {
    const rows = [
      { id: "z", street: "10 King Street" },
      { id: "a", street: "10 King Street" },
      { id: "accent", street: "10 Élan Street" },
      { id: "other", street: "2 Apple Street" },
    ];
    const ordered = [...rows].sort(compareByStreetThenId);
    expect(ordered.map((row) => row.id)).toEqual(["accent", "a", "z", "other"]);
    expect(compareByStreetThenId({ street: "Same", id: "2" }, { street: "Same", id: "10" })).toBe(1);
    expect(compareByStreetThenId({ street: "Same", id: "10" }, { street: "Same", id: "2" })).toBe(-1);
  });
});
