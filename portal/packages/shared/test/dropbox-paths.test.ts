import { describe, expect, it } from "vitest";
import { deriveAutoHdrFolderName, dropboxHomeUrl, normalisePath, rawFolderGate } from "../src/dropbox-paths";

describe("rawFolderGate", () => {
  it("names the AutoHDR folder when a usable RAW folder path is configured", () => {
    expect(rawFolderGate("/Tonomo/Raw Files/12 Example St", null)).toEqual({ ok: true, folderName: "12 Example St" });
  });

  it("looks past a Listing Images leaf to the shoot folder", () => {
    expect(rawFolderGate("/Tonomo/Raw Files/12 Example St/Listing Images", null)).toEqual({ ok: true, folderName: "12 Example St" });
  });

  it("defers a link-only project to the background worker, which alone can resolve it", () => {
    expect(rawFolderGate(null, "https://www.dropbox.com/scl/fo/abc")).toEqual({ ok: true, folderName: null });
  });

  it("prefers the path over the link when both are set", () => {
    expect(rawFolderGate("/Tonomo/Raw Files/12 Example St", "https://www.dropbox.com/scl/fo/abc")).toEqual({ ok: true, folderName: "12 Example St" });
  });

  it("refuses a project with neither a RAW folder path nor a link", () => {
    expect(rawFolderGate(null, null)).toEqual({ ok: false, reason: "missing" });
    expect(rawFolderGate("", "")).toEqual({ ok: false, reason: "missing" });
    expect(rawFolderGate("   ", undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a RAW folder path no shoot folder can be derived from", () => {
    // A bare Listing Images leaf has no parent to fall back to — the same input that makes
    // deriveAutoHdrFolderName throw in the publish Workflow.
    expect(rawFolderGate("/Listing Images", null)).toEqual({ ok: false, reason: "underivable" });
    expect(rawFolderGate("/", null)).toEqual({ ok: false, reason: "underivable" });
    expect(() => deriveAutoHdrFolderName("/Listing Images")).toThrow(/Cannot derive AutoHDR folder name/);
  });

  it("refuses a link that is only whitespace", () => {
    expect(rawFolderGate(null, "   ")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("normalisePath", () => {
  it("keeps the behaviour its background callers depend on after the move to shared", () => {
    expect(normalisePath("Tonomo/Raw Files/12 Example St/")).toBe("/Tonomo/Raw Files/12 Example St");
    expect(normalisePath("\\Tonomo\\Raw Files\\\\12 Example St")).toBe("/Tonomo/Raw Files/12 Example St");
    expect(normalisePath("/Users/terry/Quincy Dropbox/Tonomo/Raw Files/12 Example St")).toBe("/Tonomo/Raw Files/12 Example St");
    expect(normalisePath("   ")).toBe("");
  });
});

describe("dropboxHomeUrl", () => {
  it("builds a signed-in team member's web URL for a real Editor path with spaces", () => {
    expect(dropboxHomeUrl("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input"))
      .toBe("https://www.dropbox.com/home/Editor/01_ACTIVE%20EDITS/09.%20September/11/12%20Example%20St/0.%20Input");
  });

  it("escapes #, ?, &, +, % and Unicode inside a segment without disturbing the / separators", () => {
    expect(dropboxHomeUrl("/Editor/Bob & Sons #1/50% done?/a+b/café"))
      .toBe("https://www.dropbox.com/home/Editor/Bob%20%26%20Sons%20%231/50%25%20done%3F/a%2Bb/caf%C3%A9");
  });

  it("preserves display casing rather than lower-casing or NFC-folding", () => {
    expect(dropboxHomeUrl("/Editor/CamelCase Folder/ALLCAPS"))
      .toBe("https://www.dropbox.com/home/Editor/CamelCase%20Folder/ALLCAPS");
  });

  it("normalises a Finder-mount path first, same as every other Dropbox path consumer", () => {
    expect(dropboxHomeUrl("/Users/terry/Quincy Dropbox/Tonomo/Raw Files/12 Example St"))
      .toBe("https://www.dropbox.com/home/Tonomo/Raw%20Files/12%20Example%20St");
  });

  it("returns null when no path can be named", () => {
    expect(dropboxHomeUrl(null)).toBeNull();
    expect(dropboxHomeUrl(undefined)).toBeNull();
    expect(dropboxHomeUrl("")).toBeNull();
    expect(dropboxHomeUrl("   ")).toBeNull();
    expect(dropboxHomeUrl("/")).toBeNull();
  });

  it("returns null rather than a URL a browser would canonicalise to a different folder, for a single-dot segment", () => {
    expect(dropboxHomeUrl("/Editor/./Secret")).toBeNull();
  });

  it("returns null rather than a URL a browser would canonicalise to a different folder, for a parent-dot segment", () => {
    expect(dropboxHomeUrl("/Editor/../Secret")).toBeNull();
  });
});
