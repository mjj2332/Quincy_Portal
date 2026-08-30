import { useCallback, useSyncExternalStore } from "react";

function getMediaQuerySnapshot(query: string): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(query).matches;
}

function subscribeToMediaQuery(query: string, onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mediaQuery = window.matchMedia(query);
  const onChange = () => onStoreChange();
  if (typeof mediaQuery.addEventListener === "function") mediaQuery.addEventListener("change", onChange);
  else mediaQuery.addListener(onChange);
  return () => {
    if (typeof mediaQuery.removeEventListener === "function") mediaQuery.removeEventListener("change", onChange);
    else mediaQuery.removeListener(onChange);
  };
}

/** Subscribe to one media-query value with a stable SSR fallback. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => subscribeToMediaQuery(query, onStoreChange), [query]);
  const getSnapshot = useCallback(() => getMediaQuerySnapshot(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
