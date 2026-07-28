import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyImage } from "./LazyImage";
import { createImagePreloadScheduler, type PendingRequest, type Priority, type Scheduler } from "../lib/image-preload-scheduler";

type ControlledRequest = PendingRequest & { priority: Priority; resolve: (release?: () => void) => void; promoted: boolean };

function makeControlledScheduler() {
  const requests: ControlledRequest[] = [];
  const scheduler: Scheduler = {
    acquire(priority) {
      let resolvePromise!: (release: () => void) => void;
      const pending: ControlledRequest = {
        priority,
        promoted: false,
        promise: new Promise((resolve) => { resolvePromise = resolve; }),
        resolve(release = vi.fn()) { resolvePromise(release); },
        promote() { this.priority = "visible"; this.promoted = true; },
        cancel: vi.fn(),
      };
      requests.push(pending);
      return pending;
    },
  };
  return { scheduler, requests };
}

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  private readonly callback: IntersectionObserverCallback;
  private target: Element | null = null;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    TestIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.target = target; }
  unobserve(target: Element) { if (this.target === target) this.target = null; }
  disconnect() { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  emit(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback([{ target: this.target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  await act(async () => { await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

function setIdleCallback(value: ((callback: IdleRequestCallback) => number) | undefined, cancel: ((handle: number) => void) | undefined = undefined) {
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, writable: true, value });
  Object.defineProperty(window, "cancelIdleCallback", { configurable: true, writable: true, value: cancel ?? vi.fn() });
}

function backgroundProps(scheduler: Scheduler, assetId = "asset-1") {
  return { preload: "background" as const, assetId, alt: assetId, scheduler };
}

beforeEach(() => {
  vi.useFakeTimers();
  TestIntersectionObserver.instances = [];
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
  setIdleCallback(undefined);
  mount();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  if (originalIntersectionObserver) globalThis.IntersectionObserver = originalIntersectionObserver;
  else delete (globalThis as Partial<typeof globalThis>).IntersectionObserver;
  setIdleCallback(undefined);
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
  document.body.replaceChildren();
});

describe("LazyImage background preload", () => {
  it("starts and succeeds from the background trigger without intersection, while visible-only waits", async () => {
    const background = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(background.scheduler)} />);
    await advance(200);
    expect(background.requests.map((request) => request.priority)).toEqual(["background"]);
    background.requests[0]!.resolve();
    await flush();
    const image = document.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/media/asset/asset-1/thumb");
    await act(async () => { image!.dispatchEvent(new Event("load")); await Promise.resolve(); });
    expect(document.querySelector("img")).not.toBeNull();

    await unmount();
    mount();
    const visible = makeControlledScheduler();
    await render(<LazyImage src="/visible.jpg" alt="visible" scheduler={visible.scheduler} />);
    await advance(200);
    expect(visible.requests).toHaveLength(0);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(visible.requests).toHaveLength(1);
  });

  it("promotes a queued background request when it becomes visible without acquiring twice", async () => {
    const first = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(first.scheduler)} />);
    await advance(200);
    const observer = TestIntersectionObserver.instances[0]!;
    observer.emit(true);
    await flush();
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]!.promoted).toBe(true);
    expect(first.requests[0]!.priority).toBe("visible");
  });

  it("does not duplicate an already-active background load when it becomes visible", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(controlled.scheduler)} />);
    await advance(200);
    controlled.requests[0]!.resolve();
    await flush();
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(controlled.requests).toHaveLength(1);
  });

  it("cancels a queued background request on unmount", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(controlled.scheduler)} />);
    await advance(200);
    const pending = controlled.requests[0]!;
    await unmount();
    expect(pending.cancel).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flush();
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not let a stale continuation clear a new pending request", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(controlled.scheduler, "asset-1")} />);
    await advance(200);
    await render(<LazyImage {...backgroundProps(controlled.scheduler, "asset-2")} />);
    await advance(200);
    expect(controlled.requests).toHaveLength(2);
    controlled.requests[0]!.resolve();
    await flush();
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(controlled.requests).toHaveLength(2);
    controlled.requests[1]!.resolve();
    await flush();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/media/asset/asset-2/thumb");
  });

  it("does not re-fetch after success, but resets when the effective identity changes", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage src="/one.jpg" alt="one" scheduler={controlled.scheduler} />);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    controlled.requests[0]!.resolve();
    await flush();
    const image = document.querySelector("img")!;
    await act(async () => { image.dispatchEvent(new Event("load")); await Promise.resolve(); });
    TestIntersectionObserver.instances[0]!.emit(false);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(controlled.requests).toHaveLength(1);
    await render(<LazyImage src="/two.jpg" alt="two" scheduler={controlled.scheduler} />);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(controlled.requests).toHaveLength(2);
  });

  it("retries at the priority used by the failed attempt after promotion", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(controlled.scheduler)} />);
    await advance(200);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    controlled.requests[0]!.resolve();
    await flush();
    await act(async () => { document.querySelector("img")!.dispatchEvent(new Event("error")); await Promise.resolve(); });
    await advance(500);
    expect(controlled.requests).toHaveLength(2);
    expect(controlled.requests[1]!.priority).toBe("visible");
  });

  it("uses the watchdog, reaches terminal failure, and allows a manual retry", async () => {
    const controlled = makeControlledScheduler();
    await render(<LazyImage src="/watchdog.jpg" alt="watchdog" scheduler={controlled.scheduler} />);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      controlled.requests[attempt]!.resolve();
      await flush();
      await advance(25_001);
      await advance(1_000);
    }
    expect(document.body.textContent).toContain("Image unavailable");
    await unmount();
    mount();
    await render(<LazyImage src="/watchdog.jpg" alt="watchdog" retryToken={1} scheduler={controlled.scheduler} />);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(controlled.requests).toHaveLength(4);
  });

  it("blocks new backgrounds for save-data, leaves visible loads unaffected, and fails open without the API", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    const blocked = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(blocked.scheduler)} />);
    await advance(200);
    expect(blocked.requests).toHaveLength(0);
    await unmount();
    mount();
    const visible = makeControlledScheduler();
    await render(<LazyImage src="/visible.jpg" alt="visible" scheduler={visible.scheduler} />);
    TestIntersectionObserver.instances.at(-1)!.emit(true);
    await flush();
    expect(visible.requests).toHaveLength(1);
    await unmount();
    mount();
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    const allowed = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(allowed.scheduler, "allowed")} />);
    await advance(200);
    expect(allowed.requests).toHaveLength(1);
  });

  it("rejects src in the background branch at the type level", () => {
    const scheduler = createImagePreloadScheduler(1);
    // @ts-expect-error Background preload constructs its own thumbnail URL from assetId.
    const invalid = <LazyImage preload="background" src="/not-a-thumb.jpg" alt="invalid" scheduler={scheduler} />;
    expect(invalid).toBeTruthy();
  });

  it("isolates two instances through distinct scheduler props", async () => {
    const first = makeControlledScheduler();
    const second = makeControlledScheduler();
    await render(<><LazyImage {...backgroundProps(first.scheduler, "first")} /><LazyImage {...backgroundProps(second.scheduler, "second")} /></>);
    await advance(200);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    first.requests[0]!.resolve();
    await flush();
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(second.requests[0]!.promise).toBeInstanceOf(Promise);
  });

  it("starts from requestIdleCallback and from the 200ms Safari fallback", async () => {
    let idleCallback: IdleRequestCallback | undefined;
    setIdleCallback((callback) => { idleCallback = callback; return 17; });
    const idle = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(idle.scheduler, "idle")} />);
    expect(idle.requests).toHaveLength(0);
    idleCallback!({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
    await flush();
    expect(idle.requests).toHaveLength(1);
    await unmount();
    mount();
    setIdleCallback(undefined);
    const fallback = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(fallback.scheduler, "fallback")} />);
    await advance(199);
    expect(fallback.requests).toHaveLength(0);
    await advance(1);
    expect(fallback.requests).toHaveLength(1);
  });

  it("clears both idle and fallback handles on unmount", async () => {
    let idleCallback: IdleRequestCallback | undefined;
    const cancelIdle = vi.fn();
    setIdleCallback((callback) => { idleCallback = callback; return 23; }, cancelIdle);
    const idle = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(idle.scheduler, "idle-cleanup")} />);
    await unmount();
    expect(cancelIdle).toHaveBeenCalledWith(23);
    idleCallback!({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline);
    await flush();
    expect(idle.requests).toHaveLength(0);

    mount();
    setIdleCallback(undefined);
    const fallback = makeControlledScheduler();
    await render(<LazyImage {...backgroundProps(fallback.scheduler, "fallback-cleanup")} />);
    await unmount();
    await advance(200);
    expect(fallback.requests).toHaveLength(0);
  });
});
