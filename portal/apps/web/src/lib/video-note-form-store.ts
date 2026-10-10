import { strokesJsonBytes, STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, VIDEO_NOTE_PASTE_MAX, VIDEO_NOTE_PASTE_OFFSET_MAX, type MarkupItem, type VideoMarkup, type VideoNoteCreateInput, type VideoNotePasteCommitResponse, type VideoNotePastePreviewResponse, VideoNoteDto, VideoNoteEditInput, VideoNoteThreadDto, VideoNoteVisibility } from "@quincy/shared";
import type { FrameClockState } from "./video-frame-clock";
import type { MarkupTool } from "./use-markup";
import type { MarkupHistory } from "./markup-history";
import { classifyVideoNoteError, MARKUP_ERROR_TEXT } from "./video-note-errors";
import { EMPTY_MARKS, markFrame, marksToFrames, type NoteMarks } from "./video-note-marks";

/**
 * Every unsent or open note form of one Video tab (#741 5b): one store for a person and Project, created by the collection, so a form's
 * lifetime is the tab's and not any component's. A slot per Version (`assetId`) holds the composer's draft, the one open edit or reply, the
 * in / out marks, the request that is out, and whether the first Escape was spent. Components subscribe and send commands; nothing here
 * renders. A completion writes to the slot and operation it started in (never "the form on screen"), and clears a draft only if the draft's
 * revision is still the one it was sent from. Imports types and `video-note-marks` only: the collection loads this eagerly, so the writes
 * are handed in by the notes chunk (`send`).
 * See docs/lessons.md "Form lifetime is not component lifetime".
 */

/** How long Post waits for the browser to show the frame before it gives the draft back. */
export const FRAME_CONFIRM_TIMEOUT_MS = 10_000;

/** The part of the frame clock a post uses. */
export type NoteClock = { getState(): FrameClockState; seekToFrame(frame: number): void; awaitConfirmedFrame(): Promise<number> };
/** The frame a mark or a new draft belongs to: while playing the one last presented, paused the one a seek in flight is bringing. */
export const frameOnScreen = (state: Pick<FrameClockState, "playing" | "frame" | "targetFrame">): number => (state.playing ? state.frame : (state.targetFrame ?? state.frame));

export type Problem = { text: string; refresh?: boolean; retry?: boolean };
export type Composer = { body: string; visibility: VideoNoteVisibility; anchorFrame: number | null; /** Advances with every edit of the draft. */ revision: number; problem: Problem | null };
type Opened = Pick<VideoNoteDto, "revision" | "body" | "startFrame" | "endFrame">;
export type OpenForm = {
  kind: "edit" | "reply"; noteId: string; rootId: string; text: string; revision: number;
  /** What the form was opened with: Save sends this revision, never the live cache value. */
  base: Opened;
  /** An edit of a plain root: the frame controls show. */
  frames: boolean;
  /** The drawing of an edit (always empty for a reply). */
  drawing: EditDrawing;
  /** The server's note after a reviewed 409: "Save anyway" sends exactly its revision. */
  conflict: Opened | null;
  problem: Problem | null;
  /** Set by a person opening an edit: the form focuses its text field once when it mounts (a re-mounted or pinned form never does). */
  focusOnOpen?: boolean;
};
/** The marks belong to the clock they were made on (a Version or a viewer that is gone takes them with it); off that clock the form's baseline `seed` shows and no frame action has been taken. */
export type StoredMarks = { clock: object | null; value: NoteMarks; touched: boolean; seed: NoteMarks };
export type Op = { id: number; form: "composer" | "open"; phase: "confirming" | "posting"; revision: number };
/** Which form a drawing belongs to: the composer's, or the open edit's. */
export type DrawForm = "composer" | "edit";
/** Draw mode of one Version (#741 6b-ui): `confirming` while the frame is being brought up, `drawing` once it is on screen and frozen. A completion acts only while its `opId` still owns it. */
export type DrawState = { form: DrawForm; phase: "confirming" | "drawing"; opId: number; frame: number };
/** The composer's unsent drawing. `drawingFrame` is frozen by the first stroke and released when every stroke is gone; `revision` advances with every change, so a success never clears a newer drawing. */
export type ComposerMarkup = { items: MarkupItem[]; drawingFrame: number | null; revision: number };
/**
 * An open edit's drawing: what the note had (`hadDrawing`, `baseFrame`), the strokes once the saved drawing was fetched (`items` is null until then, and is never seeded with an empty list),
 * and what the person did to it. Save sends markup only when `touched`.
 */
export type EditDrawing = { hadDrawing: boolean; baseFrame: number | null; items: MarkupItem[] | null; drawingFrame: number | null; remove: boolean; touched: boolean; revision: number };
/** What the paste dialog keeps for a target Version so closing and reopening it loses nothing: the frame offset and the notes the person unticked (everything is ticked by default, so a re-run preview never un-ticks a note). */
export type PasteDraft = { offset: number; unticked: readonly string[] };
/** The notes copied from one Version of a Video (#741 5c-ui): ids only, the paste dialog asks the server for the plan. */
export type PasteClipboard = { sourceAssetId: string; sourceVersion: number; noteIds: readonly string[] };
/** The commit that owns a target Version's paste draft (#741 5c-ui): a completion acts only while its `opId` is still the current one. */
export type PasteOp = { opId: number; status: "idle" | "committing" | "failed" };
/**
 * Everything the paste dialog shows about the server's plan, owned here so no component's lifetime matters: the request is keyed by
 * `generation` (only a result carrying the current one is applied), `invalid` means a 409 voided the plan and no fresh one has arrived,
 * and `notice` / `failure` are what the person should read. Paste is allowed only at status `ok`.
 */
