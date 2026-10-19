import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleCheck, Lock, PencilIcon } from "lucide-react";
import { VIDEO_NOTE_BODY_MAX, type RichTextDoc, type Role, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto } from "@quincy/shared";
import { cn } from "../../lib/utils";
import { useNoteCardSeek } from "../../lib/note-card-seek";
import { isOwnNote, noteAnchorLabel } from "../../lib/video-note-view";
import { MarkupRevisionMismatch, useVideoNoteMarkupQuery } from "../../lib/video-notes-data";
import { draftDoc, effectiveMarks, frameOnScreen, writeFailure, type NoteFormStore, type Problem } from "../../lib/video-note-form-store";
import { useFrameClockSelector, type VideoFrameClock } from "../../lib/video-frame-clock";
import { EMPTY_MARKS, type NoteMarks } from "../../lib/video-note-marks";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { useMediaQuery } from "../../lib/use-media-query";
import type { RichTextEditorHandle } from "../QuincyRichTextEditorBase";
import { META_TEXT } from "../quincy/Eyebrow";
import { Button } from "../quincy/Button";
import { CollaborationTimestamp } from "../quincy/CollaborationTimestamp";
import { ICON_BUTTON } from "../quincy/icon-button";
import { InitialsAvatar } from "../quincy/InitialsAvatar";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { Notice } from "../quincy/Notice";
import { RESOLVED_TICK, ResolvedTick, TICK_SIZE } from "../quincy/ResolvedTick";
import { StatusPill } from "../quincy/StatusPill";
import { Badge } from "../reui/badge";
import { Button as ReuiButton } from "../reui/button";
import { Item } from "../reui/item";
import { NoteBody } from "../quincy/NoteMediaStrip";
import { NoteComposerBox, type NoteAnchorChip } from "../quincy/NoteComposerBox";
import { VideoNoteEditor } from "./VideoNoteEditor";
import { MARKUP_FULL_TEXT, type NoteDrawControls } from "./VideoMarkupOverlay";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";
import { IconTip } from "../quincy/IconTip";

/** What a thread asks of the panel. Every write rejects with the original error, which the thread classifies. */
export type ThreadActions = {
  reply: (rootId: string, content: RichTextDoc) => Promise<unknown>;
  edit: (noteId: string, input: VideoNoteEditInput) => Promise<unknown>;
  resolve: (rootId: string, resolved: boolean) => Promise<unknown>;
  requestDelete: (note: VideoNoteDto, root: VideoNoteThreadDto) => void;
  refresh: () => void;
};

const MONO = "[font:var(--type-mono)] tabular-nums";
const LINK_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** Shown, never chosen: the paste dialog renders it too, so a copy's visibility is visibly the source's. */
export function VisibilityBadge({ visibility }: { visibility: VideoNoteDto["visibility"] }) {
  return visibility === "internal"
    ? <StatusPill tone="caution" data-testid="video-note-visibility-badge" data-visibility="internal"><Lock aria-hidden="true" className="size-3" />Internal</StatusPill>
    : <StatusPill tone="info" data-testid="video-note-visibility-badge" data-visibility="public">Client-visible</StatusPill>;
}

export const authorName = (note: VideoNoteDto) => (note.author.kind === "staff" ? note.author.person.name : note.author.name);
const roleLabel = (note: VideoNoteDto) => (note.author.kind === "staff" ? note.author.person.roleLabel : "Client");

/**
 * A staff author's role, or a guest's "Client" badge (#741 13c). A guest's email is on the DTO only for a viewer who holds `shareVideo`; where it is, the badge is a focusable tooltip
 * trigger that shows it, and where it is not, the badge is plain.
 */
function AuthorTag({ note }: { note: VideoNoteDto }) {
  if (note.author.kind !== "guest") return <span className={cn(META_TEXT, "!normal-case")}>{roleLabel(note)}</span>;
  const badge = <Badge variant="outline" size="xs" data-testid="video-note-client-badge">Client</Badge>;
  const email = note.author.email;
  if (email === undefined) return badge;
  return <Tooltip>
    <TooltipTrigger render={<span tabIndex={0} data-testid="video-note-client-trigger" className="inline-flex rounded-[var(--radius-xs)]" />}>{badge}</TooltipTrigger>
    <TooltipContent>{email}</TooltipContent>
  </Tooltip>;
}

