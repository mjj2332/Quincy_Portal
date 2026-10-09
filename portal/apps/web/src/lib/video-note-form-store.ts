import type { VideoNoteCreateInput, VideoNoteDto, VideoNoteEditInput, VideoNoteThreadDto, VideoNoteVisibility } from "@quincy/shared";
import type { FrameClockState } from "./video-frame-clock";
import { classifyVideoNoteError } from "./video-note-errors";
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
  /** The server's note after a reviewed 409: "Save anyway" sends exactly its revision. */
  conflict: Opened | null;
  problem: Problem | null;
};
/** The marks belong to the clock they were made on (a Version or a viewer that is gone takes them with it); off that clock the form's baseline `seed` shows and no frame action has been taken. */
export type StoredMarks = { clock: object | null; value: NoteMarks; touched: boolean; seed: NoteMarks };
export type Op = { id: number; form: "composer" | "open"; phase: "confirming" | "posting"; revision: number };
export type Slot = { composer: Composer; open: OpenForm | null; marks: StoredMarks; op: Op | null; spent: boolean; /** Why a form closed by itself (its note was deleted elsewhere). */ notice: (Problem & { rootId: string }) | null };

const NO_MARKS: StoredMarks = { clock: null, value: EMPTY_MARKS, touched: false, seed: EMPTY_MARKS };
const EMPTY_COMPOSER: Composer = { body: "", visibility: "internal", anchorFrame: null, revision: 0, problem: null };
const EMPTY_SLOT: Slot = Object.freeze({ composer: EMPTY_COMPOSER, open: null, marks: NO_MARKS, op: null, spent: false, notice: null });

