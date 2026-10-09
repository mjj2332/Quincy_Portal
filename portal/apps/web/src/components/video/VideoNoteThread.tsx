import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { VIDEO_NOTE_BODY_MAX, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/utils";
import { isOwnNote, noteAnchorLabel } from "../../lib/video-note-view";
import { marksToFrames, type NoteMarks } from "../../lib/video-note-marks";
import { classifyVideoNoteError } from "../../lib/video-notes-data";
import { META_TEXT } from "../quincy/Eyebrow";
import { Button } from "../quincy/Button";
import { CollaborationTimestamp } from "../quincy/CollaborationTimestamp";
import { ICON_BUTTON } from "../quincy/icon-button";
import { InitialsAvatar } from "../quincy/InitialsAvatar";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { Notice } from "../quincy/Notice";
import { StatusPill } from "../quincy/StatusPill";
import { Button as ReuiButton } from "../reui/button";
import { Item } from "../reui/item";
import { Kbd } from "../reui/kbd";
import { Textarea } from "../reui/textarea";

/** What a thread asks of the panel. Every write rejects with the original error, which the thread classifies. */
export type ThreadActions = {
  reply: (rootId: string, body: string) => Promise<unknown>;
  edit: (noteId: string, input: VideoNoteEditInput) => Promise<unknown>;
  resolve: (rootId: string, resolved: boolean) => Promise<unknown>;
  requestDelete: (note: VideoNoteDto, root: VideoNoteThreadDto) => void;
  refresh: () => void;
  onWriteError: (error: unknown) => void;
};

/** The marks of the one root whose frames are being edited, owned by the panel so the player's I and O keys reach them. */
export type EditFrames = { marks: NoteMarks; onMark: (kind: "in" | "out") => void; onMakePoint: () => void; onBegin: (note: VideoNoteDto) => void; onEnd: () => void };

const MONO = "[font:var(--type-mono)] tabular-nums";
const SMALL = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";
const LINK_BUTTON = "min-h-8 pointer-coarse:min-h-11";

function VisibilityBadge({ visibility }: { visibility: VideoNoteDto["visibility"] }) {
  return visibility === "internal"
    ? <StatusPill tone="caution" data-testid="video-note-visibility-badge" data-visibility="internal"><Lock aria-hidden="true" className="size-3" />Internal</StatusPill>
    : <StatusPill tone="info" data-testid="video-note-visibility-badge" data-visibility="public">Client-visible</StatusPill>;
}

const authorName = (note: VideoNoteDto) => (note.author.kind === "staff" ? note.author.person.name : note.author.name);
const roleLabel = (note: VideoNoteDto) => (note.author.kind === "staff" ? note.author.person.roleLabel : "Client");

type Problem = { text: string; refresh?: boolean };
function describe(error: unknown, fallback: string, actions: ThreadActions): { problem: Problem; conflict: boolean; gone: boolean } {
  actions.onWriteError(error);
  const classified = classifyVideoNoteError(error);
  switch (classified.kind) {
    case "conflict": return { problem: { text: "This note changed since you loaded it. Review it and save again." }, conflict: true, gone: false };
    case "deleted": actions.refresh(); return { problem: { text: "This note was deleted." }, conflict: false, gone: true };
    case "gone": actions.refresh(); return { problem: { text: "This note no longer exists." }, conflict: false, gone: true };
    case "network": return { problem: { text: "Couldn't reach the server. The change may or may not have gone through — refresh the notes to check.", refresh: true }, conflict: false, gone: false };
    case "archived": return { problem: { text: "This Project was archived, so nothing was changed." }, conflict: false, gone: false };
    case "access": return { problem: { text: "You no longer have access to this Project." }, conflict: false, gone: false };
    case "range": return { problem: { text: "Those frames are outside this film." }, conflict: false, gone: false };
    default: return { problem: { text: error instanceof ApiError || error instanceof Error ? error.message || fallback : fallback }, conflict: false, gone: false };
  }
}

/** The note's text, or a muted line for a deleted one. */
function NoteText({ note }: { note: VideoNoteDto }) {
  return note.deleted
    ? <p data-testid="video-note-tombstone" className="m-0 text-foreground-secondary [font:var(--type-body-sm)] italic">Note deleted</p>
    : <p data-testid="video-note-body" className="m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]">{note.body}</p>;
}

/**
 * One note thread (#741 5b): the root with its replies, the Reply / Resolve actions, the author's "⋯" (Edit, Delete) and the inline reply
 * and edit forms. Visibility is shown, never chosen: replies take the root's. Edit and Delete are author-only (`isOwn` is the session user,
 * which is the impersonated user while an Admin impersonates), and the server enforces it again.
 */
export function VideoNoteThread({ thread, selected, userId, readOnly, now, timecode, getFrame, frameCount, actions, onSeek, editFrames }: {
  thread: VideoNoteThreadDto;
  selected: boolean;
  userId: string | null;
  readOnly: boolean;
  now: number;
  timecode: (frame: number) => string;
  getFrame: () => number;
  frameCount: number;
  actions: ThreadActions;
  onSeek: (thread: VideoNoteThreadDto) => void;
  editFrames: EditFrames;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Problem | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const focusAfter = useRef<"reply-button" | "actions" | null>(null);
  const focusEditorOnClose = useRef(false);
  const deletePending = useRef(false);
  const editTarget = editing ? (editing.id === thread.id ? thread : thread.replies.find((reply) => reply.id === editing.id) ?? null) : null;
  const editingRoot = editing?.id === thread.id;
  const finishEdit = useCallback(() => { setEditing(null); setConflicted(false); if (editingRoot) editFrames.onEnd(); focusAfter.current = "actions"; }, [editFrames, editingRoot]);

  // A form that closes hands focus back to the control that opened it; a note edited or deleted elsewhere closes its form.
  useEffect(() => {
    if (!replying && !editing && focusAfter.current) {
      const target = focusAfter.current === "reply-button" ? q(articleRef.current, '[data-testid="video-note-reply-button"]') : q(articleRef.current, '[data-testid="video-note-actions"]') ?? q(articleRef.current, '[data-testid="video-note-anchor-button"]');
      focusAfter.current = null;
      target?.focus();
    }
  }, [replying, editing]);
  useEffect(() => { if (readOnly) { setReplying(false); setEditing(null); } }, [readOnly]);
  useEffect(() => { if (editing && !editTarget) { setEditing(null); if (editingRoot) editFrames.onEnd(); } }, [editing, editTarget, editingRoot, editFrames]);

  async function guarded(run: () => Promise<unknown>, fallback: string): Promise<{ ok: boolean; gone: boolean }> {
    setBusy(true); setNotice(null);
    try { await run(); return { ok: true, gone: false }; }
    catch (error) {
      const { problem, conflict, gone } = describe(error, fallback, actions);
      setNotice(problem); setConflicted(conflict);
      if (gone) { setReplying(false); setEditing(null); if (editingRoot) editFrames.onEnd(); }
      return { ok: false, gone };
    } finally { setBusy(false); }
  }

  async function postReply() {
    const text = replyText.trim();
    if (!text || busy) return;
    const { ok } = await guarded(() => actions.reply(thread.id, text), "The reply could not be posted.");
    if (ok) { setReplying(false); setReplyText(""); focusAfter.current = "reply-button"; }
  }

  async function saveEdit() {
    if (!editing || !editTarget || busy) return;
    const text = editing.text.trim();
    if (!text) return;
    const input: { expectedRevision: number; body?: string; startFrame?: number; endFrame?: number | null } = { expectedRevision: editTarget.revision };
    if (text !== editTarget.body) input.body = text;
    if (editingRoot && !editTarget.hasMarkup) {
      const frames = marksToFrames(editFrames.marks, frameCount);
      if (frames && (frames.startFrame !== editTarget.startFrame || frames.endFrame !== editTarget.endFrame)) { input.startFrame = frames.startFrame; input.endFrame = frames.endFrame; }
    }
    if (input.body === undefined && input.startFrame === undefined) { finishEdit(); return; }
    const { ok } = await guarded(() => actions.edit(editTarget.id, input), "The note could not be saved.");
    if (ok) finishEdit();
  }

  async function toggleResolved() { await guarded(() => actions.resolve(thread.id, thread.resolved === null), "The note could not be updated."); }

  const startEdit = (note: VideoNoteDto) => {
    setNotice(null); setConflicted(false); setReplying(false);
    setEditing({ id: note.id, text: note.body });
    if (note.id === thread.id && !note.hasMarkup) editFrames.onBegin(note);
    focusEditorOnClose.current = true;
  };
  const focusEditor = useCallback((): HTMLElement | false | undefined => {
    if (deletePending.current) return false;
    if (!focusEditorOnClose.current) return undefined;
    const field = q(articleRef.current, '[data-testid="video-note-edit-body"]');
    if (!field) return undefined;
    focusEditorOnClose.current = false;
    field.focus();
    return field;
  }, []);

  function renderMenu(note: VideoNoteDto): ReactNode {
    if (readOnly || note.deleted || !isOwnNote(note, userId)) return null;
    return <Menu triggerLabel={`Actions for note by ${authorName(note)}`} label="Note actions" triggerClassName={cn(ICON_BUTTON, "me-[var(--space-1)]")} triggerTestId="video-note-actions" finalFocus={focusEditor} onOpenChange={(open) => { if (open) deletePending.current = false; }} trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={editing !== null || busy} onClick={() => { startEdit(note); }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={busy} onClick={() => { deletePending.current = true; actions.requestDelete(note, thread); }}>Delete</MenuPrimitive.Item>
    </Menu>;
  }

  const header = (note: VideoNoteDto) => <header className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
    <InitialsAvatar name={authorName(note)} className="size-6" />
    <strong className="min-w-0 text-foreground [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] [overflow-wrap:anywhere]">{authorName(note)}</strong>
    <span className={cn(META_TEXT, "!normal-case")}>{roleLabel(note)}</span>
    <CollaborationTimestamp instant={note.createdAt} now={now} mode="relative" />
    {note.editedAt && !note.deleted && <span className={cn(META_TEXT, "!normal-case")}>· Edited</span>}
    <VisibilityBadge visibility={note.visibility} />
    <span className="ms-auto">{renderMenu(note)}</span>
  </header>;

  const editForm = (note: VideoNoteDto) => editing && editing.id === note.id && <form
    data-notes-form="edit" data-dirty={editing.text !== note.body || (editingRoot && frameChanged(note, editFrames.marks, frameCount)) ? "true" : "false"}
    className="grid gap-[var(--space-2)]"
    onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}
  >
    <label className="sr-only" htmlFor={`video-note-edit-${note.id}`}>Edit note</label>
    <Textarea id={`video-note-edit-${note.id}`} data-testid="video-note-edit-body" value={editing.text} disabled={busy} maxLength={VIDEO_NOTE_BODY_MAX} onChange={(event) => { setEditing({ id: note.id, text: event.target.value }); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit(); } }} />
    {editingRoot && !note.hasMarkup && <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <span data-testid="video-note-edit-anchor" className={cn("text-foreground", MONO)}>{editAnchorLabel(editFrames.marks, timecode)}</span>
      <Button type="button" variant="secondary" className={SMALL} data-testid="video-note-edit-set-in" disabled={busy} onClick={() => { editFrames.onMark("in"); }}>Set in <Kbd>I</Kbd></Button>
      <Button type="button" variant="secondary" className={SMALL} data-testid="video-note-edit-set-out" disabled={busy} onClick={() => { editFrames.onMark("out"); }}>Set out <Kbd>O</Kbd></Button>
      <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-edit-make-point" disabled={busy} onClick={editFrames.onMakePoint}>Make point</Button>
    </div>}
    {conflicted && <Notice tone="caution" data-testid="video-note-conflict" className="grid gap-[var(--space-1)]"><span>Current note on the server:</span><span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{note.body}</span></Notice>}
    <div className="flex justify-end gap-[var(--space-2)]">
      <Button type="button" variant="secondary" data-notes-cancel="" data-testid="video-note-edit-cancel" disabled={busy} onClick={finishEdit}>Cancel</Button>
      <Button type="submit" data-testid="video-note-edit-save" disabled={busy || editing.text.trim() === ""}>{busy ? "Saving…" : "Save"}</Button>
    </div>
  </form>;

  const label = noteAnchorLabel(thread, timecode);
  const resolvedLine = thread.resolved ? `Resolved by ${thread.resolved.by.name}` : null;

  return <Item variant="outline" size="sm" className="block min-w-0 data-[selected=true]:border-foreground" data-testid="video-note-thread" data-note-id={thread.id} data-selected={selected ? "true" : "false"} data-resolved={thread.resolved ? "true" : "false"} ref={articleRef as never}>
    <div className="grid min-w-0 gap-[var(--space-2)]">
      {header(thread)}
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {thread.startFrame !== null && <ReuiButton type="button" variant="secondary" size="sm" data-testid="video-note-anchor-button" aria-label={`Go to ${label}`} className={cn("pointer-coarse:min-h-11", MONO)} onClick={() => { onSeek(thread); }}>{label}</ReuiButton>}
        {resolvedLine && <span className={cn(META_TEXT, "!normal-case")}>{resolvedLine}</span>}
      </div>
      {editing?.id === thread.id ? editForm(thread) : <NoteText note={thread} />}
      {thread.replies.length > 0 && <div className="grid gap-[var(--space-2)] border-s border-border ps-[var(--space-3)]">
        {thread.replies.map((reply) => <div key={reply.id} data-testid="video-note-reply" data-note-id={reply.id} className="grid gap-[var(--space-1)]">
          {header(reply)}
          {editing?.id === reply.id ? editForm(reply) : <NoteText note={reply} />}
        </div>)}
      </div>}
      {notice && <Notice tone="critical" role="alert" data-testid="video-note-notice" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{notice.text}</span>{notice.refresh && <Button type="button" variant="text" data-testid="video-note-notice-refresh" onClick={actions.refresh}>Refresh notes</Button>}</Notice>}
      {replying && <form data-notes-form="reply" data-dirty={replyText !== "" ? "true" : "false"} className="grid gap-[var(--space-2)]" onSubmit={(event) => { event.preventDefault(); void postReply(); }}>
        <span className="flex items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{`Reply · ${thread.visibility === "internal" ? "Internal" : "Client-visible"}`}<VisibilityBadge visibility={thread.visibility} /></span>
        <label className="sr-only" htmlFor={`video-note-reply-${thread.id}`}>Write a reply</label>
        <Textarea id={`video-note-reply-${thread.id}`} data-testid="video-note-reply-body" autoFocus value={replyText} disabled={busy} maxLength={VIDEO_NOTE_BODY_MAX} onChange={(event) => { setReplyText(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void postReply(); } }} />
        <div className="flex justify-end gap-[var(--space-2)]">
          <Button type="button" variant="secondary" data-notes-cancel="" data-testid="video-note-reply-cancel" disabled={busy} onClick={() => { setReplying(false); setReplyText(""); focusAfter.current = "reply-button"; }}>Cancel</Button>
          <Button type="submit" data-testid="video-note-reply-post" disabled={busy || replyText.trim() === ""}>{busy ? "Posting…" : "Post"}</Button>
        </div>
      </form>}
      {!readOnly && !replying && editing === null && <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        {!thread.deleted && <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-reply-button" disabled={busy} onClick={() => { setNotice(null); setReplying(true); }}>Reply</Button>}
        <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-resolve" disabled={busy} onClick={() => { void toggleResolved(); }}>{thread.resolved ? "Reopen" : "Resolve"}</Button>
      </div>}
    </div>
  </Item>;
}

function q(scope: ParentNode | null, selector: string): HTMLElement | null { return scope?.querySelector<HTMLElement>(selector) ?? null; }

function frameChanged(note: VideoNoteDto, marks: NoteMarks, frameCount: number): boolean {
  const frames = marksToFrames(marks, frameCount);
  return frames !== null && (frames.startFrame !== note.startFrame || frames.endFrame !== note.endFrame);
}

function editAnchorLabel(marks: NoteMarks, timecode: (frame: number) => string): string {
  if (marks.in !== null && marks.out !== null) return `${timecode(marks.in)} → ${timecode(marks.out)}`;
  const only = marks.in ?? marks.out;
  return only === null ? "No frames" : timecode(only);
}