/** The note's text, or a muted line for a deleted one. */
export function NoteText({ note }: { note: VideoNoteDto }) {
  if (note.deleted) return <p data-testid="video-note-tombstone" className="m-0 text-foreground-secondary [font:var(--type-body-sm)] italic">Note deleted</p>;
  // A rich note (#835) draws its document: its text, then its images and videos as one strip (#927). An older note is its plain text.
  return note.content
    ? <div data-testid="video-note-body"><NoteBody className="rich-text--body" content={note.content} /></div>
    : <p data-testid="video-note-body" className="m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]">{note.body}</p>;
}

/**
 * One note thread (#741 5b): the root with its replies, the Reply / Resolve actions, the author's "⋯" (Edit, Delete) and the inline reply
 * and edit forms. Visibility is shown, never chosen: replies take the root's. Edit and Delete are author-only (`isOwn` is the session user,
 * which is the impersonated user while an Admin impersonates), and the server enforces it again. The open form's text, baseline, conflict and
 * marks live in the Video tab's form store: this component renders them and sends commands.
 */
/** The editable element of a field: the element itself when it is one (the plain box), else the one inside the wrapper the rich editor sits in. A wrapper takes no focus. Tries again a frame later if the editor has not attached yet. */
const FIELD = "textarea, [contenteditable='true']";
function focusField(host: HTMLElement | null) {
  if (!host) return;
  const find = () => (host.matches(FIELD) ? host : host.querySelector<HTMLElement>(FIELD));
  const now = find();
  if (now) { now.focus(); return; }
  requestAnimationFrame(() => { find()?.focus(); });
}

