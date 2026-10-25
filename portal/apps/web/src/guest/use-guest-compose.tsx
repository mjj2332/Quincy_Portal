import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from "react";
import { STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, legacyBodyToRichTextDoc, type Box, type FreehandPoint, type GuestNoteCreateInput, type GuestNoteThreadDto, type MarkupItem, type RichTextDoc } from "@quincy/shared";
import { useFrameClockSelector, type FrameClockState, type VideoFrameClock } from "../lib/video-frame-clock";
import { useMarkup, type MarkupTool, type MarkupToolKind, type PointerSample } from "../lib/use-markup";
import { EMPTY_MARKS, markFrame, marksToFrames, type NoteMarks } from "../lib/video-note-marks";
import { MarkupLayer, StrokeVisible } from "../components/quincy/freehand-strokes";
import { composeInput, editPatch, noteText, type EditBaseline, type EditPatch } from "./guest-compose";

const LIMITS = { items: STROKE_LIMITS.strokes, bytes: VIDEO_MARKUP_MAX_BYTES };
const NO_ITEMS: MarkupItem[] = [];
const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };
/** The document a saved note stands for: its rich content, or its plain text as one paragraph. */
const docOf = (thread: Pick<GuestNoteThreadDto, "content" | "body">): RichTextDoc => thread.content ?? legacyBodyToRichTextDoc(thread.body);
/** New strokes are drawn at the middle width (#927: the stroke width is fixed, so the drawing row has no width control). */
const PEN: MarkupTool = { kind: "freehand", color: "#e64b3c", width: 4 };
const FRAME_CONFIRM_TIMEOUT_MS = 10_000;
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** The box's editable, inside the composer's field host: the real editor's contenteditable, or a test's textarea. */
const PILL_FIELD = '[contenteditable="true"], textarea';
/** How long a focus asked for before the field exists (the editor chunk still loading) waits for it (#879 PR 2). */
const FOCUS_WAIT_MS = 5000;

/** What the post came to: `message` is what to tell the guest, or null when the answer is not for this composer any more (a stale one). */
export type PostOutcome = { ok: true } | { ok: false; message: string | null; saved?: boolean; conflict?: GuestNoteThreadDto };

const frameOnScreen = (state: Pick<FrameClockState, "playing" | "frame" | "targetFrame">): number => (state.playing ? state.frame : (state.targetFrame ?? state.frame));
const pointOf = (rect: DOMRect, event: PointerSample): FreehandPoint => ({
  x: Math.max(0, Math.min(1, Number(((event.clientX - rect.left) / rect.width).toFixed(4)))),
  y: Math.max(0, Math.min(1, Number(((event.clientY - rect.top) / rect.height).toFixed(4)))),
});
const overPicture = (rect: DOMRect, event: PointerSample): boolean => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;

async function confirmedFrame(clock: VideoFrameClock): Promise<number | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { resolve("timeout"); }, FRAME_CONFIRM_TIMEOUT_MS); });
  try { return await Promise.race([clock.awaitConfirmedFrame(), timedOut]); } finally { clearTimeout(timer); }
}

/** The drawing row's model (`quincy/NoteDrawRow`, #927 C6 / P4): the pen, its history, and ‹ Done. */
export type GuestDrawRow = {
  tool: MarkupToolKind; color: string;
  onToolChange: (kind: MarkupToolKind) => void; onColorChange: (color: string) => void;
  canUndo: boolean; canRedo: boolean; canClear: boolean;
  onUndo: () => void; onRedo: () => void;
  /** Clears the strokes and, in an edit, the note's saved drawing too (#927: Clear is how a drawing comes off). */
  onClear: () => void;
  onDone: () => void;
};

/**
 * The guest's draft as the note box (`GuestNoteComposer`, #927 G1 / E1 / P1–P5) renders it, and the commands it sends. The state stays in the hook, so it survives the 721px
 * crossing, Full screen, and the box moving between the rail and the phone sheet.
 */
