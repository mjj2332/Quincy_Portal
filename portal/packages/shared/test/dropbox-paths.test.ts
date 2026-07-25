import { describe, expect, it } from "vitest";
import { deriveAutoHdrFolderName, normalisePath, rawFolderGate } from "../src/dropbox-paths";

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
