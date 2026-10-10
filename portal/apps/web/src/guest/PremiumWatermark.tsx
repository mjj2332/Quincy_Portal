import type { Box } from "@quincy/shared";

/**
 * The premium watermark (#741 12b, 83): drawn over the picture of a premium Video that has not been unlocked, so the first time a client sees one it is marked as a preview.
 * Hand-built, no ReUI item exists for it (see docs/plans/741-12b-ledger.md). It is `pointer-events-none` and `aria-hidden`, so it never takes a click or a screen-reader stop, and it
 * paints with the inverse text token only. It is clipped to the picture `box` the stage reports (the same placement as the timecode chip's `video-picture-box`), so it never spills into
 * the letterbox bands. Tiles are spaced with `--space-*` tokens, not stretched to the picture, so the density is the same at 1440px and 390px; the count only has to cover the rotated field.
 */
const TILE_W = 192;
const TILE_H = 96;

export function PremiumWatermark({ box }: { box: Box }) {
  const tiles = Math.ceil((4 * box.width * box.height) / (TILE_W * TILE_H)) + 6;
  return <div className="pointer-events-none absolute overflow-hidden" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
    <div data-testid="guest-watermark" aria-hidden="true" className="pointer-events-none absolute -inset-1/2 flex -rotate-[20deg] select-none flex-wrap content-center justify-center text-invert-foreground/30 [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)]">
      {Array.from({ length: tiles }, (_, index) => <span key={index} className="whitespace-nowrap px-[var(--space-8)] py-[var(--space-6)]">Preview only</span>)}
    </div>
  </div>;
}
