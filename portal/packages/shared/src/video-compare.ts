/*
 * Portions ported from FreeFrame (https://github.com/Techiebutler/freeframe, commit e9c6e2c), Copyright (c) 2026 Techiebutler
 *
 * MIT License
 *
 * Copyright (c) 2026 Techiebutler
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Rational } from "./video-rational";

/** One side of a version compare: its exact frame rate and length in frames. */
export type CompareSide = { fps: Rational; frameCount: number };

/** Shared-timeline layout, in seconds: how long each side waits before it starts, and the total span. */
export type CompareClock = { leadA: number; leadB: number; totalSeconds: number };

function durationSeconds(side: CompareSide): number {
  return (side.frameCount * side.fps.den) / side.fps.num;
}

/**
 * Lays both sides on one timeline. `offsetFramesB` is in B frames: positive means B starts
 * that many B-frames later, negative means A starts later (by that many B-frames' time).
 */
export function compareClock(a: CompareSide, b: CompareSide, offsetFramesB: number): CompareClock {
  const offsetSeconds = (offsetFramesB * b.fps.den) / b.fps.num;
  const leadA = offsetSeconds < 0 ? -offsetSeconds : 0;
  const leadB = offsetSeconds > 0 ? offsetSeconds : 0;
  return { leadA, leadB, totalSeconds: Math.max(leadA + durationSeconds(a), leadB + durationSeconds(b)) };
}

/**
 * Transport time to this side's media time. Holds the first frame before the side starts and
 * parks in the middle of the last frame after it ends, never at the exact duration (which
 * browsers may show as nothing or as the frame past the end).
 */
export function sideLocalSeconds(t: number, lead: number, side: CompareSide): number {
  if (side.frameCount <= 0) return 0;
  const lastFrameMiddle = ((side.frameCount - 0.5) * side.fps.den) / side.fps.num;
  return Math.min(Math.max(t - lead, 0), lastFrameMiddle);
}

export function sideNotStarted(t: number, lead: number): boolean {
  return t < lead;
}

export function sideEnded(t: number, lead: number, side: CompareSide): boolean {
  return t >= lead + durationSeconds(side);
}

/** Position of a note marker on the shared scrubber, clamped to [0, 1]. */
export function markerPosition(frame: number, side: CompareSide, lead: number, total: number): number {
  if (total <= 0) return 0;
  const at = lead + (frame * side.fps.den) / side.fps.num;
  return Math.min(Math.max(at / total, 0), 1);
}

/** Drift (seconds) tolerated between the two videos while playing. */
export const DRIFT_PLAYING_SECONDS = 0.05;

/** Drift tolerated while paused: one frame of this side. */
export function pausedDriftTolerance(fps: Rational): number {
  return fps.den / fps.num;
}

/** True when a slaved video has drifted past `tolerance` seconds (exclusive). */
export function driftedBeyond(expected: number, actual: number, tolerance: number): boolean {
  return Math.abs(actual - expected) > tolerance;
}
