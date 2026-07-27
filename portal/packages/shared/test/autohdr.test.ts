import { describe, expect, it } from "vitest";
import { computeRemovalAssetIds } from "../src/autohdr";

describe("computeRemovalAssetIds", () => {
  it("uses sent-file provenance and excludes current filename collisions", () => {
    expect(computeRemovalAssetIds(
      [
        { assetId: "old-a", dropboxPathKey: "/autohdr/job/a.jpg" },
        { assetId: "old-b", dropboxPathKey: "/autohdr/job/b.jpg" },
        { assetId: "old-c", dropboxPathKey: "/autohdr/job/c.jpg" },
      ],
      [
        { assetId: "new-b", filename: "B.jpg" },
        { assetId: "old-c", filename: "c.jpg" },
      ],
    )).toEqual(["old-a"]);
  });

  it("returns a stable empty set for a pure superset", () => {
    expect(computeRemovalAssetIds(
      [{ assetId: "a", dropboxPathKey: "/autohdr/job/a.jpg" }],
      [{ assetId: "a", filename: "a.jpg" }, { assetId: "b", filename: "b.jpg" }],
    )).toEqual([]);
  });
});
