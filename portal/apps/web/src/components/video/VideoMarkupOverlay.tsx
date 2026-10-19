import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { STROKE_LIMITS, VIDEO_MARKUP_MAX_BYTES, type Box, type FreehandPoint, type MarkupItem } from "@quincy/shared";
import { useFrameClockSelector } from "../../lib/video-frame-clock";
import { useMediaQuery } from "../../lib/use-media-query";
import { useMarkup, type PointerSample } from "../../lib/use-markup";
import { useVideoNoteMarkupQuery } from "../../lib/video-notes-data";
import { preloadSavedDrawing, type DrawForm } from "../../lib/video-note-form-store";
import { Button } from "../reui/button";
import { MarkupToolbar } from "../quincy/markup-toolbar";
import type { NoteDrawRowProps } from "../quincy/NoteDrawRow";
import type { NoteControl } from "../quincy/NoteComposerBox";
import { MarkupLayer, StrokeVisible } from "../quincy/freehand-strokes";
import { Notice } from "../quincy/Notice";
import type { VideoNotesSession } from "./use-video-notes";

const LIMITS = { items: STROKE_LIMITS.strokes, bytes: VIDEO_MARKUP_MAX_BYTES };
const NO_ITEMS: MarkupItem[] = [];
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** The composer box's pen (`quincy/NoteComposerBox`), which takes the focus back when drawing ends. */
const PEN = 'button[aria-label="Draw on the frame"]';

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

/** One form's drawing controls (#927): the composer's pen and, while that form draws, the row that takes its tool row's place (`quincy/NoteDrawRow`). */
export type NoteDrawControls = {
  /** The pen. Absent: this form takes no drawing here (the part is off, the person cannot annotate, the Project is archived, or the form is not a root's edit). */
  pen: ({ onPress: () => void } & NoteControl) | undefined;
  /** The drawing row's props while this form is drawing (the frame is up and frozen); null otherwise. */
  row: Omit<NoteDrawRowProps, "phone"> | null;
  /** The stroke cap was hit on this form's drawing. */
  full: boolean;
};
const NO_DRAW: NoteDrawControls = { pen: undefined, row: null, full: false };
/** The text the stroke cap shows (the box's notice line). */
export const MARKUP_FULL_TEXT = "That is as much markup as one note can hold. Undo a stroke to add more.";
/** The lock D4 puts on an edit's pen while its range has changed (the store refuses the drawing then). */
const FRAMES_FIRST = "Save the new frames first; a note's frames and its drawing change one at a time.";

/**
 * The markup of the review player (#741 6b-ui), as a hook the notes host calls so the places it lives share one state: the SVG surface drawn through `VideoStage`'s overlay
 * slot, and (#927) each note form's pen and drawing row, which the composer box renders in place of its tools (frames C6, C7, P4, P5). The picture is never covered by toolbar UI,
 * only by the drawing SVG, which sits exactly on the picture box (so a stroke never starts in a letterbox band and a point is a fraction of the picture, whatever the stage's shape),
 * takes input only while drawing, and shows a drawing only while the film is paused on the frame it was drawn on. Everything a draft is (strokes, frozen frame, phase, pen) lives in
 * the Video tab's form store; the only thing held here is the stroke being drawn, in `useMarkup`. The pen pauses, confirms the frame, then swaps the box's tools for the drawing row.
 * With the part off every slot is empty. Until the edit form carries the box (#927 T7), an edit's drawing keeps the old stack in place of the transport (`transportReplacement`).
 */
