import { describe, expect, it } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { arrangeVideos, GRID_CLASS, DEFAULT_VIDEO_GRID_PREFS, headerSort, NATURAL_DIR, normalizeVideoGridPrefs, videoGridKey, type VideoGridPrefs } from "./video-grid-prefs";

const video = (id: string, title: string, status: VideoDto["reviewStatus"], current: string, older = "2026-01-01T00:00:00.000Z"): VideoDto => ({
  id, title, reviewStatus: status,
  versions: [{ assetId: `${id}-2`, version: 2, current: true, createdAt: current }, { assetId: `${id}-1`, version: 1, current: false, createdAt: older }],
}) as unknown as VideoDto;
const prefs = (over: Partial<VideoGridPrefs>): VideoGridPrefs => ({ ...DEFAULT_VIDEO_GRID_PREFS, ...over });
const ids = (list: VideoDto[]) => list.map((v) => v.id);

describe("normalizeVideoGridPrefs", () => {
  it("defaults: upload date newest first, all statuses", () => {
    expect(normalizeVideoGridPrefs(undefined)).toEqual({ sort: "uploaded", dir: "desc", status: "all", layout: "tiles" });
  });
  it("keeps the good fields when one is junk", () => {
    expect(normalizeVideoGridPrefs({ sort: "name", dir: "sideways", status: "published" }))
      .toEqual({ sort: "name", dir: "desc", status: "published", layout: "tiles" });
  });
  it("ignores the old Appearance keys (size, thumb, info) a browser may still hold (#884)", () => {
    expect(normalizeVideoGridPrefs({ size: "L", thumb: "fill", info: false, sort: "name", dir: "asc", status: "all" })).toEqual({ sort: "name", dir: "asc", status: "all", layout: "tiles" });
  });
  it("round-trips the list layout (#938)", () => {
    expect(normalizeVideoGridPrefs({ sort: "status", dir: "asc", status: "in_review", layout: "rows" })).toEqual({ sort: "status", dir: "asc", status: "in_review", layout: "rows" });
  });
  it("a junk layout falls back to tiles and keeps sort, direction and status (#938)", () => {
    expect(normalizeVideoGridPrefs({ sort: "name", dir: "asc", status: "published", layout: "masonry" })).toEqual({ sort: "name", dir: "asc", status: "published", layout: "tiles" });
  });
  it("starts each sort key in the direction it reads naturally (moved here from the toolbar for #939's header sort)", () => {
    expect(NATURAL_DIR).toEqual({ uploaded: "desc", name: "asc", status: "asc" });
  });
  it.each([null, 7, "x", []])("falls back to defaults for %j", (raw) => {
    expect(normalizeVideoGridPrefs(raw)).toEqual(DEFAULT_VIDEO_GRID_PREFS);
  });
  it("keys per user", () => { expect(videoGridKey("u1")).toBe("quincy:ui:video-grid:u1"); });
});

describe("GRID_CLASS", () => {
  it("is as many columns as fit at 280px minimum, and one column on a phone (D26)", () => {
    expect(GRID_CLASS).toContain("min(280px,100%)");
    expect(GRID_CLASS).toContain("max-[721px]:grid-cols-1");
  });
});

describe("arrangeVideos", () => {
  const list = [
    video("a", "Film 10", "published", "2026-10-01T00:00:00.000Z"),
    video("b", "Film 2", "in_review", "2026-10-03T00:00:00.000Z"),
    video("c", "film 1", "approved_internal", "2026-10-02T00:00:00.000Z"),
    video("d", "Zed", "in_review", "2026-10-02T12:00:00.000Z", "2026-12-31T00:00:00.000Z"),
  ];
  it("uploaded newest first by the latest live Version's date, not an older Version's", () => {
    expect(ids(arrangeVideos(list, prefs({})))).toEqual(["b", "d", "c", "a"]);
  });
  it("uploaded oldest first", () => { expect(ids(arrangeVideos(list, prefs({ dir: "asc" })))).toEqual(["a", "c", "d", "b"]); });
  it("name sorts numerically and case-insensitively", () => {
    expect(ids(arrangeVideos(list, prefs({ sort: "name", dir: "asc" })))).toEqual(["c", "b", "a", "d"]);
    expect(ids(arrangeVideos(list, prefs({ sort: "name", dir: "desc" })))).toEqual(["d", "a", "b", "c"]);
  });
  it("status: In review, Approved (internal), Published, ties newest first", () => {
    expect(ids(arrangeVideos(list, prefs({ sort: "status", dir: "asc" })))).toEqual(["b", "d", "c", "a"]);
    expect(ids(arrangeVideos(list, prefs({ sort: "status", dir: "desc" })))).toEqual(["a", "c", "b", "d"]);
  });
  it("filters on the derived Review status only", () => {
    expect(ids(arrangeVideos(list, prefs({ status: "in_review" })))).toEqual(["b", "d"]);
    expect(ids(arrangeVideos(list, prefs({ status: "published" })))).toEqual(["a"]);
  });
  it("never mutates its input", () => {
    const before = ids(list);
    arrangeVideos(list, prefs({ sort: "name" }));
    expect(ids(list)).toEqual(before);
  });
});

describe("headerSort (#939, S13)", () => {
  it("a header for another key picks that key in the direction it reads naturally, whatever the current direction", () => {
    expect(headerSort(prefs({ sort: "uploaded", dir: "desc" }), "name")).toEqual(prefs({ sort: "name", dir: "asc" }));
    expect(headerSort(prefs({ sort: "name", dir: "desc" }), "uploaded")).toEqual(prefs({ sort: "uploaded", dir: "desc" }));
    expect(headerSort(prefs({ sort: "name", dir: "asc" }), "status")).toEqual(prefs({ sort: "status", dir: "asc" }));
  });
  it("the header of the current key flips its direction, both ways, and never clears the sort", () => {
    expect(headerSort(prefs({ sort: "name", dir: "asc" }), "name")).toEqual(prefs({ sort: "name", dir: "desc" }));
    expect(headerSort(prefs({ sort: "name", dir: "desc" }), "name")).toEqual(prefs({ sort: "name", dir: "asc" }));
    expect(headerSort(prefs({ sort: "uploaded", dir: "desc" }), "uploaded")).toEqual(prefs({ sort: "uploaded", dir: "asc" }));
  });
  it("keeps the filter and the layout", () => {
    expect(headerSort(prefs({ status: "published", layout: "rows" }), "name")).toEqual({ sort: "name", dir: "asc", status: "published", layout: "rows" });
  });
});
