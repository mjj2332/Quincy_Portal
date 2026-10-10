import { Button } from "../quincy/Button";

/**
 * The bar that appears once Videos are ticked (#741 11b). PhotoGrid's `ACTIONBAR` inverse surface, copied rather than lifted: PhotoGrid is
 * outside this slice's tree, so the shared `quincy/selection-bar.ts` extraction is deferred. Adds `flex-wrap` and a viewport max width
 * so it holds together at 390px.
 */
const BAR =
  "fixed left-1/2 bottom-[24px] -translate-x-1/2 z-[60] flex flex-wrap items-center justify-center " +
  "gap-x-[var(--space-4)] gap-y-[var(--space-2)] py-[10px] pr-[12px] pl-[20px] rounded-[var(--radius-pill)] " +
  "shadow-[var(--shadow-lg)] bg-background text-foreground max-w-[calc(100vw-2*var(--space-4))]";

export function ReviewLinkSelectionBar({ count, onCreate, onClear }: { count: number; onCreate: () => void; onClear: () => void }) {
  return <div role="region" aria-label="Selected films" data-surface="inverse" data-testid="review-link-selection-bar" className={BAR}>
    <span className="[font:400_18px/1.18_var(--font-display)]">{count}</span>{" "}
    <span className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-on-inverse-muted">selected</span>
    <span className="h-[22px] w-px bg-border max-[721px]:hidden" aria-hidden="true" />
    <Button type="button" variant="primary" className="min-h-11" onClick={onCreate}>Create Review link</Button>
    <Button type="button" variant="secondary" className="min-h-11" onClick={onClear}>Clear</Button>
  </div>;
}
