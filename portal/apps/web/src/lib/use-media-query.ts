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

/**
 * The one phone breakpoint: exactly what Tailwind's `max-[721px]:` compiles to (width < 721, so 720 is phone and 721
 * is desktop). Not `(max-width: 721px)`, which also matches 721 and disagrees with the classes at the edge (#914, #692).
 */
export const PHONE_VIEWPORT_QUERY = "(width < 721px)";

/** Subscribe to one media-query value with a stable SSR fallback. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => subscribeToMediaQuery(query, onStoreChange), [query]);
  const getSnapshot = useCallback(() => getMediaQuerySnapshot(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
