import type { ReactNode } from "react";
import type { GuestNoteThreadDto } from "@quincy/shared";
import { Button } from "../components/reui/button";
import { ItemGroup } from "../components/reui/item";
import { ScrollArea } from "../components/reui/scroll-area";
import { EmptyState } from "../components/quincy/EmptyState";
import { GuestThreadItem, type Writing } from "./GuestNoteItem";

/**
 * The notes list of the guest page (#741 12b, 13c): the public threads of the Version on screen, in the server's order. A guest can read them and press a timecode to seek, and (13c) add,
 * reply to, edit and delete notes through `writing`; `top` is the note box (#927 G1), the panel's foot at every width. It reads no staff store and no staff DTO: `VideoNoteThread` is coupled to the
 * form store and the staff person, so this is built from the installed `item`, `badge` and `scroll-area`. `threads` is null while the first read is out.
 *
 * On a phone (#879 PR 2, #927 P1) `top` is the box at the sheet's foot; it draws its own top border and padding, and in compose mode it may shrink.
 * Everything else is one list that scrolls above it (the prototype's P2: the tab body scrolls, the tab row and the composer stay), as the staff panel holds its header and filters
 * in its list on a phone: the delivery row (`header`), the notes in whatever state they are (loading, failed, none, the cards), then the footer rows (who is reviewing,
 * email updates). The panel clips, so no state can overflow under the pill (fix round 1: with no notes the rows sat behind it and could not be scrolled to).
 */
export function GuestNotesPanel({ threads, failed, onRetry, selectedId, onSelect, timecode, header, top, footer, writing, phone = false, filteredEmpty }: {
  threads: readonly GuestNoteThreadDto[] | null;
  /** The notes read failed in transit (not a revoked link): say so in place and offer to repeat it. */
  failed: boolean;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (thread: GuestNoteThreadDto) => void;
  timecode: (frame: number) => string;
  /** The panel's heading row; the desktop column and the phone drawer each supply their own. */
  header?: ReactNode;
  /** The note box, under the list (G1). */
  top?: ReactNode;
  /** A quiet row below the list, outside the scroll area (the email-updates switch); on a phone, the end of the list. */
  footer?: ReactNode;
  writing: Writing;
  /** The phone sheet's layout (#879 PR 2). */
  phone?: boolean;
  /** What an empty list says when the phone filters emptied it (#879 PR 3b): "No notes match." with Reset filters. Absent, an empty list has no notes at all. */
  filteredEmpty?: ReactNode;
}) {
  const items = (threads: readonly GuestNoteThreadDto[]) => <ItemGroup className="gap-[var(--space-2)]">
    {threads.map((thread) => <GuestThreadItem key={thread.id} thread={thread} selected={thread.id === selectedId} onSelect={onSelect} timecode={timecode} writing={writing} />)}
  </ItemGroup>;
  const state = failed
    ? <EmptyState size="compact" tone="error" data-testid="guest-notes-unreachable" title="Couldn't reach Quincy. Check your connection and try again."><Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onRetry}>Try again</Button></EmptyState>
    : threads === null
    ? <p className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">Loading notes…</p>
    : threads.length === 0 ? filteredEmpty ?? <EmptyState size="compact" title="No notes yet" /> : null;

  // Browse mode's composer band (#927 P1): no gap above it; the box draws its own border and padding; the list's own padding keeps its first and last rows clear.
  if (phone) return <section data-testid="guest-notes-panel" aria-label="Notes" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)] overflow-clip in-data-[mode=browse]:gap-0">
    {top && <div data-sheet-part="composer" className="order-last shrink-0 in-data-[mode=compose]:flex in-data-[mode=compose]:min-h-0 in-data-[mode=compose]:shrink in-data-[mode=compose]:flex-col in-data-[immersive=compose]:flex in-data-[immersive=compose]:min-h-0 in-data-[immersive=compose]:shrink in-data-[immersive=compose]:flex-col">{top}</div>}
    <div data-sheet-part="body" className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" data-testid="guest-notes-list" viewportProps={{ tabIndex: -1 }}>
        {/* The end gutter holds the overlay scrollbar (`w-2.5`) clear of the cards' right border (fix round 4); the start stays flush. */}
        {/* The phone head opens the list on the tab row's hairline (P1 `NotesFilter`, #879 PR 3b F4): the list keeps its bottom padding and drops the top, which the head's own carries. */}
        <div data-testid="guest-notes-list-body" className={`grid gap-[var(--space-3)] pe-[var(--space-3)] ${header ? "in-data-[mode=browse]:pt-0 in-data-[mode=browse]:pb-[var(--space-3)]" : "in-data-[mode=browse]:py-[var(--space-3)]"}`}>
          {header}
          {state ?? (threads && items(threads))}
          {footer}
        </div>
      </ScrollArea>
    </div>
  </section>;

  return <section data-testid="guest-notes-panel" aria-label="Notes" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)]">
    {header && <div data-sheet-part="body" className="shrink-0">{header}</div>}
    <div data-sheet-part="body" className="flex min-h-0 flex-1 flex-col">
      {state ?? <ScrollArea className="min-h-0 flex-1">{threads && items(threads)}</ScrollArea>}
    </div>
    {footer && <div data-sheet-part="body" className="shrink-0">{footer}</div>}
    {/* G1: the box is the rail's foot, edge to edge under its top hairline (the aside's padding is bled off); Full screen's floating box has no padding to bleed. */}
    {top && <div data-sheet-part="composer" className="-mx-[var(--space-5)] -mb-[var(--space-5)] shrink-0 in-data-[immersive=compose]:m-0">{top}</div>}
  </section>;
}
