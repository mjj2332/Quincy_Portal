import { useEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * #914 D5 — whether the desktop header is condensed: Row A (the labelled section) has scrolled out above the top of the Project
 * sheet's scroller, so Row B, the sticky tab bar, shows the stage dot and title, Whiteboard and Project info. One observer on Row A
 * (root: the sheet body, threshold 0), never on Row B, whose own height change would feed back into the observation. Re-made for
 * another Project and dropped while the whiteboard covers the Workspace (a hidden Row A has no geometry to measure). With no
 * IntersectionObserver the header simply never condenses.
 *
 * Un-condensing unmounts the bar's copies of Whiteboard and Project info. A copy that held focus names its Row A twin
 * (`data-condensed-twin`, the twin's test id), and focus moves there instead of falling to the body.
 */
export function useCondensedHeader(rowA: RefObject<HTMLElement | null>, rowB: RefObject<HTMLElement | null>, projectId: string, enabled: boolean): boolean {
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    setCondensed(false);
    const element = rowA.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // Out above the top only: a Row A below the fold (never the case at the top of the work area) does not condense.
      const next = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
      const active = document.activeElement;
      const twin = !next && active instanceof HTMLElement && rowB.current?.contains(active) ? active.closest<HTMLElement>("[data-condensed-twin]")?.dataset.condensedTwin : undefined;
      flushSync(() => setCondensed(next));
      if (twin) rowA.current?.querySelector<HTMLElement>(`[data-testid="${twin}"]`)?.focus({ preventScroll: true });
    }, { root: element.closest<HTMLElement>(".project-sheet__body"), threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rowA, rowB, projectId, enabled]);
  return condensed;
}
