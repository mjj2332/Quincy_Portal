import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { decodeExternalResponse } from "../lib/external-api-response";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { projectDataKeys } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { CollectionPanel } from "./CollectionPanel";
import type { WorkspaceAsset } from "./PhotoGrid";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
const authState = vi.hoisted(() => ({ role: "editor" }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }) }));

type DndTestEvent = { active: { id: string }; over: { id: string } | null };
const dnd = vi.hoisted(() => ({
  handlers: [] as Array<(event: DndTestEvent) => void>,
  starts: [] as Array<(event: DndTestEvent) => void>,
  overs: [] as Array<(event: DndTestEvent) => void>,
  cancels: [] as Array<(event: DndTestEvent) => void>,
  accessibilities: [] as Array<Parameters<typeof import("@dnd-kit/core").DndContext>[0]["accessibility"]>,
}));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push(props.onDragEnd as (event: DndTestEvent) => void);
      dnd.starts.push(props.onDragStart as unknown as (event: DndTestEvent) => void);
      dnd.overs.push(props.onDragOver as unknown as (event: DndTestEvent) => void);
      dnd.cancels.push(props.onDragCancel as unknown as (event: DndTestEvent) => void);
      dnd.accessibilities.push(props.accessibility);
      return createElement(actual.DndContext, props);
    },
  };
});

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostWithStatusMock = vi.fn<(path: string, body: unknown) => Promise<{ data: unknown; status: number }>>();
const externalApiGetMock = vi.hoisted(() => vi.fn<(surface: string, path: string, signal?: AbortSignal) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path), apiPostWithStatus: (path: string, body: unknown) => apiPostWithStatusMock(path, body) };
});
vi.mock("../lib/external-api-response", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/external-api-response")>();
  return { ...actual, externalApiGet: (surface: string, path: string, signal?: AbortSignal) => externalApiGetMock(surface, path, signal) };
});

function asset(id: string, version: number): WorkspaceAsset {
  return { id, collectionId: "collection", kind: "copy_pdf", originalFilename: `${id}.pdf`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version, versionGroupId: "group", supersedesAssetId: null, review: null, selected: false };
}

const props = {
  projectId: "project", collection: "copy" as const, assets: [asset("v1", 1), asset("v2", 2)], canManage: false, canApprove: false,
  onReview: vi.fn(async () => undefined), onDelete: vi.fn(async () => undefined), onChanged: vi.fn(async () => undefined), onToast: vi.fn(),
};
const videoLinks = () => [
  { id: "manual-video-link", url: "https://vimeo.com/manual", label: "Walkthrough", source: "manual" as const, position: 1024, createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "tonomo-video-link", url: "https://dropbox.com/s/tonomo", label: "Tonomo delivery", source: "tonomo" as const, position: 2048, createdAt: "2026-08-02T00:00:00.000Z" },
];
const videoProps = { ...props, collection: "video" as const, assets: [], canManage: true };

describe("Video link reorder neighbors", () => {
  it("derives immediate neighbors for first, middle, and last moves and ignores no-ops", () => {
    expect(reorderNeighbors(["a", "b", "c", "d"], "d", "a")).toMatchObject({ beforeId: null, afterId: "a" });
    expect(reorderNeighbors(["a", "b", "c", "d"], "a", "c")).toMatchObject({ beforeId: "c", afterId: "d" });
    expect(reorderNeighbors(["a", "b", "c", "d"], "a", "d")).toMatchObject({ beforeId: "d", afterId: null });
    expect(reorderNeighbors(["a", "b"], "a", null)).toBeNull();
    expect(reorderNeighbors(["a", "b"], "a", "a")).toBeNull();
  });
});

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

  it("keeps role=\"status\" on the legacy-incomplete floorplan preview placeholder", () => {
    const floorplanAsset = { ...asset("fp1", 1), kind: "floorplan_pdf" as const };
    const markup = renderToStaticMarkup(createElement(CollectionPanel, { ...props, collection: "floorplan", assets: [floorplanAsset] }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("document-preview--incomplete");
    expect(markup).toContain("Preview unavailable for this legacy version.");
  });
});