export type GuestStrip = {
  /** A draft is open (a new note or an edit). */
  open: boolean;
  /** The open draft is an edit of the guest's own root note. */
  editing: boolean;
  doc: RichTextDoc;
  /** The field's changes. The first text opens a draft if none is, and fixes a following anchor on the frame on screen (#927). */
  setDoc: (doc: RichTextDoc) => void;
  /** An upload starting is the note starting, as the first text is. */
  setUploading: (uploading: boolean) => void;
  /** How many files failed to upload (#956): Post / Save wait until each is retried or removed, so the note never goes out missing one. */
  failedFiles: number;
  setFailedFiles: (failed: number) => void;
  pending: boolean; problem: string | null;
  /** Nothing to post (no text and no media): Send is disabled (#927 D2: a drawing alone is not a note). */
  empty: boolean; uploading: boolean;
  /** The anchor still follows the film: no draft, or a new one nothing has been put into (#927: the chip follows the playhead until the note starts). */
  following: boolean;
  /** The marks as frames (null with none); `rangeMarks` are the in / out marks the guest made, as the box's one button reads them (none for a point). */
  frames: { startFrame: number; endFrame: number | null } | null; rangeMarks: NoteMarks;
  marksLocked: boolean;
  /** Why the frames cannot change in an edit (the drawing), or why the pen is locked (new frames not saved yet), or null. */
  lockHint: string | null;
  /** The note's latest saved text after a conflict, or null. */
  latest: string | null;
  /** Strokes drawn in this draft; the edited note's drawing kept. */
  strokes: number; keptDrawing: boolean;
  /** The pen is down (on the picture, or confirming its frame first). */
  penDown: boolean; canDraw: boolean; penDisabled: boolean;
  /** The draft is as much drawing as one note can hold. */
  refused: boolean;
  /** The drawing row while the pen is down, else null. */
  draw: GuestDrawRow | null;
  clockReady: boolean;
  /** Bumped by Cancel, and by a close from the page while a picture is going up: the field remounts, which aborts its uploads. */
  editorKey: number;
  /** A phone's field took the focus: pause, start a draft if none is open, and stamp a pristine one at the frame on screen (D10). */
  focusStamp: () => void;
  /** An untouched new draft is released at rest (a phone), so the chip follows the film again. */
  releaseIfPristine: () => void;
  /** The box's in/out button: In, then Out, at the frame on screen (a draft opens if none is). */
  mark: (kind: "in" | "out") => void;
  /** Its third press, and the chip's ×: the range goes back to a point at its In. */
  clearRange: () => void;
  /** The pen: puts the pen down (blurring the field first); a draft opens if none is. */
  pen: () => void;
  send: () => void; cancel: () => void;
  /** Where the field lives; `focusField` focuses it, or, while the chunk loads, as soon as it appears (5s at most). */
  fieldHost: RefCallback<HTMLElement>; focusField: () => void;
};

/** How the anchor of a new draft was fixed: not yet (it follows the film), by a phone's focus (D10), or by the note starting (text, media, a mark, a stroke). */
type Fixed = null | "focus" | "input";

