import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionPanel } from "./CollectionPanel";
import type { WorkspaceAsset } from "./PhotoGrid";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>(async () => ({ links: [] }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

function asset(id: string, version: number): WorkspaceAsset {
  return { id, collectionId: "collection", kind: "copy_pdf", originalFilename: `${id}.pdf`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version, versionGroupId: "group", supersedesAssetId: null, review: null, selected: false };
}

const props = {
  projectId: "project", collection: "copy" as const, assets: [asset("v1", 1), asset("v2", 2)], canManage: false, canApprove: false,
  onReview: vi.fn(async () => undefined), onDelete: vi.fn(async () => undefined), onChanged: vi.fn(async () => undefined), onToast: vi.fn(),
};

describe("CollectionPanel version history deletion markup", () => {
  it("keeps delete buttons as siblings of links and targets each version independently", () => {
    const markup = renderToStaticMarkup(createElement(CollectionPanel, { ...props, canDelete: true }));
    expect(markup).toContain("document-history__entry");
    expect(markup.match(/document-history__entry/g)?.length).toBe(2);
    expect(markup).not.toMatch(/<a[^>]*>[^<]*<button/);
    expect(markup).toContain('href="/media/asset/v1/original"');
    expect(markup).toContain('href="/media/asset/v2/original"');
  });

  it("does not expose deletion when canDelete is false even if collection management is allowed", () => {
    const markup = renderToStaticMarkup(createElement(CollectionPanel, { ...props, canManage: true, canDelete: false }));
    expect(markup).not.toContain("Delete</button>");
    expect(markup).toContain("Upload new version");
  });
});

describe("CollectionPanel version history deletion wiring", () => {
  let root: Root | null = null; let host: HTMLDivElement;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    window.confirm = vi.fn(() => true);
  });
  afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove(); });

  it("targets the clicked version's own id, not the other version's, even though both render the same 'Delete' label", async () => {
    const onDelete = vi.fn(async () => undefined);
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, canDelete: true, onDelete })); await Promise.resolve(); });
    const deleteButtons = [...host.querySelectorAll<HTMLButtonElement>(".document-history__entry button")];
    expect(deleteButtons).toHaveLength(2);
    // v2 sorts first (newest-first version history) — click it specifically and confirm the OTHER
    // version's id is never passed, proving each button is wired to its own entry, not a shared
    // or stale closure over whichever version happened to render last.
    await act(async () => { deleteButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("v2");
    expect(onDelete).not.toHaveBeenCalledWith("v1");
  });
});
