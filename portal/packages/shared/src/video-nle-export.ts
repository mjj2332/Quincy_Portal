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

import { type Rational } from "./video-rational";
import { type TimecodeBase, framesToTimecode, isNtscRate } from "./video-timecode";

/** A note as the exporter sees it. Frames are integers on the Version's own frame grid; ranges are half-open [start, end). */
export type ExportNote = {
  id: string;
  parentId: string | null;
  authorName: string;
  body: string;
  /** Null for a reply: it exports folded into its parent's marker. */
  startFrame: number | null;
  endFrame: number | null;
  resolved: boolean;
  visibility: "public" | "internal";
  createdAt: number;
};

export type ExportContext = {
  fps: Rational;
  base: TimecodeBase;
  /**
   * Timecode of frame 0, in frames. The caller passes the file's tmcd start, or the frame count of
   * DEFAULT_EXPORT_START_TIMECODE (01:00:00:00) when the source has none; this module never guesses.
   */
  startFrames: number;
  title: string;
  width: number;
  height: number;
  frameCount: number;
  includeInternal: boolean;
};

export type Marker = { frame: number; durationFrames: number; name: string; note: string; resolved: boolean };

function byCreation(a: ExportNote, b: ExportNote): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Notes to markers. Replies fold into their parent's note; internal roots and all their replies drop
 * unless included (a reply's own visibility is ignored: it inherits its root's); notes on one start
 * frame merge into one marker.
 */
export function buildMarkers(notes: ExportNote[], ctx: ExportContext): Marker[] {
  const roots = notes
    .filter((n) => n.parentId === null && n.startFrame !== null)
    .filter((n) => ctx.includeInternal || n.visibility === "public")
    .sort(byCreation);
  const repliesByRoot = new Map<string, ExportNote[]>();
  for (const n of notes) {
    if (n.parentId === null) continue;
    const list = repliesByRoot.get(n.parentId) ?? [];
    list.push(n);
    repliesByRoot.set(n.parentId, list);
  }
  const byFrame = new Map<number, ExportNote[]>();
  for (const r of roots) {
    const frame = r.startFrame as number;
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), r]);
  }
  return [...byFrame.keys()]
    .sort((a, b) => a - b)
    .map((frame) => {
      const group = byFrame.get(frame) as ExportNote[];
      const replies = group.flatMap((r) => (repliesByRoot.get(r.id) ?? []).slice().sort(byCreation));
      const durations = group.map((r) => (r.endFrame !== null && r.endFrame > frame ? r.endFrame - frame : 1));
      return {
        frame,
        durationFrames: Math.max(...durations),
        name: group.map((r) => `${r.authorName}: ${r.body}`).join(" — "),
        note: replies.map((r) => `— ${r.authorName}: ${r.body}`).join("\n"),
        resolved: group.every((r) => r.resolved),
      };
    });
}

/** CMX 3600 event-number limit (three digits). */
export const EDL_MAX_EVENTS = 999;