export function VideoNoteThread({ thread, selected, userId, readOnly, now, timecode, frameCount, actions, onSeek, store, assetId, clock, pinned = false, drawings, draw, rich }: {
  thread: VideoNoteThreadDto;
  selected: boolean;
  userId: string | null;
  readOnly: boolean;
  now: number;
  timecode: (frame: number) => string;
  frameCount: number;
  actions: ThreadActions;
  onSeek: (thread: VideoNoteThreadDto) => void;
  store: NoteFormStore;
  assetId: string;
  clock: VideoFrameClock | null;
  /** The filters exclude this thread but its form is open, so it stays listed. */
  pinned?: boolean;
  /** Drawings on notes (#741 6b-ui): whether the Project's `markup` part is on, whether this person may draw, and what the lazy read needs. Absent = 5b's thread. */
  drawings?: { on: boolean; canAnnotate: boolean; projectId: string; role: Role };
  /** The open edit's pen and drawing row (#927, `useVideoMarkup`'s `draw.edit`): absent, or with no pen, where this edit takes no drawing. */
  draw?: NoteDrawControls;
  /** The rich fields (#835): the Project and the person's role, which the @ list and the upload routes need. */
  rich: { projectId: string; role: Role };
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [uploading, setUploading] = useState(false);
  const replyEditor = useRef<RichTextEditorHandle>(null);
  const replyField = useRef<HTMLDivElement>(null);
  const [replyStrip, setReplyStrip] = useState<HTMLDivElement | null>(null);
  const openKey = useSyncExternalStore(store.subscribe, () => store.slot(assetId).open?.noteId ?? null);
  // A form that closes (Cancel, Save, a conflict) takes its in-flight uploads with it; the next one starts clean.
  useEffect(() => { setUploading(false); }, [openKey]);
  const articleRef = useRef<HTMLElement>(null);
  const storedForm = useSyncExternalStore(store.subscribe, () => { const open = store.slot(assetId).open; return open && open.rootId === thread.id ? open : null; });
  const form = storedForm;
  const op = useSyncExternalStore(store.subscribe, () => store.slot(assetId).op);
  const marksHeld = useSyncExternalStore(store.subscribe, () => store.slot(assetId).marks);
  const closedNotice = useSyncExternalStore(store.subscribe, () => { const held = store.slot(assetId).notice; return held && held.rootId === thread.id ? held : null; });
  const [resolving, setResolving] = useState(false);
  const [resolveNotice, setResolveNotice] = useState<Problem | null>(null);
  const focusEditorOnClose = useRef(false);
  const deletePending = useRef(false);
  const replying = form?.kind === "reply";
  const editing = form?.kind === "edit" ? form : null;
  const marks = effectiveMarks(marksHeld, clock).value;
  const sending = op?.form === "open" && form !== null;
  const busy = resolving || sending;
  const blocked = op?.phase === "posting";
  const notice = form?.problem ?? closedNotice ?? resolveNotice;

  // A form that closes hands focus back to the control that opened it, unless focus went somewhere else on purpose.
  const heldKind = useRef<"reply" | "edit" | null>(null);
  const heldNoteId = useRef<string | null>(null);
  useEffect(() => {
    const kind = form?.kind ?? null;
    const previous = heldKind.current;
    const editedId = heldNoteId.current;
    heldKind.current = kind;
    heldNoteId.current = form?.noteId ?? null;
    const active = document.activeElement;
    if (previous === null || kind !== null || (active && active !== document.body && !articleRef.current?.contains(active))) return;
    (previous === "reply" ? q(articleRef.current, '[data-testid="video-note-reply-button"]') : (editedMenu(editedId) ?? q(articleRef.current, '[data-testid="video-note-anchor-button"]')))?.focus();
  }, [form?.kind, form?.noteId]);
  /** The "⋯" of the note that was edited (a reply's own, not the root's), keyed by note id. */
  function editedMenu(noteId: string | null): HTMLElement | null {
    if (noteId === null || noteId === thread.id) return q(articleRef.current, '[data-testid="video-note-header-row"] [data-testid="video-note-actions"]');
    return q(articleRef.current, `[data-testid="video-note-reply"][data-note-id="${noteId}"] [data-testid="video-note-actions"]`);
  }

  // An edit form that opens is brought into view by moving the list's own scroller only: `scrollIntoView` would scroll every ancestor, the viewer dialog included.
  const editingHere = editing !== null && (editing.noteId === thread.id || thread.replies.some((reply) => reply.id === editing.noteId));
  useEffect(() => { if (editingHere) revealInList(q(articleRef.current, '[data-notes-form="edit"]')); }, [editingHere, editing?.noteId]);

  async function toggleResolved() {
    setResolving(true); setResolveNotice(null);
    try { await actions.resolve(thread.id, thread.resolved === null); }
    catch (error) { setResolveNotice(writeFailure(error, "The note could not be updated.").problem); }
    finally { setResolving(false); }
  }

  const startEdit = (note: VideoNoteDto) => {
    if (!store.openEdit(assetId, note, thread.id)) return; // a request is out: nothing else opens
    focusEditorOnClose.current = true;
  };
  // The menu closes before the store's update has rendered the edit form, so there is no field to focus yet: while an edit is starting the menu
  // moves no focus, and the form focuses its own field when it mounts (below). Delete moves none either; it has its own destination.
  const focusEditor = useCallback((): false | undefined => {
    if (deletePending.current) return false;
    if (!focusEditorOnClose.current) return undefined;
    focusEditorOnClose.current = false;
    return false;
  }, []);
  // The edit form a person just opened takes focus once, when it mounts. A form that mounts again (pinned, filters or Version changed) does not.
  const focusPending = editing?.focusOnOpen === true;
  useEffect(() => {
    if (!focusPending || !editing) return;
    if (store.takeFocusOnOpen(assetId, editing.noteId)) focusField(q(articleRef.current, '[data-testid="video-note-edit-body"]'));
  }, [focusPending, editing?.noteId, store, assetId]);
  // A reply that opens takes focus, as the plain reply box did with autoFocus (the rich field is a wrapper around the editor, so it has no autoFocus of its own).
  useEffect(() => {
    if (replying) focusField(q(articleRef.current, '[data-testid="video-note-reply-body"]'));
  }, [replying]); // eslint-disable-line react-hooks/exhaustive-deps

  // The "⋯" menus that are open, by note id (#901): a press on the card while one is open only dismisses it. An id counts only while its menu is
  // still rendered, so a menu that unmounts open (the note deleted elsewhere) cannot leave the card unable to seek.
  const openMenus = useRef(new Set<string>());
  const menuShown = (note: VideoNoteDto) => !readOnly && !note.deleted && isOwnNote(note, userId);
  const seek = useNoteCardSeek(thread.startFrame, () => { onSeek(thread); }, () => [thread, ...thread.replies].some((note) => openMenus.current.has(note.id) && menuShown(note)));

  function renderMenu(note: VideoNoteDto): ReactNode {
    if (!menuShown(note)) return null;
    return <Menu triggerLabel={`Actions for note by ${authorName(note)}`} label="Note actions" triggerClassName={cn(ICON_BUTTON, "me-[var(--space-1)]")} triggerTestId="video-note-actions" finalFocus={focusEditor} onOpenChange={(open) => { if (open) { deletePending.current = false; openMenus.current.add(note.id); } else openMenus.current.delete(note.id); }} trigger={<span aria-hidden="true">⋯</span>}>
      <MenuPrimitive.Item className={MENU_ITEM} disabled={busy || blocked} onClick={() => { startEdit(note); }}>Edit</MenuPrimitive.Item>
      <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive")} disabled={busy} onClick={() => { deletePending.current = true; actions.requestDelete(note, thread); }}>Delete</MenuPrimitive.Item>
    </Menu>;
  }

  // The header is who and when. The root's badge, timecode chip and "⋯" menu share the row under it (menu pushed right); a reply has no
  // badge (it inherits the root's), so its menu sits at the end of this row.
  const header = (note: VideoNoteDto, root: boolean) => <header className="grid min-w-0 gap-[var(--space-1)]">
    <div className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
      <InitialsAvatar name={authorName(note)} className="size-6" />
      <strong className="min-w-0 text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-snug)_var(--font-sans)] [overflow-wrap:anywhere]">{authorName(note)}</strong>
      <AuthorTag note={note} />
      <CollaborationTimestamp instant={note.createdAt} now={now} mode="relative" />
      {note.editedAt && !note.deleted && <span className={cn(META_TEXT, "!normal-case")}>· Edited</span>}
      {!root && <span className="ms-auto">{renderMenu(note)}</span>}
    </div>
  </header>;

  const saveEdit = () => { void store.save(assetId, { clock, frameCount, send: actions.edit, markup: drawings?.on ?? false }); };
  const editBlocked = (open: { text: string }) => busy || uploading || open.text.trim() === "" || open.text.length > VIDEO_NOTE_BODY_MAX;
  // The root's edit is the note composer box (E1). A reply's edit (it has no anchor of its own) is the field with Cancel and Save only, as the guest's is.
  const editForm = (note: VideoNoteDto) => editing && editing.noteId === note.id && (note.id === thread.id && editing.base.startFrame !== null
    ? <NoteEditBox
      thread={thread} editing={editing} store={store} assetId={assetId} clock={clock} timecode={timecode} busy={busy} saving={sending} uploading={uploading} onUploadingChange={setUploading}
      onSave={saveEdit} blocked={editBlocked(editing)} phone={phone} rich={rich} {...(drawings ? { drawings } : {})} {...(draw ? { draw } : {})}
    />
    : <form data-notes-form="edit" className="grid gap-[var(--space-2)]" onSubmit={(event) => { event.preventDefault(); saveEdit(); }}>
      <label className="sr-only" htmlFor={`video-note-edit-${note.id}`}>Edit note</label>
      <div data-testid="video-note-edit-body" className={FIELD_SHELL}><VideoNoteEditor id={`video-note-edit-${note.id}`} projectId={rich.projectId} role={rich.role} value={draftDoc(editing.content, editing.text)} disabled={busy} placeholder="Edit note… Use @ to mention a colleague."
        onChange={(doc) => { if (!busy) store.setOpenContent(assetId, doc); }} onSubmit={saveEdit} onUploadingChange={setUploading} /></div>
      {editing.conflict && <ConflictNotice body={editing.conflict.body} />}
      <div className="flex justify-end gap-[var(--space-2)]">
        <Button type="button" variant="secondary" data-testid="video-note-edit-cancel" disabled={busy} onClick={() => { store.close(assetId); }}>Cancel</Button>
        <Button type="submit" data-testid="video-note-edit-save" disabled={editBlocked(editing)}>{busy ? "Saving…" : editing.conflict ? "Save anyway" : "Save"}</Button>
      </div>
    </form>);

  const sendReply = () => { void store.reply(assetId, { send: actions.reply }); };
  const replyTooLong = form?.kind === "reply" && form.text.length > VIDEO_NOTE_BODY_MAX;
  const replyReason = uploading ? "Wait for the uploads to finish." : replyTooLong ? `Replies can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.` : undefined;

  const label = noteAnchorLabel(thread, timecode);
  const resolvedLine = thread.resolved ? `Resolved by ${thread.resolved.by.name}` : null;

  // The whole card seeks to the thread's frame (#901), as its timecode button does.
  return <Item variant="outline" size="sm" className={cn("block min-w-0 data-[selected=true]:border-foreground", seek.className)} {...seek.props} data-testid="video-note-thread" data-note-id={thread.id} data-selected={selected ? "true" : "false"} data-resolved={thread.resolved ? "true" : "false"} ref={articleRef as never}>
    <div className="grid min-w-0 gap-[var(--space-2)]">
      {pinned && <Notice tone="caution" data-testid="video-note-pinned">Outside current filters</Notice>}
      {header(thread, true)}
      {thread.copiedFrom && <span data-testid="video-note-copied-from" className="text-foreground-secondary [font:var(--type-label)]">{`Copied from v${thread.copiedFrom.version} · originally by ${thread.copiedFrom.authorName}`}</span>}
      <div data-testid="video-note-header-row" className="flex flex-wrap items-center gap-[var(--space-2)]">
        <VisibilityBadge visibility={thread.visibility} />
        {thread.startFrame !== null && <ReuiButton type="button" variant="secondary" size="sm" data-testid="video-note-anchor-button" aria-label={`Go to ${label}`} className={cn("pointer-coarse:min-h-11 max-[721px]:min-h-11", MONO)} onClick={() => { onSeek(thread); }}>{label}</ReuiButton>}
        {resolvedLine && <span className={cn(META_TEXT, "!normal-case")}>{resolvedLine}</span>}
        {drawings && thread.hasMarkup && !thread.deleted && <IconTip label="Has a drawing"><span data-testid="video-note-has-drawing" className={cn(META_TEXT, "inline-flex items-center !normal-case")}><PencilIcon aria-hidden="true" className="size-3" /><span className="sr-only">{drawings.on ? "Drawing" : "Drawing hidden"}</span></span></IconTip>}
        <span className="ms-auto">{renderMenu(thread)}</span>
      </div>
      {editing?.noteId === thread.id ? editForm(thread) : <NoteText note={thread} />}
      {thread.replies.length > 0 && <div className="grid gap-[var(--space-2)] border-s border-border ps-[var(--space-3)]">
        {thread.replies.map((reply) => <div key={reply.id} data-testid="video-note-reply" data-note-id={reply.id} className="grid gap-[var(--space-1)]">
          {header(reply, false)}
          {editing?.noteId === reply.id ? editForm(reply) : <NoteText note={reply} />}
        </div>)}
      </div>}
      {notice && <Notice tone="critical" role="alert" data-testid="video-note-notice" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{notice.text}</span>{notice.refresh && <Button type="button" variant="text" data-testid="video-note-notice-refresh" onClick={actions.refresh}>Refresh notes</Button>}</Notice>}
      {/* The Reply toggle opens the reply box and, open, dismisses it with its draft (R1: no visible Cancel); Esc goes through the viewer's form order. */}
      {!readOnly && editing === null && <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        {!thread.deleted && <Button
          type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-reply-button" disabled={busy || (!replying && blocked)} aria-expanded={replying}
          {...(replying ? { "aria-label": "Close reply", title: "Close reply (Esc)", "aria-keyshortcuts": "Escape" } : {})}
          onClick={() => { if (replying) { store.close(assetId); return; } setResolveNotice(null); store.openReply(assetId, thread.id); }}
        >Reply</Button>}
        {!replying && <span className="ms-auto"><IconTip label={thread.resolved ? "Reopen" : "Mark as complete"}>
          <ReuiButton type="button" variant="ghost" size="icon" className={TICK_SIZE} data-testid="video-note-resolve" aria-label={thread.resolved ? "Reopen" : "Mark as complete"} aria-pressed={thread.resolved !== null} disabled={busy} onClick={() => { void toggleResolved(); }}>
            <CircleCheck aria-hidden="true" className={cn("size-5", thread.resolved ? RESOLVED_TICK : "text-muted-foreground")} />
          </ReuiButton>
        </IconTip></span>}
      </div>}
      {form?.kind === "reply" && <NoteComposerBox
        variant="reply" label="Reply" testId="video-note-reply-form" phone={phone} className="p-0" formAttributes={{ "data-notes-form": "reply" }}
        field={<div ref={replyField} data-testid="video-note-reply-body" className="min-w-0">
          <label className="sr-only" htmlFor={`video-note-reply-${thread.id}`}>Write a reply</label>
          <VideoNoteEditor
            ref={replyEditor} id={`video-note-reply-${thread.id}`} projectId={rich.projectId} role={rich.role} value={draftDoc(form.content, form.text)} disabled={busy} placeholder="Reply…"
            onChange={(doc) => { if (!busy) store.setOpenContent(assetId, doc); }} onSubmit={sendReply} onUploadingChange={setUploading}
            stripContainer={replyStrip} bubbleDocked={phone} bubbleDockTo={() => replyField.current?.closest('[data-testid="note-composer-box"]') ?? null}
          />
        </div>}
        strip={<div ref={setReplyStrip} className="empty:hidden" />}
        attach={{ onPick: () => { replyEditor.current?.pickMedia(); }, disabled: busy }}
        send={{ label: "Send reply", onSend: sendReply, disabled: busy || uploading || form.text.trim() === "" || replyTooLong, pending: sending, ...(replyReason ? { reason: replyReason } : {}) }}
      />}
      {thread.resolved && (readOnly || replying || editing !== null) && <div className="flex justify-end"><ResolvedTick data-testid="video-note-resolved-status" /></div>}
    </div>
  </Item>;
}

/** Scrolls the list's scroll-area viewport so the form's bottom (its buttons) is visible, or its top when it is taller than the viewport. Nothing else scrolls. */
function revealInList(form: HTMLElement | null) {
  const viewport = form?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!form || !viewport) return;
  const pad = 8;
  const f = form.getBoundingClientRect(); const v = viewport.getBoundingClientRect();
  const delta = f.height > v.height ? f.top - v.top - pad : f.bottom > v.bottom ? f.bottom - v.bottom + pad : f.top < v.top ? f.top - v.top - pad : 0;
  if (delta !== 0) viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
}

