import { describe, expect, it } from "vitest";
import { computeSheetVisible } from "./ProjectQuickDetailSheet";

function documentLike(visibilityState: DocumentVisibilityState, focused: boolean) {
  return { visibilityState, hasFocus: () => focused };
}

describe("computeSheetVisible", () => {
  it("rejects a hidden document", () => {
    expect(computeSheetVisible(documentLike("hidden", true), true)).toBe(false);
  });

  it("rejects a sheet covered by a nested modal", () => {
    expect(computeSheetVisible(documentLike("visible", true), false)).toBe(false);
  });

  it("rejects a visible but unfocused document", () => {
    expect(computeSheetVisible(documentLike("visible", false), true)).toBe(false);
  });

  it("accepts a visible, focused, topmost sheet", () => {
    expect(computeSheetVisible(documentLike("visible", true), true)).toBe(true);
  });
});
