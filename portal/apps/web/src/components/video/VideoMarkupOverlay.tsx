import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, type Box, type FreehandPoint, type MarkupItem } from "@quincy/shared";
import { useFrameClockSelector } from "../../lib/video-frame-clock";
import { useMediaQuery } from "../../lib/use-media-query";
import { useMarkup, type PointerSample } from "../../lib/use-markup";
import { useVideoNoteMarkupQuery } from "../../lib/video-notes-data";
import { preloadSavedDrawing, type DrawForm } from "../../lib/video-note-form-store";
import { Button } from "../reui/button";
import { Kbd } from "../reui/kbd";
import { MarkupToolbar } from "../quincy/markup-toolbar";
import { MarkupLayer, StrokeVisible } from "../quincy/freehand-strokes";
import { Notice } from "../quincy/Notice";
import type { VideoNotesSession } from "./use-video-notes";

const LIMITS = { items: STROKE_LIMITS.strokes, bytes: VIDEO_MARKUP_MAX_BYTES };
const NO_ITEMS: MarkupItem[] = [];
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** Where a drawing is made: the open edit of a root note, else the composer. Null when nothing can take one (a reply is open, or the Project is read-only). */
export function drawTarget(open: { kind: "edit" | "reply"; noteId: string; rootId: string; base: { startFrame: number | null } } | null): DrawForm | null {
  if (open === null) return "composer";
  return open.kind === "edit" && open.noteId === open.rootId && open.base.startFrame !== null ? "edit" : null;
}

const pointOf = (rect: DOMRect, event: PointerSample): FreehandPoint => ({
  x: Math.max(0, Math.min(1, Number(((event.clientX - rect.left) / rect.width).toFixed(4)))),
  y: Math.max(0, Math.min(1, Number(((event.clientY - rect.top) / rect.height).toFixed(4)))),
});

/** Whether a sample is over the picture itself (a captured pointer keeps reporting after it leaves, into the letterbox bands). */
const overPicture = (rect: DOMRect, event: PointerSample): boolean => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;

/**
 * The markup surface and floating pill of the review player (#741 6b-ui), drawn through `VideoStage`'s overlay slot. The SVG sits exactly on the picture box (so a stroke
 * never starts in a letterbox band and a point is a fraction of the picture, whatever the stage's shape), takes input only while drawing, and shows a drawing only while the
 * film is paused on the frame it was drawn on. Everything a draft is (strokes, frozen frame, phase, pen) lives in the Video tab's form store; the only thing held here is the
 * stroke being drawn, in `useMarkup`. At rest the pill is one "Draw" button; pressing it pauses, confirms the frame, and expands the shared `MarkupToolbar` in place.
 */