export function useVideoMarkup(session: VideoNotesSession): { overlay: ((box: Box | null) => ReactNode) | undefined; draw: { composer: NoteDrawControls; edit: NoteDrawControls }; transportReplacement: ReactNode } {
  const { forms, assetId, clock, role, projectId, canAnnotate } = session;
  const on = session.markup;
  const selectedThread = on ? session.selectedThread : null;
  const slot = useSyncExternalStore(forms.subscribe, () => forms.slot(assetId));
  const compact = useMediaQuery("(max-width: 720px)");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const doneButton = useRef<HTMLButtonElement | null>(null);
  // The cap warning is tied to the stroke list it was raised for: any other list (undone, cleared, removed, replaced from outside, another note or Version) is not full.
  const [refusedFor, setRefusedFor] = useState<readonly MarkupItem[] | null>(null);

  const playing = useFrameClockSelector(clock, (state) => state.playing, false);
  const frameNow = useFrameClockSelector(clock, (state) => (state.targetFrame === null ? state.frame : -1), -1);

  // The drawing on screen is the selected note's saved one; read it here because an unreadable item blocks drawing on that note.
  const open = slot.open;
  const editing = on && open?.kind === "edit" ? open : null;
  const savedNote = selectedThread !== null && !selectedThread.deleted && selectedThread.hasMarkup && selectedThread.drawingFrame !== null ? selectedThread : null;
  const savedQuery = useVideoNoteMarkupQuery(projectId, assetId, savedNote?.id ?? "", savedNote?.revision ?? 1, savedNote !== null, role);
  // The edit form reads the same entry (note + revision), so this adds no fetch. A drawing with an unreadable item is never edited here.
  const editingSaved = on && editing !== null && editing.noteId === editing.rootId && editing.drawing.hadDrawing && editing.drawing.items === null && !editing.drawing.remove;
  const editedQuery = useVideoNoteMarkupQuery(projectId, assetId, editing?.noteId ?? "", editing?.base.revision ?? 1, editingSaved, role);
  const savedBlocked = editingSaved && editedQuery.data?.unsupported === true;
  const allowed = on && !session.readOnly && canAnnotate;
  const draw = on ? slot.draw : null;
  const drawing = draw !== null && draw.phase === "drawing";
  const confirming = draw !== null && draw.phase === "confirming";
  const form: DrawForm = draw?.form ?? drawTarget(slot.open) ?? "composer";
  const items = useMemo<MarkupItem[]>(() => (form === "edit" ? (open?.drawing.remove ? NO_ITEMS : open?.drawing.items ?? NO_ITEMS) : slot.markup.items), [form, open?.drawing.items, open?.drawing.remove, slot.markup.items]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const refused = refusedFor !== null && refusedFor === items;
  const pen = slot.tool;
  const toPoint = useCallback((event: PointerSample): FreehandPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? pointOf(rect, event) : { x: Number.NaN, y: Number.NaN };
  }, []);
  const setItems = useCallback((next: MarkupItem[] | ((current: MarkupItem[]) => MarkupItem[])) => { forms.setItems(assetId, form, next); }, [forms, assetId, form]);
  const markup = useMarkup({
    enabled: drawing && canAnnotate, tool: pen, toPoint, strokes: items, setStrokes: setItems, limits: LIMITS,
    onRefuse: () => { setRefusedFor(itemsRef.current); },
    history: { value: slot.history[form]?.steps ?? null, set: (next) => { forms.setHistory(assetId, form, next, forms.slot(assetId).draw?.frame ?? null); } },
  });

  // Only the primary pointer's main button draws (a right-click or a second finger never starts a stroke), and a captured pointer that wanders into a letterbox band ends the stroke
  // at the last point inside the picture, as leaving the picture does.
  const { onPointerDown, onPointerMove, onPointerUp, onPointerLeave } = markup.handlers;
  const handlers = {
    ...markup.handlers,
    // A stroke starts on the picture only (#877): a press in a letterbox band, which Social's 9:16 frame makes wide, is no stroke (the layer is the picture, so only a stray event can land outside it).
    onPointerDown: (event: ReactPointerEvent<Element>) => { if (!event.isPrimary || event.button !== 0) return; const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) return; return onPointerDown(event); },
    onPointerMove: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerMove(event); },
    onPointerUp: (event: ReactPointerEvent<Element>) => { const rect = svgRef.current?.getBoundingClientRect(); if (rect && !overPicture(rect, event)) onPointerLeave(event); else onPointerUp(event); },
  };

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

  // Focus follows the mode: Done when drawing opens; the form's pen when it ends, unless the focus went somewhere on purpose (a phone's ‹ puts it back in the field).
  const wasDrawing = useRef<DrawForm | null>(null);
  useEffect(() => {
    if (drawing && wasDrawing.current === null) doneButton.current?.focus({ preventScroll: true });
    if (!drawing && wasDrawing.current !== null) {
      const ended = wasDrawing.current;
      const active = document.activeElement;
      if (active === null || active === document.body || (active instanceof Element && active.closest('[data-testid="note-draw-row"], [data-testid="video-markup-toolbar"]'))) {
        document.querySelector<HTMLElement>(ended === "edit" ? `[data-notes-form="edit"] :is(${PEN}, [data-testid="video-note-edit-draw"])` : `[data-notes-form="composer"] ${PEN}`)?.focus({ preventScroll: true });
      }
    }
    wasDrawing.current = drawing ? draw.form : null;
  }, [drawing, draw?.form]);

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
  const unsupportedNote = visible && !drawing && shownItems === savedQuery.data?.markup && savedQuery.data?.unsupported === true;

  const overlay = on ? (box: Box | null) => <MarkupSurface box={box} svgRef={svgRef} drawing={drawing} handlers={handlers} cancel={markup.cancel} unsupported={unsupportedNote}>
    {visible && shownItems.map((item, index) => <StrokeVisible key={index} stroke={item} opacity={1} testId="video-markup-stroke" pixelDots />)}
    {drawing && markup.active && <StrokeVisible stroke={markup.active} opacity={1} testId="video-markup-stroke" pixelDots />}
  </MarkupSurface> : undefined;

  // ‹: drawing ends, the strokes stay; on a phone the composer's field takes the focus back inside the tap, so iOS raises the keyboard again.
  const done = () => { forms.exitDraw(assetId); if (compact && form === "composer") { const field = document.getElementById("video-note-body"); (field?.matches("[contenteditable]") ? field : field?.querySelector<HTMLElement>("[contenteditable]"))?.focus({ preventScroll: true }); } };
  // The pen pauses and brings the frame up (the store's confirmation), then the row opens. On a phone it lowers the keyboard first: the film is the canvas (P4).
  const enter = (target: DrawForm) => {
    if (!clock) return;
    if (compact) { const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body) active.blur(); }
    if (target === "edit") preloadSavedDrawing(forms, assetId, editedQuery.data);
    void forms.enterDraw(assetId, { clock, form: target, frameCount: session.frameCount });
  };
  // Clear removes the drawing: the strokes on screen (undoable), else an edit's saved drawing that was never loaded into strokes (Save then deletes it).
  const savedLeft = form === "edit" && editing !== null && editing.drawing.hadDrawing && !editing.drawing.remove && editing.drawing.items === null;
  const row: Omit<NoteDrawRowProps, "phone"> | null = drawing ? {
    tool: pen.kind, color: pen.color,
    onToolChange: (kind) => { forms.setTool(assetId, { kind }); },
    onColorChange: (color) => { forms.setTool(assetId, { color }); },
    canUndo: markup.canUndo, canRedo: markup.canRedo, canClear: items.length > 0 || savedLeft,
    onUndo: markup.undo, onRedo: markup.redo, onClear: () => { if (items.length > 0) markup.clear(); else if (savedLeft) forms.removeDrawing(assetId); },
    onDone: done, doneRef: doneButton,
  } : null;

  // The composer's pen: locked while another form is open, a request is out, the film is loading, or the frame is being brought up.
  const lockedBy = slot.open ? `Finish or cancel the open ${slot.open.kind} first.` : clock === null ? "Loading the film…" : null;
  const composer: NoteDrawControls = !allowed ? NO_DRAW : {
    pen: { onPress: () => { enter("composer"); }, ...(lockedBy !== null || slot.op !== null || confirming ? { disabled: true, ...(lockedBy ? { reason: lockedBy } : {}) } : {}) },
    row: draw?.form === "composer" ? row : null,
    full: form === "composer" && refused,
  };
  // An edit's pen (#927 T7 renders it): a root with frames only; D4 locks it while the range has changed, and it waits for the saved drawing.
  const editable = allowed && editing !== null && editing.noteId === editing.rootId && editing.base.startFrame !== null;
  const editLock = savedBlocked ? "Some markup can't be shown, so this drawing can't be edited here." : slot.marks.touched ? FRAMES_FIRST : editingSaved && !editedQuery.data ? "The saved drawing is loading." : clock === null ? "Loading the film…" : null;
  const edit: NoteDrawControls = !editable ? NO_DRAW : {
    pen: { onPress: () => { enter("edit"); }, ...(editLock !== null || slot.op !== null || confirming ? { disabled: true, ...(editLock ? { reason: editLock } : {}) } : {}) },
    row: draw?.form === "edit" ? row : null,
    full: form === "edit" && refused,
  };

  // Interim (#927 T6 → T7): the edit form has no drawing row yet, so its drawing keeps the stack under the picture. T7 renders `draw.edit.row` in the edit box and drops this.
  const transportReplacement = drawing && form === "edit" && row
    ? <div className="flex min-w-0 flex-col items-center gap-[var(--space-1)]" data-testid="video-markup-stack">
      {refused && <Notice tone="caution" role="status">{MARKUP_FULL_TEXT}</Notice>}
      <MarkupToolbar
        label={compact ? null : "Editing drawing"}
        tool={pen} compact={compact} testId="video-markup-toolbar"
        onToolChange={row.onToolChange} onColorChange={row.onColorChange}
        onWidthChange={(width) => { forms.setTool(assetId, { width }); }}
        canUndo={row.canUndo} canRedo={row.canRedo} canClear={row.canClear}
        onUndo={row.onUndo} onRedo={row.onRedo} onClear={row.onClear}
        trailing={<Button ref={doneButton} type="button" data-testid="video-markup-done" className="max-[721px]:min-h-11 min-[721px]:pointer-coarse:min-h-11" onClick={done}>Done</Button>}
      />
    </div>
    : null;

  return { overlay, draw: { composer, edit }, transportReplacement };
}

