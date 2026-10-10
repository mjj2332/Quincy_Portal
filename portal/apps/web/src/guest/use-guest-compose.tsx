import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { PencilIcon } from "lucide-react";
import { STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, type Box, type FreehandPoint, type GuestNoteCreateInput, type MarkupItem } from "@quincy/shared";
import { useFrameClockSelector, type FrameClockState, type VideoFrameClock } from "../lib/video-frame-clock";
import { useMediaQuery } from "../lib/use-media-query";
import { useMarkup, type MarkupTool, type PointerSample } from "../lib/use-markup";
import { EMPTY_MARKS, markFrame, marksToFrames, type NoteMarks } from "../lib/video-note-marks";
import { Button } from "../components/reui/button";
import { Textarea } from "../components/reui/textarea";
import { MarkupToolbar } from "../components/quincy/markup-toolbar";
import { MarkupLayer, StrokeVisible } from "../components/quincy/freehand-strokes";
import { composeInput } from "./guest-compose";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const LIMITS = { items: STROKE_LIMITS.strokes, bytes: VIDEO_MARKUP_MAX_BYTES };
const NO_ITEMS: MarkupItem[] = [];
const PEN: MarkupTool = { kind: "freehand", color: "#e64b3c", width: 4 };
const FRAME_CONFIRM_TIMEOUT_MS = 10_000;
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** What the post came to: `message` is what to tell the guest, or null when the answer is not for this composer any more (a stale one). */
export type PostOutcome = { ok: true } | { ok: false; message: string | null };

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
 * The guest's note composer (#741 13c): the draft (body, in / out marks, an optional drawing), the form that edits it, and the drawing layer on the picture. It is the guest twin of the
 * staff composer + `useVideoMarkup`, which are bound to the staff form store and `lib/api` and so cannot be imported here (`guest-boundary.guard.test.ts`); the pieces that are pure are
 * shared: `useMarkup` (pointer capture, undo / redo), `MarkupToolbar`, the stroke renderer, `markFrame` / `marksToFrames`.
 *
 * - The note opens as a point at the frame on screen. "Mark in" / "Mark out" set the ends at the frame on screen (button only: the guest page has no I / O keys).
 * - Drawing pauses the film and puts the pen on one frame, confirmed on screen first. A point note follows its drawing (the mark moves to the drawing's frame); a range note keeps its
 *   marks and draws on the frame on screen when that is inside them, else on its first frame. Anything the marks stop covering is caught by `composeInput` at post time, not guessed at.
 * - `post` runs the write; a failure keeps the draft and shows its message here.
 */
export function useGuestCompose({ clock, frameCount, timecode, post, onDrawingChange }: {
  clock: VideoFrameClock | null;
  frameCount: number;
  timecode: (frame: number) => string;
  post: (input: GuestNoteCreateInput) => Promise<PostOutcome>;
  /** True while the pen is on the picture (the phone drawer must get out of its way), false when it is put down. */
  onDrawingChange?: (drawing: boolean) => void;
}): { isOpen: boolean; begin: () => void; close: () => void; form: ReactNode; overlay: (box: Box | null) => ReactNode; transportReplacement: ReactNode } {
  const [isOpen, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [marks, setMarks] = useState<NoteMarks>(EMPTY_MARKS);
  const [items, setItems] = useState<MarkupItem[]>(NO_ITEMS);
  const [drawFrame, setDrawFrame] = useState<number | null>(null);
  const [phase, setPhase] = useState<"off" | "confirming" | "drawing">("off");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pen, setPen] = useState<MarkupTool>(PEN);
  const [refusedFor, setRefusedFor] = useState<readonly MarkupItem[] | null>(null);
  const compact = useMediaQuery("(max-width: 720px)");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const opId = useRef(0);

  const playing = useFrameClockSelector(clock, (state) => state.playing, false);
  const frameNow = useFrameClockSelector(clock, (state) => (state.targetFrame === null ? state.frame : -1), -1);
  const drawing = phase === "drawing";
  const here = useCallback(() => (clock ? frameOnScreen(clock.getState()) : 0), [clock]);

  const reset = useCallback(() => {
    opId.current += 1;
    setBody(""); setMarks(EMPTY_MARKS); setItems(NO_ITEMS); setDrawFrame(null); setPhase("off"); setProblem(null); setPending(false); setRefusedFor(null);
  }, []);
  const begin = useCallback(() => { reset(); setMarks({ in: here(), out: null }); setOpen(true); }, [reset, here]);
  const close = useCallback(() => { reset(); setOpen(false); }, [reset]);

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
  const drawingFor = useRef<number | null>(null);
  useEffect(() => { if (drawing && drawingFor.current !== null && drawingFor.current !== drawFrame) resetHistory(); drawingFor.current = drawing ? drawFrame : null; }, [drawing, drawFrame, resetHistory]);

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

  const startDrawing = async () => {
    if (!clock || phase !== "off" || pending) return;
    clock.pause();
    const onScreen = frameOnScreen(clock.getState());
    const frames = marksToFrames(marks, frameCount);
    let frame = onScreen;
    if (items.length > 0 && drawFrame !== null) frame = drawFrame;
    else if (marks.out === null) setMarks({ in: onScreen, out: null }); // a point note follows its drawing
    else if (frames !== null && frames.endFrame !== null && (onScreen < frames.startFrame || onScreen >= frames.endFrame)) frame = frames.startFrame;
    setProblem(null); setPhase("confirming");
    const mine = ++opId.current;
    clock.seekToFrame(frame);
    let landed: number | "timeout";
    try { landed = await confirmedFrame(clock); } catch { if (opId.current === mine) { setPhase("off"); setProblem("The frame could not be confirmed. Try Draw again."); } return; }
    if (opId.current !== mine) return;
    if (landed === "timeout") { setPhase("off"); setProblem("The frame took too long to show. Try Draw again."); return; }
    if (landed !== frame) { setPhase("off"); setProblem("The frame moved. Press Draw again."); return; }
    setDrawFrame(frame);
    setPhase("drawing");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || phase !== "off") return;
    const built = composeInput({ body, marks, frameCount, items, drawingFrame: drawFrame });
    if (!built.ok) { setProblem(built.problem); return; }
    setPending(true); setProblem(null);
    const outcome = await post(built.input);
    if (outcome.ok) { close(); return; }
    setPending(false);
    if (outcome.message !== null) setProblem(outcome.message);
  };

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
        label={compact ? null : "Markup"} tool={pen} compact={compact} testId="guest-markup-toolbar"
        onToolChange={(kind) => { setPen((current) => ({ ...current, kind })); }}
        onColorChange={(color) => { setPen((current) => ({ ...current, color })); }}
        onWidthChange={(width) => { setPen((current) => ({ ...current, width })); }}
        canUndo={markup.canUndo} canRedo={markup.canRedo} canClear={items.length > 0}
        onUndo={markup.undo} onRedo={markup.redo} onClear={markup.clear}
        trailing={<Button type="button" data-testid="guest-markup-done" className={TOUCH} onClick={() => { setPhase("off"); }}>Done</Button>}
      />
    </div>
    : null;

  const frames = marksToFrames(marks, frameCount);
  const anchor = marks.in !== null && marks.out !== null && frames?.endFrame != null ? `From ${timecode(frames.startFrame)} to ${timecode(frames.endFrame - 1)}` : frames === null ? "No frame marked" : `At ${timecode(frames.startFrame)}`;
  const form = !isOpen ? null : <form data-testid="guest-composer" aria-label="New note" onSubmit={(event) => { void submit(event); }} noValidate className="flex flex-col gap-[var(--space-2)]">
    <p data-testid="guest-composer-anchor" className="m-0 text-foreground [font:var(--type-mono)] tabular-nums">{anchor}</p>
    <div className="flex flex-wrap gap-[var(--space-2)]">
      <Button type="button" variant="outline" size="sm" data-testid="guest-composer-mark-in" className={TOUCH} disabled={clock === null} onClick={() => { setMarks((current) => markFrame(current, "in", here())); }}>Mark in</Button>
      <Button type="button" variant="outline" size="sm" data-testid="guest-composer-mark-out" className={TOUCH} disabled={clock === null} onClick={() => { setMarks((current) => markFrame(current, "out", here())); }}>Mark out</Button>
      <Button type="button" variant="outline" size="sm" data-testid="guest-composer-draw" className={TOUCH} disabled={clock === null || pending || phase !== "off"} onClick={() => { void startDrawing(); }}><PencilIcon aria-hidden="true" />{items.length > 0 ? "Edit drawing" : "Draw"}</Button>
    </div>
    {items.length > 0 && <p data-testid="guest-composer-drawing" className="m-0 flex flex-wrap items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">
      <span>{`Drawing attached (${items.length} ${items.length === 1 ? "mark" : "marks"})`}</span>
      <Button type="button" variant="ghost" size="sm" data-testid="guest-composer-remove-drawing" className={TOUCH} onClick={() => { setItems(NO_ITEMS); setDrawFrame(null); }}>Remove drawing</Button>
    </p>}
    <Textarea ref={bodyRef} data-testid="guest-composer-body" aria-label="Your note" value={body} disabled={pending} onChange={(event) => { setBody(event.target.value); }} />
    {problem !== null && <p role="alert" data-testid="guest-composer-problem" className="m-0 text-destructive [font:var(--type-body-sm)]">{problem}</p>}
    <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
      <Button type="button" variant="ghost" data-testid="guest-composer-cancel" className={TOUCH} disabled={pending} onClick={close}>Cancel</Button>
      <Button type="submit" data-testid="guest-composer-post" className={TOUCH} disabled={pending || phase !== "off"}>Post note</Button>
    </div>
  </form>;

  return useMemo(() => ({ isOpen, begin, close, form, overlay, transportReplacement }), [isOpen, begin, close, form, overlay, transportReplacement]);
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