describe("CollectionPanel version history deletion wiring", () => {
  let root: Root | null = null; let host: HTMLDivElement;
  let queryClient: QueryClient | null = null; let runtime: ProjectQueryRuntime | null = null;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    confirmMock.mockReset().mockResolvedValue(true);
    dnd.handlers.length = 0;
    dnd.starts.length = 0; dnd.overs.length = 0; dnd.cancels.length = 0; dnd.accessibilities.length = 0;
    apiGetMock.mockReset().mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: videoLinks() } : { links: [] }));
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    apiDeleteMock.mockReset();
    apiPostWithStatusMock.mockReset();
    authState.role = "editor";
    externalApiGetMock.mockReset().mockImplementation(async (surface, path) => decodeExternalResponse(surface as "collection-links", await apiGetMock(path)));
  });
  afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); runtime?.dispose(); queryClient?.clear(); runtime = null; queryClient = null; root = null; host.remove(); });

  async function renderVideoPanel(overrides: Partial<typeof videoProps> = {}) {
    await act(async () => { root!.render(createElement(CollectionPanel, { ...videoProps, ...overrides })); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  async function renderVideoPanelWithRuntime(overrides: Partial<typeof videoProps> = {}) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime!}><QueryClientProvider client={queryClient!}>{createElement(CollectionPanel, { ...videoProps, ...overrides })}</QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  async function click(element: Element) {
    await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  async function typeInto(element: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
  }
  async function dragEnd(activeId: string, overId: string | null) {
    const handler = dnd.handlers.at(-1);
    if (!handler) throw new Error("No DndContext drag-end handler was rendered");
    await act(async () => { handler({ active: { id: activeId }, over: overId ? { id: overId } : null }); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  function tile(hostElement: HTMLElement, text: string) {
    const result = [...hostElement.querySelectorAll<HTMLElement>('[data-testid="collection-link"]')].find((element) => element.textContent?.includes(text));
    if (!result) throw new Error(`No collection link tile containing ${text}`);
    return result;
  }
  function linkTile(hostElement: HTMLElement, index: number) {
    const result = hostElement.querySelectorAll<HTMLElement>('[data-testid="collection-link"]')[index];
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

  it("uses the strict external link response and keeps provenance controls after a reload", async () => {
    authState.role = "external_editor";
    const initial = videoLinks();
    externalApiGetMock.mockResolvedValue({ links: initial });
    await renderVideoPanel();
    expect(externalApiGetMock).toHaveBeenCalledWith("collection-links", "/api/projects/project/links?collection=video", undefined);
    expect(tile(host, "Walkthrough").textContent).toContain("Edit");
    expect(tile(host, "Walkthrough").textContent).toContain("Remove");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Edit");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Remove");

    const created = { id: "new-manual-link", url: "https://vimeo.com/new", label: "New cut", source: "manual" as const, position: 3072, createdAt: "2026-08-03T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValue({ data: created, status: 201 });
    await typeInto(host.querySelector<HTMLInputElement>("input[placeholder='https://vimeo.com/…']")!, created.url);
    await typeInto(host.querySelector<HTMLInputElement>("input[placeholder='Final walkthrough']")!, created.label!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add link")!);
    expect(tile(host, "New cut").textContent).toContain("Edit");

    externalApiGetMock.mockResolvedValue({ links: [] });
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "copy", canManage: true })); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    externalApiGetMock.mockResolvedValue({ links: [created, initial[1]!] });
    await act(async () => { root!.render(createElement(CollectionPanel, { ...videoProps, canManage: true })); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(tile(host, "New cut").textContent).toContain("Edit");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Remove");
  });

  it("fails loudly when an external link response omits its source discriminator", async () => {
    authState.role = "external_editor";
    apiGetMock.mockResolvedValue({ links: [{ id: "missing-source", url: "https://vimeo.com/missing", label: null, position: 1024, createdAt: "2026-08-01T00:00:00.000Z" }] });
    await renderVideoPanel();
    expect(host.querySelector('[data-testid="collection-link"]')).toBeNull();
    expect(videoProps.onToast).toHaveBeenCalledWith(expect.stringContaining("Required"), "error");
  });

  it("keeps internal link loads on apiGet rather than the external response boundary", async () => {
    await renderVideoPanel();
    expect(apiGetMock).toHaveBeenCalledWith("/api/projects/project/links?collection=video");
    expect(externalApiGetMock).not.toHaveBeenCalled();
  });

  it("exposes Video-only labelled grips without changing anchors or manual controls", async () => {
    await renderVideoPanel();
    expect(host.querySelector<HTMLButtonElement>("button[aria-label='Reorder Walkthrough']")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>("button[aria-label='Reorder Tonomo delivery']")).not.toBeNull();
    expect(tile(host, "Walkthrough").querySelector("a")?.getAttribute("href")).toBe("https://vimeo.com/manual");
    expect([...tile(host, "Walkthrough").querySelectorAll("button")].some((button) => button.textContent === "Edit")).toBe(true);
    expect([...tile(host, "Walkthrough").querySelectorAll("button")].some((button) => button.textContent === "Remove")).toBe(true);
    await renderVideoPanel({ canManage: false });
    expect(host.querySelector('button[aria-label^="Reorder "]')).toBeNull();
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "floorplan", assets: [], canManage: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('button[aria-label^="Reorder "]')).toBeNull();
  });

  it("hides the reorder grip icon from assistive tech and nests no interactive element inside another", async () => {
    await renderVideoPanel();
    const grip = host.querySelector<HTMLButtonElement>("button[aria-label='Reorder Walkthrough']")!;
    expect(grip.getAttribute("aria-label")).toBe("Reorder Walkthrough");
    const icon = grip.querySelector("svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    // No interactive element (button/a/input/select/textarea) may contain another one anywhere
    // in the panel — dnd-kit drag handles and video-link anchors are the highest-risk spots.
    const interactive = [...host.querySelectorAll<HTMLElement>("button, a, input, select, textarea")];
    for (const element of interactive) {
      const nested = element.querySelector("button, a, input, select, textarea");
      expect(nested).toBeNull();
    }
  });

  it("scopes stacked title/source tile structure to video anchors and plain links only", async () => {
    const plain = { id: "plain-video-link", url: "http://example.test/not-safe", label: "Client portal", source: "manual" as const, position: 3072, createdAt: "2026-08-03T00:00:00.000Z" };
    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: [...videoLinks(), plain] } : { links: videoLinks() }));
    await renderVideoPanel();
    const videoLinksParent = host.querySelector<HTMLElement>('[data-testid="collection-links"]')!;
    expect(videoLinksParent.dataset.video).toBe("true");
    for (const contentParent of host.querySelectorAll<HTMLElement>('[data-testid="collection-links"][data-video="true"] [data-testid="collection-link"] > a, [data-testid="collection-links"][data-video="true"] [data-testid="collection-link-plain"]')) {
      const [name, chip] = [...contentParent.children];
      expect(contentParent.children).toHaveLength(2);
      expect((name as HTMLElement).dataset.testid).toBe("collection-link-name");
      expect((chip as HTMLElement).dataset.testid).toBe("collection-link-source");
      expect(contentParent.parentElement?.querySelector('[data-testid="collection-link-meta"]')).not.toBeNull();
    }
    expect(host.querySelector('[data-testid="collection-link-plain"]')?.textContent).toContain("Client portal");
    expect(host.querySelector('[data-testid="collection-link-add"] input[placeholder="https://vimeo.com/…"]')).not.toBeNull();
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "floorplan", assets: [], canManage: false })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector<HTMLElement>('[data-testid="collection-links"]')?.dataset.video).toBeUndefined();
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, collection: "copy", assets: [], canManage: false })); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector<HTMLElement>('[data-testid="collection-links"]')?.dataset.video).toBeUndefined();
  });

  it("opens the inline editor and cancels without PATCH, restoring the original tile", async () => {
    await renderVideoPanel();
    await click([...linkTile(host, 0).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]')!;
    expect(editor.parentElement?.querySelector('button[aria-label^="Reorder "]')).toBeNull();
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.value).toBe("Walkthrough");
    expect(inputs[1]!.value).toBe("https://vimeo.com/manual");
    expect([...editor.querySelectorAll("button")].find((button) => button.textContent === "Save")).toBeDefined();
    expect([...editor.querySelectorAll("button")].some((button) => button.textContent === "Cancel")).toBe(true);

    await typeInto(inputs[0]!, "Unsaved draft");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(host.querySelector('[data-testid="collection-link-editor"]')).toBeNull();
    expect(tile(host, "Walkthrough").querySelector("a")?.getAttribute("href")).toBe("https://vimeo.com/manual");
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the selected link, replaces only that tile from the response, and leaves other links intact", async () => {
    const onChanged = vi.fn(async () => undefined);
    const responseLink = { id: "manual-video-link", url: "https://vimeo.com/updated", label: "Final cut", source: "manual" as const, position: 1024, createdAt: "2026-08-01T00:00:00.000Z" };
    apiPatchMock.mockResolvedValueOnce(responseLink);
    await renderVideoPanel({ onChanged });
    await click([...linkTile(host, 0).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]')!;
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, " Final cut ");
    await typeInto(inputs[1]!, "https://vimeo.com/updated");
    await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);

    expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/project/links/manual-video-link", { url: "https://vimeo.com/updated", label: "Final cut" });
    expect(host.querySelector('[data-testid="collection-link-editor"]')).toBeNull();
    expect(tile(host, "Final cut").textContent).toContain("Manual");
    expect(tile(host, "Final cut").querySelector("a")?.getAttribute("href")).toBe("https://vimeo.com/updated");
    expect(tile(host, "Tonomo delivery").textContent).toContain("Tonomo");
    expect(tile(host, "Tonomo delivery").textContent).not.toContain("Edit");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shows ApiError inline and retains the draft after a rejected save, including local HTTPS validation", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("A link with this URL already exists in this collection", 409));
    await renderVideoPanel();
    await click([...linkTile(host, 0).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]')!;
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

  it("keeps a dirty Add-link form draft and an in-progress inline-edit draft across a background assets refresh", async () => {
    await renderVideoPanel();
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, "https://vimeo.com/dirty-draft");
    await typeInto(inputs[1]!, "Dirty draft label");

    await click([...linkTile(host, 0).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    const editor = linkTile(host, 0).querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]')!;
    await typeInto(editor.querySelectorAll<HTMLInputElement>("input")[0]!, "Dirty edit label");

    // Simulate an ordinary background assets refetch: the parent re-renders with a fresh
    // `assets` array reference and unchanged projectId/collection — link state (which loads
    // independently of `assets`) must not be touched by it.
    await act(async () => { root!.render(createElement(CollectionPanel, { ...videoProps, assets: [...videoProps.assets] })); await Promise.resolve(); });

    expect(host.querySelector<HTMLInputElement>('[data-testid="collection-link-add"] input')?.value).toBe("https://vimeo.com/dirty-draft");
    const editorAfter = host.querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]');
    expect(editorAfter).not.toBeNull();
    expect(editorAfter!.querySelectorAll<HTMLInputElement>("input")[0]!.value).toBe("Dirty edit label");
  });

  it("disables the Add link submit button while the request is in flight, so a repeat click cannot double-submit", async () => {
    let resolvePost!: (value: { data: unknown; status: number }) => void;
    apiPostWithStatusMock.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));
    await renderVideoPanel();
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, "https://vimeo.com/pending");
    const submit = form.querySelector<HTMLButtonElement>("button")!;
    await click(submit);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe("Adding…");
    await click(submit);
    expect(apiPostWithStatusMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolvePost({ data: { id: "x", url: "https://vimeo.com/pending", label: null, source: "manual", position: 4096, createdAt: "2026-08-06T00:00:00.000Z" }, status: 201 }); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  });

  it("adds a new link on a 201, clearing the form and toasting success", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onToast = vi.fn();
    const created = { id: "new-video-link", url: "https://vimeo.com/new", label: "New cut", source: "manual" as const, position: 3072, createdAt: "2026-08-04T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValueOnce({ data: created, status: 201 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
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

  it("invalidates only Activity after each successful video-link mutation", async () => {
    const created = { id: "new-video-link", url: "https://vimeo.com/new", label: "New cut", source: "manual" as const, position: 3072, createdAt: "2026-08-04T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValueOnce({ data: created, status: 201 });
    await renderVideoPanelWithRuntime();
    const queryInvalidate = vi.spyOn(queryClient!, "invalidateQueries");
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, created.url); await click(form.querySelector("button")!);
    expect(queryInvalidate).toHaveBeenCalledWith({ queryKey: projectDataKeys.activity("project"), exact: true, refetchType: "active" });

    const responseLink = { ...created, id: "manual-video-link", label: "Final cut" };
    apiPatchMock.mockResolvedValueOnce(responseLink);
    const walkthrough = tile(host, "Walkthrough");
    await click([...walkthrough.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    const editor = host.querySelector<HTMLFormElement>('[data-testid="collection-link-editor"]')!;
    const editInputs = editor.querySelectorAll<HTMLInputElement>("input");
    await typeInto(editInputs[0]!, "Final cut"); await click([...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);

    apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("collection=video") ? { links: [responseLink, videoLinks()[1]] } : { links: [] }));
    apiPostMock.mockResolvedValueOnce({ position: 1024 });
    await dragEnd("tonomo-video-link", "manual-video-link");
    apiDeleteMock.mockResolvedValueOnce(undefined);
    await click([...tile(host, "Final cut").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!);
    expect(queryInvalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(projectDataKeys.activity("project")))).toHaveLength(4);
  });

  it("on a 200 for a link already shown locally, keeps its tile position, shows the duplicate error, keeps the typed values, and does not call onChanged", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onToast = vi.fn();
    const existing = videoLinks()[0]!; // "Walkthrough", currently the first tile
    apiPostWithStatusMock.mockResolvedValueOnce({ data: existing, status: 200 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
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
    const concurrentlyCreated = { id: "elsewhere-created-link", url: "https://vimeo.com/elsewhere", label: "Elsewhere", source: "manual" as const, position: 3072, createdAt: "2026-08-05T00:00:00.000Z" };
    apiPostWithStatusMock.mockResolvedValueOnce({ data: concurrentlyCreated, status: 200 });
    await renderVideoPanel({ onChanged, onToast });
    const form = host.querySelector<HTMLFormElement>('[data-testid="collection-link-add"]')!;
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await typeInto(inputs[0]!, concurrentlyCreated.url);
    await click(form.querySelector("button")!);

    // Appended after the preloaded tile, not prepended, replacing it, or otherwise reordered.
    expect(linkTile(host, 0).textContent).toContain("Tonomo delivery");
    expect(linkTile(host, 1).textContent).toContain("Elsewhere");
    expect(onToast).toHaveBeenCalledWith("This link is already in the list.", "error");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("POSTs the immediate reorder neighbors and reloads the server's canonical order instead of reordering locally", async () => {
    const initial = [...videoLinks(), { id: "concurrently-moved-link", url: "https://vimeo.com/concurrent", label: "Concurrent cut", source: "manual" as const, position: 3072, createdAt: "2026-08-03T00:00:00.000Z" }];
    const canonical = [
      { ...initial[2]!, position: 1024 },
      { ...initial[0]!, position: 2048 },
      { ...initial[1]!, position: 3072 },
    ];
    let resolveReorder!: (value: unknown) => void;
    const reorderResponse = new Promise<unknown>((resolve) => { resolveReorder = resolve; });
    apiGetMock.mockReset()
      .mockResolvedValueOnce({ links: initial })
      .mockResolvedValueOnce({ links: canonical });
    apiPostMock.mockReturnValueOnce(reorderResponse);
    await renderVideoPanel();

    await dragEnd("tonomo-video-link", "manual-video-link");

    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/project/links/tonomo-video-link/reorder", { beforeId: null, afterId: "manual-video-link" });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(linkTile(host, 0).textContent).toContain("Walkthrough");
    expect(linkTile(host, 1).textContent).toContain("Tonomo delivery");
    expect(linkTile(host, 2).textContent).toContain("Concurrent cut");

    await act(async () => { resolveReorder({ position: 1024 }); await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); });

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(linkTile(host, 0).textContent).toContain("Concurrent cut");
    expect(linkTile(host, 1).textContent).toContain("Walkthrough");
    expect(linkTile(host, 2).textContent).toContain("Tonomo delivery");
  });

  it("reloads canonical links and shows a retryable error when reorder conflicts", async () => {
    const initial = videoLinks();
    const canonical = [
      { ...initial[1]!, position: 1024 },
      { ...initial[0]!, position: 2048 },
    ];
    const onToast = vi.fn();
    apiGetMock.mockReset()
      .mockResolvedValueOnce({ links: initial })
      .mockResolvedValueOnce({ links: canonical });
    apiPostMock.mockRejectedValueOnce(new ApiError("Link order changed; reload and try again", 409));
    await renderVideoPanel({ onToast });

    await dragEnd("tonomo-video-link", "manual-video-link");

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(linkTile(host, 0).textContent).toContain("Tonomo delivery");
    expect(linkTile(host, 1).textContent).toContain("Walkthrough");
    expect(onToast).toHaveBeenCalledWith("Link order changed; reload and try again", "error");
  });

  it("retains the current links and shows an ordinary error for a non-conflict reorder failure", async () => {
    const onToast = vi.fn();
    apiPostMock.mockRejectedValueOnce(new ApiError("Reorder service unavailable", 500));
    await renderVideoPanel({ onToast });

    await dragEnd("tonomo-video-link", "manual-video-link");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(linkTile(host, 0).textContent).toContain("Walkthrough");
    expect(linkTile(host, 1).textContent).toContain("Tonomo delivery");
    expect(onToast).toHaveBeenCalledWith("Reorder service unavailable", "error");
  });

  it("targets the clicked version's own id, not the other version's, even though both render the same 'Delete' label", async () => {
    const onDelete = vi.fn(async () => undefined);
    await act(async () => { root!.render(createElement(CollectionPanel, { ...props, canDelete: true, onDelete })); await Promise.resolve(); });
    const deleteButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="document-version-delete"]')];
    expect(deleteButtons).toHaveLength(2);
    // v2 sorts first (newest-first version history) — click it specifically and confirm the OTHER
    // version's id is never passed, proving each button is wired to its own entry, not a shared
    // or stale closure over whichever version happened to render last.
    await act(async () => { deleteButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenCalledWith({ title: "Delete version 2?", message: "Permanently delete version 2? This cannot be undone.", confirmLabel: "Delete", danger: true });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("v2");
    expect(onDelete).not.toHaveBeenCalledWith("v1");
  });
});
