/**
 * #741 slice 6a: characterisation of the photo Lightbox's freehand markup, written against the code
 * BEFORE it was extracted into `useFreehandMarkup` + the shared stroke renderer. Every assertion here
 * pins today's behaviour, quirks included (two pointers interleave into one stroke, pointer leave ends
 * a stroke, a save keeps a draft that moved on). It must stay green, unedited, across the extraction.
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

type Stroke = { points: { x: number; y: number }[]; color: string; width: number };
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

// ---- pointer helpers: the frame's rect is stubbed because jsdom has no layout. ----
type Rect = { left: number; top: number; width: number; height: number };
function stubFrameRect(host: HTMLElement, rect: Rect) {
  const frame = host.querySelector<HTMLElement>('[data-testid="lightbox-canvas"]')!;
  const make = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  frame.getBoundingClientRect = make;
  return { set(next: Rect) { rect = next; frame.getBoundingClientRect = make; } };
}
function svgOf(host: HTMLElement) {
  const svg = host.querySelector<SVGSVGElement>('[data-testid="lightbox-markup"]')!;
  (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  return svg;
}
async function pointer(svg: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointerout", x: number, y: number, pointerId = 1) {
  await act(async () => {
    svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX: x, clientY: y, relatedTarget: null }));
    await Promise.resolve();
  });
}
const RECT: Rect = { left: 100, top: 50, width: 200, height: 100 };
function draftPolylines(host: HTMLElement) {
  return [...host.querySelectorAll<SVGPolylineElement>('[data-testid="lightbox-markup"] > polyline[data-testid="lightbox-stroke"], [data-testid="lightbox-markup"] > circle[data-testid="lightbox-stroke"]')];
}
function strokeCount(host: HTMLElement) { return host.querySelectorAll('[data-testid="lightbox-markup"] [data-testid="lightbox-stroke"]').length; }

beforeEach(() => {
  window.innerWidth = 1024;
  confirmMock.mockReset().mockResolvedValue(true);
  apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset();
  apiGetMock.mockImplementation((path) => path.includes("/annotations") ? Promise.resolve({ annotations: [] }) : Promise.resolve({}));
  apiPostMock.mockResolvedValue({ id: "created", authorId: "user-1", author: { id: "A", name: "A", role: "editor" }, scope: "edited", strokeR2Key: null, noteText: null, createdAt: new Date().toISOString(), editedAt: null });
  apiPatchMock.mockResolvedValue({ noteText: "Updated note", editedAt: new Date().toISOString() });
});
afterEach(async () => { await unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("Lightbox freehand markup, characterised before the #741 extraction", () => {
  it("1. a drag POSTs exact 4dp points clamped at both edges, with the default tool and a changed one", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 100, 50);          // top-left corner
    await pointer(svg, "pointermove", 123.456789, 87.654321);
    await pointer(svg, "pointermove", 400, 250);          // past bottom-right: clamps to 1,1
    await pointer(svg, "pointermove", -30, -30);          // before top-left: clamps to 0,0
    await pointer(svg, "pointerup", -30, -30);
    await click(button(host, "Save annotation"));
    await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/assets/asset-1/annotations", {
      strokes: [{ color: "#e64b3c", width: 4, points: [{ x: 0, y: 0 }, { x: 0.1173, y: 0.3765 }, { x: 1, y: 1 }, { x: 0, y: 0 }] }],
      noteText: undefined,
    });

    await click(button(host, "Blue"));
    await click(button(host, "7 pixels"));
    await pointer(svg, "pointerdown", 200, 100);
    await pointer(svg, "pointerup", 200, 100);
    await click(button(host, "Save annotation"));
    await flush();
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/assets/asset-1/annotations", {
      strokes: [{ color: "#2f6df0", width: 7, points: [{ x: 0.5, y: 0.5 }] }],
      noteText: undefined,
    });
  });

  it("2. renders saved and draft strokes with today's exact SVG", async () => {
    const saved = annotation("ann-1", { strokeR2Key: "key" });
    configureAnnotations([saved], [
      { points: [{ x: 0.2, y: 0.3 }], color: "#e64b3c", width: 6 },
      { points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 }, { x: 0.9, y: 0.2 }], color: "#2f6df0", width: 4 },
    ]);
    const host = mount();
    await render(<Lightbox {...baseProps({ canAnnotate: false })} />);
    await flush();
    await openReviewPanel(host);
    const group = host.querySelector<SVGGElement>('[data-annotation-id="ann-1"]')!;
    expect(group.outerHTML).toMatchInlineSnapshot(`"<g data-annotation-id="ann-1" style="pointer-events: auto; cursor: pointer; opacity: 1;"><g><circle cx="0.2" cy="0.3" r="0.03" fill="transparent" style="pointer-events: fill;"></circle><circle cx="0.2" cy="0.3" r="0.01" fill="#e64b3c" opacity="0.82" class="stroke-vis" data-testid="lightbox-stroke"></circle></g><g><polyline points="0.1,0.1 0.5,0.4 0.9,0.2" fill="none" stroke="transparent" stroke-width="16" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: stroke;"></polyline><polyline points="0.1,0.1 0.5,0.4 0.9,0.2" fill="none" stroke="#2f6df0" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" opacity="0.82" class="stroke-vis" data-testid="lightbox-stroke"></polyline></g></g>"`);
    // Highlighted (photographer selected it): opacity 1 instead of 0.82.
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    await click(group.querySelector("circle, polyline")!);
    const highlighted = host.querySelector<SVGGElement>('[data-annotation-id="ann-1"]')!;
    expect([...highlighted.querySelectorAll('[data-testid="lightbox-stroke"]')].map((node) => node.getAttribute("opacity"))).toEqual(["1", "1"]);
    const svg = host.querySelector<SVGSVGElement>('[data-testid="lightbox-markup"]')!;
    expect(svg.outerHTML.startsWith('<svg class="markup-svg" data-testid="lightbox-markup" viewBox="0 0 1 1" preserveAspectRatio="none"')).toBe(true);
    expect(svg.getAttribute("style")).toBe("pointer-events: none; cursor: default; touch-action: none;");
  });

  it("2b. draft strokes render at full opacity with no hit target, the annotator svg takes pointer events", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 150, 100);
    await pointer(svg, "pointerup", 150, 100);
    await pointer(svg, "pointerdown", 110, 60);
    await pointer(svg, "pointermove", 290, 140);
    await pointer(svg, "pointerup", 290, 140);
    expect(svg.getAttribute("style")).toBe("pointer-events: auto; cursor: crosshair; touch-action: none;");
    expect(svg.innerHTML).toMatchInlineSnapshot(`"<circle cx="0.25" cy="0.5" r="0.006666666666666667" fill="#e64b3c" opacity="1" class="stroke-vis" data-testid="lightbox-stroke"></circle><polyline points="0.05,0.1 0.95,0.9" fill="none" stroke="#e64b3c" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" opacity="1" class="stroke-vis" data-testid="lightbox-stroke"></polyline>"`);
  });

  it("3. Edit drawing preloads a deep copy, and Save PATCHes the preload plus the new stroke", async () => {
    const saved = annotation("ann-1", { strokeR2Key: "key" });
    const original: Stroke[] = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], color: "#3f8f5a", width: 2 }];
    configureAnnotations([saved], original);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await click(button(host, "Edit drawing"));
    expect(host.querySelector('[data-testid="lightbox-markup-toolbar"]')!.textContent).toContain("Editing drawing");
    expect(strokeCount(host)).toBe(1);                       // the saved copy is hidden; one draft preload shows
    expect(draftPolylines(host)).toHaveLength(1);
    await pointer(svg, "pointerdown", 200, 100);
    await pointer(svg, "pointermove", 220, 110);
    await pointer(svg, "pointerup", 220, 110);
    await click(button(host, "Save"));
    await flush(12);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenLastCalledWith("/api/annotations/ann-1", {
      strokes: [
        { points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], color: "#3f8f5a", width: 2 },
        { color: "#e64b3c", width: 4, points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }] },
      ],
    });
  });

  it("3b. cancelling an edit leaves the saved drawing exactly as it was", async () => {
    const saved = annotation("ann-1", { strokeR2Key: "key" });
    configureAnnotations([saved], [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], color: "#3f8f5a", width: 2 }]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    const before = host.querySelector('[data-annotation-id="ann-1"]')!.outerHTML;
    await click(button(host, "Edit drawing"));
    await pointer(svg, "pointerdown", 200, 100);
    await pointer(svg, "pointermove", 220, 110);
    await pointer(svg, "pointerup", 220, 110);
    await click(button(host, "Cancel"));
    await flush();
    expect(host.querySelector('[data-annotation-id="ann-1"]')!.outerHTML).toBe(before);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  // 6s: deliberate change, was "saving with the pointer still down": a stroke is now a draft only once the pointer is released
  // (it lives in the hook's `active` until then), so Save is not reachable mid-gesture; the invariant under test, that a save
  // never clears newer work, is unchanged.
  it("4. a save in flight never clears newer work; saving with nothing newer clears it", async () => {
    const pending = deferredPromise<unknown>();
    apiPostMock.mockReturnValueOnce(pending.promise);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 100, 50);
    await pointer(svg, "pointermove", 200, 100);
    await pointer(svg, "pointerup", 200, 100);
    await click(button(host, "Save annotation"));            // stroke A is a draft: the POST goes out and stays in flight
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect((apiPostMock.mock.calls[0]![1] as { strokes: Stroke[] }).strokes).toHaveLength(1);
    await pointer(svg, "pointerdown", 300, 150);              // the draft moves on while the POST is in flight
    await pointer(svg, "pointermove", 100, 150);
    await pointer(svg, "pointerup", 100, 150);
    pending.resolve({ id: "created", authorId: "user-1", author: { id: "A", name: "A", role: "editor" }, scope: "edited", strokeR2Key: null, noteText: null, createdAt: new Date().toISOString(), editedAt: null });
    await flush(12);
    expect(strokeCount(host)).toBe(2);                        // the newer stroke B survived the save (A is still in the draft too)
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0,0 0.5,0.5", "1,1 0,1"]);

    await click(button(host, "Save annotation"));             // nothing newer this time
    await flush(12);
    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(strokeCount(host)).toBe(0);
  });

  it("5. pointer leave ends the stroke, the next down starts a new one, and a move with no down adds nothing", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointermove", 150, 100);
    expect(strokeCount(host)).toBe(0);
    await pointer(svg, "pointerdown", 100, 50);
    await pointer(svg, "pointermove", 200, 100);
    await pointer(svg, "pointerout", 200, 100);               // React turns a pointerout to nowhere into onPointerLeave
    await pointer(svg, "pointermove", 300, 150);
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0,0 0.5,0.5"]);
    await pointer(svg, "pointerdown", 300, 150);
    await pointer(svg, "pointermove", 100, 150);
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0,0 0.5,0.5", "1,1 0,1"]);
  });

  // 6s: deliberate change, was "two pointers interleave into the newest stroke": a gesture now follows one pointer, so a second finger is ignored.
  it("6. a second pointer is ignored for the whole gesture", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 100, 50, 1);
    await pointer(svg, "pointermove", 200, 100, 1);
    await pointer(svg, "pointerdown", 300, 150, 2);           // a second finger does not start a second stroke
    await pointer(svg, "pointermove", 100, 150, 1);           // finger 1 keeps extending its own stroke
    await pointer(svg, "pointermove", 200, 50, 2);            // finger 2's moves add nothing
    await pointer(svg, "pointerup", 200, 50, 2);              // and its lifting does not end finger 1's gesture
    await pointer(svg, "pointermove", 300, 50, 1);
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0,0 0.5,0.5 0,1 1,0"]);
    await pointer(svg, "pointerup", 300, 50, 1);
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0,0 0.5,0.5 0,1 1,0"]);
  });

  it("7. a zoomed drag normalises against the frame rect read at pointer time", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    for (let i = 0; i < 4; i += 1) await click(button(host, "Zoom in"));
    const frame = host.querySelector<HTMLElement>('[data-testid="lightbox-canvas"]')!;
    expect(frame.style.transform).toContain("scale(2)");
    const rect = stubFrameRect(host, { left: -100, top: -50, width: 400, height: 200 });  // the transformed (scale 2) frame
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 0, 0);
    rect.set({ left: -300, top: -150, width: 400, height: 200 });                        // panned between events: read live, not cached
    await pointer(svg, "pointermove", -100, -50);
    await pointer(svg, "pointermove", 700, 450);                                         // clamps to 1,1 against the new rect
    await pointer(svg, "pointerup", 700, 450);
    expect(draftPolylines(host).map((node) => node.getAttribute("points"))).toEqual(["0.25,0.25 0.5,0.5 1,1"]);
  });

  // 6s: deliberate change, was "yields NaN for 0/0": a non-finite sample is now ignored, so a zero-size frame rect draws nothing.
  it("7b. a degenerate (zero-size) frame rect draws nothing", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    const svg = svgOf(host);
    stubFrameRect(host, { left: 0, top: 0, width: 0, height: 0 });
    await pointer(svg, "pointerdown", 0, 0);
    await pointer(svg, "pointerup", 0, 0);
    expect(strokeCount(host)).toBe(0);
  });

  it("an annotator's Escape still discards the strokes (the photo behaviour 6b deliberately does not copy)", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 150, 100);
    await pointer(svg, "pointerup", 150, 100);
    expect(strokeCount(host)).toBe(1);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(strokeCount(host)).toBe(0);
  });
});
