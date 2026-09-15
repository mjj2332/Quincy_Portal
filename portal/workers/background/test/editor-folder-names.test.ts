import { describe, expect, it } from "vitest";

import {
  EDITOR_INPUT_FOLDER,
  EDITOR_INPUT_NAME_PATTERN,
  EDITOR_OUTPUT_FOLDER,
  EDITOR_OUTPUT_NAME_PATTERN,
} from "../src/editor-folders/paths";

describe("Editor Input/Output child folder names", () => {
  it("pins the numbered child names Portal creates", () => {
    expect(EDITOR_INPUT_FOLDER).toBe("0. Input");
    expect(EDITOR_OUTPUT_FOLDER).toBe("1. Output");
  });

  it("recognises both the plain legacy spelling and the numbered spelling for Input", () => {
    expect(EDITOR_INPUT_NAME_PATTERN.test("Input")).toBe(true);
    expect(EDITOR_INPUT_NAME_PATTERN.test("input")).toBe(true);
    expect(EDITOR_INPUT_NAME_PATTERN.test("0. Input")).toBe(true);
    expect(EDITOR_INPUT_NAME_PATTERN.test("Input-backup")).toBe(false);
    expect(EDITOR_INPUT_NAME_PATTERN.test("1. Input")).toBe(false);
    expect(EDITOR_INPUT_NAME_PATTERN.test("0.Input")).toBe(false);
  });

  it("recognises both the plain legacy spelling and the numbered spelling for Output", () => {
    expect(EDITOR_OUTPUT_NAME_PATTERN.test("Output")).toBe(true);
    expect(EDITOR_OUTPUT_NAME_PATTERN.test("1. Output")).toBe(true);
    expect(EDITOR_OUTPUT_NAME_PATTERN.test("0. Output")).toBe(false);
    expect(EDITOR_OUTPUT_NAME_PATTERN.test("Outputs")).toBe(false);
  });
});