function q(scope: ParentNode | null, selector: string): HTMLElement | null { return scope?.querySelector<HTMLElement>(selector) ?? null; }

/** A reply's edit field: the box's hairline and well, since the note preset draws no chrome of its own (#927). */
const FIELD_SHELL = "min-w-0 rounded-[var(--radius-lg)] border border-solid border-[length:var(--border-width-hair)] border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-surface-sunken px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] leading-[var(--space-5)] text-foreground transition-colors focus-within:border-border-hover";
/** A line in the edit box above its tools (a load state, the stroke cap). Label type, as the composer's lines. */
const LINE = "m-0 [font:var(--type-label)]";
/** D4: a note's frames and its drawing change one at a time. While the note has a drawing (or a new one), its frames follow it. */
const FRAMES_FOLLOW = "Frames follow the drawing.";

function ConflictNotice({ body }: { body: string }) {
  return <Notice tone="caution" data-testid="video-note-conflict" className="grid gap-[var(--space-1)]"><span>Current note on the server:</span><span data-testid="video-note-conflict-body" className="whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{body}</span></Notice>;
}

type OpenEdit = NonNullable<ReturnType<NoteFormStore["slot"]>["open"]>;

/**
 * The edit of a root note (#927 E1): the note composer box in its `edit` variant. The chip is the note's anchor; in/out is the composer's three-press button over the form's
 * marks, except that its third press (and the chip's ×) keeps a frame, as a point at In: an edited note keeps an anchor. The pen and the drawing row are `useVideoMarkup`'s
 * (`draw`). D4: changing the frames locks the pen (the hook's reason), and a drawing locks the frames (`FRAMES_FOLLOW`); one Save sends either. Visibility is a fixed label.
 * It is its own component so only the open edit follows the frame clock (the chip's live Out).
 */
