import { useState, type FormEvent } from "react";
import { PencilIcon } from "lucide-react";
import type { GuestNoteDto, GuestNoteThreadDto } from "@quincy/shared";
import { noteAnchorLabel } from "../lib/video-note-view";
import { cn } from "../lib/utils";
import { Badge } from "../components/reui/badge";
import { Button } from "../components/reui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/reui/alert-dialog";
import { Item, ItemContent } from "../components/reui/item";
import { Textarea } from "../components/reui/textarea";
import { ICON_BUTTON } from "../components/quincy/icon-button";
import { Menu, MENU_ITEM, MenuPrimitive } from "../components/quincy/menu";
import { IconTip } from "../components/quincy/VideoPlayer";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const BODY = "m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]";
const PROBLEM = "m-0 text-destructive [font:var(--type-body-sm)]";

/** What a note action came to. `message` is what to tell the guest, or null when the answer is not for this form any more (a stale one). */
export type ActionOutcome = { ok: true } | { ok: false; message: string | null };
export type NoteActions = {
  reply: (root: GuestNoteThreadDto, body: string) => Promise<ActionOutcome>;
  edit: (root: GuestNoteThreadDto, note: GuestNoteDto, body: string) => Promise<ActionOutcome>;
  remove: (root: GuestNoteThreadDto, note: GuestNoteDto) => Promise<ActionOutcome>;
};
export type Writing = {
  /** The link allows comments and the Project is not archived. */
  canWrite: boolean;
  verified: boolean;
  actions: NoteActions;
  /** An unverified guest pressed a write control: open the verify dialog. */
  onNeedVerify: () => void;
  /** The composer is open (a new note or an edit): only one draft at a time, so editing another note waits. */
  composerOpen: boolean;
  /** Edit the guest's own root note in the composer (body, frames, drawing). Replies are edited inline, body only. */
  editRoot: (thread: GuestNoteThreadDto) => void;
};

function Author({ note }: { note: GuestNoteDto }) {
  const own = note.author.kind === "guest" && note.author.self;
  return <span className="flex min-w-0 items-center gap-[var(--space-2)]">
    <span data-testid="guest-note-author" className="truncate text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-snug)_var(--font-sans)]">{note.author.name}</span>
    {own
      ? <Badge variant="secondary" size="xs" data-testid="guest-note-self-badge">You</Badge>
      : <Badge variant="outline" size="xs">{note.author.kind === "studio" ? "Studio" : "Client"}</Badge>}
  </span>;
}

function NoteText({ note }: { note: GuestNoteDto }) {
  return note.deleted
    ? <p data-testid="guest-note-tombstone" className="m-0 text-foreground-secondary italic [font:var(--type-body-sm)]">Note deleted</p>
    : <p data-testid="guest-note-body" className={BODY}>{note.body}</p>;
}

type Form = { text: string; problem: string | null; pending: boolean };

