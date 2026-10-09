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

export const formKey = (form: ActiveForm): string => (form.kind === "composer" ? "composer" : form.kind === "edit" ? `edit:${form.noteId}` : `reply:${form.rootId}`);
export const editKey = (noteId: string) => `edit:${noteId}`;
export const replyKey = (rootId: string) => `reply:${rootId}`;

type State = { assetId: string; active: ActiveForm; marks: NoteMarks };
const COMPOSER: ActiveForm = { kind: "composer" };
const fresh = (assetId: string): State => ({ assetId, active: COMPOSER, marks: EMPTY_MARKS });
const takesMarks = (form: ActiveForm) => form.kind === "composer" || (form.kind === "edit" && form.frames);

/**
 * Which form is active, whose marks are live, and whether a request is out. State lives in a ref that is also mirrored into React state, so
 * a handler that activates a form and marks in the same tick sees its own change. It starts empty for each Version (marks are frames of one film).
 */
export function useNoteForms({ assetId, clock, visibleRootIds }: { assetId: string; clock: VideoFrameClock | null; visibleRootIds: ReadonlySet<string> }) {
  const [, setMirror] = useState<State>(() => fresh(assetId));
  const stateRef = useRef<State>(fresh(assetId));
  const [phase, setPhaseState] = useState<SubmitPhase>("idle");
  const phaseRef = useRef<SubmitPhase>("idle");

  // Render phase, like the Version reset: the Version on screen changed, or the active form's thread is no longer listed (filtered out, deleted elsewhere).
  const current = stateRef.current;
  if (current.assetId !== assetId || (current.active.kind !== "composer" && !visibleRootIds.has(current.active.rootId))) {
    stateRef.current = fresh(assetId);
    setMirror(stateRef.current);
  }
  const live = stateRef.current;

  const apply = useCallback((change: (state: State) => State) => {
    const base = stateRef.current.assetId === assetId ? stateRef.current : fresh(assetId);
    const next = change(base);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setMirror(next);
  }, [assetId]);

  const setPhase = useCallback((next: SubmitPhase) => { phaseRef.current = next; setPhaseState(next); }, []);

  const openComposer = useCallback(() => {
    if (phaseRef.current === "posting") return;
    apply((state) => (state.active.kind === "composer" ? state : fresh(assetId)));
  }, [apply, assetId]);
  const openEdit = useCallback((note: VideoNoteDto, rootId: string) => {
    if (phaseRef.current === "posting") return;
    const frames = note.id === rootId && !note.hasMarkup && note.startFrame !== null;
    // An edit form seeds its marks from the note's stored frames: the end is exclusive in storage, so the last included frame is end - 1.
    const marks: NoteMarks = frames ? { in: note.startFrame, out: note.endFrame === null ? null : note.endFrame - 1 } : EMPTY_MARKS;
    apply((state) => ({ assetId: state.assetId, active: { kind: "edit", noteId: note.id, rootId, frames }, marks }));
  }, [apply]);
  const openReply = useCallback((rootId: string) => {
    if (phaseRef.current === "posting") return;
    apply((state) => ({ assetId: state.assetId, active: { kind: "reply", rootId }, marks: EMPTY_MARKS }));
  }, [apply]);
  /** Closes the active form (back to the composer, marks cleared). With `only`, closes it only if it is still that form: a late success must not close the one opened since. */
  const close = useCallback((only?: string) => {
    apply((state) => (state.active.kind === "composer" || (only !== undefined && formKey(state.active) !== only) ? state : fresh(assetId)));
  }, [apply, assetId]);

  /**
   * Pause, wait for the frame to be on screen, then mark it in the form that was active when the key was pressed. A late confirmation
   * never writes into a form that has closed since, and nothing is marked while the active form is submitting.
   */
  const markFromClock = useCallback((kind: "in" | "out") => {
    if (!clock || phaseRef.current !== "idle") return;
    const pressedIn = formKey(stateRef.current.active);
    clock.awaitConfirmedFrame().then((frame) => {
      if (phaseRef.current !== "idle") return;
      apply((state) => (formKey(state.active) === pressedIn && takesMarks(state.active) ? { ...state, marks: markFrame(state.marks, kind, frame) } : state));
    }, () => undefined);
  }, [clock, apply]);
  /** Collapses the active form's marks to a point at its first mark. */
  const makePoint = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    apply((state) => (takesMarks(state.active) ? { ...state, marks: { in: state.marks.in ?? state.marks.out, out: null } } : state));
  }, [apply]);
  /** Clears the composer's marks (a posted note, or Clear marks); the marks of any other form are not its to clear. */
  const clearComposerMarks = useCallback(() => { apply((state) => (state.active.kind === "composer" && state.marks !== EMPTY_MARKS ? { ...state, marks: EMPTY_MARKS } : state)); }, [apply]);

  return { active: live.active, marks: live.marks, phase, setPhase, openComposer, openEdit, openReply, close, markFromClock, makePoint, clearComposerMarks };
}

export type NoteForms = ReturnType<typeof useNoteForms>;
