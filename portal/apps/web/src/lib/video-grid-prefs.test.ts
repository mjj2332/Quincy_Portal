import { describe, expect, it } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { arrangeVideos, GRID_COLUMNS, DEFAULT_VIDEO_GRID_PREFS, normalizeVideoGridPrefs, videoGridKey, type VideoGridPrefs } from "./video-grid-prefs";

const video = (id: string, title: string, status: VideoDto["reviewStatus"], current: string, older = "2026-01-01T00:00:00.000Z"): VideoDto => ({
  id, title, reviewStatus: status,
  versions: [{ assetId: `${id}-2`, version: 2, current: true, createdAt: current }, { assetId: `${id}-1`, version: 1, current: false, createdAt: older }],
}) as unknown as VideoDto;
const prefs = (over: Partial<VideoGridPrefs>): VideoGridPrefs => ({ ...DEFAULT_VIDEO_GRID_PREFS, ...over });
const ids = (list: VideoDto[]) => list.map((v) => v.id);

describe("normalizeVideoGridPrefs", () => {
  it("defaults: Medium, Fit, info on, upload date newest first, all statuses", () => {
    expect(normalizeVideoGridPrefs(undefined)).toEqual({ size: "M", thumb: "fit", info: true, sort: "uploaded", dir: "desc", status: "all" });
  });
  it("keeps the good fields when one is junk", () => {
    expect(normalizeVideoGridPrefs({ size: "XL", thumb: "fill", info: "yes", sort: "name", dir: "asc", status: "published" }))
      .toEqual({ size: "M", thumb: "fill", info: true, sort: "name", dir: "asc", status: "published" });
  });
  it.each([null, 7, "x", []])("falls back to defaults for %j", (raw) => {
    expect(normalizeVideoGridPrefs(raw)).toEqual(DEFAULT_VIDEO_GRID_PREFS);
  });
  it("keys per user", () => { expect(videoGridKey("u1")).toBe("quincy:ui:video-grid:u1"); });
});

describe("GRID_COLUMNS", () => {
  it("is S 240, M 320 (the size before the toolbar), L 480 minimum px", () => {
    expect(GRID_COLUMNS.S).toContain("min(240px,100%)");
    expect(GRID_COLUMNS.M).toContain("min(320px,100%)");
    expect(GRID_COLUMNS.L).toContain("min(480px,100%)");
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