/**
 * The guest's note composer (#741 13c, #927): the draft (body, in / out marks, an optional drawing) and the drawing layer on the picture. It is the guest twin of the staff
 * composer + `useVideoMarkup`, which are bound to the staff form store and `lib/api` and so cannot be imported here (`guest-boundary.guard.test.ts`); the pieces that are pure are
 * shared: `useMarkup` (pointer capture, undo / redo), the stroke renderer, `markFrame` / `marksToFrames`. The box itself is `quincy/NoteComposerBox`, through `GuestNoteComposer`.
 *
 * - A new draft follows the film until it starts (#927): the first text, the first upload, a mark or a stroke fixes it on the frame on screen. A phone keeps D10: its focus pauses
 *   and stamps. The box's one in/out button marks In, then Out, at the frame on screen; with only In marked, Out is the playhead, and a post takes the playhead as Out. The
 *   player's own I / O keys mark the same ends through `onMark` (`usePlayerKeys`), bound only while the marks can change.
 * - Drawing pauses the film and puts the pen on one frame, confirmed on screen first. A point note follows its drawing (the mark moves to the drawing's frame); a range note keeps its
 *   marks and draws on the frame on screen when that is inside them, else on its first frame. Anything the marks stop covering is caught by `composeInput` at post time, not guessed at.
 * - `post` runs the write; a failure keeps the draft and shows its message here. An answer only applies to the draft it was sent for: every reset (a new draft, a close, another Version) moves
 *   `opId` on, so an old completion cannot close or clear a newer draft.
 * - Editing (`beginEdit`) reuses the same draft for the guest's own ROOT note: body, frames and drawing, sending only what differs from where the edit began. The server refuses frames
 *   together with a drawing change, and frames on a note that has a drawing, so the two are never offered together (#927 D4: the one locks the other, with the reason as its title).
 *   A redraw starts from a blank page (the old strokes are not loaded); Clear takes the saved drawing off.
 * - `markupAllowed` is the Worker's `markup` part: with it off a note carrying a drawing, or a removal of one, is the stub, so no drawing control is shown.
 */
