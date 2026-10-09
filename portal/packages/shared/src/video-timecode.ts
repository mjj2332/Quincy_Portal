import { type Rational, rationalToNumber } from "./video-rational";

/** SMPTE label base: the integer frames-per-second count and whether labels skip (drop-frame). */
export type TimecodeBase = Readonly<{ nominalFps: number; dropFrame: boolean }>;

/** Start timecode an export uses when the source file carries no tmcd track. */
export const DEFAULT_EXPORT_START_TIMECODE = "01:00:00:00";

/** Relative tolerance for "is this an NTSC rate": accepts QuickTime-style 2997/100 as well as 30000/1001. */
const NTSC_TOLERANCE = 0.0005;

function nominalOf(fps: Rational): number {
  return Math.round(rationalToNumber(fps));
}

/** True for n*1000/1001 rates (23.976, 29.97, 59.94 ...), within 0.05%. */
export function isNtscRate(fps: Rational): boolean {
  const n = nominalOf(fps);
  if (n < 1) return false;
  const target = (n * 1000) / 1001;
  return Math.abs(rationalToNumber(fps) - target) / target <= NTSC_TOLERANCE;
}

/** Drop-frame only when the file's tmcd says so AND the rate is a 30/60 nominal NTSC rate. */
export function timecodeBaseFor(fps: Rational, tmcdDropFrame: boolean | null): TimecodeBase {
  const nominalFps = nominalOf(fps);
  const dropFrame =
    tmcdDropFrame === true && (nominalFps === 30 || nominalFps === 60) && isNtscRate(fps);
  return { nominalFps, dropFrame };
}

/** Start of frame `frame`, in seconds. */
export function frameStartSeconds(frame: number, fps: Rational): number {
  return (frame * fps.den) / fps.num;
}

/** Middle of frame `frame`: the time to seek to so the browser lands on that frame, not the one before. */
export function frameSeekSeconds(frame: number, fps: Rational): number {
  return ((frame + 0.5) * fps.den) / fps.num;
}

/** Frame for a requestVideoFrameCallback `mediaTime` (a frame's presentation time, so round). */
export function frameAtPresentationTime(mediaTime: number, fps: Rational): number {
  return Math.max(0, Math.round((mediaTime * fps.num) / fps.den));
}

/** Frame containing `seconds` (for a `currentTime` fallback). Floors, with an epsilon for float error. */
export function frameContainingTime(seconds: number, fps: Rational): number {
  return Math.max(0, Math.floor((seconds * fps.num) / fps.den + 1e-6));
}

function dropCount(base: TimecodeBase): number {
  return base.nominalFps / 15; // 30 -> 2, 60 -> 4
}

function framesPer24h(base: TimecodeBase): number {
  const nominalTotal = base.nominalFps * 86400;
  if (!base.dropFrame) return nominalTotal;
  return nominalTotal - dropCount(base) * (1440 - 144);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** SMPTE label for `frame` (plus an optional start offset). ';' before the frames for drop-frame. Wraps at 24h. */
export function framesToTimecode(frame: number, base: TimecodeBase, startFrames = 0): string {
  const cycle = framesPer24h(base);
  let total = (Math.trunc(frame) + Math.trunc(startFrames)) % cycle;
  if (total < 0) total += cycle;
  const nominal = base.nominalFps;
  if (base.dropFrame) {
    const drop = dropCount(base);
    const perMinute = nominal * 60 - drop;
    const perTenMinutes = nominal * 600 - drop * 9;
    const tens = Math.floor(total / perTenMinutes);
    const rest = total % perTenMinutes;
    total += 9 * drop * tens;
    if (rest >= drop) total += drop * Math.floor((rest - drop) / perMinute);
  }
  const ff = total % nominal;
  const ss = Math.floor(total / nominal) % 60;
  const mm = Math.floor(total / (nominal * 60)) % 60;
  const hh = Math.floor(total / (nominal * 3600));
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${base.dropFrame ? ";" : ":"}${pad2(ff)}`;
}

/**
 * Parses an SMPTE label to an absolute frame count (the caller subtracts any start offset).
 * Returns null for malformed labels and for drop-frame labels that do not exist (00:01:00;00).
 */
export function timecodeToFrames(tc: string, base: TimecodeBase): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc.trim());
  if (!m) return null;
  const [hh, mm, ss, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const nominal = base.nominalFps;
  if (hh > 23 || mm > 59 || ss > 59 || ff >= nominal) return null;
  const totalMinutes = hh * 60 + mm;
  let frames = (totalMinutes * 60 + ss) * nominal + ff;
  if (base.dropFrame) {
    const drop = dropCount(base);
    if (ss === 0 && ff < drop && mm % 10 !== 0) return null;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}
