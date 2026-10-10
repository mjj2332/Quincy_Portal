/** #741 slice 6s-ui: shapes, undo/redo keys and the shared toolbar wired into the photo Lightbox. */
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
  return { ...actual, apiGet: (p: string) => apiGetMock(p), apiPost: (p: string, b: unknown) => apiPostMock(p, b), apiPatch: (p: string, b: unknown) => apiPatchMock(p, b) };
});

function workspaceAsset(id: string): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}
function baseProps(overrides: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const asset = workspaceAsset("asset-1");
  return { assets: [asset], rawAssets: [], initialAssetId: asset.id, collectionKind: "edited" as const, canReview: true, canRecommend: true, canAnnotate: true, onClose: vi.fn(), onReview: vi.fn().mockResolvedValue(undefined), onToast: vi.fn(), ...overrides };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render(value: ReactNode) { await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); }); }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); }); }
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll<HTMLElement>("button")].find((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  if (!found) throw new Error(`No button: ${text}`);
  return found;
}
type Rect = { left: number; top: number; width: number; height: number };
const RECT: Rect = { left: 100, top: 50, width: 200, height: 100 };
function stubFrameRect(host: HTMLElement, rect: Rect) {
  const frame = host.querySelector<HTMLElement>('[data-testid="lightbox-canvas"]')!;
  frame.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
}
function svgOf(host: HTMLElement) {
  const svg = host.querySelector<SVGSVGElement>('[data-testid="lightbox-markup"]')!;
  (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  return svg;
}
async function pointer(svg: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, pointerId = 1) {
  await act(async () => { svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX: x, clientY: y })); await Promise.resolve(); });
}
async function drag(svg: Element, from: [number, number], to: [number, number]) {
  await pointer(svg, "pointerdown", ...from); await pointer(svg, "pointermove", ...to); await pointer(svg, "pointerup", ...to);
}
async function key(init: KeyboardEventInit & { key: string }) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); await Promise.resolve(); });
}
const strokeCount = (host: HTMLElement) => host.querySelectorAll('[data-testid="lightbox-markup"] [data-testid="lightbox-stroke"]').length;
async function setup(extra: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const host = mount();
  await render(<Lightbox {...baseProps(extra)} />);
  stubFrameRect(host, RECT);
  return { host, svg: svgOf(host) };
}

beforeEach(() => {
  window.innerWidth = 1280;
  confirmMock.mockReset().mockResolvedValue(true);
  apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset();
  apiGetMock.mockImplementation((path) => path.includes("/annotations") ? Promise.resolve({ annotations: [] }) : Promise.resolve({}));
  apiPostMock.mockResolvedValue({ id: "created", authorId: "user-1", author: { id: "A", name: "A", role: "editor" }, scope: "edited", strokeR2Key: null, noteText: null, createdAt: new Date().toISOString(), editedAt: null });
  apiPatchMock.mockResolvedValue({ noteText: null, editedAt: new Date().toISOString() });
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("Lightbox markup shapes", () => {
  it.each([["Arrow", "arrow"], ["Line", "line"], ["Rectangle", "rectangle"]])("a %s drag POSTs type %s with [start, end] as dragged", async (label, type) => {
    const { host, svg } = await setup();
    await click(button(host, "Blue")); await click(button(host, "7 pixels")); await click(button(host, label));
    await drag(svg, [280, 140], [120, 60]);                   // dragged up and to the left on purpose
    await click(button(host, "Save annotation")); await flush();
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/assets/asset-1/annotations", {
      strokes: [{ type, color: "#2f6df0", width: 7, points: [{ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.1 }] }],
      noteText: undefined,
    });
  });

  it("a shape tap draws nothing; a freehand tap still draws a dot", async () => {
    const { host, svg } = await setup();
    await click(button(host, "Line"));
    await pointer(svg, "pointerdown", 150, 100); await pointer(svg, "pointerup", 150, 100);
    expect(strokeCount(host)).toBe(0);
    await click(button(host, "Pen"));
    await pointer(svg, "pointerdown", 150, 100); await pointer(svg, "pointerup", 150, 100);
    expect(strokeCount(host)).toBe(1);
  });

  it("previews the shape live as the last bare child of the layer, and commits it on release", async () => {
    const { host, svg } = await setup();
    await click(button(host, "Line"));
    await pointer(svg, "pointerdown", 110, 60); await pointer(svg, "pointermove", 290, 140);
    const live = svg.querySelector(':scope > line[data-testid="lightbox-stroke"]')!;
    expect(live.getAttribute("x2")).toBe("0.95");
    expect(svg.lastElementChild).toBe(live);
    await pointer(svg, "pointerup", 290, 140);
    expect(strokeCount(host)).toBe(1);
  });

  it("Escape mid-shape draws nothing", async () => {
    const { host, svg } = await setup();
    await click(button(host, "Rectangle"));
    await pointer(svg, "pointerdown", 110, 60); await pointer(svg, "pointermove", 290, 140);
    await key({ key: "Escape" });
    await pointer(svg, "pointerup", 290, 140);
    expect(strokeCount(host)).toBe(0);
  });

  it("keeps review keys inert while the first stroke is still being drawn", async () => {
    const props = baseProps();
    const host = mount();
    await render(<Lightbox {...props} />);
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await pointer(svg, "pointerdown", 110, 60); await pointer(svg, "pointermove", 200, 100);
    await key({ key: "a" }); await key({ key: "3" });
    expect(props.onReview).not.toHaveBeenCalled();
    await pointer(svg, "pointerup", 200, 100);
  });
});

