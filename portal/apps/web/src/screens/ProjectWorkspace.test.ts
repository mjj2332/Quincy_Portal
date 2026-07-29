import { describe, expect, it, vi } from "vitest";
import { computeBulkDeleteOutcome, deletedAssetClosesLightbox, refreshAfterAssetDelete } from "./ProjectWorkspace";

describe("ProjectWorkspace post-delete refresh ordering", () => {
  it("keeps deletion result handling alive when an unrelated refresh aborts", async () => {
    const aborted = Object.assign(new Error("superseded"), { name: "AbortError" });
    const refreshAssets = vi.fn(async () => { throw aborted; });
    const refreshProject = vi.fn(async () => undefined);
    await expect(refreshAfterAssetDelete(refreshAssets, refreshProject)).resolves.toBeUndefined();
    expect(refreshAssets).toHaveBeenCalledOnce(); expect(refreshProject).toHaveBeenCalledOnce();
  });

  it("surfaces a genuine failure from either independent refresh", async () => {
    const failure = new Error("refresh failed");
    await expect(refreshAfterAssetDelete(async () => { throw failure; }, async () => undefined)).rejects.toBe(failure);
    await expect(refreshAfterAssetDelete(async () => undefined, async () => { throw failure; })).rejects.toBe(failure);
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
