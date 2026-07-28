import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhotoGrid, groupWorkspaceAssetsBySection, updateFailedThumbnailState, workspaceAssetIdsBetween, workspaceSectionKey, type WorkspaceAsset } from "./PhotoGrid";
import { cycleLightboxIndex } from "../lib/lightbox-navigation";

function asset(id: string, section: string | null): WorkspaceAsset {
  return { id, section, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

describe("groupWorkspaceAssetsBySection", () => {
  it("keeps Captures first and sorts immediate-folder sections case-insensitively", () => {
    const groups = groupWorkspaceAssetsBySection([asset("kitchen", "Kitchen"), asset("capture-a", null), asset("balcony", "balcony"), asset("capture-b", null), asset("kitchen-b", "Kitchen")]);
    expect(groups.map((group) => [group.label, group.assets.map((item) => item.id)])).toEqual([["Captures", ["capture-a", "capture-b"]], ["balcony", ["balcony"]], ["Kitchen", ["kitchen", "kitchen-b"]]]);
  });

  it("omits sections with no visible assets", () => {
    expect(groupWorkspaceAssetsBySection([asset("pool", "Pool")]).map((group) => group.label)).toEqual(["Pool"]);
  });

  it("keeps a real captures folder distinct from the Captures root section", () => {
    const groups = groupWorkspaceAssetsBySection([asset("root", null), asset("folder", "captures")]);
    expect(groups.map((group) => group.label)).toEqual(["Captures", "captures"]);
    expect(groups.map((group) => workspaceSectionKey(group.section))).toEqual(["workspace-section:root", "workspace-section:folder:captures"]);
  });

  it("uses flattened visual order for cross-section shift selection and lightbox navigation", () => {
    const order = groupWorkspaceAssetsBySection([asset("kitchen-1", "Kitchen"), asset("root-1", null), asset("bath-1", "Bathroom"), asset("root-2", null)]).flatMap((group) => group.assets);
    expect(order.map((item) => item.id)).toEqual(["root-1", "root-2", "bath-1", "kitchen-1"]);
    expect(workspaceAssetIdsBetween(order, "root-2", "kitchen-1")).toEqual(["root-2", "bath-1", "kitchen-1"]);
    expect(cycleLightboxIndex(1, 1, order.length)).toBe(2);
    expect(order[cycleLightboxIndex(1, 1, order.length)]!.id).toBe("bath-1");
    expect(cycleLightboxIndex(2, -1, order.length)).toBe(1);
    expect(order[cycleLightboxIndex(2, -1, order.length)]!.id).toBe("root-2");
    expect(cycleLightboxIndex(0, -1, order.length)).toBe(order.length - 1);
    expect(cycleLightboxIndex(order.length - 1, 1, order.length)).toBe(0);
  });

  it("preserves API-provided order within sections while presenting Captures then sections", () => {
    const assets = [
      { ...asset("kitchen-zebra", "Kitchen"), originalFilename: "zebra.jpg" },
      { ...asset("capture-zebra", null), originalFilename: "capture-zebra.jpg" },
      { ...asset("balcony-alpha", "Balcony"), originalFilename: "alpha.jpg" },
      { ...asset("capture-alpha", null), originalFilename: "capture-alpha.jpg" },
      { ...asset("kitchen-alpha", "Kitchen"), originalFilename: "alpha.jpg" },
    ];
    const markup = renderToStaticMarkup(createElement(PhotoGrid, {
      assets, showSections: true,
      canReview: true, canRecommend: false, canSelect: false, canSetCover: false,
      coverAssetId: null, storedCoverAssetId: null,
      onSetCover: async () => undefined, onOpen: () => undefined, onReview: async () => undefined, onSelection: async () => undefined,
    }));
    expect(markup.indexOf(">Captures<")).toBeLessThan(markup.indexOf(">Balcony<"));
    expect(markup.indexOf(">Balcony<")).toBeLessThan(markup.indexOf(">Kitchen<"));
    expect(markup.indexOf("capture-zebra.jpg")).toBeLessThan(markup.indexOf("capture-alpha.jpg"));
    expect(markup.indexOf("zebra.jpg")).toBeLessThan(markup.indexOf("alpha.jpg", markup.indexOf(">Kitchen<")));
  });

  it("shows processing explicitly instead of an unavailable-image failure", () => {
    const markup = renderToStaticMarkup(createElement(PhotoGrid, {
      assets: [{ ...asset("pending", "Manual"), renditionStatus: "processing" }], showSections: true,
      canReview: true, canRecommend: false, canSelect: false, canSetCover: false,
      coverAssetId: null, storedCoverAssetId: null,
      onSetCover: async () => undefined, onOpen: () => undefined, onReview: async () => undefined, onSelection: async () => undefined,
    }));
    expect(markup).toContain("Processing preview");
    expect(markup).not.toContain("Image unavailable");
  });

  it("renders Edited QA as one flat workspace grid without section headings", () => {
    const markup = renderToStaticMarkup(createElement(PhotoGrid, {
      assets: [asset("root", null), asset("kitchen", "Kitchen")], showSections: false,
      canReview: true, canRecommend: false, canSelect: false, canSetCover: false,
      coverAssetId: null, storedCoverAssetId: null,
      onSetCover: async () => undefined, onOpen: () => undefined, onReview: async () => undefined, onSelection: async () => undefined,
    }));
    expect(markup).not.toContain("workspace-section");
    expect(markup).not.toContain("Captures");
    expect(markup).not.toContain(">Kitchen<");
    expect((markup.match(/workspace-photo-grid/g) ?? []).length).toBe(1);
  });

  it("keeps the failed-thumbnail Set reference when membership is unchanged", () => {
    const current = new Set(["failed"]);
    expect(updateFailedThumbnailState(current, "failed", true)).toBe(current);
    expect(updateFailedThumbnailState(current, "ready", false)).toBe(current);
    expect(updateFailedThumbnailState(current, "ready", true)).not.toBe(current);
  });
});
