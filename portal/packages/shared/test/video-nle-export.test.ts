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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDL_MAX_EVENTS,
  buildMarkers,
  rational,
  toFcpxml19,
  toResolveEdl,
  xmlEscapeAttr,
  type ExportContext,
  type ExportNote,
  type Marker,
} from "../src";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/nle/${name}`, import.meta.url), "utf8");

const FPS25 = rational(25, 1);
const NDF25 = { nominalFps: 25, dropFrame: false };
const START_0100 = 25 * 3600; // 01:00:00:00 at 25 fps

function ctx(over: Partial<ExportContext> = {}): ExportContext {
  return {
    fps: FPS25,
    base: NDF25,
    startFrames: START_0100,
    title: "Demo Asset",
    width: 1920,
    height: 1080,
    frameCount: 1500,
    includeInternal: true,
    ...over,
  };
}

let seq = 0;
function note(over: Partial<ExportNote> = {}): ExportNote {
  seq += 1;
  return {
    id: `n${String(seq).padStart(3, "0")}`,
    parentId: null,
    authorName: "Jane",
    body: "Note",
    startFrame: 0,
    endFrame: null,
    resolved: false,
    visibility: "public",
    createdAt: seq,
    ...over,
  };
}

function marker(over: Partial<Marker> = {}): Marker {
  return { frame: 63, durationFrames: 1, name: "Jane: Fix the logo", note: "", resolved: false, ...over };
}

describe("buildMarkers", () => {
  it("folds nested replies into the parent's note in creation order, then id", () => {
    const root = note({ id: "r", startFrame: 63, body: "Fix the logo" });
    const b = note({ id: "b", parentId: "r", startFrame: null, authorName: "Bob", body: "Agreed", createdAt: 10 });
    const a = note({ id: "a", parentId: "r", startFrame: null, authorName: "Jane", body: "Done", createdAt: 10 });
    const [m] = buildMarkers([b, a, root], ctx());
    expect(m).toEqual({
      frame: 63,
      durationFrames: 1,
      name: "Jane: Fix the logo",
      note: "— Jane: Done\n— Bob: Agreed",
      resolved: false,
    });
  });

  it("drops internal roots and all their replies when includeInternal is false", () => {
    const internal = note({ id: "i", visibility: "internal", startFrame: 5 });
    const internalReply = note({ id: "ir", parentId: "i", startFrame: null, visibility: "internal" });
    const pub = note({ id: "p", startFrame: 9, body: "Public" });
    const reply = note({ id: "pr", parentId: "p", startFrame: null, authorName: "Bob", body: "Yes" });
    const ms = buildMarkers([internal, internalReply, pub, reply], ctx({ includeInternal: false }));
    expect(ms.map((m) => m.frame)).toEqual([9]);
    expect(ms[0]?.note).toBe("— Bob: Yes");
    expect(buildMarkers([internal, internalReply, pub, reply], ctx({ includeInternal: true }))).toHaveLength(2);
  });

  it("keeps a reply under a public root even if the reply row says internal (visibility is inherited)", () => {
    const pub = note({ id: "p", startFrame: 9 });
    const reply = note({ id: "pr", parentId: "p", startFrame: null, visibility: "internal", authorName: "Bob", body: "Hi" });
    const [m] = buildMarkers([pub, reply], ctx({ includeInternal: false }));
    expect(m?.note).toBe("— Bob: Hi");
  });

  it("merges notes on the same start frame in createdAt then id order", () => {
    const late = note({ id: "a", startFrame: 40, body: "B", createdAt: 20 });
    const early = note({ id: "z", startFrame: 40, body: "A", createdAt: 10 });
    const ms = buildMarkers([late, early], ctx());
    expect(ms).toHaveLength(1);
    expect(ms[0]?.name).toBe("Jane: A — Jane: B");
  });

  it("uses the longest range as the duration and 1 for points", () => {
    const range = note({ startFrame: 25, endFrame: 75 });
    const longer = note({ startFrame: 25, endFrame: 100 });
    const point = note({ startFrame: 200 });
    const ms = buildMarkers([range, longer, point], ctx());
    expect(ms.map((m) => [m.frame, m.durationFrames])).toEqual([
      [25, 75],
      [200, 1],
    ]);
  });

  it("is resolved only when every merged root is resolved", () => {
    const a = note({ startFrame: 7, resolved: true });
    const b = note({ startFrame: 7, resolved: false });
    const c = note({ startFrame: 8, resolved: true });
    const ms = buildMarkers([a, b, c], ctx());
    expect(ms.map((m) => m.resolved)).toEqual([false, true]);
  });

  it("sorts markers by frame and ignores un-timed roots", () => {
    const ms = buildMarkers([note({ startFrame: 9 }), note({ startFrame: 2 })], ctx());
    expect(ms.map((m) => m.frame)).toEqual([2, 9]);
  });
});

describe("toResolveEdl", () => {
  it("matches the FreeFrame 25 fps golden at the 01:00:00:00 default start", () => {
    const r = toResolveEdl([marker()], ctx());
    expect(r).toEqual({ ok: true, text: fixture("edl-25fps.txt"), count: 1 });
  });

  it("uses the tmcd start instead of the default when the source has one", () => {
    const r = toResolveEdl([marker({ frame: 0 })], ctx({ startFrames: 25 * 60 }));
    expect(r.ok && r.text).toContain("00:01:00:00 00:01:00:01");
  });

  it("writes the drop-frame header and semicolons at 29.97", () => {
    const base = { nominalFps: 30, dropFrame: true };
    const r = toResolveEdl([marker({ frame: 1800 })], ctx({ fps: rational(30000, 1001), base, startFrames: 0 }));
    expect(r.ok && r.text).toContain("FCM: DROP FRAME");
    expect(r.ok && r.text).toContain("00:01:00;02");
  });

  it("sanitises pipes, newlines and a leading digit", () => {
    const r = toResolveEdl([marker({ name: "2nd pass | fix\nthis\r\nnow", note: "— Bob: ok" })], ctx({ startFrames: 0 }));
    if (!r.ok) throw new Error("expected ok");
    const line = r.text.split("\n").find((l) => l.startsWith(" |C:")) ?? "";
    expect(line).toContain("|M:_2nd pass / fix this now — — Bob: ok |D:1");
    expect(line.match(/\|/g)).toHaveLength(3);
  });

  it("is green for resolved and keeps the range duration", () => {
    const r = toResolveEdl([marker({ durationFrames: 50, resolved: true })], ctx());
    expect(r.ok && r.text).toContain("|C:ResolveColorGreen");
    expect(r.ok && r.text).toContain("|D:50");
  });

  it("accepts exactly 999 markers", () => {
    const ms = Array.from({ length: EDL_MAX_EVENTS }, (_, i) => marker({ frame: i }));
    const r = toResolveEdl(ms, ctx());
    expect(r.ok && r.count).toBe(999);
    expect(r.ok && r.text.match(/\|M:/g)).toHaveLength(999);
  });

  it("refuses 1000 markers with a typed error and never truncates", () => {
    const ms = Array.from({ length: 1000 }, (_, i) => marker({ frame: i }));
    expect(toResolveEdl(ms, ctx())).toEqual({ ok: false, reason: "too_many_markers", count: 1000, limit: 999 });
  });

  it("preserves emoji, CJK and RTL text", () => {
    const name = "Jane: 🎬 修正 שלום";
    const r = toResolveEdl([marker({ name })], ctx());
    expect(r.ok && r.text).toContain(`|M:${name} |D:1`);
  });
});

describe("toFcpxml19", () => {
  it("matches the golden", () => {
    expect(toFcpxml19([marker()], ctx())).toBe(fixture("fcpxml-25fps.xml"));
  });

  it("uses the real 3840x2160 size", () => {
    const xml = toFcpxml19([], ctx({ width: 3840, height: 2160 }));
    expect(xml).toContain('width="3840" height="2160"');
    expect(xml).toContain('name="FFVideoFormat3840x2160p25"');
    expect(xml).not.toContain("1920");
  });

  it("writes the exact NTSC frameDuration, DF format and rational times", () => {
    const base = { nominalFps: 30, dropFrame: true };
    const xml = toFcpxml19([marker({ frame: 100, resolved: true, note: "— Bob: ok" })], ctx({ fps: rational(30000, 1001), base, startFrames: 0, frameCount: 3000 }));
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).toContain('tcFormat="DF"');
    expect(xml).toContain('tcStart="0s"');
    expect(xml).toContain('duration="3003000/30000s"');
    expect(xml).toContain('start="100100/30000s"');
    expect(xml).toContain('completed="1"');
    expect(xml).toContain('note="— Bob: ok"');
  });

  it("omits completed for open markers and the note when empty", () => {
    const xml = toFcpxml19([marker()], ctx());
    expect(xml).not.toContain("completed");
    expect(xml).not.toContain("note=");
  });

  it("gap spans the whole frameCount", () => {
    expect(toFcpxml19([marker()], ctx({ frameCount: 1500 }))).toContain('duration="1500/25s"');
  });

  it("escapes & < \" and newlines, keeps emoji/CJK/RTL, strips U+0001", () => {
    const xml = toFcpxml19([marker({ name: 'A & B < C " D\nE 🎬 修正 שלום\u0001F' })], ctx());
    expect(xml).toContain('value="A &amp; B &lt; C &quot; D&#10;E 🎬 修正 שלוםF"');
    expect(xml).not.toContain("\u0001");
  });
});

describe("xmlEscapeAttr", () => {
  it("escapes the XML specials, whitespace controls and strips illegal code points", () => {
    expect(xmlEscapeAttr(`&<>"'\n\t\r`)).toBe("&amp;&lt;&gt;&quot;&apos;&#10;&#9;&#13;");
    expect(xmlEscapeAttr("a\u0001b\u0008c\u000Bd\uFFFEe\uD800f")).toBe("abcdef");
    expect(xmlEscapeAttr("😀")).toBe("😀");
  });
});