/** XML 1.0 illegal code points: C0 controls other than tab/LF/CR, U+FFFE/FFFF, and unpaired surrogates. */
const XML_ILLEGAL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escapes text for a double-quoted XML attribute and strips code points XML 1.0 cannot carry. */
export function xmlEscapeAttr(value: string): string {
  return value
    .replace(XML_ILLEGAL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

/** One line, no pipes; Resolve ignores a marker whose text starts with a digit, so prefix `_`. */
function edlText(text: string): string {
  const oneLine = text.replace(XML_ILLEGAL, "").replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();
  return /^\d/.test(oneLine) ? `_${oneLine}` : oneLine;
}

/**
 * Resolve "Import Timeline Markers from EDL" dialect of CMX 3600: one event per marker, record in =
 * start TC + frame, out = in + 1 frame (Resolve needs out > in; the marker length is the `|D:` field).
 * UTF-8, LF line endings, no BOM. More than 999 markers is refused, never truncated.
 */
export function toResolveEdl(
  markers: Marker[],
  ctx: ExportContext,
): { ok: true; text: string; count: number } | { ok: false; reason: "too_many_markers"; count: number; limit: 999 } {
  if (markers.length > EDL_MAX_EVENTS) {
    return { ok: false, reason: "too_many_markers", count: markers.length, limit: 999 };
  }
  const title = ctx.title.replace(XML_ILLEGAL, "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  const lines = [`TITLE: ${title}`, `FCM: ${ctx.base.dropFrame ? "DROP FRAME" : "NON-DROP FRAME"}`, ""];
  markers.forEach((m, i) => {
    const recIn = framesToTimecode(m.frame, ctx.base, ctx.startFrames);
    const recOut = framesToTimecode(m.frame + 1, ctx.base, ctx.startFrames);
    const color = m.resolved ? "ResolveColorGreen" : "ResolveColorBlue";
    const text = edlText(m.note ? `${m.name} — ${m.note}` : m.name);
    lines.push(`${String(i + 1).padStart(3, "0")}  001      V     C        ${recIn} ${recOut} ${recIn} ${recOut}`);
    lines.push(` |C:${color} |M:${text} |D:${m.durationFrames}`);
  });
  return { ok: true, text: `${lines.join("\n")}\n`, count: markers.length };
}

/** Frames as FCPXML rational seconds, always a multiple of the frame duration. */
function timeOf(frames: number, fps: Rational): string {
  return frames === 0 ? "0s" : `${frames * fps.den}/${fps.num}s`;
}

/** FCP's format name, e.g. FFVideoFormat1080p2997 or FFVideoFormat3840x2160p25. */
function formatName(ctx: ExportContext): string {
  const { fps, width, height } = ctx;
  const nominal = Math.round(fps.num / fps.den);
  const ntsc = isNtscRate(fps);
  const rate = ntsc ? String(Math.round((nominal * 100000) / 1001)) : String(nominal);
  const size = width === 1920 && height === 1080 ? "1080" : `${width}x${height}`;
  return `FFVideoFormat${size}p${rate}`;
}

/**
 * FCPXML 1.9: one event/project/sequence with a single gap spanning the Version, markers on the gap.
 * UNVERIFIED until NLE import (Seam 3): the gap's offset = start = tcStart and the markers' start =
 * tcStart + frame. If Final Cut or Resolve reads those differently, this is the place to change.
 */
export function toFcpxml19(markers: Marker[], ctx: ExportContext): string {
  const { fps } = ctx;
  const tcStart = timeOf(ctx.startFrames, fps);
  const duration = timeOf(ctx.frameCount, fps);
  const markerLines = markers.map((m) => {
    const attrs = [
      `start="${timeOf(ctx.startFrames + m.frame, fps)}"`,
      `duration="${timeOf(m.durationFrames, fps)}"`,
      `value="${xmlEscapeAttr(m.name)}"`,
    ];
    if (m.note) attrs.push(`note="${xmlEscapeAttr(m.note)}"`);
    if (m.resolved) attrs.push('completed="1"');
    return `              <marker ${attrs.join(" ")}/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.9">',
    "  <resources>",
    `    <format id="r1" name="${formatName(ctx)}" frameDuration="${fps.den}/${fps.num}s" width="${ctx.width}" height="${ctx.height}"/>`,
    "  </resources>",
    "  <library>",
    '    <event name="Quincy Review Notes">',
    `      <project name="${xmlEscapeAttr(ctx.title)}">`,
    `        <sequence format="r1" duration="${duration}" tcStart="${tcStart}" tcFormat="${ctx.base.dropFrame ? "DF" : "NDF"}">`,
    "          <spine>",
    `            <gap name="Gap" offset="${tcStart}" start="${tcStart}" duration="${duration}">`,
    ...markerLines,
    "            </gap>",
    "          </spine>",
    "        </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  ].join("\n");
}
