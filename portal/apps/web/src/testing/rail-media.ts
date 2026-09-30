/**
 * jsdom has no `matchMedia`, so `useMediaQuery` reads `false` and the Checklist rail (#377) would
 * fall to its stacked, collapsed layout in every DOM test that reaches it through the Collaboration
 * panel. This stub answers `matches` for the rail query only (every other query stays `false`, as
 * it did with no `matchMedia` at all) and lets a test flip the layout and fire the `change` event.
 * The query string is written out here on purpose: `CHECKLIST_RAIL_QUERY` is asserted equal to it.
 */
export const RAIL_QUERY = "(min-width: 1100px)";

export function stubRailMedia(initial = true) {
  let matches = initial;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() { return query === RAIL_QUERY && matches; },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
      addListener: (listener: () => void) => { listeners.add(listener); },
      removeListener: (listener: () => void) => { listeners.delete(listener); },
      dispatchEvent: () => false,
    }),
  });
  return { set(next: boolean) { matches = next; for (const listener of [...listeners]) listener(); } };
}
