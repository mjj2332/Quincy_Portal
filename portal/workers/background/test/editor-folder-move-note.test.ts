import { describe, expect, it } from "vitest";
import { formatMoveNote, parseMoveNote } from "../src/editor-folders/move-note";

describe("move note format", () => {
  it("round-trips a code and a detail that itself contains the separator", () => {
    const note = formatMoveNote("editor_folder_move_stuck", "Last failure: UNIQUE constraint failed: x");
    expect(parseMoveNote(note)).toEqual({ code: "editor_folder_move_stuck", detail: "Last failure: UNIQUE constraint failed: x" });
  });

  it("treats a note with no separator as a bare code", () => {
    expect(parseMoveNote("editor_folder_move_refused")).toEqual({ code: "editor_folder_move_refused", detail: "editor_folder_move_refused" });
  });
});
