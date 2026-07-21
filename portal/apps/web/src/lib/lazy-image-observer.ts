/** Small DOM seam so terminal-image behavior can be regression-tested without a DOM runner. */
export function attachLazyImageObserver(
  target: () => Element | null,
  onIntersection: (isIntersecting: boolean) => void,
  Observer: typeof IntersectionObserver = IntersectionObserver,
) {
  const observer = new Observer((entries) => {
    for (const entry of entries) if (entry.target === target()) onIntersection(entry.isIntersecting);
  }, { rootMargin: "600px" });
  const initial = target();
  if (initial) observer.observe(initial);
  return observer;
}