export type PastePreview = { generation: number; status: "idle" | "loading" | "ok" | "failed" | "invalid"; plan: VideoNotePastePreviewResponse | null; error: string | null; notice: string | null; failure: { text: string; retry: boolean } | null };
export type PastePreviewRun = (offsetFrames: number) => Promise<VideoNotePastePreviewResponse>;
export type Slot = { composer: Composer; /** The composer's drawing, the pen, and draw mode (#741 6b-ui). */ markup: ComposerMarkup; tool: MarkupTool; draw: DrawState | null; /** The undo and redo steps of each form's drawing (the hook's history, kept here so it outlives the player and a Version switch). Valid only for the very array it was last anchored to. */ history: DrawHistories; open: OpenForm | null; marks: StoredMarks; op: Op | null; spent: boolean; /** Why a form closed by itself (its note was deleted elsewhere). */ notice: (Problem & { rootId: string }) | null; paste: PasteDraft; pasteOp: PasteOp; pasteView: PastePreview; /** Whether the paste dialog is open, and what the last paste said. */ pasteOpen: boolean; pasteResult: string | null };

/** A form's undo / redo steps and the frame they were made on (a drawing has exactly one frame, so steps never cross frames). */
export type DrawHistory = { steps: MarkupHistory; frame: number | null };
export type DrawHistories = { composer: DrawHistory | null; edit: DrawHistory | null };
const NO_HISTORIES: DrawHistories = Object.freeze({ composer: null, edit: null });
/** A fresh empty draft each time: the history anchors to an array by identity, so a reused empty array could revive another draft's steps. */
const emptyMarkup = (revision: number): ComposerMarkup => ({ items: [], drawingFrame: null, revision });
const NO_DRAWING: EditDrawing = Object.freeze({ hadDrawing: false, baseFrame: null, items: null, drawingFrame: null, remove: false, touched: false, revision: 0 });
const EMPTY_MARKUP: ComposerMarkup = Object.freeze({ items: Object.freeze([]) as unknown as MarkupItem[], drawingFrame: null, revision: 0 });
export const DEFAULT_PEN: MarkupTool = Object.freeze({ kind: "freehand", color: "#e64b3c", width: 4 });
const NO_MARKS: StoredMarks = { clock: null, value: EMPTY_MARKS, touched: false, seed: EMPTY_MARKS };
const EMPTY_COMPOSER: Composer = { body: "", visibility: "internal", anchorFrame: null, revision: 0, problem: null };
const EMPTY_PASTE: PasteDraft = Object.freeze({ offset: 0, unticked: Object.freeze([]) as readonly string[] });
const EMPTY_PASTE_OP: PasteOp = Object.freeze({ opId: 0, status: "idle" });
const EMPTY_PASTE_VIEW: PastePreview = Object.freeze({ generation: 0, status: "idle", plan: null, error: null, notice: null, failure: null });
const PASTE_STALE_NOTICE = "Some notes changed since the preview, so the list was refreshed. Check it, then paste again.";
const EMPTY_SLOT: Slot = Object.freeze({ composer: EMPTY_COMPOSER, markup: EMPTY_MARKUP, tool: DEFAULT_PEN, draw: null, history: NO_HISTORIES, open: null, marks: NO_MARKS, op: null, spent: false, notice: null, paste: EMPTY_PASTE, pasteOp: EMPTY_PASTE_OP, pasteView: EMPTY_PASTE_VIEW, pasteOpen: false, pasteResult: null });

export function effectiveMarks(marks: StoredMarks, clock: object | null): { value: NoteMarks; touched: boolean } {
  return marks.clock !== null && marks.clock === clock ? marks : { value: marks.seed, touched: false };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Said when a Save dropped pending drawing changes because the Project's markup part went off. */
const MARKUP_OFF_DROPPED = "Drawing changes were dropped: drawing is turned off";
const MARKUP_GONE = "Drawing isn't available on this Project any more. Your draft is kept.";

function composerProblem(error: unknown, touchedMarkup = false): Problem {
  const classified = classifyVideoNoteError(error);
  switch (classified.kind) {
    case "markup": return { text: MARKUP_ERROR_TEXT[classified.markupCode!] };
    case "network": return { text: "Couldn't reach the server. Your note may or may not have posted — refresh the notes to check, then post again if it isn't there.", refresh: true };
    case "range": return { text: `That frame is outside this film${classified.frameCount ? ` (the last frame is ${classified.frameCount - 1})` : ""}.` };
    case "archived": return { text: "This Project was archived, so the note was not posted. Your draft is kept." };
    case "access": return { text: touchedMarkup ? MARKUP_GONE : messageOf(error, "You no longer have access to this Project.") };
    default: return { text: messageOf(error, "The note could not be posted.") };
  }
}

/** What a refused write says, and (for a 409) the server's current note and (when it is gone) that the note is. */
export function writeFailure(error: unknown, fallback: string, noteId = "", touchedMarkup = false): { problem: Problem; conflict?: VideoNoteDto; gone?: boolean } {
  const classified = classifyVideoNoteError(error);
  switch (classified.kind) {
    case "markup": return { problem: { text: MARKUP_ERROR_TEXT[classified.markupCode!] } };
    case "conflict": {
      const current = classified.thread && [classified.thread, ...classified.thread.replies].find((candidate) => candidate.id === noteId);
      if (current) return { problem: { text: "This note changed since you opened it. Its current text is shown below; Save anyway replaces it with your edit." }, conflict: current };
      break;
    }
    case "deleted": return { problem: { text: "This note was deleted." }, gone: true };
    case "gone": return { problem: { text: "This note no longer exists." }, gone: true };
    case "network": return { problem: { text: "Couldn't reach the server. The change may or may not have gone through — refresh the notes to check.", refresh: true } };
    case "archived": return { problem: { text: "This Project was archived, so nothing was changed." } };
    case "access": return { problem: { text: touchedMarkup ? MARKUP_GONE : messageOf(error, "You no longer have access to this Project.") } };
    case "range": return { problem: { text: "Those frames are outside this film." } };
    default: break;
  }
  return { problem: { text: messageOf(error, fallback) } };
}

/** Whether leaving the form would lose something: an edit's text or frames changed, a reply or composer with text, or a composer with marks set. */
const isDirty = (slot: Slot) => (slot.open ? (slot.open.kind === "reply" ? slot.open.text !== "" : slot.open.text !== slot.open.base.body || slot.marks.touched || slot.open.drawing.touched) : slot.composer.body !== "" || slot.marks.touched || slot.markup.items.length > 0);

/** The frame a drawing may be on: a point note's frame, or any frame of a range (`end` is exclusive). */
const inFrames = (frame: number, start: number, end: number | null) => frame >= start && frame < (end ?? start + 1);
const clampFrame = (frame: number, low: number, high: number) => Math.min(high, Math.max(low, frame));

/** Waits for the browser to show the frame the clock was asked for (10 s at most): the frame that landed, "timeout", or an abort/failure error the caller classifies. */
async function confirmed(clock: NoteClock): Promise<number | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { resolve("timeout"); }, FRAME_CONFIRM_TIMEOUT_MS); });
  try { return await Promise.race([clock.awaitConfirmedFrame(), timedOut]); } finally { clearTimeout(timer); }
}

