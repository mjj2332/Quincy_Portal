import { useCallback, useRef, useState } from "react";
import type { VideoNoteDto } from "@quincy/shared";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { EMPTY_MARKS, markFrame, type NoteMarks } from "../../lib/video-note-marks";

/**
 * The one form that is active in the notes panel (#741 5b, Rule A): the composer, or one root edit, or one reply. Opening another closes
 * the current one. The in / out marks belong to the active form only: they are cleared when it closes, when its thread is filtered out of
 * view or unmounts, and when the Version changes. An edit of a reply or of a note with markup takes no marks.
 */
export type ActiveForm =
  | { kind: "composer" }
  | { kind: "edit"; noteId: string; rootId: string; frames: boolean }
  | { kind: "reply"; rootId: string };

/** "confirming" (a frame is being confirmed) freezes the marks; "posting" (a request is out) also stops another form opening. */
export type SubmitPhase = "idle" | "confirming" | "posting";

/**
 * `gen` names one opening of one form: it changes whenever a form opens, closes or the state resets (Version change, thread filtered
 * away). A close or phase report carries the `gen` it was made under and is ignored if it no longer matches, so a request that finishes
 * late (after a Version switch, or after the form was closed and reopened) cannot touch the form that is open now. `marksGen` also changes
 * when the marks are cleared, so a seek that lands after a clear cannot write a mark.
 */
type State = { assetId: string; active: ActiveForm; marks: NoteMarks; gen: number; marksGen: number };
const COMPOSER: ActiveForm = { kind: "composer" };
const takesMarks = (form: ActiveForm) => form.kind === "composer" || (form.kind === "edit" && form.frames);

/**
 * Which form is active, whose marks are live, and whether a request is out. State lives in a ref that is also mirrored into React state, so
 * a handler that opens a form and marks in the same tick sees its own change. It starts empty for each Version (marks are frames of one film).
 */
export function useNoteForms({ assetId, clock, visibleRootIds }: { assetId: string; clock: VideoFrameClock | null; visibleRootIds: ReadonlySet<string> }) {
  const seq = useRef(0);
  const make = useCallback((forAsset: string, active: ActiveForm = COMPOSER, marks: NoteMarks = EMPTY_MARKS): State => ({ assetId: forAsset, active, marks, gen: ++seq.current, marksGen: ++seq.current }), []);
  const [, setMirror] = useState(0);
  const stateRef = useRef<State | null>(null);
  if (stateRef.current === null) stateRef.current = make(assetId);
  const phaseRef = useRef<{ value: SubmitPhase; gen: number }>({ value: "idle", gen: 0 });

  // Render phase, like the Version reset: the Version on screen changed, or the active form's thread is no longer listed (filtered out, deleted elsewhere).
  const current = stateRef.current;
  if (current.assetId !== assetId || (current.active.kind !== "composer" && !visibleRootIds.has(current.active.rootId))) {
    stateRef.current = make(assetId);
    setMirror((n) => n + 1);
  }
  const live = stateRef.current;
  const phaseNow = (): SubmitPhase => (phaseRef.current.gen === stateRef.current!.gen ? phaseRef.current.value : "idle");

  const apply = useCallback((change: (state: State) => State) => {
    const held = stateRef.current!;
    if (held.assetId !== assetId) return; // a callback from a Version that is no longer on screen
    const next = change(held);
    if (next === held) return;
    stateRef.current = next;
    setMirror((n) => n + 1);
  }, [assetId, make]);

  const setPhase = useCallback((value: SubmitPhase, gen: number) => {
    if (gen !== stateRef.current!.gen) return;
    phaseRef.current = { value, gen };
    setMirror((n) => n + 1);
  }, []);
  const currentGen = useCallback(() => stateRef.current!.gen, []);

  const open = useCallback((active: ActiveForm, marks: NoteMarks): number => {
    if (stateRef.current!.assetId !== assetId || phaseNow() === "posting") return 0;
    const next = make(assetId, active, marks);
    stateRef.current = next;
    setMirror((n) => n + 1);
    return next.gen;
  }, [assetId, make]); // eslint-disable-line react-hooks/exhaustive-deps -- phaseNow reads refs only
  const openComposer = useCallback(() => { if (stateRef.current!.active.kind !== "composer") open(COMPOSER, EMPTY_MARKS); }, [open]);
  /** Returns the new form's generation (0 if refused because a request is out). An edit form seeds its marks from the note's stored frames: the end is exclusive in storage, so the last included frame is end - 1. */
  const openEdit = useCallback((note: VideoNoteDto, rootId: string): number => {
    const frames = note.id === rootId && !note.hasMarkup && note.startFrame !== null;
    const marks: NoteMarks = frames ? { in: note.startFrame, out: note.endFrame === null ? null : note.endFrame - 1 } : EMPTY_MARKS;
    return open({ kind: "edit", noteId: note.id, rootId, frames }, marks);
  }, [open]);
  const openReply = useCallback((rootId: string): number => open({ kind: "reply", rootId }, EMPTY_MARKS), [open]);
  /** Closes the form opened under `gen` (back to the composer, marks cleared); a stale `gen` closes nothing. */
  const close = useCallback((gen: number | undefined) => {
    apply((state) => (state.active.kind === "composer" || gen === undefined || gen !== state.gen ? state : make(assetId)));
  }, [apply, assetId, make]);

  /**
   * Pause, wait for the frame to be on screen, then mark it in the form (and marks) that were current when the key was pressed. A
   * confirmation that lands after the form closed, after a clear, or while a request is out writes nothing.
   */
  const markFromClock = useCallback((kind: "in" | "out") => {
    if (!clock || phaseNow() !== "idle") return;
    const { gen, marksGen } = stateRef.current!;
    clock.awaitConfirmedFrame().then((frame) => {
      if (phaseNow() !== "idle") return;
      apply((state) => (state.gen === gen && state.marksGen === marksGen && takesMarks(state.active) ? { ...state, marks: markFrame(state.marks, kind, frame) } : state));
    }, () => undefined);
  }, [clock, apply]); // eslint-disable-line react-hooks/exhaustive-deps -- phaseNow reads refs only
  /** Collapses the active form's marks to a point at its first mark. */
  const makePoint = useCallback(() => {
    if (phaseNow() !== "idle") return;
    apply((state) => (takesMarks(state.active) ? { ...state, marks: { in: state.marks.in ?? state.marks.out, out: null } } : state));
  }, [apply]); // eslint-disable-line react-hooks/exhaustive-deps -- phaseNow reads refs only
  /** Clears the composer's marks (a posted note, or Clear marks) and voids any mark still waiting for its frame. With `gen`, only if that composer opening is still current. */
  const clearComposerMarks = useCallback((gen?: number) => {
    apply((state) => (state.active.kind === "composer" && (gen === undefined || gen === state.gen) ? { ...state, marks: EMPTY_MARKS, marksGen: ++seq.current } : state));
  }, [apply]);

  return { active: live.active, marks: live.marks, gen: live.gen, phase: phaseNow(), currentGen, setPhase, openComposer, openEdit, openReply, close, markFromClock, makePoint, clearComposerMarks };
}

export type NoteForms = ReturnType<typeof useNoteForms>;
