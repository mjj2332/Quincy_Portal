import { describe, expect, it } from "vitest";

import {
  EDITOR_INPUT_FOLDER,
  EDITOR_INPUT_NAME_PATTERN,
  EDITOR_OUTPUT_FOLDER,
  EDITOR_OUTPUT_NAME_PATTERN,
  fallbackEditorProjectFolderName,
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

describe("fallbackEditorProjectFolderName", () => {
  const street = "2/20 Sutherland Crescent";
  const suburb = "Darling Point";
  it("restores the original casing from Tonomo's formatted address and keeps Tonomo's numeric suffix", () => {
    expect(fallbackEditorProjectFolderName({
      storedRawFolderPath: "/tonomo/raw files/christian quinlan/17-08-2026/2-20 sutherland cres, darling point nsw 2027, australia 2",
      formattedAddress: "2/20 Sutherland Cres, Darling Point NSW 2027, Australia", street, suburb,
    })).toEqual({ name: "2-20 Sutherland Cres, Darling Point NSW 2027, Australia 2", source: "tonomo_formatted_address" });
    expect(fallbackEditorProjectFolderName({
      storedRawFolderPath: "/tonomo/raw files/christian quinlan/02-09-2026/5-124 francis st, bondi beach nsw 2026, australia (1)",
      formattedAddress: "5/124 Francis St, Bondi Beach NSW 2026, Australia", street: "5/124 Francis Street", suburb: "Bondi Beach",
    }).name).toBe("5-124 Francis St, Bondi Beach NSW 2026, Australia (1)");
  });
  it("falls back to the Project's own address when the formatted address does not match the stored leaf or is absent", () => {
    expect(fallbackEditorProjectFolderName({
      storedRawFolderPath: "/tonomo/raw files/igor melo/24-08-2026/62 edward st, bondi nsw 2026, australia",
      formattedAddress: "Somewhere Else, Bondi NSW 2026, Australia", street: "62 Edward Street", suburb: "Bondi",
    })).toEqual({ name: "62 Edward Street, Bondi", source: "project_address" });
    expect(fallbackEditorProjectFolderName({ storedRawFolderPath: null, formattedAddress: null, street, suburb }).name).toBe("2-20 Sutherland Crescent, Darling Point");
  });
  it("names after the parent when the stored leaf is Listing Images", () => {
    expect(fallbackEditorProjectFolderName({
      storedRawFolderPath: "/Tonomo/Raw Files/Studio/62 edward st, bondi nsw 2026, australia/Listing Images",
      formattedAddress: "62 Edward St, Bondi NSW 2026, Australia", street: "62 Edward Street", suburb: "Bondi",
    }).name).toBe("62 Edward St, Bondi NSW 2026, Australia");
  });
});

