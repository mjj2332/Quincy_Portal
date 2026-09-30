import { describe, expect, it } from "vitest";
import { attachLazyImageObserver } from "./lazy-image-observer";

class FakeIntersectionObserver {
  static instance: FakeIntersectionObserver | undefined;
  callback: IntersectionObserverCallback;
  options: unknown;
  target: Element | undefined;
  constructor(callback: IntersectionObserverCallback, options?: unknown) { this.callback = callback; this.options = options; FakeIntersectionObserver.instance = this; }
  observe(target: Element) { this.target = target; }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
  fire(isIntersecting: boolean) { this.callback([{ target: this.target!, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}

describe("LazyImage intersection retry boundary", () => {
  it("does not restart after a terminal failure when the fake observer sees its replacement", () => {
    const target = {} as Element;
    let terminal = false; let starts = 0;
    attachLazyImageObserver(() => target, () => { if (!terminal) starts += 1; }, FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    FakeIntersectionObserver.instance!.fire(true);
    terminal = true; // third failure replaces <img> with a visible placeholder
    FakeIntersectionObserver.instance!.fire(true);
    expect(starts).toBe(1);
  });

  it("extends both the viewport and nested scroll containers by 600px (#362)", () => {
    attachLazyImageObserver(() => ({}) as Element, () => undefined, FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    expect(FakeIntersectionObserver.instance!.options).toMatchObject({ rootMargin: "600px", scrollMargin: "600px" });
  });
});
