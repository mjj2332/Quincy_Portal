import { cn } from "@/lib/utils"

// Two corrections to the vendor class string.
//
// 1. Colour and geometry: nova's `bg-muted` and `rounded-md` are re-pointed to Quincy's
//    `bg-surface-sunken` and a square corner. The dashboard's shipped skeleton bars
//    (`Dashboard.tsx`, the projects loading block) are square `bg-surface-sunken` rectangles, and
//    the surrounding list they stand in for has no corner radius either — a rounded bar would
//    announce itself as a different shape from the row it is loading.
//
// 2. `animate-pulse` is gated behind `motion-safe:`. Every other looping animation in this app is
//    (`Dashboard.tsx`'s `motion-safe:animate-[fade_…]` on the same loading panel), and an
//    ungated infinite pulse is a WCAG 2.3.3 / prefers-reduced-motion problem rather than a
//    stylistic one. The bar still paints its resting `bg-surface-sunken`, so the skeleton reads
//    correctly with animation suppressed.
const SKELETON = "motion-safe:animate-pulse bg-surface-sunken"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(SKELETON, className)}
      {...props}
    />
  )
}

export { Skeleton, SKELETON }
