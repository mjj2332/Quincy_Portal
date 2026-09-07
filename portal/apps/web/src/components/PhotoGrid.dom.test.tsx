import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoGrid, type WorkspaceAsset } from "./PhotoGrid";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

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
  const el = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-filter"]')].find((button) => button.textContent?.startsWith(label));
  if (!el) throw new Error(`No filter chip labeled ${label}`);
  return el;
}

function selectAllButton(host: HTMLElement): HTMLButtonElement {
  const el = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-filter"]')].find((button) => /Select all|Deselect all/.test(button.textContent ?? ""));
  if (!el) throw new Error("No select-all/deselect-all button");
  return el;
}

function isSelected(host: HTMLElement, assetId: string): boolean {
  return selBox(host, assetId).closest<HTMLElement>('[data-testid="photo-grid-tile"]')?.dataset.multiSelected === "true";
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
    const clearButton = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Clear")!;
    await click(clearButton);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).toBeNull();

    await click(selBox(host, "b"), { shiftKey: true });

    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "a")).toBe(false);
    expect(isSelected(host, "c")).toBe(false);
  });

  it("resets the shift-click anchor after a completed bulk() action", async () => {
    const assets = [asset("a"), asset("b"), asset("c")];
    await render(<PhotoGrid {...baseProps} assets={assets} />);

    await click(selBox(host, "a"));
    const approveButton = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Approve")!;
    await click(approveButton);
    await flush();
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).toBeNull();

    await click(selBox(host, "b"), { shiftKey: true });

    expect(isSelected(host, "b")).toBe(true);
    expect(isSelected(host, "a")).toBe(false);
    expect(isSelected(host, "c")).toBe(false);
  });
});

describe("PhotoGrid deletion controls", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); confirmMock.mockReset().mockResolvedValue(true); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("confirms a single delete and prunes that id from multi", async () => {
    const onDelete = vi.fn(async () => undefined);
    await render(<PhotoGrid {...baseProps} canDelete onDelete={onDelete} assets={[asset("one"), asset("two")]} />);
    await click(selBox(host, "one"));
    await click(host.querySelector('[aria-label="Delete one.jpg"]')!);
    expect(confirmMock).toHaveBeenCalledWith({ title: "Delete one.jpg?", message: "Permanently delete one.jpg? This cannot be undone.", confirmLabel: "Delete", danger: true });
    expect(onDelete).toHaveBeenCalledWith("one");
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).toBeNull();
  });

  it("uses count-inclusive bulk confirmation and retains only failed ids", async () => {
    const onBulkDelete = vi.fn(async () => ({ succeededIds: ["one"], failedIds: ["two"] }));
    await render(<PhotoGrid {...baseProps} canDelete onBulkDelete={onBulkDelete} assets={[asset("one"), asset("two")]} />);
    await click(selBox(host, "one")); await click(selBox(host, "two"));
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Delete 2")!);
    expect(confirmMock).toHaveBeenCalledWith({ title: "Delete 2 selected assets?", message: "Permanently delete 2 selected assets? This cannot be undone.", confirmLabel: "Delete selected", danger: true });
    expect(onBulkDelete).toHaveBeenCalledWith(["one", "two"]);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')?.textContent).toContain("1");
    expect(isSelected(host, "two")).toBe(true);
  });

  it("leaves selection and calls untouched when a confirmation is declined", async () => {
    confirmMock.mockResolvedValue(false);
    const onDelete = vi.fn(async () => undefined);
    await render(<PhotoGrid {...baseProps} canDelete onDelete={onDelete} assets={[asset("one")]} />);
    await click(selBox(host, "one")); await click(host.querySelector('[aria-label="Delete one.jpg"]')!);
    expect(onDelete).not.toHaveBeenCalled();
    expect(isSelected(host, "one")).toBe(true);
  });

  it("leaves the whole selection untouched when a bulk confirmation is declined", async () => {
    confirmMock.mockResolvedValue(false);
    const onBulkDelete = vi.fn(async () => ({ succeededIds: [], failedIds: [] }));
    await render(<PhotoGrid {...baseProps} canDelete onBulkDelete={onBulkDelete} assets={[asset("one"), asset("two")]} />);
    await click(selBox(host, "one")); await click(selBox(host, "two"));
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Delete 2")!);
    expect(onBulkDelete).not.toHaveBeenCalled();
    expect(isSelected(host, "one")).toBe(true); expect(isSelected(host, "two")).toBe(true);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')?.textContent).toContain("2");
  });
});

describe("PhotoGrid download selection", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("appends Download selection after Clear and sends the current checked ids without clearing them", async () => {
    const onDownloadSelection = vi.fn(async () => undefined);
    await render(<PhotoGrid {...baseProps} canDownloadSelection onDownloadSelection={onDownloadSelection} assets={[asset("one"), asset("two")]} />);
    await click(selBox(host, "one")); await click(selBox(host, "two"));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')];
    expect(buttons.slice(-2).map((button) => button.textContent)).toEqual(["Clear", "Download selection"]);
    await click(buttons.at(-1)!);
    expect(onDownloadSelection).toHaveBeenCalledTimes(1);
    expect(onDownloadSelection).toHaveBeenCalledWith(["one", "two"]);
    expect(isSelected(host, "one")).toBe(true); expect(isSelected(host, "two")).toBe(true);
  });

  it("keeps the action bar and selection on an error, and exposes only its own pending state", async () => {
    let reject!: (reason: Error) => void;
    const onDownloadSelection = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    await render(<PhotoGrid {...baseProps} canDownloadSelection onDownloadSelection={onDownloadSelection} assets={[asset("one")]} />);
    await click(selBox(host, "one"));
    const download = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Download selection")!;
    await click(download);
    expect(download.disabled).toBe(true); expect(download.textContent).toBe("Preparing download…");
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Clear")?.disabled).toBe(false);
    await act(async () => { reject(new Error("nope")); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).not.toBeNull(); expect(isSelected(host, "one")).toBe(true);
  });

  it("hides the control without capability and disables it for count or byte overages", async () => {
    await render(<PhotoGrid {...baseProps} assets={[asset("one")]} />);
    await click(selBox(host, "one"));
    expect(host.textContent).not.toContain("Download selection");

    const many = Array.from({ length: 501 }, (_, index) => asset(`many-${index}`));
    await render(<PhotoGrid {...baseProps} canDownloadSelection onDownloadSelection={async () => undefined} assets={many} />);
    await click(selectAllButton(host));
    const tooMany = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Download selection")!;
    expect(tooMany.disabled).toBe(true); expect(tooMany.title).toContain("500 assets / 256 MiB");

    await render(<PhotoGrid {...baseProps} canDownloadSelection onDownloadSelection={async () => undefined} assets={[asset("large", { bytes: 256 * 1024 * 1024 + 1 })]} />);
    await click(selBox(host, "large"));
    const tooLarge = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Download selection")!;
    expect(tooLarge.disabled).toBe(true);
  });
});
