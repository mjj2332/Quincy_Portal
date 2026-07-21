import { describe, expect, it } from "vitest";
import { attachLazyImageObserver } from "./lazy-image-observer";

class FakeIntersectionObserver {
  static instance: FakeIntersectionObserver | undefined;
  callback: IntersectionObserverCallback;
  target: Element | undefined;
  constructor(callback: IntersectionObserverCallback) { this.callback = callback; FakeIntersectionObserver.instance = this; }
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
});
