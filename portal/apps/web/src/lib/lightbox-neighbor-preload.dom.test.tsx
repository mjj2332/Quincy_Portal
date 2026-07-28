import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LazyImage } from "../components/LazyImage";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import {
  createNeighborScheduler,
  neighborIndices,
  reconcile,
  type NeighborPendingRequest,
  type NeighborScheduler,
  type NeighborState,
  useLightboxNeighborPreload,
} from "./lightbox-neighbor-preload";
import { createImagePreloadScheduler, type PendingRequest, type Scheduler } from "./image-preload-scheduler";

type TrackedNeighborRequest = NeighborPendingRequest & { cancel: ReturnType<typeof vi.fn>; releases: Array<ReturnType<typeof vi.fn>> };
type TrackedGridRequest = PendingRequest & { cancel: ReturnType<typeof vi.fn> };

function trackedNeighborScheduler(maxConcurrent: number) {
  const base = createNeighborScheduler(maxConcurrent);
  const requests: TrackedNeighborRequest[] = [];
  const scheduler: NeighborScheduler = {
    acquire() {
      const request = base.acquire();
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const tracked: TrackedNeighborRequest = {
        promise: request.promise.then((release) => {
          const trackedRelease = vi.fn(release);
          releases.push(trackedRelease);
          return trackedRelease;
        }),
        cancel: vi.fn(() => request.cancel()),
        releases,
      };
      requests.push(tracked);
      return tracked;
    },
  };
  return { scheduler, requests };
}

function trackedGridScheduler(maxConcurrent: number) {
  const base = createImagePreloadScheduler(maxConcurrent);
  const requests: TrackedGridRequest[] = [];
  const scheduler: Scheduler = {
    acquire(priority) {
      const request = base.acquire(priority);
      const tracked: TrackedGridRequest = {
        promise: request.promise.then((release) => vi.fn(release)),
        promote: vi.fn(() => request.promote()),
        cancel: vi.fn(() => request.cancel()),
      };
      requests.push(tracked);
      return tracked;
    },
  };
  return { scheduler, requests };
}

class TestImage {
  static instances: TestImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";

  constructor() {
    TestImage.instances.push(this);
  }
}

type TestImageConstructor = typeof Image;
const originalImage = globalThis.Image;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeAssets(ids: string[]) {
  return ids.map((id) => ({ id })) as WorkspaceAsset[];
}

function Harness({ assets, index, scheduler }: { assets: WorkspaceAsset[]; index: number; scheduler: NeighborScheduler }) {
  useLightboxNeighborPreload(assets, index, scheduler);
  return null;
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
}

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function unmount() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
    await Promise.resolve();
  });
  root = null;
}

function activeState(neighbors: Map<string, NeighborState>, assetId: string) {
  const entry = neighbors.get(assetId);
  expect(entry?.kind).toBe("active");
  if (!entry || entry.kind !== "active") throw new Error(`Expected active ${assetId}`);
  return entry;
}

beforeEach(() => {
  vi.useFakeTimers();
  TestImage.instances = [];
  globalThis.Image = TestImage as unknown as TestImageConstructor;
  window.Image = TestImage as unknown as TestImageConstructor;
  mount();
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.Image = originalImage;
  window.Image = originalImage;
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
  document.body.replaceChildren();
});

