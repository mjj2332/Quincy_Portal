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

/** Geometry of a laid-out replaced element (<img> or <video>), read off the DOM. */
export interface MediaFrameMetrics {
  /** Intrinsic size. Both 0 until the media has loaded. */
  naturalWidth: number;
  naturalHeight: number;
  /** The element's own laid-out box (offsetWidth/offsetHeight). */
  elementWidth: number;
  elementHeight: number;
  /** Where that box sits inside the nearest positioned ancestor. */
  offsetLeft: number;
  offsetTop: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The centred, aspect-preserving sub-box `object-fit: contain` produces when fitting content
 * into a box. `left`/`top` are relative to the box's own origin.
 *
 * Compares aspect ratios by cross-multiplying rather than dividing, so an exact fit (a 16:9
 * frame in a 16:9 box) stays exact instead of drifting a fraction of a pixel through an
 * intermediate ratio.
 *
 * Assumes all four dimensions are non-zero; callers guard degenerate input.
 */
export function containBox(
  contentWidth: number,
  contentHeight: number,
  boxWidth: number,
  boxHeight: number,
): Box {
  const contentIsWider = contentWidth * boxHeight > contentHeight * boxWidth;

  const width = contentIsWider ? boxWidth : (boxHeight * contentWidth) / contentHeight;
  const height = contentIsWider ? (boxWidth * contentHeight) / contentWidth : boxHeight;

  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

/**
 * The box the picture actually occupies, in the coordinate space of the element's offsetParent,
 * excluding the empty bands `object-fit: contain` leaves behind.
 *
 * Markup must be authored and displayed in THIS box rather than the container's, or the same
 * drawing lands somewhere else whenever the container's aspect ratio changes.
 *
 * Measured from the ELEMENT's box, not the container's: `max-w-full max-h-full` elements already
 * hug the picture, while `w-full h-full` elements (a <video>) letterbox the picture inside.
 * Running the contain fit inside the element's own box is correct for both.
 */
export function renderedMediaBox({
  naturalWidth,
  naturalHeight,
  elementWidth,
  elementHeight,
  offsetLeft,
  offsetTop,
}: MediaFrameMetrics): Box | null {
  // Not laid out yet: there is no box to report.
  if (!elementWidth || !elementHeight) return null;

  // Not decoded yet: the element box is the best available answer, and the caller recalculates on load.
  if (!naturalWidth || !naturalHeight) {
    return { left: offsetLeft, top: offsetTop, width: elementWidth, height: elementHeight };
  }

  const box = containBox(naturalWidth, naturalHeight, elementWidth, elementHeight);

  return {
    left: offsetLeft + box.left,
    top: offsetTop + box.top,
    width: box.width,
    height: box.height,
  };
}

/**
 * A pointer position as a fraction of `box`, clamped to [0, 1] and rounded to 4 decimal places
 * (the same rule as the photo lightbox). `box` and the pointer must share a coordinate space;
 * a degenerate box maps to the origin.
 */
export function toNormalizedPoint(clientX: number, clientY: number, box: Box): { x: number; y: number } {
  if (!(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0 };
  const norm = (value: number) => Math.max(0, Math.min(1, Number(value.toFixed(4))));
  return { x: norm((clientX - box.left) / box.width), y: norm((clientY - box.top) / box.height) };
}

/**
 * Like toNormalizedPoint, but null when the pointer is in the letterbox/pillarbox, i.e. outside
 * the picture. `pictureBox` is the renderedMediaBox translated into the pointer's coordinate space.
 */
export function picturePoint(
  clientX: number,
  clientY: number,
  pictureBox: Box,
): { x: number; y: number } | null {
  if (!(pictureBox.width > 0) || !(pictureBox.height > 0)) return null;
  if (
    clientX < pictureBox.left ||
    clientX > pictureBox.left + pictureBox.width ||
    clientY < pictureBox.top ||
    clientY > pictureBox.top + pictureBox.height
  ) {
    return null;
  }
  return toNormalizedPoint(clientX, clientY, pictureBox);
}