function NoteEditBox({ thread, editing, store, assetId, clock, timecode, busy, saving, uploading, onUploadingChange, onSave, blocked, phone, rich, drawings, draw }: {
  thread: VideoNoteThreadDto; editing: OpenEdit; store: NoteFormStore; assetId: string; clock: VideoFrameClock | null; timecode: (frame: number) => string;
  busy: boolean; saving: boolean; uploading: boolean; onUploadingChange: (uploading: boolean) => void; onSave: () => void; blocked: boolean; phone: boolean;
  rich: { projectId: string; role: Role }; drawings?: { on: boolean; canAnnotate: boolean; projectId: string; role: Role }; draw?: NoteDrawControls;
}) {
  const editor = useRef<RichTextEditorHandle>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const held = useSyncExternalStore(store.subscribe, () => store.slot(assetId).marks);
  const drawingNow = useSyncExternalStore(store.subscribe, () => store.slot(assetId).draw !== null);
  const liveFrame = useFrameClockSelector(clock, (state) => state.targetFrame ?? state.frame, 0);
  // The marks a third press left as a point: they read as a point (not In with a live Out) until the next mark.
  const [pointed, setPointed] = useState<NoteMarks | null>(null);
  const drawing = editing.drawing;
  const marks = effectiveMarks(held, clock);
  // A note with a drawing keeps its own frames (they follow the drawing); a plain one shows the form's marks.
  const value: NoteMarks = editing.frames ? marks.value : { in: editing.base.startFrame, out: editing.base.endFrame === null ? null : editing.base.endFrame - 1 };
  const ranging = editing.frames && marks.touched && value.in !== null && value.out === null && held.value !== pointed;
  const shown: NoteMarks = (value.in !== null && value.out !== null) || ranging ? value : EMPTY_MARKS;
  const point = value.in ?? value.out;
  const framesLocked = !editing.frames || drawing.touched;
  const hasDrawing = drawing.items === null ? drawing.hadDrawing && !drawing.remove : drawing.items.length > 0;

  const toPoint = () => { if (!clock) return; store.makePoint(assetId, clock); setPointed(store.slot(assetId).marks.value); };
  const chip: NoteAnchorChip = shown.in !== null
    ? { kind: "range", from: timecode(shown.in), to: timecode(shown.out ?? Math.max(liveFrame, shown.in)), toLive: shown.out === null, onClear: toPoint, clearDisabled: busy || framesLocked || drawingNow || !clock }
    : { kind: "point", at: point === null ? "" : timecode(point), following: false };
  const rangeOff = busy || !clock || framesLocked || drawingNow;
  const rangeReason = framesLocked ? FRAMES_FOLLOW : !clock ? "Loading the film…" : null;

  // New strokes on a plain note that were all cleared again are no drawing: the frames unlock (Clear on a saved drawing is a removal, and stays one until Save).
  const clearedNew = !drawing.hadDrawing && drawing.touched && drawing.items !== null && drawing.items.length === 0;
  useEffect(() => { if (clearedNew && !drawingNow) store.removeDrawing(assetId); }, [clearedNew, drawingNow, store, assetId]);

  const tooLong = editing.text.length > VIDEO_NOTE_BODY_MAX;
  const saveReason = uploading ? "Wait for the uploads to finish." : tooLong ? `Notes can be ${VIDEO_NOTE_BODY_MAX.toLocaleString("en")} characters at most.` : undefined;
  const notice = <>
    {drawings?.on && drawings.canAnnotate && <SavedDrawingStatus store={store} assetId={assetId} note={thread} editing={editing} projectId={drawings.projectId} role={drawings.role} />}
    {draw?.full && <p role="status" data-testid="video-note-edit-markup-full" className={cn(LINE, "text-warning-foreground")}>{MARKUP_FULL_TEXT}</p>}
    {editing.conflict && <ConflictNotice body={editing.conflict.body} />}
  </>;

  return <NoteComposerBox
    variant="edit" label="Edit note" testId="video-note-edit-form" phone={phone} className="p-0" formAttributes={{ "data-notes-form": "edit" }}
    visibility={thread.visibility}
    field={<div ref={fieldRef} data-testid="video-note-edit-body" className="min-w-0">
      <label className="sr-only" htmlFor={`video-note-edit-${thread.id}`}>Edit note</label>
      <VideoNoteEditor
        ref={editor} id={`video-note-edit-${thread.id}`} projectId={rich.projectId} role={rich.role} value={draftDoc(editing.content, editing.text)} disabled={busy} placeholder="Edit note… Use @ to mention a colleague."
        onChange={(doc) => { if (!busy) store.setOpenContent(assetId, doc); }} onSubmit={onSave} onUploadingChange={onUploadingChange}
        stripContainer={strip} bubbleDocked={phone} bubbleDockTo={() => fieldRef.current?.closest('[data-testid="note-composer-box"]') ?? null}
      />
    </div>}
    strip={<div ref={setStrip} className="empty:hidden" />}
    notice={notice}
    chip={chip} drawn={hasDrawing}
    range={{
      marks: shown,
      onPress: (step) => { if (!clock) return; if (step === "clear") toPoint(); else store.mark(assetId, step, frameOnScreen(clock.getState()), clock); },
      ...(rangeOff ? { disabled: true, ...(rangeReason ? { reason: rangeReason } : {}) } : {}),
    }}
    attach={{ onPick: () => { editor.current?.pickMedia(); }, disabled: busy }}
    {...(draw?.pen ? { pen: draw.pen } : {})}
    draw={draw?.row ?? null}
    save={{ onSave, onCancel: () => { store.close(assetId); }, disabled: blocked, pending: saving, saveLabel: editing.conflict ? "Save anyway" : "Save", ...(saveReason ? { reason: saveReason } : {}) }}
  />;
}

