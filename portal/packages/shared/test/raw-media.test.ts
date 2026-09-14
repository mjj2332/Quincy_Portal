import { describe, expect, it } from "vitest";
import {
  DNG_CONTENT_TYPE,
  dngPreviewKey,
  isDngFilename,
  isRawMediaFilename,
  rawMediaContentType,
} from "../src/raw-media";

describe("raw media contracts", () => {
  it("recognises only complete DNG extensions and assigns source MIME from the filename", () => {
    expect(isDngFilename("capture.DNG")).toBe(true);
    expect(isDngFilename("capture.dng.tmp")).toBe(false);
    expect(isDngFilename("capture.dng.backup")).toBe(false);
    expect(rawMediaContentType("capture.DNG")).toBe(DNG_CONTENT_TYPE);
    expect(rawMediaContentType("capture.JPG")).toBe("image/jpeg");
    expect(rawMediaContentType("capture.jpeg")).toBe("image/jpeg");
    expect(rawMediaContentType("capture.nef")).toBeNull();
    expect(isRawMediaFilename("capture.DNG")).toBe(true);
    expect(isRawMediaFilename("capture.nef")).toBe(false);
  });

  it("derives a deterministic preview key under the original project prefix", () => {
    const original = "projects/project-1/raw/dropbox/hash/capture.DNG";
    expect(dngPreviewKey(original)).toBe(`${original}.preview.jpg`);
    expect(dngPreviewKey(original)).toBe(dngPreviewKey(original));
    expect(dngPreviewKey(original)).toMatch(/^projects\/project-1\//);
    expect(() => dngPreviewKey("bad\0key")).toThrow("invalid");
  });
});
