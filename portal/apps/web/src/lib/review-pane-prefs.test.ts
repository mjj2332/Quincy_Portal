import { describe, expect, it } from "vitest";
import { REVIEW_PANE_KEY, normalizeReviewPane } from "./review-pane-prefs";
import { readUiPref, writeUiPref, type UiPrefStorage } from "./ui-prefs";

const memoryStorage = (): UiPrefStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
};

describe("review pane prefs (#859, #881)", () => {
  it("keeps one browser-wide key", () => {
    expect(REVIEW_PANE_KEY).toBe("quincy:ui:review-notes-pane");
  });
  it("reads anything that is not a pane object as never chosen, at 380", () => {
    for (const junk of [null, undefined, "x", 3, [], NaN, { open: "yes", width: "wide" }, { width: NaN }, { open: 1 }]) expect(normalizeReviewPane(junk)).toEqual({ open: null, width: 380 });
  });
  it("keeps a remembered choice, and rounds and clamps a stored width to 300–560", () => {
    expect(normalizeReviewPane({ open: false, width: 400.4 })).toEqual({ open: false, width: 400 });
    expect(normalizeReviewPane({ open: true, width: 10 })).toEqual({ open: true, width: 300 });
    expect(normalizeReviewPane({ open: true, width: 9999 })).toEqual({ open: true, width: 560 });
    expect(normalizeReviewPane({ open: true, width: Infinity })).toEqual({ open: true, width: 380 });
    expect(normalizeReviewPane({ open: null, width: 420 })).toEqual({ open: null, width: 420 });
  });
  it("round-trips through the stored JSON, a never-chosen state included", () => {
    const storage = memoryStorage();
    writeUiPref(REVIEW_PANE_KEY, { open: null, width: 450 }, normalizeReviewPane, storage);
    expect(readUiPref(REVIEW_PANE_KEY, normalizeReviewPane, storage)).toEqual({ open: null, width: 450 });
    writeUiPref(REVIEW_PANE_KEY, { open: false, width: 450 }, normalizeReviewPane, storage);
    expect(JSON.parse(storage.values.get(REVIEW_PANE_KEY)!)).toEqual({ open: false, width: 450 });
    expect(readUiPref(REVIEW_PANE_KEY, normalizeReviewPane, storage)).toEqual({ open: false, width: 450 });
  });
  it("falls back to the defaults for corrupt JSON and a storage that throws", () => {
    const storage = memoryStorage();
    storage.values.set(REVIEW_PANE_KEY, "{{{not json");
    expect(readUiPref(REVIEW_PANE_KEY, normalizeReviewPane, storage)).toEqual({ open: null, width: 380 });
    const throwing: UiPrefStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readUiPref(REVIEW_PANE_KEY, normalizeReviewPane, throwing)).toEqual({ open: null, width: 380 });
  });
});
