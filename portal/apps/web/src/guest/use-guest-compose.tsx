import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from "react";
import { PencilIcon } from "lucide-react";
import { STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, legacyBodyToRichTextDoc, type Box, type FreehandPoint, type GuestNoteCreateInput, type GuestNoteThreadDto, type MarkupItem, type RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { useFrameClockSelector, type FrameClockState, type VideoFrameClock } from "../lib/video-frame-clock";
import { useMarkup, type MarkupTool, type PointerSample } from "../lib/use-markup";
import { EMPTY_MARKS, markFrame, marksToFrames, type NoteMarks } from "../lib/video-note-marks";
import { Button } from "../components/reui/button";
import { MarkupToolbar } from "../components/quincy/markup-toolbar";
import { MarkupLayer, StrokeVisible } from "../components/quincy/freehand-strokes";
import { composeInput, editPatch, noteText, type EditBaseline, type EditPatch } from "./guest-compose";
import { GuestNoteField } from "./GuestNoteField";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const LIMITS = { items: STROKE_LIMITS.strokes, bytes: VIDEO_MARKUP_MAX_BYTES };
const NO_ITEMS: MarkupItem[] = [];
const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };
/** The document a saved note stands for: its rich content, or its plain text as one paragraph. */
const docOf = (thread: Pick<GuestNoteThreadDto, "content" | "body">): RichTextDoc => thread.content ?? legacyBodyToRichTextDoc(thread.body);
const PEN: MarkupTool = { kind: "freehand", color: "#e64b3c", width: 4 };
const FRAME_CONFIRM_TIMEOUT_MS = 10_000;
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** The pill's editable, inside the strip's field host: the real editor's contenteditable, or a test's textarea. */
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

/**
 * The phone pill's draft as the strip (`GuestNoteComposer`, #879 PR 2) renders it, and the commands it sends. The state stays in the hook, so it survives the 721px crossing and the
 * desktop form reads the same draft.
 */
export type GuestStrip = {
  /** A draft is open (a new note or an edit). */
  open: boolean;
  /** The open draft is an edit of the guest's own root note. */
  editing: boolean;
  doc: RichTextDoc; setDoc: (doc: RichTextDoc) => void; setUploading: (uploading: boolean) => void;
  pending: boolean; problem: string | null;
  /** Nothing to post: Send is disabled on the phone (the staff phone rule). */
  empty: boolean; uploading: boolean;
  /** The marks as frames (null with none), and whether they are a range of two marks. */
  frames: { startFrame: number; endFrame: number | null } | null; ranged: boolean; marks: NoteMarks;
  marksLocked: boolean;
  /** Why the frames cannot change in an edit (the drawing), or null. */
  lockHint: string | null;
  /** The note's latest saved text after a conflict, or null. */
  latest: string | null;
  /** Strokes drawn in this draft; the edited note's drawing kept; its removal pending. */
  strokes: number; drawFrame: number | null; keptDrawing: boolean; drawingRemoved: boolean;
  /** The pen: on the picture or confirming its frame. */
  penDown: boolean; confirming: boolean; canDraw: boolean; drawLabel: string; penDisabled: boolean;
  clockReady: boolean;
  /** The + tray (an open tray is a compose hold). Opening it with no draft starts one. */
  tray: boolean; setTray: (open: boolean) => void;
  /** Bumped by Cancel: the field remounts, which aborts its uploads. */
  editorKey: number;
  /** The field took the focus: pause, start a draft if none is open, and stamp a pristine one at the frame on screen (D10). */
  focusStamp: () => void;
  /** An untouched new draft is released at rest, so the chip follows the film again. */
  releaseIfPristine: () => void;
  step: (delta: -1 | 1) => void; mark: (kind: "in" | "out") => void; clearMarks: () => void; removeDrawing: () => void;
  /** The pen in the pill: starts a drawing (blurring the field first), or, while drawing, is Done and gives the field the focus back. */
  pen: () => void;
  send: () => void; cancel: () => void;
  /** Where the field lives; `focusField` focuses it, or, while the chunk loads, as soon as it appears (5s at most). */
  fieldHost: RefCallback<HTMLElement>; focusField: () => void;
};

