import { useCallback, useState } from "react";

/**
 * The in / out marks of a note being composed (#741 5b). Storage is half-open `[startFrame, endFrame)`: I marks the first included
 * frame, O the LAST included frame, so a range always covers at least one frame (I and O on the same frame is a one-frame range) and
 * `endFrame = out + 1`. A mark that would cross the other clears the other (the NLE rule), never swaps silently
 * (docs/lessons.md "A range shortcut that sets both ends silently rewrites the one you were not editing (#683)").
 */
export type NoteMarks = Readonly<{ in: number | null; out: number | null }>;

export const EMPTY_MARKS: NoteMarks = { in: null, out: null };

export function markFrame(marks: NoteMarks, kind: "in" | "out", frame: number): NoteMarks {
  if (kind === "in") return { in: frame, out: marks.out !== null && marks.out < frame ? null : marks.out };
  return { in: marks.in !== null && marks.in > frame ? null : marks.in, out: frame };
}

export function clearMarks(): NoteMarks { return EMPTY_MARKS; }

/** The frames a post would send, or null with no marks. Both marks make a range; one mark is a point at that mark. Clamped into the film. */
export function marksToFrames(marks: NoteMarks, frameCount: number): { startFrame: number; endFrame: number | null } | null {
  const last = Math.max(0, frameCount - 1);
  const clamp = (value: number) => Math.min(last, Math.max(0, Math.round(value)));
  if (marks.in !== null && marks.out !== null) {
    const startFrame = clamp(marks.in);
    return { startFrame, endFrame: Math.max(startFrame + 1, clamp(marks.out) + 1) };
  }
  const only = marks.in ?? marks.out;
  return only === null ? null : { startFrame: clamp(only), endFrame: null };
}

export function useNoteMarks(initial: NoteMarks = EMPTY_MARKS) {
  const [marks, setMarks] = useState<NoteMarks>(initial);
  const mark = useCallback((kind: "in" | "out", frame: number) => { setMarks((current) => markFrame(current, kind, frame)); }, []);
  const clear = useCallback(() => { setMarks(EMPTY_MARKS); }, []);
  return { marks, mark, clear, set: setMarks };
}