/** The SVG on the picture box. A gesture never outlives draw mode or the picture it started on: leaving, or a resize, drops the stroke in progress and keeps the finished ones. */
function MarkupSurface({ box, svgRef, drawing, handlers, cancel, unsupported, children }: {
  box: Box | null; svgRef: RefObject<SVGSVGElement | null>; drawing: boolean; handlers: React.ComponentProps<typeof MarkupLayer>; cancel: () => void; unsupported: boolean; children: ReactNode;
}) {
  useEffect(() => { cancel(); }, [cancel, drawing, box?.left, box?.top, box?.width, box?.height]);
  if (box === null) return null;
  return <div data-testid="video-markup" data-drawing={drawing ? "true" : "false"} className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
    <MarkupLayer
      ref={svgRef} aria-hidden="true" data-testid="video-markup-layer" viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-hidden"
      style={{ pointerEvents: drawing ? "auto" : "none", cursor: drawing ? "crosshair" : "default", touchAction: drawing ? "none" : "auto" }}
      {...handlers}
    >
      {children}
    </MarkupLayer>
    {unsupported && <div data-testid="video-markup-unsupported" role="status" className="pointer-events-none absolute inset-x-0 top-[var(--space-2)] flex justify-center"><span className="rounded-[var(--radius-pill)] bg-[var(--scrim-overlay)] px-[var(--space-3)] py-[var(--space-1)] text-on-inverse-muted [font:var(--type-eyebrow)]">Some markup can't be shown</span></div>}
  </div>;
}
