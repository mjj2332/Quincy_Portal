import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { CollectionPanel } from "./CollectionPanel";
import type { WorkspaceAsset } from "./PhotoGrid";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPostWithStatusMock = vi.fn<(path: string, body: unknown) => Promise<{ data: unknown; status: number }>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiPostWithStatus: (path: string, body: unknown) => apiPostWithStatusMock(path, body) };
});

function asset(id: string, version: number): WorkspaceAsset {
  return { id, collectionId: "collection", kind: "copy_pdf", originalFilename: `${id}.pdf`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version, versionGroupId: "group", supersedesAssetId: null, review: null, selected: false };
}

const props = {
  projectId: "project", collection: "copy" as const, assets: [asset("v1", 1), asset("v2", 2)], canManage: false, canApprove: false,
  onReview: vi.fn(async () => undefined), onDelete: vi.fn(async () => undefined), onChanged: vi.fn(async () => undefined), onToast: vi.fn(),
};
const videoLinks = () => [
  { id: "manual-video-link", url: "https://vimeo.com/manual", label: "Walkthrough", source: "manual" as const, createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "tonomo-video-link", url: "https://dropbox.com/s/tonomo", label: "Tonomo delivery", source: "tonomo" as const, createdAt: "2026-08-02T00:00:00.000Z" },
];
const videoProps = { ...props, collection: "video" as const, assets: [], canManage: true };

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
    apiGetMock.mockReset().mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: videoLinks() } : { links: [] }));
    apiPatchMock.mockReset();
    apiPostWithStatusMock.mockReset();
  });
  afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove(); });

  async function renderVideoPanel(overrides: Partial<typeof videoProps> = {}) {
    await act(async () => { root!.render(createElement(CollectionPanel, { ...videoProps, ...overrides })); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  async function click(element: Element) {
    await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  async function typeInto(element: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
  }
  function tile(hostElement: HTMLElement, text: string) {
    const result = [...hostElement.querySelectorAll<HTMLElement>(".collection-link")].find((element) => element.textContent?.includes(text));
    if (!result) throw new Error(`No collection link tile containing ${text}`);
    return result;
  }
  function linkTile(hostElement: HTMLElement, index: number) {
    const result = hostElement.querySelectorAll<HTMLElement>(".collection-link")[index];
    if (!result) throw new Error(`No collection link tile at index ${index}`);
    return result;
  }

  it("shows Edit only for manageable manual video links", async () => {
    await renderVideoPanel();
    expect(tile(host, "Walkthrough").textContent).toContain("Edit");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Edit");

    await renderVideoPanel({ canManage: false });
    expect(host.textContent).not.toContain("Edit");
  });

  it("scopes stacked title/source tile structure to video anchors and plain links only", async () => {
    const plain = { id: "plain-video-link", url: "http://example.test/not-safe", label: "Client portal", source: "manual" as const, createdAt: "2026-08-03T00:00:00.000Z" };
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: [...videoLinks(), plain] } : { links: videoLinks() }));
    await renderVideoPanel();
    const videoLinksParent = host.querySelector<HTMLElement>(".collection-links")!;
    expect(videoLinksParent.classList.contains("collection-links--video")).toBe(true);
    for (const contentParent of host.querySelectorAll<HTMLElement>(".collection-links--video .collection-link > a, .collection-links--video .collection-link__plain")) {
      expect([...contentParent.children].map((child) => child.className)).toEqual(["collection-link__name", "chip"]);
      expect(contentParent.parentElement?.querySelector(".collection-link__meta")).not.toBeNull();
    }
    expect(host.querySelector(".collection-link__plain")?.textContent).toContain("Client portal");
    expect(host.querySelector(".collection-link-form:not(.collection-link-editor) input[placeholder='https://vimeo.com/…']")).not.toBeNull();
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "floorplan", assets: [], canManage: false })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".collection-links")?.classList.contains("collection-links--video")).toBe(false);
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "copy", assets: [], canManage: false })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".collection-links")?.classList.contains("collection-links--video")).toBe(false);
  });

  it("opens the inline editor and cancels without PATCH, restoring the original tile", async () => {
    await renderVideoPanel();
    await click(linkTile(host, 0).querySelector<HTMLButtonElement>("button")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>(".collection-link-editor")!;
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.value).toBe("Walkthrough");
    expect(inputs[1]!.value).toBe("https://vimeo.com/manual");
    expect([...editor.querySelectorAll("button")].find((button) => button.textContent === "Save")).toBeDefined();
    expect([...editor.querySelectorAll("button")].some((button) => button.textContent === "Cancel")).toBe(true);

    await typeInto(inputs[0]!, "Unsaved draft");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(host.querySelector(".collection-link-editor")).toBeNull();
    expect(tile(host, "Walkthrough").querySelector("a")?.getAttribute("href")).toBe("https://vimeo.com/manual");
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the selected link, replaces only that tile from the response, and leaves other links intact", async () => {
    const onChanged = vi.fn(async () => undefined);
    const responseLink = { id: "manual-video-link", url: "https://vimeo.com/updated", label: "Final cut", source: "manual" as const, createdAt: "2026-08-01T00:00:00.000Z" };
    apiPatchMock.mockResolvedValueOnce(responseLink);
    await renderVideoPanel({ onChanged });
    await click(linkTile(host, 0).querySelector<HTMLButtonElement>("button")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>(".collection-link-editor")!;
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, " Final cut ");
    await typeInto(inputs[1]!, "https://vimeo.com/updated");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);

    expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/project/links/manual-video-link", { url: "https://vimeo.com/updated", label: "Final cut" });
    expect(host.querySelector(".collection-link-editor")).toBeNull();
    expect(tile(host, "Final cut").textContent).toContain("Manual");
    expect(tile(host, "Final cut").querySelector("a")?.getAttribute("href")).toBe("https://vimeo.com/updated");
    expect(tile(host, "Tonomo delivery").textContent).toContain("Tonomo");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Edit");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shows ApiError inline and retains the draft after a rejected save, including local HTTPS validation", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("A link with this URL already exists in this collection", 409));
    await renderVideoPanel();
    await click(linkTile(host, 0).querySelector<HTMLButtonElement>("button")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>(".collection-link-editor")!;
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, "Collision draft");
    await typeInto(inputs[1]!, "https://vimeo.com/collision");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(editor.querySelector('[role="alert"]')?.textContent).toBe("A link with this URL already exists in this collection");
    expect(editor.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("Collision draft");
    expect(editor.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("https://vimeo.com/collision");

    apiPatchMock.mockClear();
    await typeInto(editor.querySelectorAll<HTMLInputElement>("input")[1]!, "http://vimeo.com/not-https");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(editor.querySelector('[role="alert"]')?.textContent).toBe("Enter an HTTPS URL.");
    expect(editor.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("Collision draft");
    expect(editor.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("http://vimeo.com/not-https");
  });

  it("adds a new link on a 201, clearing the form and toasting success", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onToast = vi.fn();
    const created = { id: "new-video-link", url: "https://vimeo.com/new", label: "New cut", source: "manual" as const, createdAt: "2026-08-04T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValueOnce({ data: created, status: 201 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>(".collection-link-form:not(.collection-link-editor)")!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, "https://vimeo.com/new");
    await typeInto(inputs[1]!, "New cut");
    await click(form.querySelector("button")!);

    expect(apiPostWithStatusMock).toHaveBeenCalledWith("/api/projects/project/links", { collection: "video", url: "https://vimeo.com/new", label: "New cut" });
    expect(tile(host, "New cut")).toBeDefined();
    expect(inputs[0]!.value).toBe(""); expect(inputs[1]!.value).toBe("");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("Link added.");
  });

  it("on a 200 for a link already shown locally, keeps its tile position, shows the duplicate error, keeps the typed values, and does not call onChanged", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onToast = vi.fn();
    const existing = videoLinks()[0]!; // "Walkthrough", currently the first tile
    apiPostWithStatusMock.mockResolvedValueOnce({ data: existing, status: 200 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>(".collection-link-form:not(.collection-link-editor)")!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, existing.url);
    await typeInto(inputs[1]!, "Attempted duplicate");
    await click(form.querySelector("button")!);

    expect(onToast).toHaveBeenCalledWith("This link is already in the list.", "error");
    expect(onToast).not.toHaveBeenCalledWith("Link added.");
    expect(inputs[0]!.value).toBe(existing.url); expect(inputs[1]!.value).toBe("Attempted duplicate");
    expect(onChanged).not.toHaveBeenCalled();
    // No server mutation happened, so the tile must not jump to the end of the list.
    expect(linkTile(host, 0).textContent).toContain("Walkthrough");
    expect(linkTile(host, 1).textContent).toContain("Tonomo delivery");
  });

  it("on a 200 for a link this client didn't have yet (created concurrently), appends it defensively without a false success toast", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onToast = vi.fn();
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: [videoLinks()[1]] } : { links: [] })); // only "Tonomo delivery" preloaded
    const concurrentlyCreated = { id: "elsewhere-created-link", url: "https://vimeo.com/elsewhere", label: "Elsewhere", source: "manual" as const, createdAt: "2026-08-05T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValueOnce({ data: concurrentlyCreated, status: 200 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>(".collection-link-form:not(.collection-link-editor)")!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, concurrentlyCreated.url);
    await click(form.querySelector("button")!);

    // Appended after the preloaded tile, not prepended, replacing it, or otherwise reordered.
    expect(linkTile(host, 0).textContent).toContain("Tonomo delivery");
    expect(linkTile(host, 1).textContent).toContain("Elsewhere");
    expect(onToast).toHaveBeenCalledWith("This link is already in the list.", "error");
    expect(onChanged).not.toHaveBeenCalled();
  });

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
