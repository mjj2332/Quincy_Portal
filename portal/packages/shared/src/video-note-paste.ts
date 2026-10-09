import { type Rational } from "./video-rational";

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function assertFrame(frame: number): void {
  if (!Number.isSafeInteger(frame)) throw new RangeError(`invalid frame ${frame}`);
}

/**
 * Maps a source frame to the target frame holding the source frame's middle moment:
 * floor((2f+1) * fromDen * toNum / (2 * fromNum * toDen)). Exact (BigInt).
 */
export function mapFrame(frame: number, from: Rational, to: Rational): number {
  assertFrame(frame);
  const num = BigInt(2 * frame + 1) * BigInt(from.den) * BigInt(to.num);
  const den = 2n * BigInt(from.num) * BigInt(to.den);
  return Number(floorDiv(num, den));
}

/** Maps an exclusive range end: round(f * fromDen * toNum / (fromNum * toDen)). Exact (BigInt). */
export function mapBoundary(frame: number, from: Rational, to: Rational): number {
  assertFrame(frame);
  const den = BigInt(from.num) * BigInt(to.den);
  const num = 2n * BigInt(frame) * BigInt(from.den) * BigInt(to.num) + den;
  return Number(floorDiv(num, 2n * den));
}

export type PasteNote = {
  id: string;
  startFrame: number;
  /** Exclusive end; null for a point note. */
  endFrame: number | null;
  drawingFrame: number | null;
};

export type PastePlanRow =
  | {
      noteId: string;
      status: "mapped";
      startFrame: number;
      endFrame: number | null;
      drawingFrame: number | null;
      shortened: boolean;
    }
  | {
      noteId: string;
      status: "skipped";
      reason: "before_start" | "past_end" | "drawing_outside" | "already_copied";
    };

/**
 * Plans copying notes from one Version to another. Ranges are half-open [start, end).
 * `offsetFrames` is in target frames and is applied after mapping. Nothing is dropped
 * silently: every note gets a row, and markup that no longer lands on the note is a skip.
 */
export function planPaste(
  notes: PasteNote[],
  from: Rational,
  to: { fps: Rational; frameCount: number },
  offsetFrames: number,
  alreadyCopied: ReadonlySet<string>,
): PastePlanRow[] {
  const skip = (
    noteId: string,
    reason: "before_start" | "past_end" | "drawing_outside" | "already_copied",
  ): PastePlanRow => ({ noteId, status: "skipped", reason });

  return notes.map((note): PastePlanRow => {
    if (alreadyCopied.has(note.id)) return skip(note.id, "already_copied");

    const start = mapFrame(note.startFrame, from, to.fps) + offsetFrames;
    if (start < 0) return skip(note.id, "before_start");
    if (start >= to.frameCount) return skip(note.id, "past_end");

    let end: number | null = null;
    let shortened = false;
    if (note.endFrame !== null) {
      end = Math.max(mapBoundary(note.endFrame, from, to.fps) + offsetFrames, start + 1);
      if (end > to.frameCount) {
        end = to.frameCount;
        shortened = true;
      }
    }

    let drawingFrame: number | null = null;
    if (note.drawingFrame !== null) {
      drawingFrame = mapFrame(note.drawingFrame, from, to.fps) + offsetFrames;
      const inside = end === null ? drawingFrame === start : drawingFrame >= start && drawingFrame < end;
      if (!inside) return skip(note.id, "drawing_outside");
    }

    return { noteId: note.id, status: "mapped", startFrame: start, endFrame: end, drawingFrame, shortened };
  });
}
