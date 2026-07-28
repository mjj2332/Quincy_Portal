import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhotoGrid, type WorkspaceAsset } from "./PhotoGrid";

function asset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, ...overrides };
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
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

function click(el: Element, options: { shiftKey?: boolean } = {}) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: options.shiftKey ?? false }));
    await Promise.resolve();
  });
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function selBox(host: HTMLElement, assetId: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`[aria-label="Select ${assetId}.jpg"]`);
  if (!el) throw new Error(`No select box for ${assetId}`);
  return el;
}

function filterChip(host: HTMLElement, label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>(".filter-chips .chip")].find((button) => button.textContent?.startsWith(label));
  if (!el) throw new Error(`No filter chip labeled ${label}`);
  return el;
}

function selectAllButton(host: HTMLElement): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>(".filter-chips .chip")].find((button) => /Select all|Deselect all/.test(button.textContent ?? ""));
  if (!el) throw new Error("No select-all/deselect-all button");
  return el;
}

function isSelected(host: HTMLElement, assetId: string): boolean {
  return selBox(host, assetId).closest(".tile")?.classList.contains("is-selected") ?? false;
}

const baseProps = {
  showSections: false,
  canReview: true,
  canRecommend: false,
  canSelect: false,
  canSetCover: false,
  coverAssetId: null,
  storedCoverAssetId: null,
  onSetCover: async () => undefined,
  onOpen: () => undefined,
  onReview: async () => undefined,
  onSelection: async () => undefined,
};

describe("PhotoGrid select-all / deselect-all", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("unions the visible set into multi without dropping a hidden pre-existing selection", async () => {
    const assets = [asset("hidden"), asset("vis1", { review: { stars: 5, colorLabel: null, decision: null, recommended: false } })];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "hidden"));
    expect(isSelected(host, "hidden")).toBe(true);

    await click(filterChip(host, "Rated"));
    expect(host.querySelector('[aria-label="Select hidden.jpg"]')).toBeNull();

    await click(selectAllButton(host));

    await click(filterChip(host, "All"));
    expect(isSelected(host, "hidden")).toBe(true);
    expect(isSelected(host, "vis1")).toBe(true);
  });

  it("deselect-all removes only the currently-visible ids, leaving a hidden selection intact", async () => {
    const assets = [
      asset("hidden"),
      asset("vis1", { review: { stars: 5, colorLabel: null, decision: null, recommended: false } }),
      asset("vis2", { review: { stars: 4, colorLabel: null, decision: null, recommended: false } }),
    ];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "hidden"));
    await click(filterChip(host, "Rated"));
    await click(selectAllButton(host));
    expect(selectAllButton(host).textContent).toContain("Deselect all");

    await click(selectAllButton(host));

    await click(filterChip(host, "All"));
    expect(isSelected(host, "hidden")).toBe(true);
    expect(isSelected(host, "vis1")).toBe(false);
    expect(isSelected(host, "vis2")).toBe(false);
  });

  it("flips to Deselect all only when every visible item is selected, not on a size coincidence", async () => {
    const assets = [
      asset("hidden"),
      asset("vis1", { review: { stars: 5, colorLabel: null, decision: null, recommended: false } }),
      asset("vis2", { review: { stars: 4, colorLabel: null, decision: null, recommended: false } }),
    ];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "hidden"));
    await click(filterChip(host, "Rated"));
    await click(selBox(host, "vis1"));

    expect(selectAllButton(host).textContent).toContain("Select all");
  });

  it("resets the shift-click anchor on select-all so a following shift-click is a fresh single toggle", async () => {
    const assets = [asset("a"), asset("b"), asset("c"), asset("d")];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "a"));
    await click(selectAllButton(host));
    expect(isSelected(host, "a")).toBe(true);
    expect(isSelected(host, "d")).toBe(true);

    await click(selBox(host, "d"), { shiftKey: true });

    expect(isSelected(host, "d")).toBe(false);
    expect(isSelected(host, "a")).toBe(true);
    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "c")).toBe(true);
  });

  it("resets the shift-click anchor on deselect-all, isolated from select-all's own reset", async () => {
    const assets = [asset("a"), asset("b"), asset("c")];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    // Select every item via individual clicks (not select-all) so the anchor is non-null
    // ("c") immediately before deselect-all runs — isolates deselect-all's own reset from
    // select-all's, which already sets the anchor null as a side effect.
    await click(selBox(host, "a"));
    await click(selBox(host, "b"));
    await click(selBox(host, "c"));
    expect(selectAllButton(host).textContent).toContain("Deselect all");

    await click(selectAllButton(host));
    expect(isSelected(host, "a")).toBe(false);

    await click(selBox(host, "b"), { shiftKey: true });

    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "a")).toBe(false);
    expect(isSelected(host, "c")).toBe(false);
  });

  it("resets the shift-click anchor on Clear", async () => {
    const assets = [asset("a"), asset("b"), asset("c")];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "a"));
    const clearButton = [...host.querySelectorAll<HTMLButtonElement>(".actionbar .barbtn")].find((button) => button.textContent === "Clear")!;
    await click(clearButton);
    expect(host.querySelector(".actionbar")).toBeNull();

    await click(selBox(host, "b"), { shiftKey: true });

    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "a")).toBe(false);
    expect(isSelected(host, "c")).toBe(false);
  });

  it("resets the shift-click anchor after a completed bulk() action", async () => {
    const assets = [asset("a"), asset("b"), asset("c")];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "a"));
    const approveButton = [...host.querySelectorAll<HTMLButtonElement>(".actionbar .barbtn")].find((button) => button.textContent === "Approve")!;
    await click(approveButton);
    await flush();
    expect(host.querySelector(".actionbar")).toBeNull();

    await click(selBox(host, "b"), { shiftKey: true });

    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "a")).toBe(false);
    expect(isSelected(host, "c")).toBe(false);
  });
});
