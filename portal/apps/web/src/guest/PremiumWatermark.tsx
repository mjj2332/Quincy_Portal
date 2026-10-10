/**
 * The premium watermark (#741 12b, 83): drawn over the picture of a premium Video that has not been unlocked, so the first time a client sees one it is marked as a preview.
 * Hand-built, no ReUI item exists for it (see docs/plans/741-12b-ledger.md). It is `pointer-events-none` and `aria-hidden`, so it never takes a click or a screen-reader stop, and it
 * paints with the inverse text token only. The stage clips it (`overflow-hidden`), so the rotated field can be larger than the picture.
 */
const TILES = 12;

export function PremiumWatermark() {
  return <div data-testid="guest-watermark" aria-hidden="true" className="pointer-events-none absolute inset-0 select-none overflow-hidden">
    <div className="absolute -inset-[30%] grid -rotate-[20deg] grid-cols-3 content-around justify-items-center gap-y-[var(--space-8)] text-invert-foreground/30 [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)]">
      {Array.from({ length: TILES }, (_, index) => <span key={index} className="whitespace-nowrap">Preview only</span>)}
    </div>
  </div>;
}
