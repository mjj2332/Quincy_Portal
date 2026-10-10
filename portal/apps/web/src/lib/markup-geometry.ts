/**
 * Arrowhead and rectangle geometry for photo markup (#741 slice 6s-api).
 *
 * The arrowhead angle maths (an `atan2` of the drag, base points at the direction ± PI/6, the apex on the end point) and the
 * rectangle min/abs normalisation are ported from FreeFrame's `apps/web/hooks/use-drawing.ts`, rewritten for this module:
 * the head is computed in measured PIXELS (a head authored in 0..1 would be skewed by the picture's aspect ratio under
 * `preserveAspectRatio="none"`), sized by the stroke width, and the shaft stops at the head's base.
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
import type { FreehandPoint } from "@quincy/shared";

export interface MeasuredBox { width: number; height: number }

const HEAD_HALF_ANGLE = Math.PI / 6;

/**
 * An arrow's head as a triangle [apex, base one, base two] and where the shaft should end (the base's centre), all as
 * 0..1 fractions. `null` when the arrow has no length or the layer has not been measured: the caller then draws a plain line.
 * The head side is `3 * width + 8` px (at least 12 px), but never more than 60% of the shaft.
 */
export function arrowGeometry(start: FreehandPoint, end: FreehandPoint, widthPx: number, box: MeasuredBox): { head: [FreehandPoint, FreehandPoint, FreehandPoint]; shaftEnd: FreehandPoint } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const x1 = start.x * box.width; const y1 = start.y * box.height;
  const x2 = end.x * box.width; const y2 = end.y * box.height;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (!(length > 0)) return null;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const side = Math.min(Math.max(3 * widthPx + 8, 12), 0.6 * length);
  const toFraction = (x: number, y: number): FreehandPoint => ({ x: x / box.width, y: y / box.height });
  const reach = side * Math.cos(HEAD_HALF_ANGLE);
  return {
    head: [
      { x: end.x, y: end.y },
      toFraction(x2 - side * Math.cos(angle - HEAD_HALF_ANGLE), y2 - side * Math.sin(angle - HEAD_HALF_ANGLE)),
      toFraction(x2 - side * Math.cos(angle + HEAD_HALF_ANGLE), y2 - side * Math.sin(angle + HEAD_HALF_ANGLE)),
    ],
    shaftEnd: toFraction(x2 - reach * Math.cos(angle), y2 - reach * Math.sin(angle)),
  };
}

/** A rectangle from any two opposite corners: the same box whichever way it was dragged. */
export function normaliseRect(a: FreehandPoint, b: FreehandPoint): { x: number; y: number; width: number; height: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