/** One thread of the guest page: the root, its replies, and (for the guest's own notes) the actions. Edit, delete and reply forms live here, one open at a time per thread. */
export function GuestThreadItem({ thread, selected, onSelect, timecode, writing }: {
  thread: GuestNoteThreadDto;
  selected: boolean;
  onSelect: (thread: GuestNoteThreadDto) => void;
  timecode: (frame: number) => string;
  writing: Writing;
}) {
  const [editing, setEditing] = useState<(Form & { noteId: string; baseRevision: number }) | null>(null);
  const [replying, setReplying] = useState<Form | null>(null);
  const [deleting, setDeleting] = useState<(Omit<Form, "text"> & { noteId: string }) | null>(null);
  const busy = (editing?.pending ?? false) || (replying?.pending ?? false) || (deleting?.pending ?? false);

  const own = (note: GuestNoteDto) => writing.canWrite && !note.deleted && note.author.kind === "guest" && note.author.self;
  const all = [thread, ...thread.replies];
  const editingNote = editing === null ? null : all.find((note) => note.id === editing.noteId) ?? null;
  const deletingNote = deleting === null ? null : all.find((note) => note.id === deleting.noteId) ?? null;

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null || editingNote === null || editing.pending) return;
    const text = editing.text.trim();
    if (text === "") { setEditing({ ...editing, problem: "A note can't be empty." }); return; }
    if (text === editingNote.body) { setEditing(null); return; }
    setEditing({ ...editing, pending: true, problem: null });
    const outcome = await writing.actions.edit(thread, editingNote, text);
    setEditing((current) => (current === null ? null : outcome.ok ? null : { ...current, pending: false, problem: outcome.message }));
  };
  const sendReply = async (event: FormEvent) => {
    event.preventDefault();
    if (replying === null || replying.pending) return;
    const text = replying.text.trim();
    if (text === "") { setReplying({ ...replying, problem: "Write a reply first." }); return; }
    setReplying({ ...replying, pending: true, problem: null });
    const outcome = await writing.actions.reply(thread, text);
    setReplying((current) => (current === null ? null : outcome.ok ? null : { ...current, pending: false, problem: outcome.message }));
  };
  const confirmDelete = async () => {
    if (deleting === null || deletingNote === null || deleting.pending) return;
    setDeleting({ ...deleting, pending: true, problem: null });
    const outcome = await writing.actions.remove(thread, deletingNote);
    setDeleting((current) => (current === null ? null : outcome.ok ? null : { ...current, pending: false, problem: outcome.message }));
  };

  const menu = (note: GuestNoteDto) => own(note)
    ? <Menu triggerLabel="Actions for your note" label="Note actions" triggerClassName={cn(ICON_BUTTON, "ms-auto")} triggerTestId="guest-note-actions" trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={busy || (note.id === thread.id && writing.composerOpen)} onClick={() => { if (note.id === thread.id) writing.editRoot(thread); else setEditing({ noteId: note.id, baseRevision: note.revision, text: note.body, problem: null, pending: false }); }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={busy} onClick={() => { setDeleting({ noteId: note.id, problem: null, pending: false }); }}>Delete</MenuPrimitive.Item>
    </Menu>
    : null;

  const body = (note: GuestNoteDto) => editing !== null && editing.noteId === note.id
    ? <form data-testid="guest-note-edit-form" aria-label="Edit your note" onSubmit={(event) => { void saveEdit(event); }} noValidate className="flex flex-col gap-[var(--space-2)]">
      <Textarea data-testid="guest-note-edit-body" aria-label="Your note" autoFocus value={editing.text} disabled={editing.pending} onChange={(event) => { setEditing({ ...editing, text: event.target.value }); }} />
      {editing.baseRevision !== note.revision && <p data-testid="guest-note-edit-latest" className="m-0 whitespace-pre-wrap text-foreground-secondary [font:var(--type-body-sm)] [overflow-wrap:anywhere]">{`Latest saved version: ${note.body}`}</p>}
      {editing.problem !== null && <p role="alert" data-testid="guest-note-edit-problem" className={PROBLEM}>{editing.problem}</p>}
      <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
        <Button type="button" variant="ghost" size="sm" data-testid="guest-note-edit-cancel" className={TOUCH} disabled={editing.pending} onClick={() => { setEditing(null); }}>Cancel</Button>
        <Button type="submit" size="sm" data-testid="guest-note-edit-save" className={TOUCH} disabled={editing.pending}>Save</Button>
      </div>
    </form>
    : <NoteText note={note} />;

  return <Item variant="outline" size="sm" data-testid="guest-note" data-note-id={thread.id} data-selected={selected ? "true" : "false"} className="flex-col items-stretch data-[selected=true]:border-foreground">
    <ItemContent className="gap-[var(--space-2)]">
      <div className="flex min-w-0 items-center gap-[var(--space-2)]"><Author note={thread} />{menu(thread)}</div>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {thread.startFrame !== null && <Button type="button" variant="secondary" size="sm" data-testid="guest-note-anchor" aria-label={`Go to ${noteAnchorLabel(thread, timecode)}`} className={cn(TOUCH, "[font:var(--type-mono)] tabular-nums")} onClick={() => { onSelect(thread); }}>{noteAnchorLabel(thread, timecode)}</Button>}
        {thread.hasMarkup && !thread.deleted && <IconTip label="Has a drawing"><span data-testid="guest-note-has-drawing" className="inline-flex items-center text-foreground-secondary"><PencilIcon aria-hidden="true" className="size-3" /><span className="sr-only">Has a drawing</span></span></IconTip>}
      </div>
      {body(thread)}
      {thread.resolved && <Badge variant="success" size="xs" data-testid="guest-note-resolved">Resolved</Badge>}
      {thread.replies.map((reply) => <div key={reply.id} data-testid="guest-note-reply" className="flex flex-col gap-[var(--space-1)] border-l border-border ps-[var(--space-3)]">
        <div className="flex min-w-0 items-center gap-[var(--space-2)]"><Author note={reply} />{menu(reply)}</div>
        {body(reply)}
      </div>)}
      {writing.canWrite && !thread.deleted && (replying === null
        ? <div><Button type="button" variant="ghost" size="sm" data-testid="guest-note-reply-button" className={TOUCH} disabled={busy} onClick={() => { if (!writing.verified) writing.onNeedVerify(); else setReplying({ text: "", problem: null, pending: false }); }}>Reply</Button></div>
        : <form data-testid="guest-reply-form" aria-label="Reply" onSubmit={(event) => { void sendReply(event); }} noValidate className="flex flex-col gap-[var(--space-2)]">
          <Textarea data-testid="guest-reply-body" aria-label="Your reply" autoFocus value={replying.text} disabled={replying.pending} onChange={(event) => { setReplying({ ...replying, text: event.target.value }); }} />
          {replying.problem !== null && <p role="alert" data-testid="guest-reply-problem" className={PROBLEM}>{replying.problem}</p>}
          <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
            <Button type="button" variant="ghost" size="sm" data-testid="guest-reply-cancel" className={TOUCH} disabled={replying.pending} onClick={() => { setReplying(null); }}>Cancel</Button>
            <Button type="submit" size="sm" data-testid="guest-reply-send" className={TOUCH} disabled={replying.pending}>Send reply</Button>
          </div>
        </form>)}
    </ItemContent>
    <AlertDialog open={deleting !== null && deletingNote !== null} onOpenChange={(next) => { if (!next && !busy) setDeleting(null); }}>
      <AlertDialogContent size="default" data-testid="guest-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note?</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {deleting?.problem != null && <p role="alert" data-testid="guest-delete-problem" className={PROBLEM}>{deleting.problem}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="guest-delete-cancel" disabled={deleting?.pending ?? false}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="guest-delete-confirm" disabled={deleting?.pending ?? false} onClick={() => { void confirmDelete(); }}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Item>;
}
