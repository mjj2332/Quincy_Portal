import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";
import type { WorkspaceAsset } from "./PhotoGrid";

vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }),
}));

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

function workspaceAsset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`,
    bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
    createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
    supersedesAssetId: null, review: null, selected: false, ...overrides,
  };
}

type TestAnnotation = {
  id: string;
  authorId: string;
  author: { id: string; name: string; role: string };
  scope: "raw" | "edited";
  strokeR2Key: string | null;
  noteText: string | null;
  createdAt: string;
  editedAt: string | null;
};

function annotation(id: string, overrides: Partial<TestAnnotation> = {}): TestAnnotation {
  return {
    id, authorId: "user-1", author: { id: "user-1", name: "A", role: "editor" },
    scope: "edited", strokeR2Key: null, noteText: "Saved note",
    createdAt: "2026-07-28T00:00:00.000Z", editedAt: null, ...overrides,
  };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

// `selectAnnotation()` itself has an internal `if (canAnnotate) return;` guard, so any test that
// only observes *its* side effects (scrollIntoView, highlight state) can't tell "onClick correctly
// omitted" apart from "onClick still attached, but the inner guard happened to catch it" — both
// look identical from the outside. Reading the actual `onClick` prop straight off the fiber (React
// stashes the current props object on the DOM node under a `__reactProps$...` key) tests handler
// *presence* directly, independent of what the handler does once called.
function reactOnClick(node: Element): unknown {
  const key = Object.keys(node).find((item) => item.startsWith("__reactProps$"));
  if (!key) throw new Error("No React props found on node — component may not be mounted");
  return (node as unknown as Record<string, { onClick?: unknown }>)[key]!.onClick;
}

async function drawOneStroke(host: HTMLElement) {
  const svg = host.querySelector(".markup-svg")!;
  (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  await act(async () => {
    svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10 }));
    await Promise.resolve();
  });
}

function draftStrokeCount(host: HTMLElement) {
  return host.querySelectorAll(".markup-svg .stroke-vis").length;
}

function baseProps(overrides: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const asset = workspaceAsset("asset-1");
  return {
    assets: [asset], rawAssets: [], initialAssetId: asset.id, collectionKind: "edited" as const,
    canReview: true, canRecommend: true, canAnnotate: true,
    onClose: vi.fn(), onReview: vi.fn().mockResolvedValue(undefined), onToast: vi.fn(),
    ...overrides,
  };
}

async function openReviewPanel(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>(".viewer__panel-trigger");
  if (!trigger) throw new Error("No Review panel trigger found");
  await click(trigger);
}

function topNote(host: HTMLElement) {
  const note = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional note for this markup…"]');
  if (!note) throw new Error("No top-level markup note");
  return note;
}

function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  if (!found) throw new Error(`No button: ${text}`);
  return found;
}

function configureAnnotations(items: TestAnnotation[]) {
  apiGetMock.mockImplementation((path) => {
    if (path.includes("/annotations")) return Promise.resolve({ annotations: items });
    if (path.includes("/media/annotation/")) return Promise.resolve([{ points: [{ x: 0.2, y: 0.2 }], color: "#000", width: 2 }]);
    return Promise.resolve({});
  });
}

beforeEach(() => {
  window.innerWidth = 1024;
  window.confirm = vi.fn(() => true);
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiGetMock.mockImplementation((path) => path.includes("/annotations") ? Promise.resolve({ annotations: [] }) : Promise.resolve({}));
  apiPostMock.mockResolvedValue({
    id: "created", authorId: "user-1", author: { id: "A", name: "A", role: "editor" },
    scope: "edited", strokeR2Key: null, noteText: null, createdAt: new Date().toISOString(), editedAt: null,
  });
  apiPatchMock.mockResolvedValue({ noteText: "Updated note", editedAt: new Date().toISOString() });
});

afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Lightbox — always-on drawing and draft protection", () => {
  it("is draw-ready immediately for annotators, with no Draw button, and no confirm prompt with no inline edit open", async () => {
    const host = mount();
    const confirm = vi.spyOn(window, "confirm");
    await render(<Lightbox {...baseProps()} />);
    expect([...host.querySelectorAll("button")].some((item) => item.textContent?.includes("Draw"))).toBe(false);
    expect(host.querySelector(".drawbar")).not.toBeNull();
    await drawOneStroke(host);
    expect(draftStrokeCount(host)).toBe(1);
    expect(confirm).not.toHaveBeenCalled(); // the common path — no inline edit open — never prompts at all
  });

  it("keeps the markup note enabled and typable before and after drawing", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    const note = topNote(host);
    expect(note.disabled).toBe(false);
    await typeInto(note, "before drawing");
    expect(note.value).toBe("before drawing");
    await drawOneStroke(host);
    expect(note.disabled).toBe(false);
    await typeInto(note, "after drawing");
    expect(note.value).toBe("after drawing");
  });

  it("undoes with Cmd/Ctrl+Z and safely does nothing with no strokes", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await keydown(window, { key: "z", metaKey: true });
    expect(draftStrokeCount(host)).toBe(0);
    await drawOneStroke(host);
    expect(draftStrokeCount(host)).toBe(1);
    await keydown(window, { key: "z", ctrlKey: true });
    expect(draftStrokeCount(host)).toBe(0);
  });

  it("protects a blurred note-only draft from frame and review shortcuts", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const host = mount();
    await render(<Lightbox {...baseProps({ assets, onReview })} />);
    await openReviewPanel(host);
    const note = topNote(host);
    await typeInto(note, "note only");
    note.blur();
    await keydown(window, { key: "ArrowRight" });
    await keydown(window, { key: "a" });
    expect(host.textContent).toContain("Frame 1 of 2");
    expect(onReview).not.toHaveBeenCalled();
    expect(note.value).toBe("note only");
  });

  it("discards strokes, notes, and inline edits on Escape, but closes when idle", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    const note = topNote(host);
    await typeInto(note, "discard me");
    note.blur();
    await drawOneStroke(host);
    await keydown(window, { key: "Escape" });
    expect(draftStrokeCount(host)).toBe(0);
    expect(note.value).toBe("");
    const onClose = vi.fn();
    await unmount();
    document.body.replaceChildren();
    const idleHost = mount();
    await render(<Lightbox {...baseProps({ onClose })} />);
    await keydown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("preserves the focus caveat: Escape in the note field is a no-op until blur", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    const note = topNote(host);
    await typeInto(note, "keep me");
    note.focus();
    await keydown(note, { key: "Escape" });
    expect(note.value).toBe("keep me");
    expect(note.disabled).toBe(false);
    note.blur();
    await keydown(window, { key: "Escape" });
    expect(note.value).toBe("");
  });

  it("discards an in-progress inline annotation-note edit on Escape", async () => {
    const saved = annotation("ann-1", { noteText: "old" });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Edit note"));
    const inline = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit annotation note"]')!;
    await typeInto(inline, "unsaved inline edit");
    inline.blur();
    await keydown(window, { key: "Escape" });
    expect(host.querySelector('textarea[aria-label="Edit annotation note"]')).toBeNull();
    expect(host.textContent).toContain("old"); // the saved note is unchanged — nothing was submitted
  });

  it("confirm-gates drawing over an inline note edit and keeps the new stroke only when confirmed", async () => {
    const saved = annotation("ann-1", { noteText: "old" });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Edit note"));
    const inline = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit annotation note"]')!;
    await typeInto(inline, "unsaved edit");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await drawOneStroke(host);
    expect(draftStrokeCount(host)).toBe(0);
    expect(inline.value).toBe("unsaved edit");
    confirm.mockReturnValue(true);
    await drawOneStroke(host);
    expect(host.querySelector('textarea[aria-label="Edit annotation note"]')).toBeNull();
    expect(draftStrokeCount(host)).toBe(1);
  });

  it("confirm-gates previous/next, filmstrip selection, and close while a draft exists, declining blocks all three", async () => {
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const onClose = vi.fn();
    const host = mount();
    await render(<Lightbox {...baseProps({ assets, onClose })} />);
    await drawOneStroke(host);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(button(host, "Next frame"));
    expect(host.textContent).toContain("Frame 1 of 2");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="asset-2.jpg"]')!);
    expect(host.textContent).toContain("Frame 1 of 2");
    await click(button(host, "Close"));
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("accepting the confirm lets Next frame, filmstrip selection, and Close each proceed", async () => {
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const nextHost = mount();
    await render(<Lightbox {...baseProps({ assets })} />);
    await drawOneStroke(nextHost);
    await click(button(nextHost, "Next frame"));
    expect(nextHost.textContent).toContain("Frame 2 of 2");
    await unmount();
    document.body.replaceChildren();

    const filmstripHost = mount();
    await render(<Lightbox {...baseProps({ assets })} />);
    await drawOneStroke(filmstripHost);
    await click(filmstripHost.querySelector<HTMLButtonElement>('button[aria-label="asset-2.jpg"]')!);
    expect(filmstripHost.textContent).toContain("Frame 2 of 2");
    await unmount();
    document.body.replaceChildren();

    const onClose = vi.fn();
    const closeHost = mount();
    await render(<Lightbox {...baseProps({ assets, onClose })} />);
    await drawOneStroke(closeHost);
    await click(button(closeHost, "Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not prompt at all for Next frame, filmstrip selection, or Close with no draft", async () => {
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    const host = mount();
    await render(<Lightbox {...baseProps({ assets, onClose })} />);
    await click(button(host, "Next frame"));
    expect(host.textContent).toContain("Frame 2 of 2");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="asset-1.jpg"]')!);
    expect(host.textContent).toContain("Frame 1 of 2");
    await click(button(host, "Close"));
    expect(onClose).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("also confirm-gates navigation for an active inline annotation edit", async () => {
    const saved = annotation("ann-1");
    configureAnnotations([saved]);
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const host = mount();
    await render(<Lightbox {...baseProps({ assets })} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Edit note"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(button(host, "Next frame"));
    expect(host.textContent).toContain("Frame 1 of 2");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="asset-2.jpg"]')!);
    expect(host.textContent).toContain("Frame 1 of 2");
    await click(button(host, "Close"));
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("gates the note field and Save annotation during the two existing-edit flows", async () => {
    const saved = annotation("ann-1", { noteText: null });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Add drawing"));
    expect(topNote(host).disabled).toBe(true);
    expect(button(host, "Save annotation").disabled).toBe(true);
    await click(button(host, "Cancel"));
    await click(button(host, "Edit note"));
    expect(topNote(host).disabled).toBe(true);
  });

  it("keeps the active inline editor usable while other annotation actions stay disabled", async () => {
    const first = annotation("ann-1", { noteText: "first" });
    const second = annotation("ann-2", { noteText: "second" });
    configureAnnotations([first, second]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Edit note"));
    const inline = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit annotation note"]')!;
    expect(inline.disabled).toBe(false);
    await typeInto(inline, "changed");
    const otherButtons = [...host.querySelectorAll<HTMLButtonElement>(".comment-reply")].filter((item) => item.textContent?.trim() === "Edit note" || item.textContent?.trim() === "Add drawing" || item.textContent?.trim() === "Delete");
    expect(otherButtons.length).toBeGreaterThan(0);
    expect(otherButtons.every((item) => item.disabled)).toBe(true);
    await click(button(host, "Save"));
    expect(apiPatchMock).toHaveBeenCalled();
  });

  function otherAnnotationButtons(host: HTMLElement) {
    return [...host.querySelectorAll<HTMLButtonElement>(".comment-reply")].filter((item) => item.textContent?.trim() === "Edit note" || item.textContent?.trim() === "Add drawing" || item.textContent?.trim() === "Delete");
  }

  it("also disables other annotations' actions while a new, unsaved stroke draft exists (not just during an inline edit)", async () => {
    const saved = annotation("ann-1", { noteText: "existing" });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await drawOneStroke(host);
    const otherButtons = otherAnnotationButtons(host);
    expect(otherButtons.length).toBeGreaterThan(0);
    expect(otherButtons.every((item) => item.disabled)).toBe(true);
    await keydown(window, { key: "Escape" }); // discard the draft
    expect(otherAnnotationButtons(host).every((item) => item.disabled)).toBe(false); // re-enabled once the draft is gone
  });

  it("also disables other annotations' actions for a note-only draft, and re-enables them once it's saved", async () => {
    const saved = annotation("ann-1", { noteText: "existing" });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    await typeInto(topNote(host), "a note, no drawing");
    const otherButtons = otherAnnotationButtons(host);
    expect(otherButtons.length).toBeGreaterThan(0);
    expect(otherButtons.every((item) => item.disabled)).toBe(true);
    await click(button(host, "Save annotation"));
    await flush();
    expect(otherAnnotationButtons(host).every((item) => item.disabled)).toBe(false); // re-enabled once the note-only draft is saved
  });

  it("does not pan or swipe for annotators, but retains both for photographers and preserves click-to-select", async () => {
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const host = mount();
    await render(<Lightbox {...baseProps({ assets })} />);
    await openReviewPanel(host);
    await click(button(host, "Zoom in"));
    const canvas = host.querySelector<HTMLElement>(".canvasframe")!;
    (canvas as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    const before = canvas.style.transform;
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 100, clientY: 100 }));
    expect(canvas.style.transform).toBe(before);

    await unmount();
    document.body.replaceChildren();
    const saved = annotation("ann-1", { strokeR2Key: "key" });
    configureAnnotations([saved]);
    const photographerHost = mount();
    await render(<Lightbox {...baseProps({ assets, canAnnotate: false })} />);
    await flush();
    expect(photographerHost.querySelector(".drawbar")).toBeNull();
    expect(photographerHost.querySelector('textarea[placeholder="Optional note for this markup…"]')).toBeNull();
    const photographerCanvas = photographerHost.querySelector<HTMLElement>(".canvasframe")!;
    await openReviewPanel(photographerHost);
    await click(button(photographerHost, "Zoom in"));
    const photographerBefore = photographerCanvas.style.transform;
    await act(async () => {
      photographerCanvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 10, clientY: 10 }));
      photographerCanvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 100, clientY: 100 }));
      await Promise.resolve();
    });
    expect(photographerCanvas.style.transform).not.toBe(photographerBefore);
  });

  function twoFingerTouch(target: Element, type: string, points: [number, number][]) {
    const touches = points.map((point, index) => new Touch({ identifier: index, target, clientX: point[0], clientY: point[1] }));
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: touches, targetTouches: touches } as TouchEventInit));
  }

  it("does not pinch-zoom for annotators, but retains it for photographers", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    const canvas = host.querySelector<HTMLElement>(".canvasframe")!;
    const before = canvas.style.transform;
    await act(async () => {
      twoFingerTouch(canvas, "touchstart", [[10, 10], [20, 20]]);
      twoFingerTouch(canvas, "touchmove", [[10, 10], [60, 60]]);
      await Promise.resolve();
    });
    expect(canvas.style.transform).toBe(before);

    await unmount();
    document.body.replaceChildren();
    const photographerHost = mount();
    await render(<Lightbox {...baseProps({ canAnnotate: false })} />);
    const photographerCanvas = photographerHost.querySelector<HTMLElement>(".canvasframe")!;
    const photographerBefore = photographerCanvas.style.transform;
    await act(async () => {
      twoFingerTouch(photographerCanvas, "touchstart", [[10, 10], [20, 20]]);
      twoFingerTouch(photographerCanvas, "touchmove", [[10, 10], [60, 60]]);
      await Promise.resolve();
    });
    expect(photographerCanvas.style.transform).not.toBe(photographerBefore);
  });

  it("does not swipe-navigate frames for annotators, but retains it for photographers", async () => {
    const assets = [workspaceAsset("asset-1"), workspaceAsset("asset-2")];
    const host = mount();
    await render(<Lightbox {...baseProps({ assets })} />);
    const canvas = host.querySelector<HTMLElement>(".canvasframe")!;
    (canvas as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 4, pointerType: "touch", clientX: 300, clientY: 100 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 4, pointerType: "touch", clientX: 100, clientY: 100 }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Frame 1 of 2");

    await unmount();
    document.body.replaceChildren();
    const photographerHost = mount();
    await render(<Lightbox {...baseProps({ assets, canAnnotate: false })} />);
    const photographerCanvas = photographerHost.querySelector<HTMLElement>(".canvasframe")!;
    (photographerCanvas as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await act(async () => {
      photographerCanvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 5, pointerType: "touch", clientX: 300, clientY: 100 }));
      photographerCanvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 5, pointerType: "touch", clientX: 100, clientY: 100 }));
      await Promise.resolve();
    });
    expect(photographerHost.textContent).toContain("Frame 2 of 2");
  });

  it("does not select a saved stroke for annotators, but the click creates a new stroke; photographers still select it", async () => {
    const saved = annotation("ann-1", { strokeR2Key: "key" });
    configureAnnotations([saved]);
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await flush();
    const group = host.querySelector<SVGGElement>('[data-annotation-id="ann-1"]')!;
    const svg = host.querySelector(".markup-svg")!;
    (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    // The real, targeted assertion: the onClick prop itself is absent for a canAnnotate user —
    // independent of selectAnnotation's own internal guard, which would silently absorb an
    // accidentally-still-attached handler and make a behavior-only assertion a false oracle.
    expect(reactOnClick(group)).toBeUndefined();
    const annotatorScroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const hitTarget = group.querySelector("circle, polyline")!;
    // A real tap is pointerdown (which drawDown listens for) followed by a "click" (which the
    // group's conditional onClick listens for, when present) — dispatching only pointerdown, as an
    // earlier version of this test did, never exercises onClick at all.
    group.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 20, clientY: 20 }));
    await click(hitTarget);
    await flush();
    expect(host.querySelector(".cmt--highlighted")).toBeNull();
    expect(annotatorScroll).not.toHaveBeenCalled();
    expect(draftStrokeCount(host)).toBe(2); // drawDown still fired correctly, from the pointerdown
    annotatorScroll.mockRestore();

    await unmount();
    document.body.replaceChildren();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const photographerHost = mount();
    await render(<Lightbox {...baseProps({ canAnnotate: false })} />);
    await flush();
    await openReviewPanel(photographerHost); // annotationRefs only attach once the sidebar list actually renders
    const photographerGroup = photographerHost.querySelector<SVGGElement>('[data-annotation-id="ann-1"]')!;
    expect(typeof reactOnClick(photographerGroup)).toBe("function"); // the handler is genuinely attached, not just "truthy by accident"
    const photographerHit = photographerGroup.querySelector("circle, polyline")!;
    const strokeCountBeforeClick = draftStrokeCount(photographerHost);
    expect(strokeCountBeforeClick).toBe(1); // baseline: only the saved stroke, nothing drawn yet
    await click(photographerHit);
    expect(photographerGroup.getAttribute("style")).toContain("pointer-events: auto");
    expect(draftStrokeCount(photographerHost)).toBe(strokeCountBeforeClick); // unchanged — drawDown correctly never fires for a photographer
    expect(scroll).toHaveBeenCalled(); // selectAnnotation's own observable effect actually ran, not just a style check
    scroll.mockRestore();
  });

  it("does not auto-collapse an opened review panel on a phone", async () => {
    window.innerWidth = 600;
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await click(host.querySelector<HTMLButtonElement>(".vpanel__peek-handle")!);
    await flush();
    expect(host.querySelector(".vpanel.open")).not.toBeNull();
    expect(host.querySelector('textarea[placeholder="Optional note for this markup…"]')).not.toBeNull();
  });

  it("restores an inline edit only when its async save has no competing draft", async () => {
    const saved = annotation("ann-1");
    configureAnnotations([saved]);
    const pending = deferredPromise<unknown>();
    apiPatchMock.mockReturnValue(pending.promise);
    const onToast = vi.fn();
    const host = mount();
    await render(<Lightbox {...baseProps({ onToast })} />);
    await openReviewPanel(host);
    await flush();
    await click(button(host, "Edit note"));
    await typeInto(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit annotation note"]')!, "race");
    await click(button(host, "Save"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await drawOneStroke(host);
    expect(confirm).not.toHaveBeenCalled();
    pending.reject(new Error("Save failed"));
    await flush(12);
    expect(host.querySelector('textarea[aria-label="Edit annotation note"]')).toBeNull();
    expect(onToast).toHaveBeenCalledWith("The annotation note could not be updated, and your edit could not be restored because new unsaved markup was started.", "error");

    await unmount();
    document.body.replaceChildren();
    configureAnnotations([saved]);
    apiPatchMock.mockRejectedValue(new Error("Save failed"));
    const controlHost = mount();
    await render(<Lightbox {...baseProps({ onToast })} />);
    await openReviewPanel(controlHost);
    await flush();
    await click(button(controlHost, "Edit note"));
    await click(button(controlHost, "Save"));
    await flush(12);
    expect(controlHost.querySelector('textarea[aria-label="Edit annotation note"]')).not.toBeNull();
  });
});
