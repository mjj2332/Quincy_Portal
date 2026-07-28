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
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiDelete: (path: string) => apiDeleteMock(path),
  };
});

function workspaceAsset(id: string): WorkspaceAsset {
  return {
    id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`,
    bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
    createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
    supersedesAssetId: null, review: null, selected: false,
  };
}

const postedComment = {
  id: "comment-1", parentId: null, authorId: "user-1", body: "hello during drawing",
  author: { id: "user-1", name: "A", role: "editor" }, createdAt: "2026-07-28T00:00:00.000Z",
  editedAt: null, replies: [] as unknown[],
};

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

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}

// happy-dom's textarea setter is intercepted by React's own value-tracking, same as jsdom/real
// browsers — setting .value directly does not notify React. Going through the native setter and
// dispatching a real "input" event is the standard way to simulate typing into a controlled field.
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

// Draws exactly one stroke (a single-point circle, since only pointerdown fires — no move) onto
// the markup SVG, so undo-suppression tests have a real, observable stroke to check against
// instead of undoing an already-empty array (which would pass regardless of whether the guard
// works). happy-dom's SVGElement doesn't implement setPointerCapture, so it's stubbed first.
async function drawOneStroke(host: HTMLElement) {
  const svg = host.querySelector(".markup-svg")!;
  (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  await act(async () => {
    svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10 }));
    await Promise.resolve();
  });
}

function draftStrokeCount(host: HTMLElement): number {
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

// happy-dom's default window.innerWidth (1024) falls into the "tablet" band, where the sidebar
// panel's content only renders once opened (matching real tablet/phone behavior) — desktop is the
// only band where it's open by default. Every test needs the panel open to reach the Draw button
// and comment composer.
async function openReviewPanel(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>(".viewer__panel-trigger");
  if (!trigger) throw new Error("No Review panel trigger found");
  await click(trigger);
}

function drawButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((element) => element.textContent === "Draw" || element.textContent === "Drawing…");
  if (!button) throw new Error("No Draw toggle button found");
  return button;
}

function commentTextarea(host: HTMLElement): HTMLTextAreaElement {
  const textarea = host.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!textarea) throw new Error("No comment textarea found");
  return textarea;
}

function sendCommentButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll(".composer button")].find((element) => element.textContent === "Send comment") as HTMLButtonElement | undefined;
  if (!button) throw new Error("No Send comment button found");
  return button;
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  apiGetMock.mockResolvedValue({ annotations: [], comments: [] });
  apiPostMock.mockResolvedValue(postedComment);
});

afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
});

describe("Lightbox — comment box usable while drawing mode is active", () => {
  it("unlocks the comment textarea and send button once drawing mode is entered, and posting succeeds", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    expect(drawButton(host).textContent).toBe("Drawing…");

    const textarea = commentTextarea(host);
    const send = sendCommentButton(host);
    expect(textarea.disabled).toBe(false);
    expect(send.disabled).toBe(true); // still empty — disabled for that reason, not drawing mode

    await typeInto(textarea, "hello during drawing");
    expect(sendCommentButton(host).disabled).toBe(false);

    await click(sendCommentButton(host));
    expect(apiPostMock).toHaveBeenCalledWith("/api/assets/asset-1/comments", { body: "hello during drawing", parentId: undefined });
  });

  it("does not undo the last stroke or exit drawing mode when Escape/⌘Z fire with focus in the comment textarea", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    await drawOneStroke(host);
    expect(draftStrokeCount(host)).toBe(1);

    const textarea = commentTextarea(host);
    await typeInto(textarea, "in progress");
    textarea.focus();

    await keydown(textarea, { key: "z", metaKey: true });
    await keydown(textarea, { key: "Escape" });

    expect(drawButton(host).textContent).toBe("Drawing…"); // still in drawing mode — Escape was suppressed
    expect(draftStrokeCount(host)).toBe(1); // ⌘Z did not undo the real stroke drawn above
    expect(commentTextarea(host).value).toBe("in progress"); // unaffected by either keypress
  });

  it("still exits drawing mode on Escape when a toolbar button has focus (not a text field)", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    const undoButton = [...host.querySelectorAll(".drawbar button")].find((element) => element.textContent === "Undo") as HTMLButtonElement;
    expect(undoButton).toBeTruthy();
    undoButton.focus();

    await keydown(undoButton, { key: "Escape" });
    expect(drawButton(host).textContent).toBe("Draw"); // exited drawing mode — a focused button is not a text field
  });

  it("still undoes the last stroke on ⌘Z when a toolbar button has focus (not a text field)", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    await drawOneStroke(host);
    expect(draftStrokeCount(host)).toBe(1);
    const undoButton = [...host.querySelectorAll(".drawbar button")].find((element) => element.textContent === "Undo") as HTMLButtonElement;
    expect(undoButton).toBeTruthy();
    undoButton.focus();

    await keydown(undoButton, { key: "z", metaKey: true });
    expect(draftStrokeCount(host)).toBe(0); // the stroke was undone — a focused button did not suppress ⌘Z
    expect(drawButton(host).textContent).toBe("Drawing…"); // undo doesn't exit drawing mode
  });

  it("still exits drawing mode on Escape with no element focused", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    await keydown(window, { key: "Escape" });
    expect(drawButton(host).textContent).toBe("Draw");
  });

  it("leaves the annotation-note field disabled during drawing mode (unchanged, out of scope for this fix)", async () => {
    const host = mount();
    await render(<Lightbox {...baseProps()} />);
    await openReviewPanel(host);
    await click(drawButton(host));
    const note = host.querySelector<HTMLTextAreaElement>(".annotation-note");
    expect(note?.disabled).toBe(true);
  });
});