describe("Lightbox undo and redo keys", () => {
  async function drawThree(svg: Element) {
    await drag(svg, [110, 60], [150, 90]); await drag(svg, [120, 70], [200, 120]); await drag(svg, [130, 80], [250, 130]);
  }

  it("Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Ctrl+Y redo, and Shift+Cmd+Z is not an undo", async () => {
    const { host, svg } = await setup();
    await drawThree(svg);
    expect(strokeCount(host)).toBe(3);
    await key({ key: "z", metaKey: true }); expect(strokeCount(host)).toBe(2);
    await key({ key: "z", ctrlKey: true }); expect(strokeCount(host)).toBe(1);
    await key({ key: "Z", metaKey: true, shiftKey: true }); expect(strokeCount(host)).toBe(2);
    await key({ key: "Z", ctrlKey: true, shiftKey: true }); expect(strokeCount(host)).toBe(3);
    await key({ key: "z", metaKey: true }); await key({ key: "z", metaKey: true });
    expect(strokeCount(host)).toBe(1);
    await key({ key: "y", ctrlKey: true }); expect(strokeCount(host)).toBe(2);
    await key({ key: "y", metaKey: true }); expect(strokeCount(host)).toBe(2);       // Cmd+Y is History on macOS: never redo
    await key({ key: "Z", metaKey: true, shiftKey: true }); await key({ key: "Z", metaKey: true, shiftKey: true });
    expect(strokeCount(host)).toBe(3);                                               // nothing left to redo, and it did not undo
  });

  it("redo works after undoing everything, when no draft is left", async () => {
    const { host, svg } = await setup();
    await drag(svg, [110, 60], [150, 90]);
    await key({ key: "z", metaKey: true });
    expect(strokeCount(host)).toBe(0);
    await key({ key: "a" });                                                         // not a draft: review keys are live again
    await key({ key: "Z", metaKey: true, shiftKey: true });
    expect(strokeCount(host)).toBe(1);
  });

  it("Clear is undoable in one step", async () => {
    const { host, svg } = await setup();
    await drawThree(svg);
    await click(button(host, "Clear"));
    expect(strokeCount(host)).toBe(0);
    await key({ key: "z", metaKey: true });
    expect(strokeCount(host)).toBe(3);
  });

  it("the Undo and Redo buttons do the same, and are disabled when there is nothing to do", async () => {
    const { host, svg } = await setup();
    expect((button(host, "Undo") as HTMLButtonElement).disabled).toBe(true);
    expect((button(host, "Redo") as HTMLButtonElement).disabled).toBe(true);
    await drag(svg, [110, 60], [150, 90]);
    await click(button(host, "Undo"));
    expect((button(host, "Redo") as HTMLButtonElement).disabled).toBe(false);
    await click(button(host, "Redo"));
    expect(strokeCount(host)).toBe(1);
  });

  it("does not undo while typing in the note field", async () => {
    const { host, svg } = await setup();
    await drag(svg, [110, 60], [150, 90]);
    const textarea = document.createElement("textarea"); document.body.appendChild(textarea);
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    expect(strokeCount(host)).toBe(1);
  });

  it("shows the redo shortcut in the hint pill while drawing", async () => {
    const { host, svg } = await setup();
    await drag(svg, [110, 60], [150, 90]);
    expect(host.textContent).toContain("⇧⌘Z");
  });
});

