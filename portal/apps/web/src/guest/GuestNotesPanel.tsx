import type { ReactNode } from "react";
import type { GuestNoteDto, GuestNoteThreadDto } from "@quincy/shared";
import { noteAnchorLabel } from "../lib/video-note-view";
import { Badge } from "../components/reui/badge";
import { Button } from "../components/reui/button";
import { Item, ItemContent, ItemGroup } from "../components/reui/item";
import { ScrollArea } from "../components/reui/scroll-area";
import { EmptyState } from "../components/quincy/EmptyState";

const BODY = "m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]";

function Author({ note }: { note: GuestNoteDto }) {
  return <span className="flex min-w-0 items-center gap-[var(--space-2)]">
    <span data-testid="guest-note-author" className="truncate text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-snug)_var(--font-sans)]">{note.author.name}</span>
    <Badge variant="outline" size="xs">{note.author.kind === "studio" ? "Studio" : "Client"}</Badge>
  </span>;
}

function NoteText({ note }: { note: GuestNoteDto }) {
  return note.deleted
    ? <p data-testid="guest-note-tombstone" className="m-0 text-foreground-secondary italic [font:var(--type-body-sm)]">Note deleted</p>
    : <p data-testid="guest-note-body" className={BODY}>{note.body}</p>;
}

/**
 * The read-only notes list of the guest page (#741 12b): the public threads of the Version on screen, in the server's order. A guest can read them and press a timecode to seek;
 * writing (the composer, replies, resolve) arrives with 13. It reads no staff store and no staff DTO: `VideoNoteThread` is coupled to the form store and the staff person, so this is
 * built from the installed `item`, `badge` and `scroll-area`. `threads` is null while the first read is out.
 */
export function GuestNotesPanel({ threads, failed, onRetry, selectedId, onSelect, timecode, header }: {
  threads: readonly GuestNoteThreadDto[] | null;
  /** The notes read failed in transit (not a revoked link): say so in place and offer to repeat it. */
  failed: boolean;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (thread: GuestNoteThreadDto) => void;
  timecode: (frame: number) => string;
  /** The panel's heading row; the desktop column and the phone drawer each supply their own. */
  header?: ReactNode;
}) {
  return <section data-testid="guest-notes-panel" aria-label="Notes" className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-3)]">
    {header}
    {failed
      ? <EmptyState size="compact" tone="error" data-testid="guest-notes-unreachable" title="Couldn't reach Quincy. Check your connection and try again."><Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onRetry}>Try again</Button></EmptyState>
      : threads === null
      ? <p className="m-0 text-foreground-secondary [font:var(--type-body-sm)]">Loading notes…</p>
      : threads.length === 0
        ? <EmptyState size="compact" title="No notes yet" />
        : <ScrollArea className="min-h-0 flex-1">
          <ItemGroup className="gap-[var(--space-2)]">
            {threads.map((thread) => <Item key={thread.id} variant="outline" size="sm" data-testid="guest-note" data-note-id={thread.id} data-selected={thread.id === selectedId ? "true" : "false"} className="flex-col items-stretch data-[selected=true]:bg-muted">
              <ItemContent className="gap-[var(--space-2)]">
                <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
                  <Author note={thread} />
                  {thread.startFrame !== null && <Button type="button" variant="ghost" size="sm" data-testid="guest-note-anchor" aria-label={`Go to ${noteAnchorLabel(thread, timecode)}`} className="pointer-coarse:min-h-11 max-[721px]:min-h-11 [font:var(--type-mono)] tabular-nums" onClick={() => { onSelect(thread); }}>{noteAnchorLabel(thread, timecode)}</Button>}
                </div>
                <NoteText note={thread} />
                {thread.resolved && <Badge variant="success" size="xs" data-testid="guest-note-resolved">Resolved</Badge>}
                {thread.replies.map((reply) => <div key={reply.id} data-testid="guest-note-reply" className="flex flex-col gap-[var(--space-1)] border-l border-border ps-[var(--space-3)]">
                  <Author note={reply} />
                  <NoteText note={reply} />
                </div>)}
              </ItemContent>
            </Item>)}
          </ItemGroup>
        </ScrollArea>}
  </section>;
}
