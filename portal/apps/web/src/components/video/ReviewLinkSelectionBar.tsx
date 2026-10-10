import { useLayoutEffect, useRef } from "react";
import { REVIEW_LINK_MAX_VIDEOS } from "@quincy/shared";
import { Button } from "../quincy/Button";

/**
 * The bar that appears once Videos are ticked (#741 11b). PhotoGrid's `ACTIONBAR` inverse surface, copied rather than lifted: PhotoGrid is
 * outside this slice's tree, so the shared `quincy/selection-bar.ts` extraction is deferred. Above 721px it is the floating pill; at or below
 * it, a full-width bar pinned to the bottom with a normal (square-bottomed) radius, one row for the count and the two buttons.
 */
const BAR =
  "fixed left-1/2 bottom-[24px] -translate-x-1/2 z-[60] flex flex-wrap items-center justify-center " +
  "gap-x-[var(--space-4)] gap-y-[var(--space-2)] py-[10px] pr-[12px] pl-[20px] rounded-[var(--radius-pill)] " +
  "shadow-[var(--shadow-lg)] bg-background text-foreground max-w-[calc(100vw-2*var(--space-4))] " +
  "max-[721px]:inset-x-0 max-[721px]:bottom-0 max-[721px]:left-0 max-[721px]:w-full max-[721px]:max-w-none max-[721px]:translate-x-0 " +
  "max-[721px]:justify-start max-[721px]:gap-x-[var(--space-3)] max-[721px]:rounded-t-[var(--radius-lg)] max-[721px]:rounded-b-none " +
  "max-[721px]:pl-[var(--space-4)] max-[721px]:pr-[var(--space-4)] max-[721px]:pb-[calc(10px+env(safe-area-inset-bottom))]";

/** `onHeight` reports the bar's measured height while it is mounted (0 once it goes), so the collection can keep its last cards clear of it. */
export function ReviewLinkSelectionBar({ count, onCreate, onClear, onHeight }: { count: number; onCreate: () => void; onClear: () => void; onHeight?: (height: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    const measure = () => onHeight(Math.ceil(el.getBoundingClientRect().height));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => { observer?.disconnect(); onHeight(0); };
  }, [onHeight]);
  return <div ref={ref} role="region" aria-label="Selected films" data-surface="inverse" data-testid="review-link-selection-bar" className={BAR}>
    <span className="[font:400_18px/1.18_var(--font-display)]">{count}</span>{" "}
    <span className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-on-inverse-muted max-[721px]:mr-auto">selected</span>
    {count > REVIEW_LINK_MAX_VIDEOS && <span role="status" className="max-[721px]:order-last max-[721px]:basis-full [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{`A link can hold at most ${REVIEW_LINK_MAX_VIDEOS} films.`}</span>}
    <span className="h-[22px] w-px bg-border max-[721px]:hidden" aria-hidden="true" />
    <Button type="button" variant="primary" className="min-h-11" disabled={count > REVIEW_LINK_MAX_VIDEOS} onClick={onCreate}>Create Review link</Button>
    <Button type="button" variant="secondary" className="min-h-11" onClick={onClear}>Clear</Button>
  </div>;
}
