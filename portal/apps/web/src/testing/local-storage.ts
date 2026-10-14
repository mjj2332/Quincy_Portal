/**
 * A plain in-memory `window.localStorage` for a DOM test. Under this toolchain's Node, Node's own native `localStorage` global wins over
 * happy-dom's and is non-functional without `--localstorage-file` (`setItem` / `clear` are not functions on it); see the same shim in
 * `App-navigation-rail-shell.dom.test.tsx`. `blockWrites` makes `setItem` throw, as blocked site data does.
 */
export function installLocalStorageShim(options: { blockWrites?: boolean } = {}): { values: Map<string, string>; restore: () => void } {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (options.blockWrites) throw new Error("blocked"); values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } });
  return { values, restore: () => { if (original) Object.defineProperty(window, "localStorage", original); else delete (window as { localStorage?: unknown }).localStorage; } };
}
