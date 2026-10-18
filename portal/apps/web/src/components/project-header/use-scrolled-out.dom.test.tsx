import { act, startTransition, Suspense, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLiveTwin, useScrolledOut } from "./use-scrolled-out";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIO {
  static instances: FakeIO[] = [];
  targets: Element[] = [];
  constructor(public callback: IntersectionObserverCallback) { FakeIO.instances.push(this); }
  observe(target: Element) { this.targets.push(target); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  FakeIO.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const never = new Promise<never>(() => undefined);
function Suspends({ on }: { on: boolean }): ReactNode {
  if (on) throw never;
  return null;
}

// #914 standards review: the hook reads the latest committed `handOff`, never one from a render React threw away.
describe("useScrolledOut's handOff", () => {
  it("calls the committed handOff when a newer render was discarded (a suspended transition)", async () => {
    const first = vi.fn();
    const second = vi.fn();
    let update: (next: { handOff: () => void; suspend: boolean }) => void = () => undefined;
    function Probe() {
      const [state, setState] = useState({ handOff: first as () => void, suspend: false });
      update = setState;
      const target = useRef<HTMLDivElement>(null);
      useScrolledOut(target, "p1", true, { handOff: state.handOff });
      return <><div ref={target} /><Suspends on={state.suspend} /></>;
    }
    await act(async () => { root.render(<Suspense fallback="loading"><Probe /></Suspense>); });
    // A transition that suspends keeps the committed UI: the render carrying `second` never commits.
    await act(async () => { startTransition(() => update({ handOff: second, suspend: true })); });
    expect(host.textContent).not.toContain("loading");
    const io = FakeIO.instances.at(-1)!;
    await act(async () => {
      io.callback([{ target: io.targets[0]!, isIntersecting: false, boundingClientRect: { top: -40, bottom: -10 } as DOMRectReadOnly, rootBounds: { top: 0 } as DOMRectReadOnly } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledWith(true);
  });
});

// Project info and the whiteboard return focus to a control only when isLiveTwin says it is reachable. The header's own hidden twin
// bar is not; a control on a page that a modal layer has marked inert around itself still is, or that layer would close with
// nowhere to put focus.
describe("isLiveTwin", () => {
  function control(markup: string): HTMLElement {
    host.innerHTML = markup;
    return host.querySelector<HTMLElement>("button")!;
  }

  it("rejects a control in the header's hidden twin bar, and nothing (null, or a control no longer in the page)", () => {
    expect(isLiveTwin(control('<div data-twin-bar inert><button>Info</button></div>'))).toBe(false);
    expect(isLiveTwin(null)).toBe(false);
    expect(isLiveTwin(document.createElement("button"))).toBe(false);
  });

  it("accepts a control in the twin bar that is showing, even with the page around a modal layer marked inert", () => {
    expect(isLiveTwin(control('<div data-twin-bar><button>Info</button></div>'))).toBe(true);
    expect(isLiveTwin(control('<div inert><div data-twin-bar><button>Info</button></div></div>'))).toBe(true);
  });
});
