import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Lock, PencilIcon } from "lucide-react";
import { VIDEO_NOTE_BODY_MAX, type Role, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto } from "@quincy/shared";
import { cn } from "../../lib/utils";
import { isOwnNote, noteAnchorLabel } from "../../lib/video-note-view";
import { MarkupRevisionMismatch, useVideoNoteMarkupQuery } from "../../lib/video-notes-data";
import { effectiveMarks, frameOnScreen, preloadSavedDrawing, writeFailure, type NoteFormStore, type Problem } from "../../lib/video-note-form-store";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import type { NoteMarks } from "../../lib/video-note-marks";
import { META_TEXT } from "../quincy/Eyebrow";
import { Button } from "../quincy/Button";
import { CollaborationTimestamp } from "../quincy/CollaborationTimestamp";
import { ICON_BUTTON } from "../quincy/icon-button";
import { InitialsAvatar } from "../quincy/InitialsAvatar";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { Notice } from "../quincy/Notice";
import { StatusPill } from "../quincy/StatusPill";
import { Badge } from "../reui/badge";
import { Button as ReuiButton } from "../reui/button";
import { Item } from "../reui/item";
import { Kbd } from "../reui/kbd";
import { Textarea } from "../reui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";
import { IconTip } from "../quincy/VideoPlayer";
import { ANCHOR_CHIP, ANCHOR_CHIP_ROW } from "./VideoNoteComposer";

/** What a thread asks of the panel. Every write rejects with the original error, which the thread classifies. */
export type ThreadActions = {
  reply: (rootId: string, body: string) => Promise<unknown>;
  edit: (noteId: string, input: VideoNoteEditInput) => Promise<unknown>;
  resolve: (rootId: string, resolved: boolean) => Promise<unknown>;
  requestDelete: (note: VideoNoteDto, root: VideoNoteThreadDto) => void;
  refresh: () => void;
};

const MONO = "[font:var(--type-mono)] tabular-nums";
const SMALL = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";
const LINK_BUTTON = "min-h-8 px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** Shown, never chosen: the paste dialog renders it too, so a copy's visibility is visibly the source's. */
export function VisibilityBadge({ visibility }: { visibility: VideoNoteDto["visibility"] }) {
  return visibility === "internal"
    ? <StatusPill tone="caution" data-testid="video-note-visibility-badge" data-visibility="internal"><Lock aria-hidden="true" className="size-3" />Internal</StatusPill>
    : <StatusPill tone="info" data-testid="video-note-visibility-badge" data-visibility="public">Client-visible</StatusPill>;
}

const authorName = (note: VideoNoteDto) => (note.author.kind === "staff" ? note.author.person.name : note.author.name);
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
function NoteText({ note }: { note: VideoNoteDto }) {
  return note.deleted
    ? <p data-testid="video-note-tombstone" className="m-0 text-foreground-secondary [font:var(--type-body-sm)] italic">Note deleted</p>
    : <p data-testid="video-note-body" className="m-0 whitespace-pre-wrap text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [overflow-wrap:anywhere]">{note.body}</p>;
}

/**
 * One note thread (#741 5b): the root with its replies, the Reply / Resolve actions, the author's "⋯" (Edit, Delete) and the inline reply
 * and edit forms. Visibility is shown, never chosen: replies take the root's. Edit and Delete are author-only (`isOwn` is the session user,
 * which is the impersonated user while an Admin impersonates), and the server enforces it again. The open form's text, baseline, conflict and
 * marks live in the Video tab's form store: this component renders them and sends commands.
 */
