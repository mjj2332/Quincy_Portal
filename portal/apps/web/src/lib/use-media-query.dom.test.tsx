// Happy-dom proves media-query subscription wiring only; it cannot prove
// sensor/geometry/scroll behavior, browser focus timing, or AT delivery.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery, usePrefersReducedMotion } from "./use-media-query";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ query }: { query: string }) {
  const matches = useMediaQuery(query);
  const reducedMotion = usePrefersReducedMotion();
  return <output data-query={String(matches)} data-reduced-motion={String(reducedMotion)} />;
}

describe("useMediaQuery", () => {
  let host: HTMLDivElement;
  let root: Root;
  let matches: Map<string, boolean>;
  let listeners: Map<string, Set<() => void>>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    matches = new Map([
      ["(pointer: coarse)", true],
      ["(prefers-reduced-motion: reduce)", false],
    ]);
    listeners = new Map();
    vi.stubGlobal("matchMedia", (query: string) => {
      const queryListeners = listeners.get(query) ?? new Set<() => void>();
      listeners.set(query, queryListeners);
      return {
        media: query,
        matches: matches.get(query) ?? false,
        addEventListener: (_type: string, listener: () => void) => queryListeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => queryListeners.delete(listener),
        addListener: (listener: () => void) => queryListeners.add(listener),
        removeListener: (listener: () => void) => queryListeners.delete(listener),
      } as unknown as MediaQueryList;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("reads matchMedia and updates from a change event", () => {
    act(() => root.render(<Probe query="(pointer: coarse)" />));
    expect(host.querySelector("output")?.dataset.query).toBe("true");
    expect(host.querySelector("output")?.dataset.reducedMotion).toBe("false");

    matches.set("(pointer: coarse)", false);
    matches.set("(prefers-reduced-motion: reduce)", true);
    act(() => {
      listeners.get("(pointer: coarse)")?.forEach((listener) => listener());
      listeners.get("(prefers-reduced-motion: reduce)")?.forEach((listener) => listener());
    });
    expect(host.querySelector("output")?.dataset.query).toBe("false");
    expect(host.querySelector("output")?.dataset.reducedMotion).toBe("true");
  });
});
