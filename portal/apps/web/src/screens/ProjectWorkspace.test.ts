import { describe, expect, it } from "vitest";
import { computeBulkDeleteOutcome, deletedAssetClosesLightbox, projectAssetsForRender } from "./ProjectWorkspace";
import { ApiError } from "../lib/api";
import type { WorkspaceAsset } from "../components/PhotoGrid";

function asset(id: string): WorkspaceAsset {
  return { id, collectionId: "c", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-08-25T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

describe("ProjectWorkspace post-delete refresh ordering", () => {
  it("derives passive-RAW membership loss as empty before the body render, while retaining transient data", () => {
    const privateAssets = [asset("private-raw")];
    expect(projectAssetsForRender(privateAssets, new ApiError("membership lost", 403), "raw")).toEqual([]);
    expect(projectAssetsForRender(privateAssets, new ApiError("temporary outage", 500), "raw")).toEqual(privateAssets);
  });

  it("closes the lightbox for either member returned by a floorplan-pair delete", () => {
    expect(deletedAssetClosesLightbox("preview", ["pdf", "preview"])).toBe(true);
    expect(deletedAssetClosesLightbox("other", ["pdf", "preview"])).toBe(false);
    expect(deletedAssetClosesLightbox(null, ["pdf"])).toBe(false);
  });
});

describe("computeBulkDeleteOutcome", () => {
  it("puts a rejected request's own id in failedIds, never in succeededIds", () => {
    // The bug this guards against: an earlier version put every requested id — including
    // rejected ones — into what it called succeededIds, so a real per-item failure was silently
    // reported as success and the user was never told anything was wrong.
    const result = computeBulkDeleteOutcome(
      ["a", "b", "c"],
      [
        { status: "fulfilled", value: { deletedAssetIds: ["a"] } },
        { status: "rejected", reason: new Error("blocked") },
        { status: "fulfilled", value: { deletedAssetIds: ["c"] } },
      ],
    );
    expect(result.succeededIds).toEqual(["a", "c"]);
    expect(result.failedIds).toEqual(["b"]);
  });

  it("credits a floorplan pair's sibling id even though only the primary was requested", () => {
    const result = computeBulkDeleteOutcome(
      ["pdf"],
      [{ status: "fulfilled", value: { deletedAssetIds: ["pdf", "preview"] } }],
    );
    expect(result.succeededIds).toEqual(["pdf", "preview"]);
    expect(result.failedIds).toEqual([]);
  });

  it("counts successful deletes whose Dropbox cleanup failed or lost its claim, but not clean successes", () => {
    const result = computeBulkDeleteOutcome(
      ["a", "b", "c"],
      [
        { status: "fulfilled", value: { deletedAssetIds: ["a"], dropboxOutcome: "removed" } },
        { status: "fulfilled", value: { deletedAssetIds: ["b"], dropboxOutcome: "failed" } },
        { status: "fulfilled", value: { deletedAssetIds: ["c"], dropboxOutcome: "claimLost" } },
      ],
    );
    expect(result.failedIds).toEqual([]);
    expect(result.dropboxCleanupWarnings).toBe(2);
  });

  it("reports nothing succeeded when every request is rejected", () => {
    const result = computeBulkDeleteOutcome(
      ["a", "b"],
      [
        { status: "rejected", reason: new Error("blocked") },
        { status: "rejected", reason: new Error("blocked") },
      ],
    );
    expect(result.succeededIds).toEqual([]);
    expect(result.failedIds).toEqual(["a", "b"]);
  });
});
