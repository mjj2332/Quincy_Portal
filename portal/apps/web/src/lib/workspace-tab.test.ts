import { describe, expect, it } from "vitest";
import { availableCollectionTabs, resolveArrivalTab } from "./workspace-tab";

describe("#337 availableCollectionTabs", () => {
  it("offers every Collection to a role that can view Edited, and only RAW otherwise", () => {
    expect(availableCollectionTabs(true, new Set())).toEqual(["raw", "edited", "video", "floorplan", "copy"]);
    expect(availableCollectionTabs(false, new Set())).toEqual(["raw"]);
  });

  it("drops a denied Collection", () => {
    expect(availableCollectionTabs(true, new Set(["edited", "copy"]))).toEqual(["raw", "video", "floorplan"]);
    expect(availableCollectionTabs(false, new Set(["raw"]))).toEqual([]);
  });
});

describe("#337 resolveArrivalTab", () => {
  it("keeps an available tab", () => {
    expect(resolveArrivalTab("raw", true, new Set())).toBe("raw");
    expect(resolveArrivalTab("edited", true, new Set())).toBe("edited");
    expect(resolveArrivalTab("raw", false, new Set())).toBe("raw");
    expect(resolveArrivalTab("collaboration", false, new Set())).toBe("collaboration");
  });

  it("falls back to Collaboration when the role cannot see the tab", () => {
    expect(resolveArrivalTab("edited", false, new Set())).toBe("collaboration");
    expect(resolveArrivalTab("video", false, new Set())).toBe("collaboration");
  });

  it("falls back to Collaboration when the tab has been denied", () => {
    expect(resolveArrivalTab("edited", true, new Set(["edited"]))).toBe("collaboration");
    expect(resolveArrivalTab("raw", true, new Set(["raw"]))).toBe("collaboration");
  });
});