describe("lightbox neighbor reconciliation", () => {
  it("preloads exactly the previous and next assets in a larger collection", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(2);
    await render(<Harness assets={makeAssets(["a", "b", "c", "d", "e"])} index={2} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(2);
    expect(TestImage.instances.map((image) => image.src)).toEqual(["/media/asset/d/web", "/media/asset/b/web"]);
  });

  it("does not preload anything for a one-asset collection", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(2);
    await render(<Harness assets={makeAssets(["only"])} index={0} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(0);
  });

  it("deduplicates the single other asset in a two-asset collection", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(2);
    await render(<Harness assets={makeAssets(["a", "b"])} index={0} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(1);
    expect(TestImage.instances[0]?.src).toBe("/media/asset/b/web");
  });

  it("cancels queued neighbors outside the new radius while retaining an in-radius queued neighbor", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    const assets = makeAssets(["a", "b", "c"]);
    await render(<Harness assets={assets} index={0} scheduler={scheduler} />);
    await flush();
    await render(<Harness assets={assets} index={1} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[1]!.cancel).not.toHaveBeenCalled();
    expect(requests[2]!.cancel).not.toHaveBeenCalled();
  });

  it("leaves an active neighbor tracked when no longer desired, and releases it on completion without retrying", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    const neighbors = new Map<string, NeighborState>();
    reconcile(neighbors, scheduler, ["a"]);
    await flush();
    const active = activeState(neighbors, "a");
    reconcile(neighbors, scheduler, []);
    // No longer desired, but can't be cleanly aborted — still tracked as the same active entry.
    expect(neighbors.get("a")).toBe(active);
    active.img.onload!(new Event("load"));
    await flush();
    const later = scheduler.acquire();
    expect(await later.promise).toBeTypeOf("function");
    (await later.promise)();
    expect(requests[0]!.releases[0]).toHaveBeenCalledTimes(1);
    expect(neighbors.has("a")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("runs one active finish exactly once across load and error events", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    const neighbors = new Map<string, NeighborState>();
    reconcile(neighbors, scheduler, ["a"]);
    await flush();
    const active = activeState(neighbors, "a");
    active.img.onload!(new Event("load"));
    active.img.onerror!(new Event("error"));
    await flush();
    const later = scheduler.acquire();
    expect(await later.promise).toBeTypeOf("function");
    (await later.promise)();
    expect(requests[0]!.releases[0]).toHaveBeenCalledTimes(1);
    expect(neighbors.has("a")).toBe(false);
  });

  it("ignores stale load and watchdog completions after the same asset is reacquired", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    const neighbors = new Map<string, NeighborState>();
    const watchdogs: Array<() => void> = [];
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler === "function" && timeout === 25_000) watchdogs.push(handler as () => void);
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);

    reconcile(neighbors, scheduler, ["a"]);
    await flush();
    const oldActive = activeState(neighbors, "a");
    const oldImage = oldActive.img;
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(neighbors.has("a")).toBe(false);
    expect(watchdogs).toHaveLength(1);

    reconcile(neighbors, scheduler, ["a"]);
    await flush();
    const newActive = activeState(neighbors, "a");
    expect(newActive).not.toBe(oldActive);
    expect(newActive.img).not.toBe(oldImage);
    oldImage.onload!(new Event("load"));
    watchdogs[0]!();
    await flush();
    expect(requests[1]!.releases[0]).not.toHaveBeenCalled();
    expect(neighbors.get("a")).toBe(newActive);
    newActive.img.onload!(new Event("load"));
    expect(neighbors.has("a")).toBe(false);
  });

  it("starts a fresh acquire after a queued attempt is canceled and immediately re-desired", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    const neighbors = new Map<string, NeighborState>();
    reconcile(neighbors, scheduler, ["a", "b"]);
    await flush();
    const canceled = requests[1]!;
    reconcile(neighbors, scheduler, ["a"]);
    reconcile(neighbors, scheduler, ["a", "b"]);
    expect(requests).toHaveLength(3);
    expect(canceled.cancel).toHaveBeenCalledTimes(1);
    expect(requests[2]).not.toBe(canceled);
    expect(neighbors.get("b")?.kind).toBe("queued");
  });

  it("cancels queued entries on unmount while an active entry can finish afterward", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(1);
    await render(<Harness assets={makeAssets(["a", "b", "c"])} index={1} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(2);
    const activeImage = TestImage.instances[0]!;
    await unmount();
    expect(requests[1]!.cancel).toHaveBeenCalledTimes(1);
    expect(() => activeImage.onload!()).not.toThrow();
    await flush();
    const later = scheduler.acquire();
    expect(await later.promise).toBeTypeOf("function");
    (await later.promise)();
  });

  it("reconciles a changed asset array even when the numeric index is unchanged", async () => {
    const { scheduler, requests } = trackedNeighborScheduler(2);
    const firstAssets = makeAssets(["a", "b", "c"]);
    await render(<Harness assets={firstAssets} index={0} scheduler={scheduler} />);
    await flush();
    expect(requests.map((request) => request)).toHaveLength(2);
    await render(<Harness assets={makeAssets(["a", "x", "y"])} index={0} scheduler={scheduler} />);
    await flush();
    expect(requests).toHaveLength(4);
    TestImage.instances.slice(0, 2).forEach((image) => image.onload!());
    await flush();
    expect(TestImage.instances.map((image) => image.src)).toEqual([
      "/media/asset/b/web",
      "/media/asset/c/web",
      "/media/asset/x/web",
      "/media/asset/y/web",
    ]);
  });

  it("normalizes and deduplicates large-radius neighbors without negative indices", () => {
    expect(neighborIndices(0, 3, 4)).toEqual([1, 2]);
    expect(neighborIndices(0, 3, 4).every((index) => index >= 0 && index < 3)).toBe(true);
  });

  it("blocks neighbor preloads for save-data and fails open when the API is absent", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    const blocked = trackedNeighborScheduler(2);
    await render(<Harness assets={makeAssets(["a", "b", "c"])} index={1} scheduler={blocked.scheduler} />);
    await flush();
    expect(blocked.requests).toHaveLength(0);
    await unmount();
    mount();
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    const allowed = trackedNeighborScheduler(2);
    await render(<Harness assets={makeAssets(["a", "b", "c"])} index={1} scheduler={allowed.scheduler} />);
    await flush();
    expect(allowed.requests).toHaveLength(2);
  });

  it("keeps the dedicated and grid scheduler permit budgets independent", async () => {
    const neighbor = trackedNeighborScheduler(1);
    const grid = trackedGridScheduler(1);
    await render(<>
      <Harness assets={makeAssets(["a", "b", "c"])} index={1} scheduler={neighbor.scheduler} />
      <LazyImage preload="background" assetId="grid-a" alt="grid-a" scheduler={grid.scheduler} />
      <LazyImage preload="background" assetId="grid-b" alt="grid-b" scheduler={grid.scheduler} />
    </>);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await flush();
    expect(neighbor.requests).toHaveLength(2);
    expect(grid.requests).toHaveLength(2);
    expect(TestImage.instances).toHaveLength(1);

    TestImage.instances[0]!.onload!();
    document.querySelector("img")?.dispatchEvent(new Event("load"));
    await flush();
    expect(TestImage.instances).toHaveLength(2);
    expect(neighbor.requests).toHaveLength(2);
    expect(grid.requests).toHaveLength(2);
  });
});
