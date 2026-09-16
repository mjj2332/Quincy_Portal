import { describe, expect, it } from "vitest";
import { monitoredRawFolderFromMapping, type EditorFolderMapping } from "../src/lib/editor-folders";

const ROOT = "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St";

function mapping(overrides: Partial<EditorFolderMapping>): EditorFolderMapping {
  return {
    state: "ready",
    rootPath: ROOT,
    inputRoots: [],
    outputRoots: [],
    ...overrides,
  };
}

describe("monitoredRawFolderFromMapping", () => {
  it("exposes nothing for a pending mapping — an unreviewed root cannot be trusted", () => {
    expect(monitoredRawFolderFromMapping(mapping({ state: "pending", inputRoots: [{ path: `${ROOT}/0. Input`, section: null }] }))).toBeNull();
  });

  it("exposes nothing for a needs_review mapping", () => {
    expect(monitoredRawFolderFromMapping(mapping({ state: "needs_review", inputRoots: [{ path: `${ROOT}/0. Input`, section: null }] }))).toBeNull();
  });

  it("returns the single Input root with no extra paths", () => {
    expect(monitoredRawFolderFromMapping(mapping({ inputRoots: [{ path: `${ROOT}/0. Input`, section: null }] }))).toEqual({
      source: "editor_input",
      path: `${ROOT}/0. Input`,
      webUrl: expect.stringContaining("https://www.dropbox.com/home/"),
      extraPaths: [],
    });
  });

  it("prefers the direct 0. Input child over a legacy Day/Input root, which lands in extraPaths", () => {
    const direct = `${ROOT}/0. Input`;
    const legacy = `${ROOT}/11/Input`;
    const result = monitoredRawFolderFromMapping(mapping({ inputRoots: [{ path: legacy, section: "Day" }, { path: direct, section: null }] }));
    expect(result?.path).toBe(direct);
    expect(result?.extraPaths).toEqual([legacy]);
  });

  it("matches the plain 'Input' spelling as a direct child too", () => {
    // A competing legacy root that sorts first alphabetically ("11/Input" < "Input") so this
    // only passes if the plain "Input" spelling is actually recognised as the direct child —
    // a single-root fixture would pass even if the pattern never matched.
    const legacy = `${ROOT}/11/Input`;
    const direct = `${ROOT}/Input`;
    const result = monitoredRawFolderFromMapping(mapping({ inputRoots: [{ path: legacy, section: "Day" }, { path: direct, section: null }] }));
    expect(result?.path).toBe(direct);
    expect(result?.extraPaths).toEqual([legacy]);
  });

  it("returns null when a ready mapping has no input roots — fail closed", () => {
    expect(monitoredRawFolderFromMapping(mapping({ inputRoots: [] }))).toBeNull();
  });

  it("does not throw when an input root path is unsafe", () => {
    expect(() => monitoredRawFolderFromMapping(mapping({ inputRoots: [{ path: "not/../a/safe/path", section: null }] }))).not.toThrow();
  });

  it("falls back to the first root sorted by path when none sits directly under rootPath", () => {
    const first = `${ROOT}/11/Input`;
    const second = `${ROOT}/12/Input`;
    const result = monitoredRawFolderFromMapping(mapping({ inputRoots: [{ path: second, section: "Day" }, { path: first, section: "Day" }] }));
    expect(result?.path).toBe(first);
    expect(result?.extraPaths).toEqual([second]);
  });

  it("sorts extraPaths by path with three or more roots, excluding only the primary", () => {
    const direct = `${ROOT}/0. Input`;
    const legacyA = `${ROOT}/12/Input`;
    const legacyB = `${ROOT}/11/Input`;
    const legacyC = `${ROOT}/13/Input`;
    const result = monitoredRawFolderFromMapping(mapping({
      inputRoots: [
        { path: legacyA, section: "Day" },
        { path: direct, section: null },
        { path: legacyC, section: "Day" },
        { path: legacyB, section: "Day" },
      ],
    }));
    expect(result?.path).toBe(direct);
    expect(result?.extraPaths).toEqual([legacyB, legacyA, legacyC]);
  });
});
