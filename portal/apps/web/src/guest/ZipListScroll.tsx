import type { ReactNode } from "react";
import { ScrollArea } from "../components/reui/scroll-area";
import { cn } from "../lib/utils";

/**
 * The scrolling middle of a Download all dialog (#882 follow-up): the zip's status and its list, between the pinned header and footer. A plain `overflow-y-auto` box cut a row flush at its
 * edge, and iOS shows no scroll indicator at rest, so on a phone the list read as clipped rather than scrollable. This is `reui/scroll-area` with the edge fade `PopupFrame` uses: an edge
 * fades only while there is more to scroll past it (`--scroll-area-overflow-y-start/end`, set by Base UI), so the list's last row is drawn in full once it is reached.
 * It runs into the dialog's own padding (`DialogContent` is `p-4`, `--space-4`; the footer does the same with `-mx-4`), so the scrollbar sits in that gutter, inset `--space-1` from the
 * dialog's border (important: Base UI writes `inset-inline-end: 0` inline), and never over the rows' border.
 * The viewport is focusable while it overflows (Base UI), so its focus ring is drawn on the root, outside the mask.
 * `className` is merged onto the root (#907): the photo dialog passes `[@media(height<520px)]:flex-none` so at short heights its dialog is the one scroller and this never overflows.
 */
export function ZipListScroll({ testId, className, children }: { testId: string; className?: string; children: ReactNode }) {
  return <ScrollArea data-testid={testId} className={cn("-mx-[var(--space-4)] flex min-h-0 flex-1 flex-col [--fade-size:var(--space-5)] *:data-[slot=scroll-area-viewport]:mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] *:data-[slot=scroll-area-viewport]:mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] *:data-[slot=scroll-area-viewport]:focus-visible:ring-0 *:data-[slot=scroll-area-viewport]:focus-visible:!outline-none *:data-[slot=scroll-area-scrollbar]:!end-[var(--space-1)] -outline-offset-2 has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-solid has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-[length:var(--border-width-bold)] has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-[var(--focus-ring)] has-[[data-slot=scroll-area-viewport]:focus-visible]:-outline-offset-2", className)}>
    <div className="px-[var(--space-4)]">{children}</div>
  </ScrollArea>;
}
