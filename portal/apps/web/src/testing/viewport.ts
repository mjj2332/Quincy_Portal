import { act } from "react";

/**
 * #734: one fake viewport for `matchMedia`, evaluated from a width and a pointer, so a test says
 * "at 800px" instead of hard-coding the one query string a component happened to use. Evaluates
 * `(width < Npx)` (what Tailwind's `max-[Npx]` compiles to), `(max-width: Npx)`, `(min-width: Npx)` and `(pointer: coarse|fine)`; any other query is false.
 * `set` re-evaluates and notifies every subscriber, as a real resize would.
 */
export interface MockViewport {
  /**
   * Resize and/or change the pointer, notifying subscribers inside `act`. A change of orientation (the width and height cross, or `landscape` is given) also fires `change` on the stubbed
   * `screen.orientation`, as a device turn does. `height` alone is a resize (an on-screen keyboard): it moves the media query but never the device's orientation.
   */
  set(next: { width?: number; height?: number; coarse?: boolean; landscape?: boolean }): Promise<void>;
  /** Put the original `window.matchMedia` back. */
  restore(): void;
}

export function mockViewport(initial: { width: number; height?: number; coarse?: boolean; landscape?: boolean; /** The device's own screen size (what `isPhoneDevice` reads); defaults to the viewport's. Stubbing it also stubs `screen.orientation`. */ screen?: { width: number; height: number } | false }): MockViewport {
  const original = window.matchMedia;
  const originalScreen = Object.getOwnPropertyDescriptor(window, "screen");
  let width = initial.width;
  let height = initial.height ?? 800;
  let coarse = initial.coarse ?? false;
  // The device orientation (what `screen.orientation.type` says) changes only when the device turns, never on a resize that merely reshapes the viewport (a keyboard).
  let landscape = initial.landscape ?? width > height;
  const subscribers = new Set<() => void>();
  const orientationListeners = new Set<() => void>();
  const deviceScreen = initial.screen === false ? null : initial.screen ?? { width: Math.min(width, height), height: Math.max(width, height) };
  const fakeScreen = deviceScreen && { get width() { return landscape ? deviceScreen.height : deviceScreen.width; }, get height() { return landscape ? deviceScreen.width : deviceScreen.height; },
    orientation: {
      get type() { return landscape ? "landscape-primary" : "portrait-primary"; },
      addEventListener: (_type: string, listener: () => void) => { orientationListeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { orientationListeners.delete(listener); },
    } };
  if (fakeScreen) Object.defineProperty(window, "screen", { configurable: true, value: fakeScreen });

  const evaluate = (query: string): boolean => {
    const lt = /^\(width\s*<\s*([\d.]+)px\)$/.exec(query);
    if (lt) return width < Number(lt[1]);
    const max = /^\(max-width:\s*([\d.]+)px\)$/.exec(query);
    if (max) return width <= Number(max[1]);
    const min = /^\(min-width:\s*([\d.]+)px\)$/.exec(query);
    if (min) return width >= Number(min[1]);
    if (query === "(pointer: coarse)") return coarse;
    if (query === "(pointer: fine)") return !coarse;
    if (query === "(orientation: landscape)") return height > 0 && width > height;
    if (query === "(orientation: portrait)") return !(width > height);
    return false;
  };

  window.matchMedia = ((query: string) => {
    const mine = new Set<() => void>();
    return {
      media: query,
      get matches() { return evaluate(query); },
      addEventListener: (_type: string, listener: () => void) => { mine.add(listener); subscribers.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { mine.delete(listener); subscribers.delete(listener); },
      addListener: (listener: () => void) => { mine.add(listener); subscribers.add(listener); },
      removeListener: (listener: () => void) => { mine.delete(listener); subscribers.delete(listener); },
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;

  return {
    async set(next) {
      if (next.width !== undefined) width = next.width;
      if (next.height !== undefined) height = next.height;
      if (next.coarse !== undefined) coarse = next.coarse;
      const turned = next.landscape !== undefined ? next.landscape !== landscape : next.width !== undefined && next.height !== undefined && (next.width > next.height) !== landscape;
      if (turned) landscape = next.landscape ?? next.width! > next.height!;
      await act(async () => {
        subscribers.forEach((listener) => listener());
        if (turned) orientationListeners.forEach((listener) => listener());
        await Promise.resolve();
      });
    },
    restore() {
      window.matchMedia = original;
      if (fakeScreen) { if (originalScreen) Object.defineProperty(window, "screen", originalScreen); else delete (window as unknown as Record<string, unknown>).screen; }
    },
  };
}
