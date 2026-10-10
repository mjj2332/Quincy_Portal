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

// --- Compare transport maths (#741 7b). Exact integer arithmetic on the rational frame rates: no float touches a frame index. ---

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/** B's frame at the middle of A's frame `a`, with no offset applied. */
function bRaw(a: number, fpsA: Rational, fpsB: Rational): number {
  return Number(floorDiv(BigInt(2 * a + 1) * BigInt(fpsA.den) * BigInt(fpsB.num), 2n * BigInt(fpsA.num) * BigInt(fpsB.den)));
}

/** B's local frame shown with A on frame `a`, when B starts `d` B-frames later. Equal rates reduce to `a - d`. */
export function bOf(a: number, d: number, fpsA: Rational, fpsB: Rational): number {
  return bRaw(a, fpsA, fpsB) - d;
}

/** A's local frame shown with B on frame `b` (the inverse of `bOf`, to within one frame). */
export function aOf(b: number, d: number, fpsA: Rational, fpsB: Rational): number {
  return Number(floorDiv(BigInt(2 * (b + d) + 1) * BigInt(fpsB.den) * BigInt(fpsA.num), 2n * BigInt(fpsB.num) * BigInt(fpsA.den)));
}

/**
 * The span of shared positions (A's local frame indices, which may lie outside A's own range) in which at least one side has a frame.
 * It is tight: the mapping rounds, so the ends are found by stepping from the mapped estimate until B's frame is exactly the first or
 * last one, and a position beyond either end shows no frame on either side.
 */
export function compareDomain(a: CompareSide, b: CompareSide, d: number): { start: number; end: number } {
  let lo = aOf(0, d, a.fps, b.fps);
  for (let i = 0; i < 1000 && bOf(lo - 1, d, a.fps, b.fps) >= 0; i++) lo--;
  for (let i = 0; i < 1000 && bOf(lo, d, a.fps, b.fps) < 0; i++) lo++;
  let hi = aOf(b.frameCount - 1, d, a.fps, b.fps);
  for (let i = 0; i < 1000 && bOf(hi + 1, d, a.fps, b.fps) <= b.frameCount - 1; i++) hi++;
  for (let i = 0; i < 1000 && bOf(hi, d, a.fps, b.fps) > b.frameCount - 1; i++) hi--;
  return { start: Math.min(0, lo), end: Math.max(a.frameCount - 1, hi) };
}

/** Offsets (B frames) that leave at least one frame of overlap between the two sides. */
export function offsetBounds(a: CompareSide, b: CompareSide): { min: number; max: number } {
  return {
    min: bRaw(0, a.fps, b.fps) - (b.frameCount - 1),
    max: bRaw(a.frameCount - 1, a.fps, b.fps),
  };
}

/** Where a side stands for a local frame: not started, playing its own range, on its last frame, or past it. */
export type SidePhase = "before" | "live" | "last" | "after";

export function phase(local: number, lastFrame: number): SidePhase {
  if (local < 0) return "before";
  if (local < lastFrame) return "live";
  return local === lastFrame ? "last" : "after";
}

/** Kill switch: set to 0 to correct drift by seeking only, never by trimming `playbackRate`. */
export const COMPARE_RATE_TRIM = 1;
/** How far the follower's `playbackRate` is nudged. */
export const COMPARE_TRIM_FACTOR = 0.05;

export type DriftDecision =
  | { action: "none" }
  | { action: "trim"; factor: number }
  | { action: "release" }
  | { action: "seek" };

/** Median of the last three drift samples (fewer samples: the median of what there is). */
export function medianOfLastThree(samples: readonly number[]): number {
  const last = samples.slice(-3).sort((x, y) => x - y);
  return last.length === 0 ? 0 : last[Math.floor(last.length / 2)]!;
}

/**
 * What to do about a follower that has drifted `driftSeconds` from where the master says it should be (positive: the follower is ahead).
 * `tol = max(50 ms, 1 follower frame)`; between `tol` and `hard = 0.5 s x max(1, rate)` the follower's rate is trimmed 5% toward the
 * master and released once the drift is under `tol / 2`; beyond `hard` it is seeked. With the kill switch off every drift past `tol` seeks.
 * `trimmed` is the factor now applied (1 for none).
 */
export function driftDecision(input: { driftSeconds: number; followerFps: Rational; rate: number; trimmed: number; trimEnabled?: boolean }): DriftDecision {
  const { driftSeconds, followerFps, rate, trimmed, trimEnabled = (COMPARE_RATE_TRIM as number) !== 0 } = input;
  const size = Math.abs(driftSeconds);
  const tol = Math.max(DRIFT_PLAYING_SECONDS, followerFps.den / followerFps.num);
  const hard = 0.5 * Math.max(1, Math.abs(rate));
  if (size > hard) return { action: "seek" };
  if (!trimEnabled) return size > tol ? { action: "seek" } : { action: "none" };
  const wanted = driftSeconds > 0 ? 1 - COMPARE_TRIM_FACTOR : 1 + COMPARE_TRIM_FACTOR;
  if (trimmed !== 1) return size < tol / 2 ? { action: "release" } : { action: "trim", factor: wanted };
  return size > tol ? { action: "trim", factor: wanted } : { action: "none" };
}
