import type { ReactNode } from "react";
import type { GuestNoteThreadDto } from "@quincy/shared";
import { Button } from "../components/reui/button";
import { ItemGroup } from "../components/reui/item";
import { ScrollArea } from "../components/reui/scroll-area";
import { EmptyState } from "../components/quincy/EmptyState";
import { GuestThreadItem, type Writing } from "./GuestNoteItem";

/**
 * The notes list of the guest page (#741 12b, 13c): the public threads of the Version on screen, in the server's order. A guest can read them and press a timecode to seek, and (13c) add,
 * reply to, edit and delete notes through `writing`; `top` is the "Add a note" entry or the open composer. It reads no staff store and no staff DTO: `VideoNoteThread` is coupled to the
 * form store and the staff person, so this is built from the installed `item`, `badge` and `scroll-area`. `threads` is null while the first read is out.
 *
 * On a phone (#879 PR 2) `top` is the pill strip at the sheet's foot, with the staff strip's wrapper (a top border at rest; in compose mode the strip itself, which may shrink).
 * Everything else is one list that scrolls above it (the prototype's P2: the tab body scrolls, the tab row and the composer stay), as the staff panel holds its header and filters
 * in its list on a phone: the delivery row (`header`), the notes in whatever state they are (loading, failed, none, the cards), then the footer rows (who is reviewing,
 * email updates). The panel clips, so no state can overflow under the pill (fix round 1: with no notes the rows sat behind it and could not be scrolled to).
 */
export function GuestNotesPanel({ threads, failed, onRetry, selectedId, onSelect, timecode, header, top, footer, writing, phone = false }: {
  threads: readonly GuestNoteThreadDto[] | null;
  /** The notes read failed in transit (not a revoked link): say so in place and offer to repeat it. */
  failed: boolean;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (thread: GuestNoteThreadDto) => void;
  timecode: (frame: number) => string;
  /** The panel's heading row; the desktop column and the phone drawer each supply their own. */
  header?: ReactNode;
  /** Above the list: the "Add a note" entry, or the composer while one is open. */
  top?: ReactNode;
  /** A quiet row below the list, outside the scroll area (the email-updates switch); on a phone, the end of the list. */
  footer?: ReactNode;
  writing: Writing;
  /** The phone sheet's layout (#879 PR 2). */
  phone?: boolean;
}) {
  const items = (threads: readonly GuestNoteThreadDto[]) => <ItemGroup className="gap-[var(--space-2)]">
    {threads.map((thread) => <GuestThreadItem key={thread.id} thread={thread} selected={thread.id === selectedId} onSelect={onSelect} timecode={timecode} writing={writing} />)}
  </ItemGroup>;
  const state = failed
    ? <EmptyState size="compact" tone="error" data-testid="guest-notes-unreachable" title="Couldn't reach Quincy. Check your connection and try again."><Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onRetry}>Try again</Button></EmptyState>
    : threads === null
    ? <p className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">Loading notes…</p>
    : threads.length === 0 ? <EmptyState size="compact" title="No notes yet" /> : null;

  if (phone) return <section data-testid="guest-notes-panel" aria-label="Notes" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)] overflow-clip">
    {top && <div data-sheet-part="composer" className="order-last shrink-0 border-t border-border pt-[var(--space-3)] in-data-[mode=compose]:flex in-data-[mode=compose]:min-h-0 in-data-[mode=compose]:shrink in-data-[mode=compose]:flex-col in-data-[mode=compose]:border-t-0 in-data-[mode=compose]:pt-0">{top}</div>}
    <div data-sheet-part="body" className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" data-testid="guest-notes-list" viewportProps={{ tabIndex: -1 }}>
        <div className="grid gap-[var(--space-3)] pe-[var(--space-1)]">
          {header}
          {state ?? (threads && items(threads))}
          {footer}
        </div>
      </ScrollArea>
    </div>
  </section>;

  return <section data-testid="guest-notes-panel" aria-label="Notes" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)]">
    {header && <div data-sheet-part="body" className="shrink-0">{header}</div>}
    {top && <div data-sheet-part="composer" className="-m-1 max-h-[60%] min-h-0 shrink-0 overflow-y-auto p-1 max-[721px]:order-last max-[721px]:max-h-none">{top}</div>}
    <div data-sheet-part="body" className="flex min-h-0 flex-1 flex-col">
      {state ?? <ScrollArea className="min-h-0 flex-1">{threads && items(threads)}</ScrollArea>}
    </div>
    {footer && <div data-sheet-part="body" className="shrink-0">{footer}</div>}
  </section>;
}