describe("Lightbox Edit drawing with shapes", () => {
  it("keeps each shape's type through the preload and the PATCH, and adds the new shape", async () => {
    const saved = { id: "ann-1", authorId: "user-1", author: { id: "user-1", name: "A", role: "editor" }, scope: "edited", strokeR2Key: "key", noteText: "Saved", createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };
    const original = [{ type: "arrow", points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }], color: "#3f8f5a", width: 2 }, { points: [{ x: 0.2, y: 0.2 }], color: "#000", width: 2 }];
    apiGetMock.mockImplementation((path) => path.includes("/annotations") ? Promise.resolve({ annotations: [saved] }) : path.includes("/media/annotation/") ? Promise.resolve(original) : Promise.resolve({}));
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await click(host.querySelector('[data-testid="lightbox-review-trigger"]')!);
    await flush();
    await click(button(host, "Edit drawing")); await flush();
    stubFrameRect(host, RECT);
    const svg = svgOf(host);
    await click(button(host, "Rectangle"));
    await drag(svg, [120, 60], [200, 120]);
    await click(button(host, "Save")); await flush(12);
    expect(apiPatchMock).toHaveBeenLastCalledWith("/api/annotations/ann-1", {
      strokes: [original[0], original[1], { type: "rectangle", color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.7 }] }],
    });
  });
});

describe("Lightbox markup toolbar", () => {
  it("holds the hint pill and the toolbar in one bottom-anchored stack", async () => {
    const { host } = await setup();
    const toolbar = host.querySelector('[data-testid="lightbox-markup-toolbar"]')!;
    const stack = toolbar.parentElement!;
    expect(stack.getAttribute("data-testid")).toBe("lightbox-markup-stack");
    expect(stack.querySelector('[aria-hidden="true"]')?.textContent).toContain("Esc");
  });

  it("names the tool radios, colours and widths in the Lightbox", async () => {
    const { host } = await setup();
    expect(host.querySelector('[role="radiogroup"][aria-label="Markup tool"]')).not.toBeNull();
    expect(host.querySelectorAll('[aria-label="Pen colour"] button')).toHaveLength(6);
    expect(host.querySelectorAll('[aria-label="Stroke width"] button')).toHaveLength(3);
  });

  it("uses the compact toolbar on a phone: icon-only history and one width-cycle button", async () => {
    window.innerWidth = 390;
    const { host } = await setup();
    expect(host.querySelector('[aria-label="Stroke width"]')).toBeNull();
    expect(button(host, "Stroke width, 4 pixels")).toBeTruthy();
    expect(button(host, "Undo").textContent?.trim()).toBe("");
  });

  it("an unchanged persisted tool survives switching assets", async () => {
    const props = baseProps({ assets: [workspaceAsset("asset-1"), workspaceAsset("asset-2")] });
    const host = mount();
    await render(<Lightbox {...props} />);
    await click(button(host, "Line")); await click(button(host, "Blue"));
    await click(host.querySelector('button[aria-label="Next frame"]')!); await flush();
    expect(button(host, "Line").getAttribute("aria-checked")).toBe("true");
    expect(button(host, "Blue").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Lightbox saving mid-gesture", () => {
  async function editing() {
    const saved = { id: "ann-1", authorId: "user-1", author: { id: "user-1", name: "A", role: "editor" }, scope: "edited", strokeR2Key: "key", noteText: "Saved", createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path) => path.includes("/annotations") ? Promise.resolve({ annotations: [saved] }) : path.includes("/media/annotation/") ? Promise.resolve([{ points: [{ x: 0.2, y: 0.2 }], color: "#000", width: 2 }]) : Promise.resolve({}));
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await click(host.querySelector('[data-testid="lightbox-review-trigger"]')!);
    await flush();
    await click(button(host, "Edit drawing")); await flush();
    stubFrameRect(host, RECT);
    return { host, svg: svgOf(host) };
  }

  it("disables Save while a stroke is unfinished, and a click then sends nothing and discards nothing", async () => {
    const { host, svg } = await editing();
    await pointer(svg, "pointerdown", 110, 60); await pointer(svg, "pointermove", 200, 100);
    expect((button(host, "Save") as HTMLButtonElement).disabled).toBe(true);
    await click(button(host, "Save"));
    expect(apiPatchMock).not.toHaveBeenCalled();
    await pointer(svg, "pointerup", 200, 100);
    expect((button(host, "Save") as HTMLButtonElement).disabled).toBe(false);
    await click(button(host, "Save")); await flush(12);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect((apiPatchMock.mock.calls[0]![1] as { strokes: unknown[] }).strokes).toHaveLength(2);
  });

  it("disables Save annotation while a new stroke is unfinished", async () => {
    const { host, svg } = await setup();
    await pointer(svg, "pointerdown", 110, 60); await pointer(svg, "pointermove", 200, 100);
    await click(host.querySelector('[data-testid="lightbox-review-trigger"]')!);
    expect((button(host, "Save annotation") as HTMLButtonElement).disabled).toBe(true);
    await click(button(host, "Save annotation"));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("sizes Cancel and Save for a coarse pointer above the phone width", async () => {
    const { host } = await editing();
    for (const name of ["Cancel", "Save"]) expect(button(host, name).className).toContain("min-[721px]:pointer-coarse:min-h-11");
  });
});