/**
 * The guest's note composer (#741 13c): the draft (body, in / out marks, an optional drawing), the form that edits it, and the drawing layer on the picture. It is the guest twin of the
 * staff composer + `useVideoMarkup`, which are bound to the staff form store and `lib/api` and so cannot be imported here (`guest-boundary.guard.test.ts`); the pieces that are pure are
 * shared: `useMarkup` (pointer capture, undo / redo), `MarkupToolbar`, the stroke renderer, `markFrame` / `marksToFrames`.
 *
 * - The note opens as a point at the frame on screen. "Mark in" / "Mark out" set the ends at the frame on screen; the player's own I / O keys do the same through `onMark`
 *   (`usePlayerKeys`, the hook the staff viewer uses), bound only while the marks can change.
 * - Drawing pauses the film and puts the pen on one frame, confirmed on screen first. A point note follows its drawing (the mark moves to the drawing's frame); a range note keeps its
 *   marks and draws on the frame on screen when that is inside them, else on its first frame. Anything the marks stop covering is caught by `composeInput` at post time, not guessed at.
 * - `post` runs the write; a failure keeps the draft and shows its message here. An answer only applies to the draft it was sent for: every reset (a new draft, a close, another Version) moves
 *   `opId` on, so an old completion cannot close or clear a newer draft.
 * - Editing (`beginEdit`) reuses the same draft for the guest's own ROOT note: body, frames and drawing, sending only what differs from where the edit began. The server refuses frames
 *   together with a drawing change, and frames on a note that has a drawing, so the two are never offered together. A redraw starts from a blank page (the old strokes are not loaded).
 * - `markupAllowed` is the Worker's `markup` part: with it off a note carrying a drawing, or a removal of one, is the stub, so no drawing control is shown.
 */
