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
 */
export function GuestNotesPanel({ threads, failed, onRetry, selectedId, onSelect, timecode, header, top, writing }: {
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
  writing: Writing;
}) {
  return <section data-testid="guest-notes-panel" aria-label="Notes" className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)]">
    {header && <div className="shrink-0">{header}</div>}
    {top && <div className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto">{top}</div>}
    {failed
      ? <EmptyState size="compact" tone="error" data-testid="guest-notes-unreachable" title="Couldn't reach Quincy. Check your connection and try again."><Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onRetry}>Try again</Button></EmptyState>
      : threads === null
      ? <p className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">Loading notes…</p>
      : threads.length === 0
        ? <EmptyState size="compact" title="No notes yet" />
        : <ScrollArea className="min-h-0 flex-1">
          <ItemGroup className="gap-[var(--space-2)]">
            {threads.map((thread) => <GuestThreadItem key={thread.id} thread={thread} selected={thread.id === selectedId} onSelect={onSelect} timecode={timecode} writing={writing} />)}
          </ItemGroup>
        </ScrollArea>}
  </section>;
}