/**
 * The saved drawing's read for an open edit (#741 6b-ui), keyed by note and revision: the same entry `useVideoMarkup` reads, so this adds no fetch. It says while it loads,
 * offers Retry when it fails, and names a drawing this build cannot read. A read refused because the list moved on (another session saved) makes the edit follow the newer note,
 * or ask, as a 409 does.
 */
function SavedDrawingStatus({ store, assetId, note, editing, projectId, role }: { store: NoteFormStore; assetId: string; note: VideoNoteThreadDto; editing: OpenEdit; projectId: string; role: Role }) {
  const drawing = editing.drawing;
  const saved = drawing.hadDrawing && !drawing.remove && drawing.items === null;
  const query = useVideoNoteMarkupQuery(projectId, assetId, note.id, editing.base.revision, saved, role);
  const moved = query.error instanceof MarkupRevisionMismatch && note.revision !== editing.base.revision;
  useEffect(() => { if (moved) store.adoptCurrentNote(assetId, note); }, [moved, store, assetId, note]);
  const unsupported = saved && query.data?.unsupported === true;
  return <>
    {unsupported && <p data-testid="video-note-edit-drawing-unsupported" className={cn(LINE, "text-foreground-secondary")}>Some markup can't be shown, so this drawing can't be edited here. You can still change the text.</p>}
    {saved && query.isError && <p role="alert" className={cn(LINE, "flex flex-wrap items-center gap-x-[var(--space-2)] text-destructive")}>The drawing could not be loaded.<Button type="button" variant="text" className="min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { void query.refetch(); }}>Retry</Button></p>}
    {saved && query.isPending && <p role="status" className={cn(LINE, "text-foreground-secondary")}>Loading the drawing…</p>}
  </>;
}
