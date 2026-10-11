import { describe, expect, it } from "vitest";
import { createCompareStore, offsetOf } from "./video-compare-store";

describe("compare store dropVersion (#776 E)", () => {
  it("closes the open pair when either side is the removed Version", () => {
    const a = createCompareStore("p"); a.setPair("v3", "v2"); a.dropVersion("v3");
    expect(a.getState().pair).toBeNull();
    const b = createCompareStore("p"); b.setPair("v3", "v2"); b.dropVersion("v2");
    expect(b.getState().pair).toBeNull();
  });

  it("keeps an open pair that does not involve it", () => {
    const s = createCompareStore("p"); s.setPair("v3", "v2"); s.dropVersion("v1");
    expect(s.getState().pair).toEqual({ a: "v3", b: "v2" });
  });

  it("forgets every remembered offset of a pair that involved it, and only those", () => {
    const s = createCompareStore("p");
    s.setPair("v3", "v2"); s.setOffset(12);
    s.setPair("v3", "v1"); s.setOffset(-4);
    s.setPair("v2", "v1"); s.setOffset(7);
    s.dropVersion("v3");
    expect(Object.keys(s.getState().offsets)).toEqual(["v2:v1"]);
    s.setPair("v3", "v2");
    expect(offsetOf(s.getState())).toBe(0);
    s.setPair("v2", "v1");
    expect(offsetOf(s.getState())).toBe(7);
  });
});
