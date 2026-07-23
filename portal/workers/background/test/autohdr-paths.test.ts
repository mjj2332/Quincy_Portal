import { describe, expect, it } from "vitest";
import { autoHdrFinalPathCandidates, autoHdrManualUploadPath, autoHdrRawInputPath, deriveAutoHdrFolderName, reconstructSourcePath } from "../src/autohdr/paths";

describe("AutoHDR paths", () => {
  const mcGowenRawPath = "/Projects/4 McGowen Ave, Malabar NSW 2036, Australia/Listing Images";

  it("derives the listing address from a RAW folder path", () => {
    expect(deriveAutoHdrFolderName(mcGowenRawPath)).toBe("4 McGowen Ave, Malabar NSW 2036, Australia");
  });

  it("ignores a trailing slash", () => {
    expect(deriveAutoHdrFolderName(`${mcGowenRawPath}/`)).toBe("4 McGowen Ave, Malabar NSW 2036, Australia");
  });

  it("normalises backslashes and duplicate slashes", () => {
    expect(deriveAutoHdrFolderName("\\Projects\\\\123 Main St\\Listing Images")).toBe("123 Main St");
  });

  it("strips the local Dropbox mount path", () => {
    expect(deriveAutoHdrFolderName("/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Clients/123 Main St/Listing Images")).toBe("123 Main St");
  });

  it("uses the last segment for direct Tonomo RAW folder paths, including a trailing slash", () => {
    expect(deriveAutoHdrFolderName("/Tonomo/123 Main St, Malabar NSW/")).toBe("123 Main St, Malabar NSW");
  });

  it("normalises a direct Windows Tonomo path while preserving final-segment casing", () => {
    expect(deriveAutoHdrFolderName("\\Tonomo\\123 Main St, MALABAR NSW")).toBe("123 Main St, MALABAR NSW");
  });

  it("uses the parent only when the final segment is the Listing Images marker", () => {
    expect(deriveAutoHdrFolderName("/Projects/123 Main St/LISTING IMAGES")).toBe("123 Main St");
  });

  it("rejects empty paths and a lone Listing Images marker", () => {
    expect(() => deriveAutoHdrFolderName("")).toThrow("Cannot derive AutoHDR folder name from RAW folder path: ");
    expect(() => deriveAutoHdrFolderName("Listing Images")).toThrow("Cannot derive AutoHDR folder name from RAW folder path: Listing Images");
  });

  it("builds the required AutoHDR input path", () => {
    expect(autoHdrRawInputPath("123 Main St")).toBe("/AutoHDR/123 Main St/01-RAW-Photos");
  });

  it("reconstructs root and one/two-level sectioned Dropbox source paths", () => {
    expect(reconstructSourcePath(mcGowenRawPath, null, "DSC_0001.CR3")).toBe(`${mcGowenRawPath}/DSC_0001.CR3`);
    expect(reconstructSourcePath(mcGowenRawPath, "Premium", "DSC_0002.CR3")).toBe(`${mcGowenRawPath}/Premium/DSC_0002.CR3`);
    expect(reconstructSourcePath(mcGowenRawPath, "Kitchen/Day", "DSC_0003.CR3")).toBe(`${mcGowenRawPath}/Kitchen/Day/DSC_0003.CR3`);
    expect(reconstructSourcePath(`${mcGowenRawPath}///`, null, "DSC_0004.CR3")).toBe(`${mcGowenRawPath}/DSC_0004.CR3`);
  });

  it("refuses malformed legacy paths that could escape the configured RAW folder", () => {
    expect(reconstructSourcePath(mcGowenRawPath, "../Other", "DSC_0001.CR3")).toBe("");
    expect(reconstructSourcePath(mcGowenRawPath, "Kitchen/../Other", "DSC_0001.CR3")).toBe("");
    expect(reconstructSourcePath(mcGowenRawPath, "Kitchen//Day", "DSC_0001.CR3")).toBe("");
    expect(reconstructSourcePath(mcGowenRawPath, "Kitchen", "../DSC_0001.CR3")).toBe("");
    expect(reconstructSourcePath("/Projects/../Other", null, "DSC_0001.CR3")).toBe("");
    expect(reconstructSourcePath("", null, "DSC_0001.CR3")).toBe("");
  });

  it("builds an immutable per-asset manual-upload destination", () => {
    expect(autoHdrManualUploadPath("123 Main St", "11111111-1111-4111-8111-111111111111", "edited final.jpg"))
      .toBe("/AutoHDR/123 Main St/Manual-Uploads/11111111-1111-4111-8111-111111111111/edited final.jpg");
    expect(() => autoHdrManualUploadPath("123 Main St", "not-an-id", "edited.jpg")).toThrow("Invalid manual upload path segment");
    expect(() => autoHdrManualUploadPath("123 Main St", "11111111-1111-4111-8111-111111111111", "nested/edited.jpg")).toThrow("Invalid manual upload path segment");
    expect(() => autoHdrManualUploadPath("../escape", "11111111-1111-4111-8111-111111111111", "edited.jpg")).toThrow("Invalid manual upload path segment");
    expect(() => autoHdrManualUploadPath("123 Main St", "11111111-1111-4111-8111-111111111111", "../edited.jpg")).toThrow("Invalid manual upload path segment");
  });
  it("builds final-folder candidates in priority order", () => {
    expect(autoHdrFinalPathCandidates("123 Main St")).toEqual([
      "/AutoHDR/123 Main St/04-FINAL-Photos",
      "/AutoHDR/123 Main St/04-FINALS-Photos",
    ]);
  });
});
