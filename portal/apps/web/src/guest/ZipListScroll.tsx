import type { ReactNode } from "react";
import { ScrollArea } from "../components/reui/scroll-area";

/**
 * The scrolling middle of a Download all dialog (#882 follow-up): the zip's status and its list, between the pinned header and footer. A plain `overflow-y-auto` box cut a row flush at its
 * edge, and iOS shows no scroll indicator at rest, so on a phone the list read as clipped rather than scrollable. This is `reui/scroll-area` with the edge fade `PopupFrame` uses: an edge
 * fades only while there is more to scroll past it (`--scroll-area-overflow-y-start/end`, set by Base UI), so the list's last row is drawn in full once it is reached.
 * It runs into the dialog's own padding (`DialogContent` is `p-4`, `--space-4`; the footer does the same with `-mx-4`), so the scrollbar sits in that gutter, inset `--space-1` from the
 * dialog's border, and never over the rows' border.
 * The viewport is focusable while it overflows (Base UI), so its focus ring is drawn on the root, outside the mask.
 */
export function ZipListScroll({ testId, children }: { testId: string; children: ReactNode }) {
  return <ScrollArea data-testid={testId} className="-mx-[var(--space-4)] flex min-h-0 flex-1 flex-col [--fade-size:var(--space-5)] *:data-[slot=scroll-area-viewport]:mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] *:data-[slot=scroll-area-viewport]:mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] *:data-[slot=scroll-area-viewport]:focus-visible:ring-0 *:data-[slot=scroll-area-viewport]:focus-visible:!outline-none *:data-[slot=scroll-area-scrollbar]:right-[var(--space-1)] -outline-offset-2 has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-solid has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-[length:var(--border-width-bold)] has-[[data-slot=scroll-area-viewport]:focus-visible]:outline-[var(--focus-ring)] has-[[data-slot=scroll-area-viewport]:focus-visible]:-outline-offset-2">
    <div className="px-[var(--space-4)]">{children}</div>
  </ScrollArea>;
}
