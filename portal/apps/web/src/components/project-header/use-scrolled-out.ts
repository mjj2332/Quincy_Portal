import { useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useLatest } from "../../lib/use-latest";
import { useProjectSheet } from "../quincy/ProjectSheet";

/**
 * #914 — whether `target` has scrolled out above the top of the Project sheet's scroller (shrunk by `rootMargin`). One
 * IntersectionObserver (root: the sheet context's `body`, threshold 0) on an element whose own geometry never depends on the answer,
 * so the observation cannot feed back into itself. Re-made for another Project, and dropped while `enabled` is false (the whiteboard covers
 * the Workspace, and a hidden element has no geometry to measure). With no IntersectionObserver the answer stays false.
 *
 * - D5: Row A out condenses Row B (desktop).
 * - M2: the phone project bar under the 48px slim bar (`rootMargin: "-48px 0px 0px 0px"`) swaps the slim bar in.
 *
 * Either swap unmounts or inerts the controls focus may be on. `handOff(next)` runs before the swap and may return a step to run
 * after it (moving focus to the control's twin in the bar that is now live).
 */
export function useScrolledOut(target: RefObject<HTMLElement | null>, projectId: string, enabled: boolean, options: { rootMargin?: string; handOff?: (next: boolean) => (() => void) | void } = {}): boolean {
  const [out, setOut] = useState(false);
  const current = useRef(false);
  const handOff = useLatest(options.handOff);
  const rootMargin = options.rootMargin ?? "0px";
  // The sheet's scroll body (its context's `body`, set once it mounts); outside a sheet, the viewport.
  const scroller = useProjectSheet()?.body ?? null;
  useEffect(() => {
    current.current = false;
    setOut(false);
    const element = target.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // Out above the top only: an element below the fold (never the case at the top of the work area) does not count.
      const next = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
      if (next === current.current) return;
      current.current = next;
      const after = handOff.current?.(next);
      flushSync(() => setOut(next));
      after?.();
    }, { root: scroller, rootMargin, threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, projectId, enabled, rootMargin, handOff, scroller]);
  return out;
}

/**
 * Whether `element` is a control a person can reach now. The header draws some controls twice and makes the twin it is not showing
 * inert (`data-twin-bar`); only that disqualifies one. An `inert` a modal layer puts on the page around itself does not, or a
 * layer closing would find nowhere to return focus to.
 */
export function isLiveTwin(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element?.isConnected && !element.closest("[data-twin-bar][inert]"));
}

/**
 * Moves focus from a control inside `from` to its twin inside `to` (the element carrying the same `data-twin` name), after the swap
 * has committed. Nothing happens when focus is elsewhere.
 */
export function twinHandOff(from: HTMLElement | null, to: () => HTMLElement | null): (() => void) | void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !from?.contains(active)) return;
  const name = active.closest<HTMLElement>("[data-twin]")?.dataset.twin;
  if (!name) return;
  return () => to()?.querySelector<HTMLElement>(`[data-twin="${name}"]`)?.focus({ preventScroll: true });
}