export function effectiveMarks(marks: StoredMarks, clock: object | null): { value: NoteMarks; touched: boolean } {
  return marks.clock !== null && marks.clock === clock ? marks : { value: marks.seed, touched: false };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

function composerProblem(error: unknown): Problem {
  const classified = classifyVideoNoteError(error);
  switch (classified.kind) {
    case "network": return { text: "Couldn't reach the server. Your note may or may not have posted — refresh the notes to check, then post again if it isn't there.", refresh: true };
    case "range": return { text: `That frame is outside this film${classified.frameCount ? ` (the last frame is ${classified.frameCount - 1})` : ""}.` };
    case "archived": return { text: "This Project was archived, so the note was not posted. Your draft is kept." };
    case "access": return { text: messageOf(error, "You no longer have access to this Project.") };
    default: return { text: messageOf(error, "The note could not be posted.") };
  }
}

/** What a refused write says, and (for a 409) the server's current note and (when it is gone) that the note is. */
export function writeFailure(error: unknown, fallback: string, noteId = ""): { problem: Problem; conflict?: VideoNoteDto; gone?: boolean } {
  const classified = classifyVideoNoteError(error);
  switch (classified.kind) {
    case "conflict": {
      const current = classified.thread && [classified.thread, ...classified.thread.replies].find((candidate) => candidate.id === noteId);
      if (current) return { problem: { text: "This note changed since you opened it. Its current text is shown below; Save anyway replaces it with your edit." }, conflict: current };
      break;
    }
    case "deleted": return { problem: { text: "This note was deleted." }, gone: true };
    case "gone": return { problem: { text: "This note no longer exists." }, gone: true };
    case "network": return { problem: { text: "Couldn't reach the server. The change may or may not have gone through — refresh the notes to check.", refresh: true } };
    case "archived": return { problem: { text: "This Project was archived, so nothing was changed." } };
    case "access": return { problem: { text: messageOf(error, "You no longer have access to this Project.") } };
    case "range": return { problem: { text: "Those frames are outside this film." } };
    default: break;
  }
  return { problem: { text: messageOf(error, fallback) } };
}

/** Whether leaving the form would lose something: an edit's text or frames changed, a reply or composer with text. */
const isDirty = (slot: Slot) => (slot.open ? (slot.open.kind === "reply" ? slot.open.text !== "" : slot.open.text !== slot.open.base.body || slot.marks.touched) : slot.composer.body !== "");

export function createNoteFormStore(key: string) {
  const slots = new Map<string, Slot>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let dead = false;
  const slot = (assetId: string): Slot => slots.get(assetId) ?? EMPTY_SLOT;
  const put = (assetId: string, patch: Partial<Slot>) => {
    if (dead) return;
    slots.set(assetId, { ...slot(assetId), ...patch });
    listeners.forEach((listener) => { listener(); });
  };
  const owns = (assetId: string, op: Op) => slot(assetId).op?.id === op.id;

  const close = (assetId: string) => { if (slot(assetId).open) put(assetId, { open: null, marks: NO_MARKS, spent: false }); };
  const cancelConfirmation = (assetId: string) => { if (slot(assetId).op?.phase === "confirming") put(assetId, { op: null }); };

  function open(assetId: string, form: Omit<OpenForm, "revision" | "conflict" | "problem">, seed: NoteMarks): boolean {
    if (slot(assetId).op?.phase === "posting") return false;
    put(assetId, { op: null, open: { ...form, revision: 0, conflict: null, problem: null }, marks: { ...NO_MARKS, value: seed, seed }, spent: false, notice: null });
    return true;
  }

  function takeMark(assetId: string, clock: object, change: (marks: NoteMarks) => NoteMarks) {
    const held = slot(assetId);
    if (held.op || (held.open && !held.open.frames)) return;
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
    if (root?.deleted && (form.kind === "reply" || form.noteId === root.id)) { put(assetId, { open: null, marks: NO_MARKS, spent: false, notice: { text: "This note was deleted.", rootId: root.id } }); return; }
    if (!root) { put(assetId, { open: null, marks: NO_MARKS, spent: false, notice: { text: "This note no longer exists.", rootId: form.rootId } }); return; }
    if (form.kind === "edit" && form.noteId !== root.id && !root.replies.some((reply) => reply.id === form.noteId)) close(assetId);
  }

  /** An edit or a reply goes out. It is never cancelled once sent; its result closes the form only if the same operation still owns it. */
  async function submitOpen(assetId: string, form: OpenForm, run: () => Promise<unknown>, fallback: string) {
    const op: Op = { id: ++seq, form: "open", phase: "posting", revision: form.revision };
    put(assetId, { op, open: { ...form, problem: null }, notice: null });
    try { await run(); } catch (error) {
      if (!owns(assetId, op)) return;
      const failure = writeFailure(error, fallback, form.noteId);
      const current = slot(assetId).open;
      if (failure.gone) put(assetId, { op: null, open: null, marks: NO_MARKS, spent: false, notice: { ...failure.problem, rootId: form.rootId } });
      else { put(assetId, { op: null, open: current && { ...current, problem: failure.problem, ...(failure.conflict ? { conflict: failure.conflict } : {}) } }); reconcile(assetId); }
      return;
    }
    if (!owns(assetId, op)) return;
    const current = slot(assetId).open;
    put(assetId, { op: null, ...(current?.noteId === form.noteId && current.kind === form.kind ? { open: null, marks: NO_MARKS, spent: false } : {}) });
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
      return open(assetId, { kind: "edit", noteId: note.id, rootId, text: note.body, base: { revision: note.revision, body: note.body, startFrame: note.startFrame, endFrame: note.endFrame }, frames }, seed);
    },
    openReply: (assetId: string, rootId: string): boolean => open(assetId, { kind: "reply", noteId: rootId, rootId, text: "", base: { revision: 0, body: "", startFrame: null, endFrame: null }, frames: false }, EMPTY_MARKS),
    close,
    setOpenText(assetId: string, text: string) {
      const form = slot(assetId).open;
      if (form) put(assetId, { open: { ...form, text, revision: form.revision + 1 }, spent: false });
    },

    mark: (assetId: string, kind: "in" | "out", frame: number, clock: object) => { takeMark(assetId, clock, (marks) => markFrame(marks, kind, frame)); },
    makePoint: (assetId: string, clock: object) => { takeMark(assetId, clock, (marks) => ({ in: marks.in ?? marks.out, out: null })); },
    clearMarks(assetId: string) { const held = slot(assetId); if (!held.op) put(assetId, { marks: { ...NO_MARKS, seed: held.marks.seed }, spent: false }); },

    /** Pause, seek to the range start or the frozen anchor, confirm exactly that frame (10 s at most), then send. Cancelling the confirmation invalidates the operation before it can send. */
    async post(assetId: string, { clock, frameCount, send }: { clock: NoteClock; frameCount: number; send: (input: VideoNoteCreateInput) => Promise<unknown> }) {
      const held = slot(assetId);
      const draft = held.composer;
      const text = draft.body.trim();
      if (held.op || held.open || !text) return;
      const marked = marksToFrames(effectiveMarks(held.marks, clock).value, frameCount);
      const anchor = marked ? marked.startFrame : Math.min(Math.max(0, draft.anchorFrame ?? frameOnScreen(clock.getState())), Math.max(0, frameCount - 1));
      const op: Op = { id: ++seq, form: "composer", phase: "confirming", revision: draft.revision };
      put(assetId, { op, composer: { ...draft, problem: null } });
      const stop = (problem: Problem | null) => { if (owns(assetId, op)) put(assetId, { op: null, composer: { ...slot(assetId).composer, problem } }); };
      clock.seekToFrame(anchor);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { resolve("timeout"); }, FRAME_CONFIRM_TIMEOUT_MS); });
      let confirmed: number | "timeout";
      try { confirmed = await Promise.race([clock.awaitConfirmedFrame(), timedOut]); }
      catch (error) { stop(isAbort(error) ? null : { text: "The frame could not be confirmed. Your draft is kept.", retry: true }); return; }
      finally { clearTimeout(timer); }
      if (!owns(assetId, op)) return;
      if (confirmed === "timeout") return stop({ text: "The frame took too long to show. Your draft is kept.", retry: true });
      // The frame on screen must be the one the note was composed at: a scrub or a step that landed first moved it.
      if (confirmed !== anchor) return stop({ text: "Frame moved — Post again" });
      put(assetId, { op: { ...op, phase: "posting" } });
      const frames = marked ?? { startFrame: anchor, endFrame: null };
      try { await send({ startFrame: frames.startFrame, ...(frames.endFrame !== null ? { endFrame: frames.endFrame } : {}), visibility: draft.visibility, body: text }); }
      catch (error) { stop(composerProblem(error)); return; }
      if (!owns(assetId, op)) return;
      const now = slot(assetId).composer;
      put(assetId, { op: null, marks: NO_MARKS, composer: now.revision === op.revision ? { ...EMPTY_COMPOSER, revision: now.revision + 1 } : now });
    },

    /** Sends the revision the form was opened with (or, after a reviewed conflict, the server's) and only what changed; frames only after a frame action since opening. Never seeks. */
    async save(assetId: string, { clock, frameCount, send }: { clock: object | null; frameCount: number; send: (noteId: string, input: VideoNoteEditInput) => Promise<unknown> }) {
      const held = slot(assetId);
      const form = held.open;
      const text = form?.text.trim();
      if (!form || form.kind !== "edit" || held.op || !text) return;
      const against = form.conflict ?? form.base;
      const input: { expectedRevision: number; body?: string; startFrame?: number; endFrame?: number | null } = { expectedRevision: against.revision };
      if (text !== against.body) input.body = text;
      const marks = effectiveMarks(held.marks, clock);
      const frames = form.frames && marks.touched ? marksToFrames(marks.value, frameCount) : null;
      if (frames && (frames.startFrame !== against.startFrame || frames.endFrame !== against.endFrame)) { input.startFrame = frames.startFrame; input.endFrame = frames.endFrame; }
      if (input.body === undefined && input.startFrame === undefined) { close(assetId); return; }
      await submitOpen(assetId, form, () => send(form.noteId, input as VideoNoteEditInput), "The note could not be saved.");
    },
    async reply(assetId: string, { send }: { send: (rootId: string, body: string) => Promise<unknown> }) {
      const held = slot(assetId);
      const form = held.open;
      const text = form?.text.trim();
      if (!form || form.kind !== "reply" || held.op || !text) return;
      await submitOpen(assetId, form, () => send(form.rootId, text), "The reply could not be posted.");
    },

    cancelConfirmation,
    /** The first Escape of a dirty form is held (the text stays); the next one is not. A clean edit or reply closes. Nothing here moves focus: the answer says where it should go. */
    escape(assetId: string, { focusInForm }: { focusInForm: boolean }): { consumed: boolean; focus: "dialog" | "textarea" | "opener" | null } {
      const held = slot(assetId);
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
    },
    /** Dismisses the notice a closed form left behind. */
    dismissNotice(assetId: string) { if (slot(assetId).notice) put(assetId, { notice: null }); },
    rearm(assetId: string) { if (slot(assetId).spent) put(assetId, { spent: false }); },
    /** The open form's note left the Version's full list (deleted elsewhere): the form goes, unless its own request is out (it is reconciled again when that settles). */
    retireMissing(assetId: string, threads: readonly VideoNoteThreadDto[]) { latest.set(assetId, threads); reconcile(assetId); },

    /** The person's session ended: every frame confirmation stops. A request already sent is never touched. */
    cancelAll() { for (const assetId of [...slots.keys()]) cancelConfirmation(assetId); },
    /** This store is being replaced (another person or Project): nothing it started may write or send again. */
    retire() { dead = true; slots.clear(); listeners.clear(); },
  };
}

export type NoteFormStore = ReturnType<typeof createNoteFormStore>;
