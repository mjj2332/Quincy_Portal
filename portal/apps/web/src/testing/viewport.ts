import { act } from "react";

/**
 * #734: one fake viewport for `matchMedia`, evaluated from a width and a pointer, so a test says
 * "at 800px" instead of hard-coding the one query string a component happened to use. Evaluates
 * `(max-width: Npx)`, `(min-width: Npx)` and `(pointer: coarse|fine)`; any other query is false.
 * `set` re-evaluates and notifies every subscriber, as a real resize would.
 */
export interface MockViewport {
  /** Resize and/or change the pointer, notifying subscribers inside `act`. */
  set(next: { width?: number; coarse?: boolean }): Promise<void>;
  /** Put the original `window.matchMedia` back. */
  restore(): void;
}

export function mockViewport(initial: { width: number; coarse?: boolean }): MockViewport {
  const original = window.matchMedia;
  let width = initial.width;
  let coarse = initial.coarse ?? false;
  const subscribers = new Set<() => void>();

  const evaluate = (query: string): boolean => {
    const max = /^\(max-width:\s*([\d.]+)px\)$/.exec(query);
    if (max) return width <= Number(max[1]);
    const min = /^\(min-width:\s*([\d.]+)px\)$/.exec(query);
    if (min) return width >= Number(min[1]);
    if (query === "(pointer: coarse)") return coarse;
    if (query === "(pointer: fine)") return !coarse;
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
      if (next.coarse !== undefined) coarse = next.coarse;
      await act(async () => {
        subscribers.forEach((listener) => listener());
        await Promise.resolve();
      });
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