export function useGuestCompose({ clock, frameCount, markupAllowed, post, edit, latestOf, onDrawingChange }: {
  clock: VideoFrameClock | null;
  frameCount: number;
  markupAllowed: boolean;
  post: (input: GuestNoteCreateInput) => Promise<PostOutcome>;
  /** Saves the edit draft of the note `id`, sending `expectedRevision`: the revision the draft was opened on, or the one a conflict showed the guest (never the list's, which may have moved unseen). */
  edit: (id: string, patch: EditPatch, expectedRevision: number) => Promise<PostOutcome>;
  /** The note `id` as the page holds it now, for showing the latest version beside the draft, or null when it is gone. */
  latestOf: (id: string) => GuestNoteThreadDto | null;
  /** True while the pen is on the picture (the phone drawer must get out of its way), false when it is put down. */
  onDrawingChange?: (drawing: boolean) => void;
}): {
  isOpen: boolean; editingId: string | null;
  /** True while the draft of an edit stands in for the saved drawing of the note `id` (a redraw is under way, drawn, or the drawing is being removed), so the saved strokes must not show under it. */
  replacesSavedDrawing: (id: string | null) => boolean;
  /** The pen is on the picture. */
  drawing: boolean;
  /** The pen is down: on the picture, or confirming its frame first (the phone sheet's draw mode, #879 PR 2). */
  penDown: boolean;
  /** The box's draft and commands. */
  strip: GuestStrip;
  /** Puts the pen down (also from `confirming`: a late confirmation then does nothing); the strokes stay in the draft. Social preview (#872) ends a drawing this way on entry. */
  endDrawing: () => void;
  begin: () => void; beginEdit: (thread: GuestNoteThreadDto) => void; close: () => void; overlay: (box: Box | null) => ReactNode;
  /** The player's I / O marks (a draft opens if none is), or undefined while the marks cannot change (locked by a drawing, drawing in progress, or posting). */
  onMark: ((kind: "in" | "out", frame: number) => void) | undefined;
  /** The draft's marks, for the player's handles (#861), and the Clear they offer (back to a point). Both inert while `onMark` is. */
  marks: NoteMarks;
} {
  const [isOpen, setOpen] = useState(false);
  const [doc, setDoc] = useState<RichTextDoc>(EMPTY_DOC);
  // A picture still going up holds Post / Save: the note would go without it.
  const [uploading, setUploading] = useState(false);
  const [failedFiles, setFailedFiles] = useState(0);
  const [marks, setMarksState] = useState<NoteMarks>(EMPTY_MARKS);
  const [items, setItems] = useState<MarkupItem[]>(NO_ITEMS);
  const [drawFrame, setDrawFrame] = useState<number | null>(null);
  const [phase, setPhase] = useState<"off" | "confirming" | "drawing">("off");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pen, setPen] = useState<MarkupTool>(PEN);
  const [refusedFor, setRefusedFor] = useState<readonly MarkupItem[] | null>(null);
  const [target, setTarget] = useState<{ id: string; baseline: EditBaseline; baseRevision: number; ackRevision: number | null } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  // The marks, how a new draft's anchor was fixed, and whether its In is a mark the guest made (a range under way) rather than the point it is stamped at. Each has a ref beside
  // it, for the commands that run twice in one tap (a draft opening, then a mark) before React has rendered.
  const marksRef = useRef<NoteMarks>(EMPTY_MARKS);
  const setMarks = useCallback((next: NoteMarks) => { marksRef.current = next; setMarksState(next); }, []);
  const [fixed, setFixedState] = useState<Fixed>(null);
  const fixedRef = useRef<Fixed>(null);
  const setFixed = useCallback((next: Fixed) => { fixedRef.current = next; setFixedState(next); }, []);
  const [inMarked, setInMarkedState] = useState(false);
  const inMarkedRef = useRef(false);
  const setInMarked = useCallback((next: boolean) => { inMarkedRef.current = next; setInMarkedState(next); }, []);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const opId = useRef(0);
  // Owns a drawing confirmation only. Post / Save own `opId`; ending a drawing (Social preview, #872) must never discard a submission's answer.
  const drawOp = useRef(0);
  // The frame the drawing history was built on; it survives the off / confirming phases so a later start on another frame can tell.
  const drawingFor = useRef<number | null>(null);

  // The box's field: focused inside the tap that asks for it (iOS raises the keyboard only then), or, while the editor chunk is still loading, as soon as it appears.
  // A scoped wait on the field's own node, not a page-wide poll; the next ask, or unmounting, ends it.
  const fieldHostRef = useRef<HTMLElement | null>(null);
  const focusWait = useRef<(() => void) | null>(null);
  const fieldHost = useCallback<RefCallback<HTMLElement>>((element) => { fieldHostRef.current = element; }, []);
  const focusField = useCallback(() => {
    focusWait.current?.();
    const find = () => fieldHostRef.current?.querySelector<HTMLElement>(PILL_FIELD) ?? null;
    const now = find();
    if (now) { now.focus({ preventScroll: true }); return; }
    const host = fieldHostRef.current;
    if (!host) return;
    const watch = new MutationObserver(() => { const found = find(); if (found) { stop(); found.focus({ preventScroll: true }); } });
    const timer = setTimeout(() => { stop(); }, FOCUS_WAIT_MS);
    const stop = () => { watch.disconnect(); clearTimeout(timer); if (focusWait.current === stop) focusWait.current = null; };
    watch.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable"] });
    focusWait.current = stop;
  }, []);
  useEffect(() => () => { focusWait.current?.(); }, []);

  const playing = useFrameClockSelector(clock, (state) => state.playing, false);
  const frameNow = useFrameClockSelector(clock, (state) => (state.targetFrame === null ? state.frame : -1), -1);
  const drawing = phase === "drawing";
  const here = useCallback(() => (clock ? frameOnScreen(clock.getState()) : 0), [clock]);
  // What a command inside the same tap must see before React has rendered (⋯ Edit focuses the field in its click, #879 PR 2; the first keystroke opens the draft): whether a draft
  // is open, and whether it is an edit.
  const live = useRef({ open: false, editing: false });
  live.current = { open: isOpen, editing: target !== null };

  // `useMarkup` is called below (it needs `items`), so `reset` reaches its history through a ref.
  const resetHistoryRef = useRef<() => void>(() => undefined);
  const reset = useCallback(() => {
    opId.current += 1; drawOp.current += 1;
    resetHistoryRef.current(); // a new draft starts with no undo / redo steps from the last one
    setDoc(EMPTY_DOC); setUploading(false); setFailedFiles(0); setMarks(EMPTY_MARKS); setItems(NO_ITEMS); setDrawFrame(null); setPhase("off"); setProblem(null); setPending(false); setRefusedFor(null); setTarget(null); setRemoved(false); drawingFor.current = null;
    setFixed(null); setInMarked(false);
  }, [setMarks, setFixed, setInMarked]);
  const begin = useCallback(() => { reset(); setMarks({ in: here(), out: null }); setOpen(true); live.current = { open: true, editing: false }; }, [reset, here, setMarks]);
  const beginEdit = useCallback((thread: GuestNoteThreadDto) => {
    if (thread.startFrame === null) return;
    reset();
    setTarget({ id: thread.id, baseRevision: thread.revision, ackRevision: null, baseline: { doc: docOf(thread), startFrame: thread.startFrame, endFrame: thread.endFrame, hadDrawing: thread.hasMarkup } });
    setDoc(docOf(thread));
    setMarks({ in: thread.startFrame, out: thread.endFrame === null ? null : thread.endFrame - 1 });
    setFixed("input"); setInMarked(thread.endFrame !== null);
    setOpen(true);
    live.current = { open: true, editing: true };
  }, [reset, setMarks, setFixed, setInMarked]);
  const close = useCallback(() => { reset(); setOpen(false); live.current = { open: false, editing: false }; }, [reset]);
  // The page closes the draft from outside (another Version, the project archived, the edited note gone). The box keeps its field mounted across that, and the field's
  // uploads abort only when it unmounts: a picture still going up would land in whatever draft the field holds when it arrives, another Version's included (fix round 5). So a
  // close with an upload under way remounts the field, as Cancel does; without one the field stays (the page closes on mount too, and nothing is in flight then).
  const uploadingNow = useRef(false);
  uploadingNow.current = uploading;
  const closeFromPage = useCallback(() => { const inFlight = uploadingNow.current; close(); if (inFlight) setEditorKey((key) => key + 1); }, [close]);

  /** The note starts (#927): a new draft that still follows the film is fixed on the frame on screen. A mark, an edit and a phone's focus have fixed it already. */
  const startNote = useCallback(() => {
    if (live.current.editing || fixedRef.current === "input") return;
    if (fixedRef.current === null && !inMarkedRef.current && marksRef.current.out === null) setMarks({ in: here(), out: null });
    setFixed("input");
  }, [here, setMarks, setFixed]);
  /** A mark the guest made, at `frame`. A draft that still follows the film has no mark yet: its stamp is not an In. A point's stamp under a first Out is the range's start, as the shipped I / O keys did. */
  const markAt = useCallback((kind: "in" | "out", frame: number) => {
    const following = !live.current.editing && fixedRef.current === null && !inMarkedRef.current;
    const next = markFrame(following ? EMPTY_MARKS : marksRef.current, kind, frame);
    setMarks(next);
    setInMarked(next.in !== null && (kind === "in" || inMarkedRef.current || next.out !== null));
    setFixed("input");
  }, [setMarks, setFixed, setInMarked]);

  const toPoint = useCallback((event: PointerSample): FreehandPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? pointOf(rect, event) : { x: Number.NaN, y: Number.NaN };
  }, []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const markup = useMarkup({ enabled: drawing, tool: pen, toPoint, strokes: items, setStrokes: setItems, limits: LIMITS, onRefuse: () => { setRefusedFor(itemsRef.current); } });
  const refused = refusedFor !== null && refusedFor === items;

  // Only the primary pointer's main button draws, and a captured pointer that wanders into a letterbox band ends the stroke at the last point inside the picture.
  const { onPointerDown, onPointerMove, onPointerUp, onPointerLeave } = markup.handlers;
  const handlers = {
    ...markup.handlers,
    onPointerDown: (event: ReactPointerEvent<Element>) => { if (!event.isPrimary || event.button !== 0) return; return onPointerDown(event); },
    onPointerMove: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerMove(event); },
    onPointerUp: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerUp(event); },
  };

  // A drawing has exactly one frame, and an undo step restores strokes without one: starting on a different frame than the history was built on drops its steps.
  const { resetHistory } = markup;
  resetHistoryRef.current = resetHistory;
  useEffect(() => {
    if (!drawing || drawFrame === null) return;
    if (drawingFor.current !== null && drawingFor.current !== drawFrame) resetHistory();
    drawingFor.current = drawFrame;
  }, [drawing, drawFrame, resetHistory]);

  // Nothing may move the frame under the pen: if playback starts or the frame changes anyway, drawing ends and the strokes stay.
  const offFrame = drawing && (playing || frameNow !== drawFrame);
  useEffect(() => { if (offFrame) setPhase("off"); }, [offFrame]);

  const lastDrawing = useRef(false);
  useEffect(() => { if (lastDrawing.current !== drawing) { lastDrawing.current = drawing; onDrawingChange?.(drawing); } }, [drawing, onDrawingChange]);

  // Escape puts the pen down; Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes, outside text fields. (Escape inside the box is the box's own, and ends drawing there.)
  const { undo, redo, canUndo, canRedo } = markup;
  useEffect(() => {
    if (!drawing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.defaultPrevented) return;
      const field = event.target instanceof Element && event.target.closest(FIELD) !== null;
      if (event.key === "Escape" && !field) { setPhase("off"); return; }
      if (field || !(event.metaKey || event.ctrlKey)) return;
      const letter = event.key.toLowerCase();
      if ((letter === "z" && event.shiftKey) || (letter === "y" && event.ctrlKey && !event.metaKey)) { if (canRedo) { event.preventDefault(); redo(); } return; }
      if (letter === "z" && !event.shiftKey && canUndo) { event.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [drawing, canUndo, canRedo, undo, redo]);

  const endDrawing = useCallback(() => { drawOp.current += 1; setPhase("off"); }, []);
  const startDrawing = async () => {
    if (!clock || phase !== "off" || pending) return;
    clock.pause();
    const onScreen = frameOnScreen(clock.getState());
    const current = marksRef.current;
    const frames = marksToFrames(current, frameCount);
    const ranging = inMarkedRef.current && current.in !== null && current.out === null;
    let frame = onScreen;
    if (items.length > 0 && drawFrame !== null) frame = drawFrame;
    else if (live.current.editing && frames !== null) frame = frames.endFrame === null || onScreen < frames.startFrame || onScreen >= frames.endFrame ? frames.startFrame : onScreen; // an edit never moves the frames
    else if (ranging) frame = Math.max(onScreen, current.in!); // only In marked, Out is the playhead: the drawing stays inside the range
    else if (current.out === null) setMarks({ in: onScreen, out: null }); // a point note follows its drawing
    else if (frames !== null && frames.endFrame !== null && (onScreen < frames.startFrame || onScreen >= frames.endFrame)) frame = frames.startFrame;
    if (!live.current.editing) setFixed("input");
    setProblem(null); setPhase("confirming");
    const mine = ++drawOp.current;
    clock.seekToFrame(frame);
    let landed: number | "timeout";
    try { landed = await confirmedFrame(clock); } catch { if (drawOp.current === mine) { setPhase("off"); setProblem("The frame could not be confirmed. Try Draw again."); } return; }
    if (drawOp.current !== mine) return;
    if (landed === "timeout") { setPhase("off"); setProblem("The frame took too long to show. Try Draw again."); return; }
    if (landed !== frame) { setPhase("off"); setProblem("The frame moved. Press Draw again."); return; }
    setDrawFrame(frame);
    setPhase("drawing");
  };

  // With only In marked, Out is the playhead (the chip shows it live): a post takes the frame on screen as Out, or is a point at In when the film never left it.
  const sentMarks = (): NoteMarks => (inMarked && marks.in !== null && marks.out === null && here() > marks.in ? { in: marks.in, out: here() } : marks);
  const submit = async () => {
    if (pending || phase !== "off" || uploading || failedFiles > 0) return;
    let send: () => Promise<PostOutcome>;
    if (target === null) {
      const built = composeInput({ doc, marks: sentMarks(), frameCount, items, drawingFrame: drawFrame });
      if (!built.ok) { setProblem(built.problem); return; }
      send = () => post(built.input);
    } else {
      const built = editPatch({ doc, marks: sentMarks(), frameCount, items, drawingFrame: drawFrame, drawingRemoved: removed, baseline: target.baseline });
      if (!built.ok) { setProblem(built.problem); return; }
      if (built.patch === null) { close(); return; }
      const { patch } = built;
      const expected = target.ackRevision ?? target.baseRevision;
      send = () => edit(target.id, patch, expected);
    }
    const mine = ++opId.current;
    setPending(true); setProblem(null);
    const outcome = await send();
    // Anything that reset the draft meanwhile (another Version, a new draft, a close) owns the composer now; this answer is not for it.
    if (opId.current !== mine) return;
    if (outcome.ok) { close(); return; }
    setPending(false);
    // A conflict showed the guest the latest version: saving again is their acknowledgement, so the base moves to it (and only then).
    if (outcome.conflict !== undefined) { const shown = outcome.conflict.revision; setTarget((current) => (current === null ? current : { ...current, ackRevision: shown })); }
    if (outcome.message !== null) setProblem(outcome.message);
  };

  const frames = marksToFrames(marks, frameCount);
  const hadDrawing = target?.baseline.hadDrawing ?? false;
  const framesChanged = target !== null && frames !== null && (frames.startFrame !== target.baseline.startFrame || frames.endFrame !== target.baseline.endFrame);
  const marksLocked = target !== null && (hadDrawing || items.length > 0);
  // The box is always there (#927), so I and O mark as its button does, opening a draft when none is open; the host binds them only for a guest who can write.
  const marksOpen = !marksLocked && !pending && phase === "off";
  const onMark = useMemo(() => (marksOpen ? (kind: "in" | "out", frame: number) => { if (!live.current.open) begin(); markAt(kind, frame); } : undefined), [marksOpen, markAt, begin]);

  /** Back to a point at the range's start: an edit keeps a frame, and a new draft keeps its anchor (the note has started). */
  const clearRange = useCallback(() => { const current = marksRef.current; setMarks({ in: current.in ?? current.out, out: null }); setInMarked(false); }, [setMarks, setInMarked]);

  const showsDraft = drawing || (isOpen && items.length > 0 && drawFrame !== null && !playing && frameNow === drawFrame);
  const overlay = useCallback((box: Box | null): ReactNode => {
    if (!isOpen || box === null || !showsDraft) return null;
    return <DraftSurface box={box} svgRef={svgRef} drawing={drawing} handlers={handlers} cancel={markup.cancel}>
      {items.map((item, index) => <StrokeVisible key={index} stroke={item} opacity={1} testId="guest-draft-stroke" pixelDots />)}
      {drawing && markup.active && <StrokeVisible stroke={markup.active} opacity={1} testId="guest-draft-stroke" pixelDots />}
    </DraftSurface>;
  }, [isOpen, showsDraft, drawing, items, markup.active, markup.cancel]); // eslint-disable-line react-hooks/exhaustive-deps -- `handlers` is rebuilt every render and reads only stable refs

  const latest = target === null ? null : latestOf(target.id);
  const keptDrawing = hadDrawing && !removed && items.length === 0;
  const hint = target === null ? null
    : hadDrawing ? (markupAllowed ? "The frames can't change while the note has a drawing. Clear the drawing and save, then change the frames." : "The frames can't change while the note has a drawing.")
    : items.length > 0 ? "The frames are fixed while the note has a new drawing. Save, then change the frames."
    : framesChanged && markupAllowed ? "Save the new frames before you draw."
    : null;

  const empty = noteText(doc) === "";
  // Pristine: a new draft nothing has been put into, which a phone's blur gives back. A phone's focus stamp alone does not count.
  const pristine = isOpen && target === null && empty && marks.out === null && !inMarked && items.length === 0 && phase === "off" && !pending && problem === null && !uploading && failedFiles === 0;
  const penDown = phase !== "off";
  const draw: GuestDrawRow | null = penDown ? {
    tool: pen.kind, color: pen.color,
    onToolChange: (kind) => { setPen((current) => ({ ...current, kind })); },
    onColorChange: (color) => { setPen((current) => ({ ...current, color })); },
    canUndo: markup.canUndo, canRedo: markup.canRedo, canClear: !pending && (items.length > 0 || keptDrawing),
    onUndo: markup.undo, onRedo: markup.redo,
    onClear: () => { if (pending) return; if (items.length > 0) markup.clear(); if (hadDrawing) setRemoved(true); },
    // ‹ (and Esc in the box) ends drawing with the strokes kept, and gives the field the focus back (a phone's keyboard comes back up, P4).
    onDone: () => { endDrawing(); focusField(); },
  } : null;
  const strip: GuestStrip = {
    open: isOpen, editing: target !== null, doc, pending, problem, empty, uploading,
    setDoc: (next) => {
      if (noteText(next) !== "") { if (!live.current.open) begin(); startNote(); }
      setDoc(next);
    },
    setUploading: (next) => {
      if (next) { if (!live.current.open) begin(); startNote(); }
      setUploading(next);
    },
    failedFiles, setFailedFiles,
    following: !isOpen || (target === null && fixed === null && !inMarked),
    frames, rangeMarks: inMarked || marks.out !== null ? marks : EMPTY_MARKS, marksLocked,
    lockHint: hint, latest: target !== null && latest !== null && latest.revision !== target.baseRevision ? latest.body : null,
    strokes: items.length, keptDrawing,
    penDown, canDraw: markupAllowed,
    penDisabled: pending || phase === "confirming" || (!drawing && (clock === null || framesChanged)),
    refused, draw,
    clockReady: clock !== null,
    editorKey,
    focusStamp: () => {
      clock?.pause();
      if (!live.current.open) { begin(); setFixed("focus"); return; }
      // A pristine new draft is stamped again at the frame on screen; once there is text (or an edit) the anchor is frozen (D10).
      if (!live.current.editing && pristine) { setMarks({ in: here(), out: null }); setFixed("focus"); }
    },
    releaseIfPristine: () => { if (pristine) close(); },
    mark: (kind) => {
      if (!clock || pending || phase !== "off") return;
      if (!live.current.open) begin();
      else if (marksLocked) return;
      markAt(kind, here());
    },
    clearRange: () => { if (!pending && !marksLocked) clearRange(); },
    pen: () => {
      if (drawing) { endDrawing(); focusField(); return; }
      if (phase !== "off") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
      if (!live.current.open) begin();
      void startDrawing();
    },
    send: () => { if (!empty) void submit(); },
    cancel: () => { if (pending) return; close(); setEditorKey((key) => key + 1); },
    fieldHost, focusField,
  };

  const editingId = isOpen && target !== null ? target.id : null;
  const replacing = editingId !== null && (items.length > 0 || phase !== "off" || removed);
  const replacesSavedDrawing = useCallback((id: string | null) => replacing && id === editingId, [replacing, editingId]);
  // `strip` is rebuilt every render (its commands read the draft as rendered); the composer is the one reader and re-renders with the hook's owner anyway.
  return { isOpen, editingId, drawing, penDown, strip, endDrawing, replacesSavedDrawing, begin, beginEdit, close: closeFromPage, overlay, onMark, marks };
}

/** The SVG on the picture box. A gesture never outlives draw mode or the picture it started on: leaving, or a resize, drops the stroke in progress and keeps the finished ones. */
function DraftSurface({ box, svgRef, drawing, handlers, cancel, children }: {
  box: Box; svgRef: RefObject<SVGSVGElement | null>; drawing: boolean; handlers: React.ComponentProps<typeof MarkupLayer>; cancel: () => void; children: ReactNode;
}) {
  useEffect(() => { cancel(); }, [cancel, drawing, box.left, box.top, box.width, box.height]);
  return <div data-testid="guest-draft" data-drawing={drawing ? "true" : "false"} className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
    <MarkupLayer
      ref={svgRef} aria-hidden="true" data-testid="guest-draft-layer" viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-hidden"
      style={{ pointerEvents: drawing ? "auto" : "none", cursor: drawing ? "crosshair" : "default", touchAction: drawing ? "none" : "auto" }}
      {...handlers}
    >
      {children}
    </MarkupLayer>
  </div>;
}