export function VideoMarkupOverlay({ session, box }: { session: VideoNotesSession; box: Box | null }) {
  const { forms, assetId, clock, role, projectId, canAnnotate, selectedThread } = session;
  const slot = useSyncExternalStore(forms.subscribe, () => forms.slot(assetId));
  const compact = useMediaQuery("(max-width: 720px)");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drawButton = useRef<HTMLButtonElement | null>(null);
  const doneButton = useRef<HTMLButtonElement | null>(null);
  const [refused, setRefused] = useState(false);

  const playing = useFrameClockSelector(clock, (state) => state.playing, false);
  const frameNow = useFrameClockSelector(clock, (state) => (state.targetFrame === null ? state.frame : -1), -1);

  // The drawing on screen is the selected note's saved one; read it here because an unreadable item blocks drawing on that note.
  const open = slot.open;
  const editing = open?.kind === "edit" ? open : null;
  const savedNote = selectedThread !== null && !selectedThread.deleted && selectedThread.hasMarkup && selectedThread.drawingFrame !== null ? selectedThread : null;
  const savedQuery = useVideoNoteMarkupQuery(projectId, assetId, savedNote?.id ?? "", savedNote?.revision ?? 1, savedNote !== null, role);
  // The edit form reads the same entry (note + revision), so this adds no fetch. A drawing with an unreadable item is never edited here.
  const editingSaved = editing !== null && editing.noteId === editing.rootId && editing.drawing.hadDrawing && editing.drawing.items === null && !editing.drawing.remove;
  const editedQuery = useVideoNoteMarkupQuery(projectId, assetId, editing?.noteId ?? "", editing?.base.revision ?? 1, editingSaved, role);
  const savedBlocked = editingSaved && editedQuery.data?.unsupported === true;
  const target = session.readOnly || !canAnnotate || savedBlocked ? null : drawTarget(slot.open);
  const draw = slot.draw;
  const drawing = draw !== null && draw.phase === "drawing";
  const confirming = draw !== null && draw.phase === "confirming";
  const form: DrawForm = draw?.form ?? target ?? "composer";
  const items = useMemo<MarkupItem[]>(() => (form === "edit" ? open?.drawing.items ?? NO_ITEMS : slot.markup.items), [form, open?.drawing.items, slot.markup.items]);

  const pen = slot.tool;
  const toPoint = useCallback((event: PointerSample): FreehandPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? pointOf(rect, event) : { x: Number.NaN, y: Number.NaN };
  }, []);
  const setItems = useCallback((next: MarkupItem[] | ((current: MarkupItem[]) => MarkupItem[])) => { setRefused(false); forms.setItems(assetId, form, next); }, [forms, assetId, form]);
  const markup = useMarkup({
    enabled: drawing && canAnnotate, tool: pen, toPoint, strokes: items, setStrokes: setItems, limits: LIMITS,
    onRefuse: () => { setRefused(true); },
    history: { value: slot.history[form]?.steps ?? null, set: (next) => { forms.setHistory(assetId, form, next, forms.slot(assetId).draw?.frame ?? null); } },
  });

  // Only the primary pointer's main button draws (a right-click or a second finger never starts a stroke), and a captured pointer that wanders into a letterbox band ends the stroke
  // at the last point inside the picture, as leaving the picture does.
  const { onPointerDown, onPointerMove, onPointerUp, onPointerLeave } = markup.handlers;
  const handlers = {
    ...markup.handlers,
    onPointerDown: (event: ReactPointerEvent<Element>) => { if (!event.isPrimary || event.button !== 0) return; return onPointerDown(event); },
    onPointerMove: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerMove(event); },
    onPointerUp: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerUp(event); },
  };

  // A gesture never outlives draw mode or the picture it started on: leaving, or a resize, drops the stroke in progress and keeps the finished ones.
  const { cancel } = markup;
  useEffect(() => { cancel(); }, [cancel, drawing, box?.left, box?.top, box?.width, box?.height]);

  // A drawing has exactly one frame, and an undo step restores strokes without one: when drawing starts on a different frame than the history was built on, its steps are dropped.
  const { resetHistory } = markup;
  const drawFrame = drawing ? draw.frame : null;
  useEffect(() => {
    if (drawFrame === null) return;
    const held = forms.slot(assetId).history[form];
    if (held && held.frame !== null && held.frame !== drawFrame) resetHistory();
  }, [drawFrame, resetHistory, forms, assetId, form]);

  // An edited drawing is shown only for the selected note: drawing on an edit selects its note (the frame and filter checks still decide whether it shows).
  const editingId = editing?.noteId ?? null;
  const drawingEdit = draw !== null && draw.form === "edit";
  const { selectedId, select } = session;
  useEffect(() => { if (drawingEdit && editingId !== null && selectedId !== editingId) select(editingId); }, [drawingEdit, editingId, selectedId, select]);

  // Nothing may move the frame under the pen. If playback starts or the frame changes anyway (a seek that got through), drawing ends and the strokes stay.
  const offFrame = drawing && (playing || frameNow !== draw.frame);
  useEffect(() => { if (offFrame) forms.exitDraw(assetId); }, [offFrame, forms, assetId]);

  // Undo and redo outside text fields: Shift is checked first (Shift+Cmd+Z is redo), and Cmd+Y is not redo (it is History on macOS). Nothing is prevented when there is nothing to do.
  const { undo, redo, canUndo, canRedo } = markup;
  useEffect(() => {
    if (!drawing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const field = event.target instanceof Element && event.target.closest(FIELD) !== null;
      if (field || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const letter = event.key.toLowerCase();
      if ((letter === "z" && event.shiftKey) || (letter === "y" && event.ctrlKey && !event.metaKey)) { if (canRedo) { event.preventDefault(); redo(); } return; }
      if (letter === "z" && !event.shiftKey) { if (canUndo) { event.preventDefault(); undo(); } }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [drawing, canUndo, canRedo, undo, redo]);

  // Focus follows the mode: Done when drawing opens; the Draw button when it ends, unless focus went somewhere on purpose.
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (drawing && !wasDrawing.current) doneButton.current?.focus({ preventScroll: true });
    if (!drawing && wasDrawing.current) {
      const active = document.activeElement;
      if (active === null || active === document.body || (active instanceof Element && active.closest('[data-testid="video-markup-toolbar"]'))) drawButton.current?.focus({ preventScroll: true });
    }
    wasDrawing.current = drawing;
  }, [drawing]);

  // What is on the picture. The draft being drawn wins; then a draft made earlier on this frame; then the selected note's saved drawing.
  const atRest = !playing && frameNow >= 0;
  // The edit's draft is shown whether or not the saved note has a drawing (a plain note's new drawing has no saved one to fall back on).
  const editingThis = editing !== null && editing.noteId === editing.rootId && editing.noteId === selectedThread?.id && (editing.drawing.touched || draw?.form === "edit");
  let shownItems: readonly MarkupItem[] = NO_ITEMS;
  let shownFrame: number | null = null;
  if (drawing) { shownItems = items; shownFrame = draw.frame; }
  else if (editingThis && editing.drawing.items !== null) { shownItems = editing.drawing.remove ? NO_ITEMS : editing.drawing.items; shownFrame = editing.drawing.drawingFrame; }
  else if (editingThis) { shownItems = NO_ITEMS; shownFrame = null; }
  else if (slot.markup.items.length > 0 && slot.markup.drawingFrame !== null && !editing && frameNow === slot.markup.drawingFrame) { shownItems = slot.markup.items; shownFrame = slot.markup.drawingFrame; }
  else if (savedNote !== null && savedQuery.data?.markup && savedQuery.data.noteId === savedNote.id) { shownItems = savedQuery.data.markup; shownFrame = savedNote.drawingFrame; }
  const visible = drawing || (shownFrame !== null && atRest && frameNow === shownFrame);

  const showPill = pillShows(target, drawing, confirming, clock !== null, playing);
  const pillHint = drawing ? <div aria-hidden="true" className="pointer-events-none flex w-max items-center gap-[var(--space-2)] rounded-[var(--radius-pill)] border border-solid border-[length:var(--border-width-hair)] border-border bg-[var(--scrim-overlay)] px-[var(--space-3)] py-[var(--space-1)] text-on-inverse-muted [font:var(--type-eyebrow)] max-[721px]:hidden"><Kbd>⌘Z</Kbd> undo<Kbd>⇧⌘Z</Kbd> redo<Kbd>Esc</Kbd> done</div> : null;

  return <>
    {box !== null && <div data-testid="video-markup" data-drawing={drawing ? "true" : "false"} className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <MarkupLayer
        ref={svgRef} aria-hidden="true" data-testid="video-markup-layer" viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-hidden"
        style={{ pointerEvents: drawing ? "auto" : "none", cursor: drawing ? "crosshair" : "default", touchAction: drawing ? "none" : "auto" }}
        {...handlers}
      >
        {visible && shownItems.map((item, index) => <StrokeVisible key={index} stroke={item} opacity={1} testId="video-markup-stroke" pixelDots />)}
        {drawing && markup.active && <StrokeVisible stroke={markup.active} opacity={1} testId="video-markup-stroke" pixelDots />}
      </MarkupLayer>
      {visible && !drawing && shownItems === savedQuery.data?.markup && savedQuery.data?.unsupported && <div data-testid="video-markup-unsupported" role="status" className="pointer-events-none absolute inset-x-0 top-[var(--space-2)] flex justify-center"><span className="rounded-[var(--radius-pill)] bg-[var(--scrim-overlay)] px-[var(--space-3)] py-[var(--space-1)] text-on-inverse-muted [font:var(--type-eyebrow)]">Some markup can't be shown</span></div>}
    </div>}
    {showPill && <div className="pointer-events-none absolute inset-x-0 bottom-[var(--space-3)] z-10 flex flex-col items-center gap-[var(--space-2)] max-[721px]:bottom-[var(--space-2)]" data-testid="video-markup-stack">
      {refused && <Notice tone="caution" role="status" className="pointer-events-auto">That is as much markup as one note can hold. Undo a stroke to add more.</Notice>}
      {pillHint}
      <MarkupToolbar
        label={compact ? null : form === "edit" ? "Editing drawing" : "Markup"}
        tool={pen} compact={compact} testId="video-markup-toolbar" drawRef={drawButton}
        collapsed={!drawing} expanding={confirming}
        onExpand={() => { if (clock && target) { if (target === "edit") preloadSavedDrawing(forms, assetId, editedQuery.data); void forms.enterDraw(assetId, { clock, form: target, frameCount: session.frameCount }); } }}
        onToolChange={(kind) => { forms.setTool(assetId, { kind }); }}
        onColorChange={(color) => { forms.setTool(assetId, { color }); }}
        onWidthChange={(width) => { forms.setTool(assetId, { width }); }}
        canUndo={markup.canUndo} canRedo={markup.canRedo} canClear={items.length > 0}
        onUndo={markup.undo} onRedo={markup.redo} onClear={markup.clear}
        trailing={<Button ref={doneButton} type="button" data-testid="video-markup-done" className="max-[721px]:min-h-11 min-[721px]:pointer-coarse:min-h-11" onClick={() => { forms.exitDraw(assetId); }}>Done</Button>}
      />
    </div>}
  </>;
}

/** The pill (or the lone Draw button) shows while drawing or confirming; at rest only when something can take a drawing, the film is ready, and it is paused. */
function pillShows(target: DrawForm | null, drawing: boolean, confirming: boolean, ready: boolean, playing: boolean): boolean {
  if (drawing || confirming) return true;
  return target !== null && ready && !playing;
}
