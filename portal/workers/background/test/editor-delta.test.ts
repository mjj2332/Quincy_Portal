import { describe, expect, it } from "vitest";
import { changedEditorProjectIds } from "../src/editor-folders/delta";
import type { DropboxEntry } from "../src/dropbox/client";

const root = "/Editor/01_ACTIVE EDITS/09. September/01/Example";
const mappings = [{ projectId: "p1", inputRoots: [{ path: `${root}/Input` }], outputRoots: [{ path: `${root}/Output` }] }];
const file = (path: string): DropboxEntry => ({ ".tag": "file", id: path, name: path.split("/").at(-1)!, size: 1, path_lower: path.toLowerCase() });

describe("Editor delta scope", () => {
  it("routes Input DNG and Output JPEG once per Project", () => {
    expect(changedEditorProjectIds([file(`${root}/Input/extra/a.DNG`), file(`${root}/Output/a.jpg`)], mappings)).toEqual(["p1"]);
  });
  it("ignores notes, wrong path prefixes, Output DNG and Portal echoes", () => {
    expect(changedEditorProjectIds([
      file(`${root}/Editing Notes/a.jpg`), file(`${root}/Input-backup/a.jpg`),
      file(`${root}/Output/a.dng`), file(`${root}/Input/Manual-Uploads/asset/a.jpg`),
      file(`${root}/Output/Manual-Uploads/asset/a.jpg`), file(`${root}/Input/a.xmp`),
    ], mappings)).toEqual([]);
  });
  it("does not delete Portal assets when a Dropbox entry disappears", () => {
    expect(changedEditorProjectIds([{ ".tag": "deleted", path_lower: `${root}/input/a.jpg`.toLowerCase() }], mappings)).toEqual([]);
  });
});