export function createNoteFormStore(key: string) {
  const slots = new Map<string, Slot>();
  // The clipboard is per Video, not per Version: it must outlive switching Versions, and no slot rewrite touches it.
  const clipboards = new Map<string, PasteClipboard>();
  // How to ask for the plan again, per target Version: lets a 409 refresh the preview with no dialog mounted.
  const pasteRuns = new Map<string, PastePreviewRun>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let dead = false;
  const slot = (assetId: string): Slot => slots.get(assetId) ?? EMPTY_SLOT;
  const put = (assetId: string, patch: Partial<Slot>) => {
    if (dead) return;
    const prev = slot(assetId);
    // The edit's steps belong to the note being edited: another note, or none, starts clean.
    const sameEdit = !("open" in patch) || prev.open?.noteId === patch.open?.noteId;
    slots.set(assetId, { ...prev, ...patch, ...(sameEdit || "history" in patch ? {} : { history: { ...prev.history, edit: null } }) });
    listeners.forEach((listener) => { listener(); });
  };
  function startPreview(assetId: string, run: PastePreviewRun, offset: number) {
    if (dead) return;
    pasteRuns.set(assetId, run);
    const held = slot(assetId).pasteView;
    const generation = held.generation + 1;
    put(assetId, { pasteView: { ...held, generation, status: "loading", error: null } });
    const current = () => slot(assetId).pasteView.generation === generation;
    run(offset).then(
      (plan) => { if (current()) put(assetId, { pasteView: { ...slot(assetId).pasteView, status: "ok", plan, error: null } }); },
      (error: unknown) => { if (current()) put(assetId, { pasteView: { ...slot(assetId).pasteView, status: "failed", error: classifyVideoNoteError(error).kind === "network" ? "Couldn't reach the server." : messageOf(error, "The notes could not be previewed.") } }); },
    );
  }
  const owns = (assetId: string, op: Op) => slot(assetId).op?.id === op.id;

  /** The patch that ends an edit's draw phase when its form goes (the composer's draw phase is its own). */
  const endEditDraw = (assetId: string): Partial<Slot> => (slot(assetId).draw?.form === "edit" ? { draw: null } : {});
  const close = (assetId: string) => { if (slot(assetId).open) put(assetId, { open: null, marks: NO_MARKS, spent: false, ...endEditDraw(assetId) }); };
  const cancelConfirmation = (assetId: string) => {
    const held = slot(assetId);
    const draw = held.draw?.phase === "confirming";
    if (held.op?.phase === "confirming" || draw) put(assetId, { ...(held.op?.phase === "confirming" ? { op: null } : {}), ...(draw ? { draw: null } : {}) });
  };

  function open(assetId: string, form: Omit<OpenForm, "revision" | "conflict" | "problem" | "drawing"> & { drawing?: EditDrawing }, seed: NoteMarks): boolean {
    if (slot(assetId).op?.phase === "posting") return false;
    put(assetId, { op: null, draw: null, open: { ...form, drawing: form.drawing ?? NO_DRAWING, revision: 0, conflict: null, problem: null }, marks: { ...NO_MARKS, value: seed, seed }, spent: false, notice: null });
    return true;
  }

  function takeMark(assetId: string, clock: object, change: (marks: NoteMarks) => NoteMarks) {
    const held = slot(assetId);
    if (held.op || held.draw || (held.open && (!held.open.frames || held.open.drawing.touched))) return;
    put(assetId, { marks: { clock, value: change(effectiveMarks(held.marks, clock).value), touched: true, seed: held.marks.seed }, spent: false });
  }

  // The last thread list passed to retireMissing, per Version: a request that settles later is reconciled against it.
  const latest = new Map<string, readonly VideoNoteThreadDto[]>();
  function reconcile(assetId: string) {
    const held = slot(assetId);
    const form = held.open;
    const threads = latest.get(assetId);
    if (!form || held.op || !threads) return;
    const root = threads.find((thread) => thread.id === form.rootId);
    if (root?.deleted && (form.kind === "reply" || form.noteId === root.id)) { put(assetId, { open: null, marks: NO_MARKS, spent: false, ...endEditDraw(assetId), notice: { text: "This note was deleted.", rootId: root.id } }); return; }
    if (!root) { put(assetId, { open: null, marks: NO_MARKS, spent: false, ...endEditDraw(assetId), notice: { text: "This note no longer exists.", rootId: form.rootId } }); return; }
    if (form.kind === "edit" && form.noteId !== root.id && !root.replies.some((reply) => reply.id === form.noteId)) close(assetId);
  }

  /** An edit or a reply goes out. It is never cancelled once sent; its result closes the form only if the same operation still owns it. */
  async function submitOpen(assetId: string, form: OpenForm, run: () => Promise<unknown>, fallback: string, touchedMarkup = false) {
    const op: Op = { id: ++seq, form: "open", phase: "posting", revision: form.revision };
    put(assetId, { op, open: { ...form, problem: null }, notice: null });
    try { await run(); } catch (error) {
      if (!owns(assetId, op)) return;
      const failure = writeFailure(error, fallback, form.noteId, touchedMarkup);
      const current = slot(assetId).open;
      if (failure.gone) put(assetId, { op: null, open: null, marks: NO_MARKS, spent: false, ...endEditDraw(assetId), notice: { ...failure.problem, rootId: form.rootId } });
      else { put(assetId, { op: null, open: current && { ...current, problem: failure.problem, ...(failure.conflict ? { conflict: failure.conflict } : {}) } }); reconcile(assetId); }
      return;
    }
    if (!owns(assetId, op)) return;
    const current = slot(assetId).open;
    put(assetId, { op: null, ...(current?.noteId === form.noteId && current.kind === form.kind ? { open: null, marks: NO_MARKS, spent: false, ...endEditDraw(assetId) } : {}) });
    reconcile(assetId);
  }

  return {
    key,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    slot,

    setBody(assetId: string, body: string, frameNow: number) {
      const composer = slot(assetId).composer;
      // Composing starts at the first character: the frame on screen then is the anchor, until the text is gone again.
      const anchorFrame = body === "" ? null : composer.body === "" && composer.anchorFrame === null ? frameNow : composer.anchorFrame;
      put(assetId, { composer: { ...composer, body, anchorFrame, visibility: body === "" ? "internal" : composer.visibility, revision: composer.revision + 1 }, spent: false });
    },
    setVisibility(assetId: string, visibility: VideoNoteVisibility) {
      const composer = slot(assetId).composer;
      put(assetId, { composer: { ...composer, visibility, revision: composer.revision + 1 } });
    },

    /** Returns false (nothing opens) while a request is out in this Version. The end is exclusive in storage, so the last included frame is end - 1. */
    openEdit(assetId: string, note: VideoNoteDto, rootId: string): boolean {
      const frames = note.id === rootId && !note.hasMarkup && note.startFrame !== null;
      const seed: NoteMarks = frames ? { in: note.startFrame, out: note.endFrame === null ? null : note.endFrame - 1 } : EMPTY_MARKS;
      const drawing: EditDrawing = note.id === rootId && note.hasMarkup ? { ...NO_DRAWING, hadDrawing: true, baseFrame: note.drawingFrame, drawingFrame: note.drawingFrame } : NO_DRAWING;
      return open(assetId, { kind: "edit", noteId: note.id, rootId, text: note.body, base: { revision: note.revision, body: note.body, startFrame: note.startFrame, endFrame: note.endFrame }, frames, drawing, focusOnOpen: true }, seed);
    },
    /** True once, to the edit form that mounted because a person opened it: it then focuses its text field. */
    takeFocusOnOpen(assetId: string, noteId: string): boolean {
      const form = slot(assetId).open;
      if (!form || form.noteId !== noteId || !form.focusOnOpen) return false;
      put(assetId, { open: { ...form, focusOnOpen: false } });
      return true;
    },
    openReply: (assetId: string, rootId: string): boolean => open(assetId, { kind: "reply", noteId: rootId, rootId, text: "", base: { revision: 0, body: "", startFrame: null, endFrame: null }, frames: false }, EMPTY_MARKS),
    close,
    setOpenText(assetId: string, text: string) {
      const form = slot(assetId).open;
      if (form) put(assetId, { open: { ...form, text, revision: form.revision + 1 }, spent: false });
    },

    mark: (assetId: string, kind: "in" | "out", frame: number, clock: object) => { takeMark(assetId, clock, (marks) => markFrame(marks, kind, frame)); },
    makePoint: (assetId: string, clock: object) => { takeMark(assetId, clock, (marks) => ({ in: marks.in ?? marks.out, out: null })); },
    clearMarks(assetId: string) { const held = slot(assetId); if (!held.op && !held.draw) put(assetId, { marks: { ...NO_MARKS, seed: held.marks.seed }, spent: false }); },

    /** Pause, seek to the range start, the drawing frame or the frozen anchor, confirm exactly that frame (10 s at most), then send. Cancelling the confirmation invalidates the operation before it can send. */
    async post(assetId: string, { clock, frameCount, send, markup: markupOn = true }: { clock: NoteClock; frameCount: number; send: (input: VideoNoteCreateInput) => Promise<unknown>; /** False when the Project's markup part is off: the note posts without its drawing. */ markup?: boolean }) {
      const held = slot(assetId);
      const draft = held.composer;
      const text = draft.body.trim();
      if (held.op || held.open || !text) return;
      const drawn = held.markup;
      const withDrawing = markupOn && drawn.items.length > 0 && drawn.drawingFrame !== null;
      const marked = marksToFrames(effectiveMarks(held.marks, clock).value, frameCount);
      if (withDrawing) {
        const problem = strokesJsonBytes(drawn.items) > VIDEO_MARKUP_MAX_BYTES ? MARKUP_ERROR_TEXT.markup_too_large
          : marked && !inFrames(drawn.drawingFrame!, marked.startFrame, marked.endFrame) ? "The drawing is outside the In/Out range. Draw again inside it, or change the marks." : null;
        if (problem) { put(assetId, { draw: null, composer: { ...draft, problem: { text: problem } } }); return; }
      }
      const anchor = withDrawing ? drawn.drawingFrame! : marked ? marked.startFrame : Math.min(Math.max(0, draft.anchorFrame ?? frameOnScreen(clock.getState())), Math.max(0, frameCount - 1));
      const op: Op = { id: ++seq, form: "composer", phase: "confirming", revision: draft.revision };
      const markupRevision = drawn.revision;
      put(assetId, { op, draw: null, composer: { ...draft, problem: null } });
      const stop = (problem: Problem | null) => { if (owns(assetId, op)) put(assetId, { op: null, composer: { ...slot(assetId).composer, problem } }); };
      clock.seekToFrame(anchor);
      let landed: number | "timeout";
      try { landed = await confirmed(clock); }
      catch (error) { stop(isAbort(error) ? null : { text: "The frame could not be confirmed. Your draft is kept.", retry: true }); return; }
      if (!owns(assetId, op)) return;
      if (landed === "timeout") return stop({ text: "The frame took too long to show. Your draft is kept.", retry: true });
      // The frame on screen must be the one the note was composed at: a scrub or a step that landed first moved it.
      if (landed !== anchor) return stop({ text: "Frame moved — Post again" });
      put(assetId, { op: { ...op, phase: "posting" } });
      const frames = withDrawing && !marked ? { startFrame: anchor, endFrame: null } : marked ?? { startFrame: anchor, endFrame: null };
      try { await send({ startFrame: frames.startFrame, ...(frames.endFrame !== null ? { endFrame: frames.endFrame } : {}), visibility: draft.visibility, body: text, ...(withDrawing ? { markup: drawn.items as VideoMarkup, drawingFrame: drawn.drawingFrame! } : {}) }); }
      catch (error) { stop(composerProblem(error, withDrawing)); return; }
      if (!owns(assetId, op)) return;
      const now = slot(assetId).composer;
      const nowMarkup = slot(assetId).markup;
      put(assetId, {
        op: null, marks: NO_MARKS, composer: now.revision === op.revision ? { ...EMPTY_COMPOSER, revision: now.revision + 1 } : now,
        markup: nowMarkup.revision === markupRevision ? emptyMarkup(nowMarkup.revision + 1) : nowMarkup,
        ...(nowMarkup.revision === markupRevision ? { history: { ...slot(assetId).history, composer: null } } : {}),
      });
    },

    /** Sends the revision the form was opened with (or, after a reviewed conflict, the server's) and only what changed; frames only after a frame action since opening. Never seeks, except that a drawing change confirms its drawing frame first. */
    async save(assetId: string, { clock, frameCount, send, markup: markupOn = true }: { clock: object | null; frameCount: number; send: (noteId: string, input: VideoNoteEditInput) => Promise<unknown>; /** False when the Project's markup part has gone off: Save sends the text only and discards pending drawing changes (said so afterwards). */ markup?: boolean }) {
      const held = slot(assetId);
      const opened = held.open;
      const text = opened?.text.trim();
      if (!opened || opened.kind !== "edit" || held.op || !text) return;
      const dropped = !markupOn && opened.drawing.touched;
      const form: OpenForm = dropped ? { ...opened, drawing: { ...opened.drawing, items: null, remove: false, touched: false, drawingFrame: opened.drawing.baseFrame, revision: opened.drawing.revision + 1 } } : opened;
      if (dropped) put(assetId, { open: form, history: { ...held.history, edit: null }, ...endEditDraw(assetId) });
      const say = () => { if (dropped && slot(assetId).open === null) put(assetId, { notice: { text: MARKUP_OFF_DROPPED, rootId: form.rootId } }); };
      const against = form.conflict ?? form.base;
      const input: { expectedRevision: number; body?: string; startFrame?: number; endFrame?: number | null; markup?: VideoMarkup | null; drawingFrame?: number } = { expectedRevision: against.revision };
      if (text !== against.body) input.body = text;
      const marks = effectiveMarks(held.marks, clock);
      const frames = form.frames && marks.touched ? marksToFrames(marks.value, frameCount) : null;
      if (frames && (frames.startFrame !== against.startFrame || frames.endFrame !== against.endFrame)) { input.startFrame = frames.startFrame; input.endFrame = frames.endFrame; }
      const drawing = form.drawing;
      const items = drawing.items !== null && drawing.items.length > 0 ? drawing.items : null;
      if (drawing.touched) {
        if (items && !drawing.remove) { input.markup = items as VideoMarkup; input.drawingFrame = drawing.drawingFrame ?? against.startFrame ?? 0; }
        else if (drawing.hadDrawing) input.markup = null;
      }
      if (input.body === undefined && input.startFrame === undefined && input.markup === undefined) { close(assetId); say(); return; }
      if (held.draw) put(assetId, { draw: null }); // saving ends draw mode; the strokes go with the save
      const fail = (problem: string) => { put(assetId, { open: { ...form, problem: { text: problem } } }); };
      if (input.markup !== undefined && input.startFrame !== undefined) return fail(MARKUP_ERROR_TEXT.markup_and_frames);
      if (input.markup && strokesJsonBytes(input.markup) > VIDEO_MARKUP_MAX_BYTES) return fail(MARKUP_ERROR_TEXT.markup_too_large);
      const send_ = () => submitOpen(assetId, form, () => send(form.noteId, input as VideoNoteEditInput), "The note could not be saved.", input.markup !== undefined);
      if (!input.markup) { await send_(); say(); return; }
      // A drawing is saved on the frame it was drawn on: bring that frame up again first, exactly as Post does (story 31).
      const target = input.drawingFrame!;
      const live = clock as NoteClock | null;
      if (!live || typeof live.awaitConfirmedFrame !== "function") return fail("The film isn't ready, so the drawing can't be saved yet.");
      const op: Op = { id: ++seq, form: "open", phase: "confirming", revision: form.revision };
      put(assetId, { op, draw: null, open: { ...form, problem: null } });
      const stop = (problem: Problem | null) => { if (owns(assetId, op)) put(assetId, { op: null, open: { ...(slot(assetId).open ?? form), problem } }); };
      live.seekToFrame(target);
      let landed: number | "timeout";
      try { landed = await confirmed(live); }
      catch (error) { stop(isAbort(error) ? null : { text: "The frame could not be confirmed. Your edit is kept.", retry: true }); return; }
      if (!owns(assetId, op)) return;
      if (landed === "timeout") return stop({ text: "The frame took too long to show. Your edit is kept.", retry: true });
      if (landed !== target) return stop({ text: "Frame moved — Save again" });
      await send_();
    },
    async reply(assetId: string, { send }: { send: (rootId: string, body: string) => Promise<unknown> }) {
      const held = slot(assetId);
      const form = held.open;
      const text = form?.text.trim();
      if (!form || form.kind !== "reply" || held.op || !text) return;
      await submitOpen(assetId, form, () => send(form.rootId, text), "The reply could not be posted.");
    },

    cancelConfirmation,

    /**
     * Draw mode (#741 6b-ui): pause, seek to the drawing's frame, wait for exactly that frame (10 s at most, the same deadline and cancellation as Post), then open the drawing phase with the
     * frame frozen. Chosen frame: a drawing that already exists keeps its own; otherwise the frame on screen, brought inside the note's frames (an edit) or its In/Out marks (the composer).
     * Strokes are never touched by a cancel, a timeout or a mismatch.
     */
    async enterDraw(assetId: string, { clock, form, frameCount }: { clock: NoteClock; form: DrawForm; frameCount: number }) {
      const held = slot(assetId);
      if (dead || held.op || held.draw) return;
      const last = Math.max(0, frameCount - 1);
      const onScreen = clampFrame(frameOnScreen(clock.getState()), 0, last);
      const complain = (text: string) => { put(assetId, form === "edit" && held.open ? { open: { ...held.open, problem: { text } } } : { composer: { ...held.composer, problem: { text } } }); };
      let frame: number;
      if (form === "edit") {
        const open_ = held.open;
        if (!open_ || open_.kind !== "edit" || open_.noteId !== open_.rootId || open_.base.startFrame === null) return;
        const drawing = open_.drawing;
        if (drawing.touched && held.marks.touched) return complain("Save the new frames first; a note's frames and its drawing change one at a time.");
        if (held.marks.touched) return complain("Save the new frames first; a note's frames and its drawing change one at a time.");
        if (drawing.hadDrawing && !drawing.remove && drawing.items === null) return complain("The saved drawing hasn't loaded yet. Try again in a moment.");
        const start = open_.base.startFrame;
        const end = open_.base.endFrame === null ? start : open_.base.endFrame - 1;
        frame = drawing.items !== null && drawing.items.length > 0 && drawing.drawingFrame !== null ? drawing.drawingFrame : clampFrame(onScreen, start, end);
      } else {
        if (held.open) return;
        const drawn = held.markup;
        const marked = marksToFrames(effectiveMarks(held.marks, clock).value, frameCount);
        frame = drawn.items.length > 0 && drawn.drawingFrame !== null ? drawn.drawingFrame : marked && !inFrames(onScreen, marked.startFrame, marked.endFrame) ? marked.startFrame : onScreen;
      }
      const state: DrawState = { form, phase: "confirming", opId: ++seq, frame };
      put(assetId, { draw: state, ...(form === "edit" && held.open ? { open: { ...held.open, problem: null } } : { composer: { ...held.composer, problem: null } }) });
      const mine = () => slot(assetId).draw?.opId === state.opId;
      const stop = (problem: Problem | null) => {
        if (!mine()) return;
        const now = slot(assetId);
        put(assetId, { draw: null, ...(problem === null ? {} : form === "edit" && now.open ? { open: { ...now.open, problem } } : { composer: { ...now.composer, problem } }) });
      };
      clock.seekToFrame(frame);
      let landed: number | "timeout";
      try { landed = await confirmed(clock); }
      catch (error) { stop(isAbort(error) ? null : { text: "The frame could not be confirmed. Try Draw again.", retry: true }); return; }
      if (!mine()) return;
      if (landed === "timeout") return stop({ text: "The frame took too long to show. Try Draw again.", retry: true });
      if (landed !== frame) return stop({ text: "Frame moved — press Draw again" });
      put(assetId, { draw: { ...state, phase: "drawing" } });
    },
    /** Leaves draw mode. The strokes stay. */
    exitDraw(assetId: string) { if (slot(assetId).draw) put(assetId, { draw: null }); },
    /**
     * The committed strokes of a form, replaced by `next` (or a function of the current ones). Every change advances the draft's revision; the array is stored as given, so a caller's
     * history, which is valid only for the very array it last stored, stays valid. The first stroke freezes the drawing frame; none left releases it.
     */
    setItems(assetId: string, form: DrawForm, next: MarkupItem[] | ((current: MarkupItem[]) => MarkupItem[])) {
      const held = slot(assetId);
      const frame = held.draw?.frame ?? null;
      if (form === "composer") {
        const items = typeof next === "function" ? next(held.markup.items) : next;
        put(assetId, { markup: { items, drawingFrame: items.length === 0 ? null : held.markup.drawingFrame ?? frame, revision: held.markup.revision + 1 }, spent: false });
        return;
      }
      const open_ = held.open;
      if (!open_ || open_.kind !== "edit") return;
      const d = open_.drawing;
      const prior = d.remove ? [] : d.items ?? [];
      const items = typeof next === "function" ? next(prior) : next;
      // Strokes added to a drawing that is gone (removed, or every stroke cleared) are a new drawing: they freeze the frame they were drawn on, not the old one.
      const drawingFrame = items.length === 0 ? d.baseFrame : prior.length > 0 ? d.drawingFrame ?? frame : frame;
      put(assetId, { open: { ...open_, drawing: { ...d, items, remove: false, touched: true, drawingFrame, revision: d.revision + 1 } }, spent: false });
    },
    /** The saved drawing of the note being edited, fetched by the form's owner. It seeds the editor once and is not a change; nothing replaces strokes already being edited. */
    loadDrawing(assetId: string, noteId: string, items: MarkupItem[], frame: number) {
      const open_ = slot(assetId).open;
      if (!open_ || open_.kind !== "edit" || open_.noteId !== noteId || open_.drawing.items !== null) return;
      put(assetId, { open: { ...open_, drawing: { ...open_.drawing, items, drawingFrame: frame, baseFrame: open_.drawing.baseFrame ?? frame } }, history: { ...slot(assetId).history, edit: null } });
    },
    /** Takes the composer's drawing away (the chip's Remove). */
    clearMarkup(assetId: string) {
      const held = slot(assetId);
      if (held.markup.items.length === 0 && held.markup.drawingFrame === null) return;
      put(assetId, { markup: emptyMarkup(held.markup.revision + 1), history: { ...held.history, composer: null }, spent: false, ...(held.draw?.form === "composer" ? { draw: null } : {}) });
    },
    /** Marks the open edit's saved drawing for removal (Save sends `markup: null`). */
    removeDrawing(assetId: string) {
      const open_ = slot(assetId).open;
      if (!open_ || open_.kind !== "edit") return;
      if (!open_.drawing.hadDrawing) {
        // A note that never had a drawing: Remove drops the unsaved additions and releases their frozen frame.
        if (!open_.drawing.touched && open_.drawing.items === null) return;
        put(assetId, { open: { ...open_, drawing: { ...open_.drawing, items: null, remove: false, touched: false, drawingFrame: null, revision: open_.drawing.revision + 1 } }, history: { ...slot(assetId).history, edit: null }, spent: false, ...endEditDraw(assetId) });
        return;
      }
      put(assetId, { open: { ...open_, drawing: { ...open_.drawing, items: null, remove: true, touched: true, drawingFrame: open_.drawing.baseFrame, revision: open_.drawing.revision + 1 } }, history: { ...slot(assetId).history, edit: null }, spent: false, ...endEditDraw(assetId) });
    },
    /** Undoes a removal that has not been saved. */
    keepDrawing(assetId: string) {
      const open_ = slot(assetId).open;
      if (!open_ || open_.kind !== "edit" || !open_.drawing.remove) return;
      put(assetId, { open: { ...open_, drawing: { ...open_.drawing, remove: false, touched: false, items: null, drawingFrame: open_.drawing.baseFrame, revision: open_.drawing.revision + 1 } }, history: { ...slot(assetId).history, edit: null } });
    },
    /** Stores a form's undo / redo steps (the drawing hook's, in controlled mode). */
    setHistory(assetId: string, form: DrawForm, steps: MarkupHistory, frame: number | null) { put(assetId, { history: { ...slot(assetId).history, [form]: { steps, frame } } }); },
    setTool(assetId: string, patch: Partial<MarkupTool>) { put(assetId, { tool: { ...slot(assetId).tool, ...patch } }); },

    /** The first Escape of a dirty form is held (the text stays); the next one is not. A clean edit or reply closes. Nothing here moves focus: the answer says where it should go. */
    escape(assetId: string, { focusInForm }: { focusInForm: boolean }): { consumed: boolean; focus: "dialog" | "textarea" | "opener" | "draw" | null } {
      const held = slot(assetId);
      // Draw mode owns the first Escape: it cancels a frame confirmation or leaves the drawing phase, and the strokes stay. The dirty-form hold below is the next Escape, the viewer the one after.
      if (held.draw) { put(assetId, { draw: null }); return { consumed: true, focus: "draw" }; }
      if (held.op?.phase === "confirming") { cancelConfirmation(assetId); put(assetId, { spent: true }); return { consumed: true, focus: "textarea" }; }
      const dirty = isDirty(held);
      if (held.open && !dirty) { close(assetId); return { consumed: true, focus: "opener" }; }
      if (dirty && !held.spent) { put(assetId, { spent: true }); return { consumed: true, focus: "textarea" }; }
      if (!held.open && !dirty && focusInForm) return { consumed: true, focus: "dialog" };
      return { consumed: false, focus: null };
    },
    /** The player handed this Version a clock. Marks made on another (an earlier opening of the Version) no longer show, so their "touched" goes too: Escape's dirty check then matches what Save would send. */
    observeClock(assetId: string, clock: object) {
      const held = slot(assetId);
      if (held.marks.clock !== null && held.marks.clock !== clock) put(assetId, { marks: { ...NO_MARKS, seed: held.marks.seed } });
      if (held.draw) put(assetId, { draw: null }); // a frame confirmed on another clock means nothing here; the strokes stay
    },
    /** Dismisses the notice a closed form left behind. */
    dismissNotice(assetId: string) { if (slot(assetId).notice) put(assetId, { notice: null }); },
    /** The viewer leaves this Version: Escape is re-armed, and an empty composer is Internal again (a draft keeps its text and its visibility). */
    leave(assetId: string) {
      const held = slot(assetId);
      const reset = held.composer.body === "" && held.composer.visibility !== "internal";
      if (held.spent || reset || held.draw) put(assetId, { ...(held.draw ? { draw: null } : {}), ...(held.spent ? { spent: false } : {}), ...(reset ? { composer: { ...held.composer, visibility: "internal" as const, revision: held.composer.revision + 1 } } : {}) });
    },
    rearm(assetId: string) { if (slot(assetId).spent) put(assetId, { spent: false }); },
    /** The open form's note left the Version's full list (deleted elsewhere): the form goes, unless its own request is out (it is reconciled again when that settles). */
    retireMissing(assetId: string, threads: readonly VideoNoteThreadDto[]) { latest.set(assetId, threads); reconcile(assetId); },

    /** Copies the notes a person is looking at (at most the paste limit). An empty selection copies nothing and keeps the earlier clipboard. */
    copyNotes(videoId: string, clip: PasteClipboard) {
      if (dead || clip.noteIds.length === 0) return;
      clipboards.set(videoId, { sourceAssetId: clip.sourceAssetId, sourceVersion: clip.sourceVersion, noteIds: clip.noteIds.slice(0, VIDEO_NOTE_PASTE_MAX) });
      listeners.forEach((listener) => { listener(); });
    },
    clipboard: (videoId: string): PasteClipboard | null => clipboards.get(videoId) ?? null,
    pasteDraft: (assetId: string): PasteDraft => slot(assetId).paste,
    setPasteOffset(assetId: string, offset: number) {
      const next = Number.isFinite(offset) ? Math.min(VIDEO_NOTE_PASTE_OFFSET_MAX, Math.max(-VIDEO_NOTE_PASTE_OFFSET_MAX, Math.round(offset))) : 0;
      const held = slot(assetId).paste;
      if (held.offset !== next) put(assetId, { paste: { ...held, offset: next } });
    },
    setPasteTicked(assetId: string, noteId: string, ticked: boolean) {
      const held = slot(assetId).paste;
      const has = held.unticked.includes(noteId);
      if (ticked === has) put(assetId, { paste: { ...held, unticked: ticked ? held.unticked.filter((id) => id !== noteId) : [...held.unticked, noteId] } });
    },
    resetPaste(assetId: string) { if (slot(assetId).paste !== EMPTY_PASTE) put(assetId, { paste: EMPTY_PASTE }); },

    // Paste lifecycle (#741 5c-ui): the dialog renders this and dispatches into it; it keeps no request or result of its own.
    pasteOp: (assetId: string): PasteOp => slot(assetId).pasteOp,
    pasteView: (assetId: string): PastePreview => slot(assetId).pasteView,
    pasteOpen: (assetId: string): boolean => slot(assetId).pasteOpen,
    pasteResult: (assetId: string): string | null => slot(assetId).pasteResult,
    setPasteOpen(assetId: string, open: boolean) {
      const held = slot(assetId);
      if (held.pasteOpen === open) return;
      if (open) { put(assetId, { pasteOpen: true, pasteResult: null }); return; }
      // Closing forgets what the server said (and voids any request out); the offset and the ticks stay.
      pasteRuns.delete(assetId);
      put(assetId, { pasteOpen: false, pasteView: { ...EMPTY_PASTE_VIEW, generation: held.pasteView.generation + 1 } });
    },
    clearPasteResult(assetId: string) { if (slot(assetId).pasteResult !== null) put(assetId, { pasteResult: null }); },
    /** Asks for the plan at `offset`. Starting bumps the generation, so anything asked earlier is discarded when it lands. */
    requestPreview(assetId: string, run: PastePreviewRun, offset: number) { startPreview(assetId, run, offset); },
    /** Sends the commit and owns what comes back. Success clears the draft, closes the dialog and leaves the notice; a 409 voids the plan and asks for a fresh one itself. */
    async commitPaste(assetId: string, commit: () => Promise<VideoNotePasteCommitResponse>): Promise<void> {
      const held = slot(assetId);
      if (dead || held.pasteOp.status === "committing") return;
      const opId = ++seq;
      put(assetId, { pasteOp: { opId, status: "committing" }, pasteView: { ...held.pasteView, notice: null, failure: null } });
      const mine = () => slot(assetId).pasteOp.opId === opId && slot(assetId).pasteOp.status === "committing";
      try {
        const result = await commit();
        if (!mine()) return;
        pasteRuns.delete(assetId);
        put(assetId, { paste: EMPTY_PASTE, pasteOpen: false, pasteResult: `Pasted ${result.copied} ${result.copied === 1 ? "note" : "notes"}${result.skipped > 0 ? ` · ${result.skipped} left out` : ""}`, pasteOp: { opId, status: "idle" }, pasteView: { ...EMPTY_PASTE_VIEW, generation: slot(assetId).pasteView.generation + 1 } });
      } catch (error) {
        if (!mine()) return;
        const classified = classifyVideoNoteError(error);
        if (classified.kind === "stale" && classified.preview) {
          put(assetId, { pasteOp: { opId, status: "idle" }, pasteView: { ...slot(assetId).pasteView, status: "invalid", notice: PASTE_STALE_NOTICE } });
          const run = pasteRuns.get(assetId);
          if (run) startPreview(assetId, run, slot(assetId).paste.offset);
          return;
        }
        const failure = classified.kind === "network" ? { text: "Couldn't reach the server. Nothing is lost; try again — notes already pasted are not pasted twice.", retry: true }
          : classified.kind === "archived" ? { text: "This Project was archived, so nothing was pasted.", retry: false }
          : { text: messageOf(error, "The notes could not be pasted."), retry: false };
        put(assetId, { pasteOp: { opId, status: "failed" }, pasteView: { ...slot(assetId).pasteView, failure } });
      }
    },

    /** The person's session ended: every frame confirmation stops. A request already sent is never touched. */
    cancelAll() {
      for (const assetId of [...slots.keys()]) {
        cancelConfirmation(assetId);
        if (slot(assetId).draw) put(assetId, { draw: null });
        // A paste commit already sent is not touched, but it stops owning the draft: its completion is ignored.
        const held = slot(assetId).pasteOp;
        if (held.status === "committing") put(assetId, { pasteOp: { ...held, opId: ++seq, status: "idle" } });
      }
    },
    /** This store is being replaced (another person or Project): nothing it started may write or send again. */
    retire() { dead = true; slots.clear(); clipboards.clear(); pasteRuns.clear(); listeners.clear(); },
  };
}

export type NoteFormStore = ReturnType<typeof createNoteFormStore>;

/**
 * Seeds the open edit with the note's saved drawing before the editor opens (the panel's "Edit drawing" and the floating Draw both go through here). Only a read for this very note
 * and the revision the edit was opened on is taken, only while the edit still holds the saved drawing unloaded, and an empty read seeds nothing: the editor is never seeded with a
 * list that was not the note's.
 */
export function preloadSavedDrawing(store: Pick<NoteFormStore, "slot" | "loadDrawing">, assetId: string, read: { noteId: string; revision: number; markup: MarkupItem[] | null } | undefined): void {
  const form = store.slot(assetId).open;
  if (!form || form.kind !== "edit" || !read || read.markup === null) return;
  const d = form.drawing;
  if (!d.hadDrawing || d.remove || d.items !== null || read.noteId !== form.noteId || read.revision !== form.base.revision) return;
  store.loadDrawing(assetId, form.noteId, read.markup, d.baseFrame ?? form.base.startFrame ?? 0);
}
