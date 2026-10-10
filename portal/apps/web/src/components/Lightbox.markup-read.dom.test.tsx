/**
 * #741 slice 6s-api: the Lightbox's read path for shapes. Saved arrows, lines and rectangles render; a `type` this build
 * does not know renders nothing, says so, keeps its data and blocks drawing edits; an Edit drawing round trip keeps
 * `type` and saves a typeless stroke byte for byte.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";
import type { WorkspaceAsset } from "./PhotoGrid";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
  };
});

type Stroke = Record<string, unknown>;
type TestAnnotation = {
  id: string; authorId: string; author: { id: string; name: string; role: string }; scope: "raw" | "edited";
  strokeR2Key: string | null; noteText: string | null; createdAt: string; editedAt: string | null;
};

function workspaceAsset(id: string): WorkspaceAsset {
  return {
    id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`,
    bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
    createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
    supersedesAssetId: null, review: null, selected: false,
  };
}
function annotation(id: string, overrides: Partial<TestAnnotation> = {}): TestAnnotation {
  return {
    id, authorId: "user-1", author: { id: "user-1", name: "A", role: "editor" }, scope: "edited",
    strokeR2Key: null, noteText: "Saved note", createdAt: "2026-07-28T00:00:00.000Z", editedAt: null, ...overrides,
  };
}
function baseProps(overrides: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const asset = workspaceAsset("asset-1");
  return {
    assets: [asset], rawAssets: [], initialAssetId: asset.id, collectionKind: "edited" as const,
    canReview: true, canRecommend: true, canAnnotate: true,
    onClose: vi.fn(), onReview: vi.fn().mockResolvedValue(undefined), onToast: vi.fn(), ...overrides,
  };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render(value: ReactNode) { await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); }); }
async function unmount() { if (!root) return; await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); }); }
function deferredPromise<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  if (!found) throw new Error(`No button: ${text}`);
  return found;
}
async function openReviewPanel(host: HTMLElement) {
  await click(host.querySelector<HTMLButtonElement>('[data-testid="lightbox-review-trigger"]')!);
}
function configureAnnotations(items: TestAnnotation[], strokes: Stroke[] = [{ points: [{ x: 0.2, y: 0.2 }], color: "#000", width: 2 }]) {
  apiGetMock.mockImplementation((path) => {
    if (path.includes("/annotations")) return Promise.resolve({ annotations: items });
    if (path.includes("/media/annotation/")) return Promise.resolve(strokes);
    return Promise.resolve({});
  });
}


const UNKNOWN_NOTE = "Some markup can't be shown";
beforeEach(() => {
  window.innerWidth = 1024;
  confirmMock.mockReset().mockResolvedValue(true);
  apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset();
  apiPatchMock.mockResolvedValue({ noteText: "n", editedAt: new Date().toISOString() });
});
afterEach(async () => { await unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const pt = (x: number, y: number) => ({ x, y });
const arrow = { type: "arrow", points: [pt(0.1, 0.1), pt(0.9, 0.9)], color: "#e64b3c", width: 4 };
const lineShape = { type: "line", points: [pt(0.2, 0.2), pt(0.6, 0.2)], color: "#3f8f5a", width: 2 };
const rectShape = { type: "rectangle", points: [pt(0.7, 0.8), pt(0.3, 0.4)], color: "#e64b3c", width: 7 };
const freehand = { points: [pt(0.1, 0.2), pt(0.3, 0.4)], color: "#3f8f5a", width: 2 };
const future = { type: "circle", points: [pt(0.2, 0.2), pt(0.4, 0.4)], color: "#e64b3c", width: 4 };
const saved = () => annotation("ann-1", { strokeR2Key: "key" });
async function open(strokes: Stroke[]) {
  configureAnnotations([saved()], strokes);
  const host = mount();
  await render(<Lightbox {...baseProps()} />);
  await openReviewPanel(host);
  await flush();
  return host;
}
const savedTags = (host: HTMLElement) => [...host.querySelectorAll('[data-annotation-id="ann-1"] [data-testid="lightbox-stroke"]')].map((el) => el.tagName);

describe("Lightbox read path for markup shapes (#741 6s-api)", () => {
  it("renders saved arrow, line and rectangle", async () => {
    const host = await open([arrow, lineShape, rectShape, freehand]);
    expect(savedTags(host)).toEqual(["g", "line", "rect", "polyline"]);
    expect(host.textContent).not.toContain(UNKNOWN_NOTE);
  });

  it("an unknown type renders nothing, shows the note, and keeps the rest", async () => {
    const host = await open([future, freehand]);
    expect(savedTags(host)).toEqual(["polyline"]);
    expect(host.textContent).toContain(UNKNOWN_NOTE);
  });

  it("an unknown type blocks Edit drawing and nothing is sent", async () => {
    const host = await open([future, freehand]);
    const edit = button(host, "Edit drawing") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    await click(edit);
    expect(host.querySelector('[data-testid="lightbox-markup-toolbar"]')!.textContent).not.toContain("Editing drawing");
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("Edit drawing with shapes keeps type and the two-point tuple through Save", async () => {
    const host = await open([arrow, lineShape, rectShape]);
    await click(button(host, "Edit drawing"));
    expect(host.querySelector('[data-testid="lightbox-markup-toolbar"]')!.textContent).toContain("Editing drawing");
    expect(host.querySelectorAll('[data-testid="lightbox-markup"] > [data-testid="lightbox-stroke"]')).toHaveLength(3);
    await click(button(host, "Save"));
    await flush(12);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(apiPatchMock.mock.calls[0]![1])).toBe(JSON.stringify({ strokes: [arrow, lineShape, rectShape] }));
  });

  it("Edit drawing saves a typeless stroke byte for byte", async () => {
    const host = await open([freehand, { points: [pt(0.5, 0.5)], color: "#fff", width: 7 }]);
    await click(button(host, "Edit drawing"));
    await click(button(host, "Save"));
    await flush(12);
    expect(JSON.stringify(apiPatchMock.mock.calls[0]![1])).toBe(JSON.stringify({ strokes: [freehand, { points: [pt(0.5, 0.5)], color: "#fff", width: 7 }] }));
  });

  it("hiding markup hides shapes", async () => {
    const host = await open([arrow]);
    await click(button(host, "Hide markup"));
    expect(savedTags(host)).toEqual([]);
  });
});
