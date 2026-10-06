import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "./Lightbox";
import { ConfirmModalHost } from "./ConfirmDialog";
import { confirmStore } from "../lib/confirm";
import type { WorkspaceAsset } from "./PhotoGrid";

/**
 * #625 — the Lightbox against the REAL confirm (not a `lib/confirm` mock): with unsaved markup,
 * closing the viewer raises "Discard unsaved markup?", and Escape on that alert dialog must answer
 * false without closing the Lightbox or discarding the draft behind it.
 */
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }) }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => Promise.resolve(path.includes("/annotations") ? { annotations: [] } : {}), apiPost: () => Promise.resolve({}), apiPatch: () => Promise.resolve({}) };
});
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asset: WorkspaceAsset = {
  id: "asset-1", section: null, collectionId: "collection", kind: "photo", originalFilename: "asset-1.jpg",
  bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
  createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
  supersedesAssetId: null, review: null, selected: false,
};

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => { window.innerWidth = 1024; });
afterEach(async () => {
  while (confirmStore.getSnapshot()) confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("Lightbox with unsaved markup and the real confirm (#625)", () => {
  it("Escape on the discard confirm resolves false: the Lightbox stays open and keeps its draft", async () => {
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<><Lightbox assets={[asset]} rawAssets={[]} initialAssetId={asset.id} collectionKind="edited" canReview canRecommend canAnnotate onClose={onClose} onReview={vi.fn().mockResolvedValue(undefined)} onToast={vi.fn()} /><ConfirmModalHost /></>);
      await Promise.resolve();
    });
    await flush();
    const svg = host.querySelector('[data-testid="lightbox-markup"]')!;
    (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await act(async () => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10 })); await Promise.resolve(); });
    const strokes = () => host.querySelectorAll('[data-testid="lightbox-markup"] [data-testid="lightbox-stroke"]').length;
    expect(strokes()).toBe(1);

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); await Promise.resolve(); });
    await flush();
    const dialog = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]');
    expect(dialog?.getAttribute("role")).toBe("alertdialog");

    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    await flush();
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 200)); });
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(strokes()).toBe(1);
  });
});