export function useGuestCompose({ phone, clock, frameCount, timecode, markupAllowed, media, post, edit, latestOf, onDrawingChange }: {
  /** The phone layout (`PHONE_QUERY`): the pill strip instead of the form, the compact markup toolbar. */
  phone: boolean;
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  markupAllowed: boolean;
  /** The note field's media routes (#835): the link's own, so a picture uploads and shows from there. */
  media: EditorMediaTransport;
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
  /** The phone pill's draft and commands (#879 PR 2). */
  strip: GuestStrip;
  /** Puts the pen down (also from `confirming`: a late confirmation then does nothing); the strokes stay in the draft. Social preview (#872) ends a drawing this way on entry. */
  endDrawing: () => void;
  begin: () => void; beginEdit: (thread: GuestNoteThreadDto) => void; close: () => void; form: ReactNode; overlay: (box: Box | null) => ReactNode; transportReplacement: ReactNode;
  /** The player's I / O marks, or undefined while the marks cannot change (no draft, locked by a drawing, drawing in progress, or posting). */
  onMark: ((kind: "in" | "out", frame: number) => void) | undefined;
  /** The draft's marks, for the player's range button and handles (#861), and the Clear they offer: an edit keeps a frame (a point), a new draft empties. Both inert while `onMark` is. */
  marks: NoteMarks; clearMarks: () => void;
} {
  const [isOpen, setOpen] = useState(false);
  const [doc, setDoc] = useState<RichTextDoc>(EMPTY_DOC);
  // A picture still going up holds Post / Save: the note would go without it.
  const [uploading, setUploading] = useState(false);
  const [marks, setMarks] = useState<NoteMarks>(EMPTY_MARKS);
  const [items, setItems] = useState<MarkupItem[]>(NO_ITEMS);
  const [drawFrame, setDrawFrame] = useState<number | null>(null);
  const [phase, setPhase] = useState<"off" | "confirming" | "drawing">("off");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pen, setPen] = useState<MarkupTool>(PEN);
  const [refusedFor, setRefusedFor] = useState<readonly MarkupItem[] | null>(null);
  const [target, setTarget] = useState<{ id: string; baseline: EditBaseline; baseRevision: number; ackRevision: number | null } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [tray, setTrayOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const opId = useRef(0);
  // Owns a drawing confirmation only. Post / Save own `opId`; ending a drawing (Social preview, #872) must never discard a submission's answer.
  const drawOp = useRef(0);
  // The frame the drawing history was built on; it survives the off / confirming phases so a later start on another frame can tell.
  const drawingFor = useRef<number | null>(null);

  // The pill's field (#879 PR 2): focused inside the tap that asks for it (iOS raises the keyboard only then), or, while the editor chunk is still loading, as soon as it appears.
  // A scoped wait on the strip's own node, not a page-wide poll; the next ask, or unmounting, ends it.
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
  // What a focus inside the same tap must see before React has rendered (⋯ Edit focuses the field in its click, #879 PR 2): whether a draft is open, and whether it is an edit.
  const live = useRef({ open: false, editing: false });
  live.current = { open: isOpen, editing: target !== null };

  // `useMarkup` is called below (it needs `items`), so `reset` reaches its history through a ref.
  const resetHistoryRef = useRef<() => void>(() => undefined);
  const reset = useCallback(() => {
    opId.current += 1; drawOp.current += 1;
    resetHistoryRef.current(); // a new draft starts with no undo / redo steps from the last one
    setDoc(EMPTY_DOC); setUploading(false); setMarks(EMPTY_MARKS); setItems(NO_ITEMS); setDrawFrame(null); setPhase("off"); setProblem(null); setPending(false); setRefusedFor(null); setTarget(null); setRemoved(false); setTrayOpen(false); drawingFor.current = null;
  }, []);
  const begin = useCallback(() => { reset(); setMarks({ in: here(), out: null }); setOpen(true); live.current = { open: true, editing: false }; }, [reset, here]);
  const beginEdit = useCallback((thread: GuestNoteThreadDto) => {
    if (thread.startFrame === null) return;
    reset();
    setTarget({ id: thread.id, baseRevision: thread.revision, ackRevision: null, baseline: { doc: docOf(thread), startFrame: thread.startFrame, endFrame: thread.endFrame, hadDrawing: thread.hasMarkup } });
    setDoc(docOf(thread));
    setMarks({ in: thread.startFrame, out: thread.endFrame === null ? null : thread.endFrame - 1 });
    setOpen(true);
    live.current = { open: true, editing: true };
  }, [reset]);
  const close = useCallback(() => { reset(); setOpen(false); live.current = { open: false, editing: false }; }, [reset]);

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

  // Escape puts the pen down; Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes, outside text fields.
  const { undo, redo, canUndo, canRedo } = markup;
  useEffect(() => {
    if (!drawing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey) return;
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
    const frames = marksToFrames(marks, frameCount);
    let frame = onScreen;
    if (items.length > 0 && drawFrame !== null) frame = drawFrame;
    else if (target !== null && frames !== null) frame = frames.endFrame === null || onScreen < frames.startFrame || onScreen >= frames.endFrame ? frames.startFrame : onScreen; // an edit never moves the frames
    else if (marks.out === null) setMarks({ in: onScreen, out: null }); // a point note follows its drawing
    else if (frames !== null && frames.endFrame !== null && (onScreen < frames.startFrame || onScreen >= frames.endFrame)) frame = frames.startFrame;
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

  const submit = async () => {
    if (pending || phase !== "off" || uploading) return;
    let send: () => Promise<PostOutcome>;
    if (target === null) {
      const built = composeInput({ doc, marks, frameCount, items, drawingFrame: drawFrame });
      if (!built.ok) { setProblem(built.problem); return; }
      send = () => post(built.input);
    } else {
      const built = editPatch({ doc, marks, frameCount, items, drawingFrame: drawFrame, drawingRemoved: removed, baseline: target.baseline });
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
  const marksOpen = isOpen && !marksLocked && !pending && phase === "off";
  const onMark = useMemo(() => (marksOpen ? (kind: "in" | "out", frame: number) => { setMarks((current) => markFrame(current, kind, frame)); } : undefined), [marksOpen]);

  const clearMarks = useMemo(() => (marksOpen ? () => { setMarks((current) => (target === null ? EMPTY_MARKS : { in: current.in ?? current.out, out: null })); } : () => undefined), [marksOpen, target]);

  const showsDraft = drawing || (isOpen && items.length > 0 && drawFrame !== null && !playing && frameNow === drawFrame);
  const overlay = useCallback((box: Box | null): ReactNode => {
    if (!isOpen || box === null || !showsDraft) return null;
    return <DraftSurface box={box} svgRef={svgRef} drawing={drawing} handlers={handlers} cancel={markup.cancel}>
      {items.map((item, index) => <StrokeVisible key={index} stroke={item} opacity={1} testId="guest-draft-stroke" pixelDots />)}
      {drawing && markup.active && <StrokeVisible stroke={markup.active} opacity={1} testId="guest-draft-stroke" pixelDots />}
    </DraftSurface>;
  }, [isOpen, showsDraft, drawing, items, markup.active, markup.cancel]); // eslint-disable-line react-hooks/exhaustive-deps -- `handlers` is rebuilt every render and reads only stable refs

  const transportReplacement = drawing
    ? <div className="flex min-w-0 flex-col items-center gap-[var(--space-1)]" data-testid="guest-markup-stack">
      {refused && <p role="status" className="m-0 text-foreground-secondary [font:var(--type-label)]">That is as much drawing as one note can hold. Undo a stroke to add more.</p>}
      <MarkupToolbar
        label={phone ? null : "Markup"} tool={pen} compact={phone} testId="guest-markup-toolbar"
        onToolChange={(kind) => { setPen((current) => ({ ...current, kind })); }}
        onColorChange={(color) => { setPen((current) => ({ ...current, color })); }}
        onWidthChange={(width) => { setPen((current) => ({ ...current, width })); }}
        canUndo={markup.canUndo} canRedo={markup.canRedo} canClear={items.length > 0}
        onUndo={markup.undo} onRedo={markup.redo} onClear={markup.clear}
        trailing={<Button type="button" data-testid="guest-markup-done" className={TOUCH} onClick={() => { setPhase("off"); if (phone) focusField(); }}>Done</Button>}
      />
    </div>
    : null;

  const anchor = marks.in !== null && marks.out !== null && frames?.endFrame != null ? `From ${timecode(frames.startFrame)} to ${timecode(frames.endFrame - 1)}` : frames === null ? "No frame marked" : `At ${timecode(frames.startFrame)}`;
  const latest = target === null ? null : latestOf(target.id);
  const keptDrawing = hadDrawing && !removed && items.length === 0;
  const hint = target === null ? null
    : hadDrawing ? (markupAllowed ? "The frames can't change while the note has a drawing. Remove the drawing and save, then change the frames." : "The frames can't change while the note has a drawing.")
    : items.length > 0 ? "The frames are fixed while the note has a new drawing. Save, then change the frames."
    : framesChanged && markupAllowed ? "Save the new frames before you draw."
    : null;
  const drawLabel = items.length > 0 ? "Edit drawing" : keptDrawing ? "Redraw" : "Draw";
  const form = !isOpen ? null : <form data-testid="guest-composer" aria-label={target === null ? "New note" : "Edit note"} onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(); }} noValidate className="flex flex-col gap-[var(--space-2)] border-b border-border pb-[var(--space-3)]">
    <p data-testid="guest-composer-anchor" className="m-0 text-foreground [font:var(--type-mono)] tabular-nums">{anchor}</p>
    <div className="flex flex-wrap gap-[var(--space-2)]">
      <Button type="button" variant="outline" size="sm" data-testid="guest-composer-mark-in" className={TOUCH} disabled={clock === null || marksLocked || pending} onClick={() => { if (!pending) setMarks((current) => markFrame(current, "in", here())); }}>Mark in</Button>
      <Button type="button" variant="outline" size="sm" data-testid="guest-composer-mark-out" className={TOUCH} disabled={clock === null || marksLocked || pending} onClick={() => { if (!pending) setMarks((current) => markFrame(current, "out", here())); }}>Mark out</Button>
      {markupAllowed && <Button type="button" variant={drawing ? "default" : "outline"} size="sm" data-testid="guest-composer-draw" aria-pressed={drawing} className={TOUCH} disabled={pending || (!drawing && (clock === null || phase !== "off" || framesChanged))} onClick={() => { if (drawing) setPhase("off"); else void startDrawing(); }}><PencilIcon aria-hidden="true" />{drawLabel}</Button>}
    </div>
    {hint !== null && <p data-testid="guest-composer-hint" className="m-0 text-foreground-secondary [font:var(--type-label)]">{hint}</p>}
    {(items.length > 0 || keptDrawing || (removed && hadDrawing)) && <p data-testid="guest-composer-drawing" className="m-0 flex flex-wrap items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">
      <span>{items.length > 0 ? `Drawing attached (${items.length} ${items.length === 1 ? "mark" : "marks"})` : keptDrawing ? "This note has a drawing" : "The drawing will be removed when you save"}</span>
      {markupAllowed && (items.length > 0 || keptDrawing) && <Button type="button" variant="ghost" size="sm" data-testid="guest-composer-remove-drawing" className={TOUCH} disabled={pending} onClick={() => { setItems(NO_ITEMS); setDrawFrame(null); if (hadDrawing) setRemoved(true); }}>Remove drawing</Button>}
    </p>}
    <div className="max-[721px]:[&_[contenteditable]]:text-[length:var(--text-base)]"><GuestNoteField testId="guest-composer-body" label="Your note" placeholder="Add a note at this frame…" media={media} value={doc} disabled={pending} onChange={setDoc} onUploadingChange={setUploading} /></div>
    {target !== null && latest !== null && latest.revision !== target.baseRevision && <p data-testid="guest-composer-latest" className="m-0 whitespace-pre-wrap text-foreground-secondary [font:var(--type-body-sm)] [overflow-wrap:anywhere]">{`Latest saved version: ${latest.body}`}</p>}
    {problem !== null && <p role="alert" data-testid="guest-composer-problem" className="m-0 text-destructive [font:var(--type-body-sm)]">{problem}</p>}
    <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
      <Button type="button" variant="ghost" data-testid="guest-composer-cancel" className={TOUCH} disabled={pending} onClick={close}>Cancel</Button>
      <Button type="submit" data-testid="guest-composer-post" className={TOUCH} disabled={pending || phase !== "off" || uploading}>{target === null ? "Post note" : "Save"}</Button>
    </div>
  </form>;

  // The phone pill's strip (#879 PR 2). Pristine: a new draft nothing has been put into, which a blur gives back.
  const empty = noteText(doc) === "";
  const pristine = isOpen && target === null && empty && marks.out === null && items.length === 0 && phase === "off" && !pending && problem === null && !uploading;
  useEffect(() => { if (!phone) setTrayOpen(false); }, [phone]);
  const setTray = useCallback((next: boolean) => { if (next && !live.current.open) begin(); setTrayOpen(next); }, [begin]);
  const strip: GuestStrip = {
    open: isOpen, editing: target !== null, doc, setDoc, setUploading, pending, problem, empty, uploading,
    frames, ranged: marks.in !== null && marks.out !== null && frames?.endFrame != null, marks, marksLocked,
    lockHint: hint, latest: target !== null && latest !== null && latest.revision !== target.baseRevision ? latest.body : null,
    strokes: items.length, drawFrame, keptDrawing, drawingRemoved: removed && hadDrawing,
    penDown: phase !== "off", confirming: phase === "confirming", canDraw: markupAllowed, drawLabel,
    penDisabled: pending || phase === "confirming" || (!drawing && (clock === null || framesChanged)),
    clockReady: clock !== null,
    tray, setTray, editorKey,
    focusStamp: () => {
      clock?.pause();
      if (!live.current.open) { begin(); return; }
      // A pristine new draft is stamped again at the frame on screen; once there is text (or an edit) the anchor is frozen (D10).
      if (!live.current.editing && pristine) setMarks({ in: here(), out: null });
    },
    releaseIfPristine: () => { if (pristine) close(); },
    step: (delta) => {
      if (!clock || pending || phase !== "off") return;
      const to = Math.min(Math.max(0, here() + delta), Math.max(0, frameCount - 1));
      clock.step(delta);
      // The strip's own frame step moves the stamp of an empty point draft (the hint follows it); once there is text it only steps the film.
      if (isOpen && target === null && empty && marks.out === null && items.length === 0) setMarks({ in: to, out: null });
    },
    mark: (kind) => { if (clock && !pending && !marksLocked && phase === "off") setMarks((current) => markFrame(current, kind, here())); },
    clearMarks,
    removeDrawing: () => { if (pending) return; setItems(NO_ITEMS); setDrawFrame(null); if (hadDrawing) setRemoved(true); },
    pen: () => {
      setTrayOpen(false);
      if (drawing) { setPhase("off"); focusField(); return; }
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
  const penDown = phase !== "off";
  // `strip` is rebuilt every render (its commands read the draft as rendered); the composer is the one reader and re-renders with the hook's owner anyway.
  return { isOpen, editingId, drawing, penDown, strip, endDrawing, replacesSavedDrawing, begin, beginEdit, close, form, overlay, transportReplacement, onMark, marks, clearMarks };
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
