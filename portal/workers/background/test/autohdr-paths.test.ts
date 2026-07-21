import { describe, expect, it } from "vitest";
import { autoHdrFinalPathCandidates, autoHdrRawInputPath, deriveAutoHdrFolderName, reconstructSourcePath } from "../src/autohdr/paths";

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

  it("rejects paths without a parent segment", () => {
    expect(() => deriveAutoHdrFolderName("")).toThrow("Cannot derive AutoHDR folder name from RAW folder path: ");
    expect(() => deriveAutoHdrFolderName("Listing Images")).toThrow("Cannot derive AutoHDR folder name from RAW folder path: Listing Images");
  });

  it("builds the required AutoHDR input path", () => {
    expect(autoHdrRawInputPath("123 Main St")).toBe("/AutoHDR/123 Main St/01-RAW-Photos");
  });

  it("reconstructs root and sectioned Dropbox source paths", () => {
    expect(reconstructSourcePath(mcGowenRawPath, null, "DSC_0001.CR3")).toBe(`${mcGowenRawPath}/DSC_0001.CR3`);
    expect(reconstructSourcePath(mcGowenRawPath, "Premium", "DSC_0002.CR3")).toBe(`${mcGowenRawPath}/Premium/DSC_0002.CR3`);
    expect(reconstructSourcePath(`${mcGowenRawPath}///`, null, "DSC_0003.CR3")).toBe(`${mcGowenRawPath}/DSC_0003.CR3`);
  });

  it("builds final-folder candidates in priority order", () => {
    expect(autoHdrFinalPathCandidates("123 Main St")).toEqual([
      "/AutoHDR/123 Main St/04-FINAL-Photos",
      "/AutoHDR/123 Main St/04-FINALS-Photos",
    ]);
  });
});
