import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNoteDraft, type GuestDrafts } from "./guest-drafts";
import { PencilIcon } from "lucide-react";
import { legacyBodyToRichTextDoc, type GuestNoteDto, type GuestNoteThreadDto, type RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { RichTextContent } from "../components/RichTextContent";
import { noteAnchorLabel } from "../lib/video-note-view";
import { cn } from "../lib/utils";
import { Badge } from "../components/reui/badge";
import { Button } from "../components/reui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/reui/alert-dialog";
import { Item, ItemContent } from "../components/reui/item";
import { ICON_BUTTON } from "../components/quincy/icon-button";
import { Menu, MENU_ITEM, MenuPrimitive } from "../components/quincy/menu";
import { ResolvedTick } from "../components/quincy/ResolvedTick";
import { IconTip } from "../components/quincy/VideoPlayer";
import { noteText, sameDoc } from "./guest-compose";
import { GuestNoteField } from "./GuestNoteField";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const BODY = "m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]";
const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };
const PROBLEM = "m-0 text-destructive [font:var(--type-body-sm)]";

/** What a note action came to. `message` is what to tell the guest, or null when the answer is not for this form any more (a stale one). */
/** `saved` is a write that landed but whose answer is not for this view any more (the guest went to All videos meanwhile): the form's draft is done with all the same. `conflict` is the thread a conflict answered with: the latest version the guest was shown. */
export type ActionOutcome = { ok: true } | { ok: false; message: string | null; saved?: boolean; conflict?: GuestNoteThreadDto };
export type NoteActions = {
  reply: (root: GuestNoteThreadDto, content: RichTextDoc) => Promise<ActionOutcome>;
  edit: (root: GuestNoteThreadDto, note: GuestNoteDto, content: RichTextDoc, expectedRevision: number) => Promise<ActionOutcome>;
  remove: (root: GuestNoteThreadDto, note: GuestNoteDto, expectedRevision: number) => Promise<ActionOutcome>;
};
export type Writing = {
  /** The link allows comments and the Project is not archived. */
  canWrite: boolean;
  verified: boolean;
  /** The link's media routes (#835 C): where a note's pictures are read from, and what a reply's editor uploads through. */
  media: EditorMediaTransport;
  actions: NoteActions;
  /** The reply and reply-edit drafts, which outlive the list (the phone drawer closing, a re-verification). */
  drafts: GuestDrafts;
  /** An unverified guest pressed a write control: open the verify dialog. */
  onNeedVerify: () => void;
  /** The composer is open (a new note or an edit): only one draft at a time, so editing another note waits. */
  composerOpen: boolean;
  /** Edit the guest's own root note in the composer (body, frames, drawing). Replies are edited inline, body only. */
  editRoot: (thread: GuestNoteThreadDto) => void;
  /** Social preview is on (#872): every write control and form is hidden and inert, but stays mounted, so a draft keeps its place and its text. A saved note stays readable. */
  paused?: boolean;
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

/** The note as the guest reads it: the rich document when the note has one (pictures from the link's media routes; a mention is already the plain "@Name"), else its text. */
function NoteText({ note, media }: { note: GuestNoteDto; media: EditorMediaTransport }) {
  if (note.deleted) return <p data-testid="guest-note-tombstone" className="m-0 text-foreground-secondary italic [font:var(--type-body-sm)]">Note deleted</p>;
  if (note.content) return <div data-testid="guest-note-body" className="text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]"><RichTextContent content={note.content} mediaUrl={media.mediaUrl} posterUrl={media.posterUrl} /></div>;
  return <p data-testid="guest-note-body" className={BODY}>{note.body}</p>;
}

type Status = { problem: string | null; pending: boolean };
const IDLE: Status = { problem: null, pending: false };

/** One thread of the guest page: the root, its replies, and (for the guest's own notes) the actions. Edit, delete and reply forms live here, one open at a time per thread; the reply and edit drafts live in `writing.drafts`, not in this component. */
export function GuestThreadItem({ thread, selected, onSelect, timecode, writing }: {
  thread: GuestNoteThreadDto;
  selected: boolean;
  onSelect: (thread: GuestNoteThreadDto) => void;
  timecode: (frame: number) => string;
  writing: Writing;
}) {
  const { drafts } = writing;
  const editKey = `edit:${thread.id}`;
  const replyKey = `reply:${thread.id}`;
  const editDraft = useNoteDraft(drafts, editKey);
  const replyDraft = useNoteDraft(drafts, replyKey);
  const [editStatus, setEditStatus] = useState<Status>(IDLE);
  const [replyStatus, setReplyStatus] = useState<Status>(IDLE);
  const [deleting, setDeleting] = useState<(Status & { noteId: string; baseRevision: number }) | null>(null);
  /** A delete that hit a conflict: the confirm closed and the note row shows the latest text, with this line above it. */
  const [deleteConflict, setDeleteConflict] = useState<string | null>(null);
  // A picture still going up holds Send / Save: the note would go without it.
  const [editUploading, setEditUploading] = useState(false);
  const [replyUploading, setReplyUploading] = useState(false);
  const busy = (editDraft !== null && editStatus.pending) || (replyDraft !== null && replyStatus.pending) || (deleting?.pending ?? false);

  const paused = writing.paused === true;
  const own = (note: GuestNoteDto) => writing.canWrite && !paused && !note.deleted && note.author.kind === "guest" && note.author.self;
  const all = [thread, ...thread.replies];
  const editingNote = editDraft === null ? null : all.find((note) => note.id === editDraft.noteId) ?? null;
  const deletingNote = deleting === null ? null : all.find((note) => note.id === deleting.noteId) ?? null;

  // A confirm that is not yet sent does not outlive Social preview; one already sent settles on its own.
  useEffect(() => { if (paused) setDeleting((current) => (current !== null && !current.pending ? null : current)); }, [paused]);

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!writing.canWrite || editDraft === null || editingNote === null || editStatus.pending || editUploading) return;
    if (noteText(editDraft.doc) === "") { setEditStatus({ pending: false, problem: "A note can't be empty." }); return; }
    if (sameDoc(editDraft.doc, editDraft.baseDoc)) { drafts.clear(editKey); setEditStatus(IDLE); return; }
    setEditStatus({ pending: true, problem: null });
    const sent = editDraft;
    const outcome = await writing.actions.edit(thread, editingNote, sent.doc, sent.ackRevision ?? sent.baseRevision ?? editingNote.revision);
    if (outcome.ok || outcome.saved === true) { drafts.clearIf(editKey, sent.rev); setEditStatus(IDLE); return; }
    // A conflict showed the guest the latest version: saving again is their acknowledgement, so the base moves to it (and only then).
    const shown = outcome.conflict === undefined ? undefined : [outcome.conflict, ...outcome.conflict.replies].find((candidate) => candidate.id === editingNote.id);
    if (shown !== undefined) { const current = drafts.get(editKey); if (current !== null && current.rev === sent.rev) drafts.set(editKey, { ...current, ackRevision: shown.revision }); }
    setEditStatus({ pending: false, problem: outcome.message });
  };
  const sendReply = async (event: FormEvent) => {
    event.preventDefault();
    if (!writing.canWrite || replyDraft === null || replyStatus.pending || replyUploading) return;
    if (noteText(replyDraft.doc) === "") { setReplyStatus({ pending: false, problem: "Write a reply first." }); return; }
    setReplyStatus({ pending: true, problem: null });
    const sent = replyDraft;
    const outcome = await writing.actions.reply(thread, sent.doc);
    if (outcome.ok || outcome.saved === true) { drafts.clearIf(replyKey, sent.rev); setReplyStatus(IDLE); } else setReplyStatus({ pending: false, problem: outcome.message });
  };
  // A hard-deleted root unmounts this whole thread, the confirm with it, so `finalFocus` never runs. When the unmount actually happens
  // (the list may drop the thread a tick or a refetch later), park focus on the survivor if it fell to the page.
  const afterDelete = useRef<(() => HTMLElement | null) | null>(null);
  useEffect(() => () => {
    const fallback = afterDelete.current;
    if (fallback === null) return;
    window.setTimeout(() => { const active = document.activeElement; if (active === null || active === document.body || !active.isConnected) fallback()?.focus(); }, 0);
  }, []);
  const confirmDelete = async () => {
    if (!writing.canWrite || deleting === null || deletingNote === null || deleting.pending) return;
    setDeleting({ ...deleting, pending: true, problem: null });
    // The revision the confirm opened on, never the list's, which may have moved unseen.
    const outcome = await writing.actions.remove(thread, deletingNote, deleting.baseRevision);
    if (outcome.ok) {
      afterDelete.current = deleteFallbackFocus();
      setDeleting(null);
      return;
    }
    // A conflict closes the confirm without acknowledging anything: the note row shows the latest text, and deleting again snapshots that revision.
    if (outcome.conflict !== undefined) { setDeleteConflict(outcome.message); setDeleting(null); return; }
    setDeleting((current) => (current === null ? null : { ...current, pending: false, problem: outcome.message }));
  };

  /**
   * Where focus lands when the delete confirm closes. Base UI would restore it to the "..." trigger that opened the menu, but a hard-deleted
   * root takes its thread (and that trigger) with it, so focus would fall to `body`. If the same menu triggers are still there (a reply
   * deleted, or a delete refused), return to the one that opened the confirm; otherwise to "Add a note", else the notes panel itself.
   */
  const deleteFallbackFocus = () => () => document.querySelector<HTMLElement>('[data-testid="guest-add-note"]') ?? document.querySelector<HTMLElement>('[data-testid="guest-notes-panel"]');
  const deleteFinalFocus = () => {
    const triggers = [...(document.querySelector(`[data-note-id="${thread.id}"]`)?.querySelectorAll<HTMLElement>('[data-testid="guest-note-actions"]') ?? [])];
    const ownBefore = all.filter(own);
    const index = deletingNote === null ? -1 : ownBefore.findIndex((note) => note.id === deletingNote.id);
    if (index >= 0 && triggers.length === ownBefore.length && triggers[index]?.isConnected) return triggers[index];
    return deleteFallbackFocus()();
  };

  const menu = (note: GuestNoteDto) => own(note)
    ? <Menu triggerLabel="Actions for your note" label="Note actions" triggerClassName={cn(ICON_BUTTON, "ms-auto")} triggerTestId="guest-note-actions" trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={busy || (note.id === thread.id && writing.composerOpen)} onClick={() => { if (note.id === thread.id) writing.editRoot(thread); else { setEditStatus(IDLE); { const doc = note.content ?? legacyBodyToRichTextDoc(note.body); drafts.set(editKey, { noteId: note.id, baseRevision: note.revision, baseDoc: doc, ackRevision: null, doc }); } } }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={busy} onClick={() => { setDeleteConflict(null); setDeleting({ noteId: note.id, problem: null, pending: false, baseRevision: note.revision }); }}>Delete</MenuPrimitive.Item>
    </Menu>
    : null;

  const body = (note: GuestNoteDto) => editDraft !== null && editDraft.noteId === note.id
    ? <>{paused && <NoteText note={note} media={writing.media} />}<form data-testid="guest-note-edit-form" aria-label="Edit your note" hidden={paused} inert={paused} onSubmit={(event) => { void saveEdit(event); }} noValidate className="flex flex-col gap-[var(--space-2)]">
      <GuestNoteField testId="guest-note-edit-body" label="Your note" media={writing.media} value={editDraft.doc} disabled={editStatus.pending || !writing.canWrite} onChange={(doc) => { drafts.set(editKey, { ...editDraft, doc }); }} onUploadingChange={setEditUploading} />
      {editDraft.baseRevision !== note.revision && <p data-testid="guest-note-edit-latest" className="m-0 whitespace-pre-wrap text-foreground-secondary [font:var(--type-body-sm)] [overflow-wrap:anywhere]">{`Latest saved version: ${note.body}`}</p>}
      {editStatus.problem !== null && <p role="alert" data-testid="guest-note-edit-problem" className={PROBLEM}>{editStatus.problem}</p>}
      <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
        <Button type="button" variant="ghost" size="sm" data-testid="guest-note-edit-cancel" className={TOUCH} disabled={editStatus.pending} onClick={() => { drafts.clear(editKey); setEditStatus(IDLE); }}>Cancel</Button>
        <Button type="submit" size="sm" data-testid="guest-note-edit-save" className={TOUCH} disabled={editStatus.pending || !writing.canWrite || editUploading}>Save</Button>
      </div>
    </form></>
    : <NoteText note={note} media={writing.media} />;

  return <Item variant="outline" size="sm" data-testid="guest-note" data-note-id={thread.id} data-selected={selected ? "true" : "false"} className="flex-col items-stretch data-[selected=true]:border-foreground">
    <ItemContent className="gap-[var(--space-2)]">
      <div className="flex min-w-0 items-center gap-[var(--space-2)]"><Author note={thread} />{menu(thread)}</div>
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {thread.startFrame !== null && <Button type="button" variant="secondary" size="sm" data-testid="guest-note-anchor" aria-label={`Go to ${noteAnchorLabel(thread, timecode)}`} className={cn(TOUCH, "[font:var(--type-mono)] tabular-nums")} onClick={() => { onSelect(thread); }}>{noteAnchorLabel(thread, timecode)}</Button>}
        {thread.hasMarkup && !thread.deleted && <IconTip label="Has a drawing"><span data-testid="guest-note-has-drawing" className="inline-flex items-center text-foreground-secondary"><PencilIcon aria-hidden="true" className="size-3" /><span className="sr-only">Has a drawing</span></span></IconTip>}
      </div>
      {body(thread)}
      {deleteConflict !== null && <p role="alert" data-testid="guest-note-problem" className={PROBLEM}>{deleteConflict}</p>}
      {thread.replies.map((reply) => <div key={reply.id} data-testid="guest-note-reply" className="flex flex-col gap-[var(--space-1)] border-l border-border ps-[var(--space-3)]">
        <div className="flex min-w-0 items-center gap-[var(--space-2)]"><Author note={reply} />{menu(reply)}</div>
        {body(reply)}
      </div>)}
      {writing.canWrite && !thread.deleted && (replyDraft === null
        ? paused ? null : <div className="flex min-h-8 items-center"><Button type="button" variant="ghost" size="sm" data-testid="guest-note-reply-button" className={TOUCH} disabled={busy} onClick={() => { if (!writing.verified) writing.onNeedVerify(); else { setReplyStatus(IDLE); drafts.set(replyKey, { noteId: null, baseRevision: null, baseDoc: EMPTY_DOC, ackRevision: null, doc: EMPTY_DOC }); } }}>Reply</Button>{thread.resolved && <ResolvedTick data-testid="guest-note-resolved" className="ms-auto" />}</div>
        : <form data-testid="guest-reply-form" aria-label="Reply" hidden={paused} inert={paused} onSubmit={(event) => { void sendReply(event); }} noValidate className="flex flex-col gap-[var(--space-2)]">
          <GuestNoteField testId="guest-reply-body" label="Your reply" media={writing.media} value={replyDraft.doc} disabled={replyStatus.pending || !writing.canWrite} onChange={(doc) => { drafts.set(replyKey, { ...replyDraft, doc }); }} onUploadingChange={setReplyUploading} />
          {replyStatus.problem !== null && <p role="alert" data-testid="guest-reply-problem" className={PROBLEM}>{replyStatus.problem}</p>}
          <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
            <Button type="button" variant="ghost" size="sm" data-testid="guest-reply-cancel" className={TOUCH} disabled={replyStatus.pending} onClick={() => { drafts.clear(replyKey); setReplyStatus(IDLE); }}>Cancel</Button>
            <Button type="submit" size="sm" data-testid="guest-reply-send" className={TOUCH} disabled={replyStatus.pending || !writing.canWrite || replyUploading}>Send reply</Button>
          </div>
        </form>)}
      {thread.resolved && (!writing.canWrite || paused || thread.deleted || replyDraft !== null) && <div className="flex justify-end"><ResolvedTick data-testid="guest-note-resolved" /></div>}
    </ItemContent>
    <AlertDialog open={deleting !== null && deletingNote !== null} onOpenChange={(next) => { if (!next && !busy) setDeleting(null); }}>
      <AlertDialogContent size="default" data-testid="guest-delete-dialog" finalFocus={deleteFinalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note?</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {deleting?.problem != null && <p role="alert" data-testid="guest-delete-problem" className={PROBLEM}>{deleting.problem}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="guest-delete-cancel" disabled={deleting?.pending ?? false}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid="guest-delete-confirm" disabled={(deleting?.pending ?? false) || !writing.canWrite} onClick={() => { void confirmDelete(); }}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Item>;
}
