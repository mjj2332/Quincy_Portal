import { describe, expect, it } from "vitest";

import { EDITOR_ROOT } from "../src/editor-folders/paths";
import { editorMoveTarget, rebaseEditorPath } from "../src/editor-folders/move-paths";

describe("editorMoveTarget", () => {
  const mapping = (rootPath: string, shootDate: string) => ({ rootPath, shootDate });

  it("returns null when the Project has no shoot date drift", () => {
    const root = `${EDITOR_ROOT}/2026-10 October/02/Project`;
    expect(editorMoveTarget(mapping(root, "2026-10-02"), "2026-10-02")).toBeNull();
  });

  it("returns null when the Project's shoot date is missing or not a real calendar date", () => {
    const root = `${EDITOR_ROOT}/2026-10 October/02/Project`;
    expect(editorMoveTarget(mapping(root, "2026-10-02"), null)).toBeNull();
    expect(editorMoveTarget(mapping(root, "2026-10-02"), "Thursday, 15 Jan, 2027")).toBeNull();
    expect(editorMoveTarget(mapping(root, "2026-10-02"), "2026-02-30")).toBeNull();
  });

  it("computes the move target when the current root sits under the day folder its own shoot date derives to", () => {
    const root = `${EDITOR_ROOT}/2026-10 October/02/Project`;
    const result = editorMoveTarget(mapping(root, "2026-10-02"), "2027-01-15");
    expect(result).toEqual({
      kind: "move",
      previous: "2026-10-02",
      next: "2027-01-15",
      targetPath: `${EDITOR_ROOT}/2027-01 January/15/Project`,
      targetPathKey: `${EDITOR_ROOT}/2027-01 january/15/project`.toLowerCase(),
    });
  });

  it("keeps the leaf name exactly as it appears on the current root, including mixed case", () => {
    const root = `${EDITOR_ROOT}/09. September/01/72 Victoria St, Paddington NSW 2021, Australia`;
    const result = editorMoveTarget(mapping(root, "2026-09-01"), "2026-09-05");
    expect(result).toMatchObject({
      kind: "move",
      targetPath: `${EDITOR_ROOT}/09. September/05/72 Victoria St, Paddington NSW 2021, Australia`,
    });
  });

  it("treats a parent that only differs in case from the derived day folder as standard", () => {
    const root = `${EDITOR_ROOT}/09. SEPTEMBER/01/Project`;
    const result = editorMoveTarget(mapping(root, "2026-09-01"), "2026-09-05");
    expect(result).toMatchObject({ kind: "move", targetPath: `${EDITOR_ROOT}/09. September/05/Project` });
  });

  it("blocks with nonstandard_parent when the root's parent is not the day folder its own shoot date derives to", () => {
    const root = `${EDITOR_ROOT}/09. September/05/Project`;
    const result = editorMoveTarget(mapping(root, "2026-09-01"), "2026-10-02");
    expect(result).toEqual({
      kind: "nonstandard_parent",
      expectedDayPath: `${EDITOR_ROOT}/09. September/01`,
      currentParent: `${EDITOR_ROOT}/09. September/05`,
    });
  });

  it("blocks with nonstandard_parent for a legacy root that never sat under a month/day pair at all", () => {
    const root = `${EDITOR_ROOT}/Legacy Folder/Project`;
    const result = editorMoveTarget(mapping(root, "2026-09-01"), "2026-10-02");
    expect(result).toEqual({
      kind: "nonstandard_parent",
      expectedDayPath: `${EDITOR_ROOT}/09. September/01`,
      currentParent: `${EDITOR_ROOT}/Legacy Folder`,
    });
  });
});

describe("rebaseEditorPath", () => {
  const oldRoot = `${EDITOR_ROOT}/09. September/01/Project`;
  const newRoot = `${EDITOR_ROOT}/09. September/05/Project`;

  it("rebases the root itself", () => {
    expect(rebaseEditorPath(oldRoot, oldRoot, newRoot)).toBe(newRoot);
  });

  it("rebases a descendant, preserving the remainder's own casing", () => {
    expect(rebaseEditorPath(`${oldRoot}/0. Input/Photo.JPG`, oldRoot, newRoot)).toBe(`${newRoot}/0. Input/Photo.JPG`);
  });

  it("matches by path key even when the supplied path's casing differs from oldRoot's", () => {
    const differentlyCased = `${EDITOR_ROOT.toUpperCase()}/09. SEPTEMBER/01/PROJECT/Sub/File.jpg`;
    expect(rebaseEditorPath(differentlyCased, oldRoot, newRoot)).toBe(`${newRoot}/Sub/File.jpg`);
  });

  it("requires an exact '/' boundary, not just a string prefix", () => {
    const sibling = `${EDITOR_ROOT}/09. September/01/Project 2/file.jpg`;
    expect(rebaseEditorPath(sibling, oldRoot, newRoot)).toBeNull();
  });

  it("returns null for a path outside the old root entirely", () => {
    expect(rebaseEditorPath(`${EDITOR_ROOT}/09. September/01/Other/file.jpg`, oldRoot, newRoot)).toBeNull();
  });

  it("preserves special characters in the remainder: %, _, apostrophes and non-ASCII", () => {
    const path = `${oldRoot}/0. Input/50% Off_Client's café.jpg`;
    expect(rebaseEditorPath(path, oldRoot, newRoot)).toBe(`${newRoot}/0. Input/50% Off_Client's café.jpg`);
  });

  it("slices by segment count rather than string length, so a longer new root still works", () => {
    const longerNewRoot = `${EDITOR_ROOT}/2027-01 January/15/A Much Longer Project Name Than Before`;
    expect(rebaseEditorPath(`${oldRoot}/1. Output/final.jpg`, oldRoot, longerNewRoot)).toBe(`${longerNewRoot}/1. Output/final.jpg`);
  });
});
