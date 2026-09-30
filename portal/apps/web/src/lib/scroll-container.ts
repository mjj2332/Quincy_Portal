const SCROLLING = new Set(["auto", "scroll", "overlay"]);

/**
 * The nearest ancestor of `element` that scrolls vertically, or `null` when the window does. Walks
 * `parentElement` checking the computed `overflow-y`, and stops at `body`/`documentElement` (their
 * scrolling is the window's, which callers already handle). The element itself is never tested.
 *
 * `overflow: hidden` is deliberately not a scroller here even though it is a scroll container in
 * CSS terms (docs/lessons.md, "overflow: hidden is still a scroll container"): it never scrolls
 * under the user, so nothing scrolls the anchor in or out of view through it.
 */
export function nearestScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (SCROLLING.has(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}