export function VideoNoteThread({ thread, selected, userId, readOnly, now, timecode, frameCount, actions, onSeek, store, assetId, clock, pinned = false, drawings }: {
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
}) {
  const articleRef = useRef<HTMLElement>(null);
  const form = useSyncExternalStore(store.subscribe, () => { const open = store.slot(assetId).open; return open && open.rootId === thread.id ? open : null; });
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
    if (store.takeFocusOnOpen(assetId, editing.noteId)) q(articleRef.current, '[data-testid="video-note-edit-body"]')?.focus();
  }, [focusPending, editing?.noteId, store, assetId]);

  function renderMenu(note: VideoNoteDto): ReactNode {
    if (readOnly || note.deleted || !isOwnNote(note, userId)) return null;
    return <Menu triggerLabel={`Actions for note by ${authorName(note)}`} label="Note actions" triggerClassName={cn(ICON_BUTTON, "me-[var(--space-1)]")} triggerTestId="video-note-actions" finalFocus={focusEditor} onOpenChange={(open) => { if (open) deletePending.current = false; }} trigger={<span aria-hidden="true">⋯</span>}>
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

  const editForm = (note: VideoNoteDto) => editing && editing.noteId === note.id && (() => {
    const showDrawControls = Boolean(drawings?.on && drawings.canAnnotate && note.id === thread.id && thread.startFrame !== null);
    return <form
    data-notes-form="edit"
    data-size-container="true"
    className="@container grid gap-[var(--space-2)]"
    onSubmit={(event) => { event.preventDefault(); void store.save(assetId, { clock, frameCount, send: actions.edit, markup: drawings?.on ?? false }); }}
  >
    <label className="sr-only" htmlFor={`video-note-edit-${note.id}`}>Edit note</label>
    <Textarea id={`video-note-edit-${note.id}`} data-testid="video-note-edit-body" value={editing.text} readOnly={busy} maxLength={VIDEO_NOTE_BODY_MAX} onChange={(event) => { if (!busy) store.setOpenText(assetId, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void store.save(assetId, { clock, frameCount, send: actions.edit, markup: drawings?.on ?? false }); } }} />
    {(editing.frames || showDrawControls) && <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      {showDrawControls && (!editing.frames || editing.drawing.touched) && <span data-testid="video-note-edit-frames-follow" className="text-foreground-secondary [font:var(--type-label)]">Frames follow the drawing.</span>}
      {editing.frames && !editing.drawing.touched && <>
        <span data-testid="video-note-edit-anchor" className={cn(ANCHOR_CHIP, ANCHOR_CHIP_ROW)}>{editAnchorLabel(marks, timecode)}</span>
        <Button type="button" variant="secondary" className={SMALL} data-testid="video-note-edit-set-in" disabled={busy || !clock} onClick={() => { if (clock) store.mark(assetId, "in", frameOnScreen(clock.getState()), clock); }}>Set in <Kbd>I</Kbd></Button>
        <Button type="button" variant="secondary" className={SMALL} data-testid="video-note-edit-set-out" disabled={busy || !clock} onClick={() => { if (clock) store.mark(assetId, "out", frameOnScreen(clock.getState()), clock); }}>Set out <Kbd>O</Kbd></Button>
        <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-edit-make-point" disabled={busy || !clock} onClick={() => { if (clock) store.makePoint(assetId, clock); }}>Make point</Button>
      </>}
      {showDrawControls && drawings && <EditDrawingControls store={store} assetId={assetId} note={thread} editing={editing} clock={clock} frameCount={frameCount} busy={busy} timecode={timecode} projectId={drawings.projectId} role={drawings.role} />}
    </div>}
    {editing.conflict && <Notice tone="caution" data-testid="video-note-conflict" className="grid gap-[var(--space-1)]"><span>Current note on the server:</span><span data-testid="video-note-conflict-body" className="whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{editing.conflict.body}</span></Notice>}
    <div className="flex justify-end gap-[var(--space-2)]">
      <Button type="button" variant="secondary" data-testid="video-note-edit-cancel" disabled={busy} onClick={() => { store.close(assetId); }}>Cancel</Button>
      <Button type="submit" data-testid="video-note-edit-save" disabled={busy || editing.text.trim() === ""}>{busy ? "Saving…" : editing.conflict ? "Save anyway" : "Save"}</Button>
    </div>
  </form>;
  })();

  const label = noteAnchorLabel(thread, timecode);
  const resolvedLine = thread.resolved ? `Resolved by ${thread.resolved.by.name}` : null;

  return <Item variant="outline" size="sm" className="block min-w-0 data-[selected=true]:border-foreground" data-testid="video-note-thread" data-note-id={thread.id} data-selected={selected ? "true" : "false"} data-resolved={thread.resolved ? "true" : "false"} ref={articleRef as never}>
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
      {form?.kind === "reply" && <form data-notes-form="reply" className="grid gap-[var(--space-2)]" onSubmit={(event) => { event.preventDefault(); void store.reply(assetId, { send: actions.reply }); }}>
        <span className="flex items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{`Reply · ${thread.visibility === "internal" ? "Internal" : "Client-visible"}`}<VisibilityBadge visibility={thread.visibility} /></span>
        <label className="sr-only" htmlFor={`video-note-reply-${thread.id}`}>Write a reply</label>
        <Textarea id={`video-note-reply-${thread.id}`} data-testid="video-note-reply-body" autoFocus value={form.text} readOnly={busy} maxLength={VIDEO_NOTE_BODY_MAX} onChange={(event) => { if (!busy) store.setOpenText(assetId, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void store.reply(assetId, { send: actions.reply }); } }} />
        <div className="flex justify-end gap-[var(--space-2)]">
          <Button type="button" variant="secondary" data-testid="video-note-reply-cancel" disabled={busy} onClick={() => { store.close(assetId); }}>Cancel</Button>
          <Button type="submit" data-testid="video-note-reply-post" disabled={busy || form.text.trim() === ""}>{busy ? "Posting…" : "Post"}</Button>
        </div>
      </form>}
      {!readOnly && !replying && editing === null && <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        {!thread.deleted && <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-reply-button" disabled={busy || blocked} onClick={() => { setResolveNotice(null); store.openReply(assetId, thread.id); }}>Reply</Button>}
        <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-resolve" disabled={busy} onClick={() => { void toggleResolved(); }}>{thread.resolved ? "Reopen" : "Resolve"}</Button>
      </div>}
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

function editAnchorLabel(marks: NoteMarks, timecode: (frame: number) => string): string {
  if (marks.in !== null && marks.out !== null) return `${timecode(marks.in)} → ${timecode(marks.out)}`;
  const only = marks.in ?? marks.out;
  return only === null ? "No frames" : timecode(only);
}

/**
 * The drawing part of an edit form (#741 6b-ui): add a drawing to a plain note, edit or replace the one it has, or remove it. The saved drawing is fetched lazily, keyed by note and
 * revision, and the editor is only opened once it has loaded: it is never seeded with an empty list. A removal is a pending change until Save; "Keep drawing" takes it back.
 */
function EditDrawingControls({ store, assetId, note, editing, clock, frameCount, busy, timecode, projectId, role }: {
  store: NoteFormStore; assetId: string; note: VideoNoteThreadDto; editing: NonNullable<ReturnType<NoteFormStore["slot"]>["open"]>;
  clock: VideoFrameClock | null; frameCount: number; busy: boolean; timecode: (frame: number) => string; projectId: string; role: Role;
}) {
  const drawing = editing.drawing;
  const saved = drawing.hadDrawing && !drawing.remove && drawing.items === null;
  const query = useVideoNoteMarkupQuery(projectId, assetId, note.id, editing.base.revision, saved, role);
  // The read was refused because the list moved on (another session saved): once the list shows the newer note, the edit follows it, or asks, as a 409 does.
  const moved = query.error instanceof MarkupRevisionMismatch && note.revision !== editing.base.revision;
  useEffect(() => { if (moved) store.adoptCurrentNote(assetId, note); }, [moved, store, assetId, note]);
  const framesChosen = useSyncExternalStore(store.subscribe, () => store.slot(assetId).marks.touched);
  const drawingNow = useSyncExternalStore(store.subscribe, () => store.slot(assetId).draw !== null);
  const loaded = query.data?.markup ?? null;
  const ready = !saved || loaded !== null;
  const hasItems = drawing.items === null ? drawing.hadDrawing && !drawing.remove : drawing.items.length > 0;
  const frame = drawing.drawingFrame ?? drawing.baseFrame;
  const enter = () => {
    if (!clock) return;
    preloadSavedDrawing(store, assetId, query.data);
    void store.enterDraw(assetId, { clock, form: "edit", frameCount });
  };
  // A drawing with an item this build cannot read is kept as it is: Edit and Remove would save back a copy without that item.
  const unsupported = saved && query.data?.unsupported === true;
  const disabled = busy || !clock || framesChosen || drawingNow || !ready || unsupported;
  const why = unsupported ? `video-note-edit-drawing-unsupported-${note.id}` : undefined;
  // The header's anchor button already reads the note's frame: the chip only earns its place when the drawing is on another frame.
  const chipShown = hasItems && frame !== null && timecode(frame) !== noteAnchorLabel(note, timecode);
  return <div data-testid="video-note-edit-drawing" className="contents">
    {chipShown && frame !== null && <span data-testid="video-note-edit-drawing-chip" className={cn(ANCHOR_CHIP, ANCHOR_CHIP_ROW)}><PencilIcon aria-hidden="true" className="me-[var(--space-1)] inline size-3" /><span className="sr-only">Drawing on </span>{timecode(frame)}</span>}
    {drawing.remove && <span data-testid="video-note-edit-drawing-removed" className="text-foreground-secondary [font:var(--type-label)]">The drawing is removed when you save.</span>}
    {!drawing.remove && <Button type="button" variant="secondary" className={SMALL} data-testid="video-note-edit-draw" aria-describedby={why} disabled={disabled} onClick={enter}>{hasItems ? "Edit drawing" : "Add drawing"}</Button>}
    {!drawing.remove && hasItems && <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-edit-remove-drawing" aria-describedby={why} disabled={busy || drawingNow || unsupported || !ready} onClick={() => { store.removeDrawing(assetId); }}>Remove drawing</Button>}
    {drawing.remove && <Button type="button" variant="text" className={LINK_BUTTON} data-testid="video-note-edit-keep-drawing" disabled={busy} onClick={() => { store.keepDrawing(assetId); }}>Keep drawing</Button>}
    {unsupported && <span id={why} data-testid="video-note-edit-drawing-unsupported" className="text-foreground-secondary [font:var(--type-label)]">Some markup can't be shown, so this drawing can't be edited or removed here. You can still change the text.</span>}
    {saved && query.isError && <span role="alert" className="text-destructive [font:var(--type-label)]">The drawing could not be loaded. <Button type="button" variant="text" onClick={() => { void query.refetch(); }}>Retry</Button></span>}
    {saved && query.isPending && <span role="status" className="text-foreground-secondary [font:var(--type-label)]">Loading the drawing…</span>}
    {framesChosen && !drawing.touched && <span className="text-foreground-secondary [font:var(--type-label)]">Save the new frames before changing the drawing.</span>}
  </div>;
}
