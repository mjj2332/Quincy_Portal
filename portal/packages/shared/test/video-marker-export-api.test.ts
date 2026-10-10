import { describe, expect, it } from "vitest";
import {
  MARKER_EXPORT_COUNT_HEADER,
  buildMarkers,
  exportFrameViolations,
  exportNotesFromThreads,
  markerExportContentDisposition,
  markerExportFilename,
  parseMarkerExportQuery,
  rational,
  type ExportContext,
  type ExportSourceNote,
} from "../src";

const q = (s: string) => parseMarkerExportQuery(new URLSearchParams(s));
const ctx: ExportContext = { fps: rational(25, 1), base: { nominalFps: 25, dropFrame: false }, startFrames: 0, title: "t", width: 1920, height: 1080, frameCount: 250, includeInternal: true };

let n = 0;
const note = (o: Partial<ExportSourceNote> = {}): ExportSourceNote => ({
  id: `n${++n}`, parentId: null, authorName: "Ann", body: "Body", startFrame: 10, endFrame: null, resolved: false, visibility: "public", createdAt: 1000 + n, deleted: false, ...o,
});

describe("parseMarkerExportQuery", () => {
  it("requires a format and applies the defaults", () => {
    expect(q("format=edl")).toEqual({ ok: true, value: { format: "edl", includeInternal: false, status: "all" } });
    expect(q("format=fcpxml&includeInternal=true&status=open")).toEqual({ ok: true, value: { format: "fcpxml", includeInternal: true, status: "open" } });
  });
  it("rejects a missing format, unsupported values, unknown and repeated parameters", () => {
    for (const bad of ["", "format=csv", "format=edl&includeInternal=1", "format=edl&status=done", "format=edl&x=1", "format=edl&format=fcpxml", "format=edl&status=open&status=all", "format=EDL"])
      expect(q(bad).ok, bad).toBe(false);
  });
});

describe("markerExportFilename", () => {
  const base = { title: "Walkthrough", version: 2, status: "all", includeInternal: false, format: "edl" } as const;
  it("follows <title>-v<N>-notes-<status>-<public|with-internal>.<ext>", () => {
    expect(markerExportFilename(base).filename).toBe("Walkthrough-v2-notes-all-public.edl");
    expect(markerExportFilename({ ...base, status: "resolved", includeInternal: true, format: "fcpxml" }).filename).toBe("Walkthrough-v2-notes-resolved-with-internal.fcpxml");
  });
  it("strips separators, controls and bidi controls, trims dots and spaces, and falls back to video", () => {
    expect(markerExportFilename({ ...base, title: "  ..a/b\\c:d*e?f\"g<h>i|j\u0000k‮l..  " }).filename).toMatch(/^a_b_c_d_e_f_g_h_i_jkl-v2-/);
    expect(markerExportFilename({ ...base, title: "..." }).filename).toBe("video-v2-notes-all-public.edl");
  });
  it("bounds the title to 120 UTF-8 bytes without splitting a code point", () => {
    const { filename } = markerExportFilename({ ...base, title: "日".repeat(100) });
    const title = filename.split("-v2-")[0]!;
    expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(120);
    expect(title).toBe("日".repeat(40));
    expect(title).not.toContain("�");
  });
  it("normalises to NFC", () => {
    expect(markerExportFilename({ ...base, title: "é" }).filename.startsWith("é-v2")).toBe(true);
  });
  it("builds an ASCII fallback and an RFC 5987 header", () => {
    const header = markerExportContentDisposition({ ...base, title: "Café 日本 'x' (1)" });
    expect(header).toBe(`attachment; filename="Caf_ __ 'x' (1)-v2-notes-all-public.edl"; filename*=UTF-8''Caf%C3%A9%20%E6%97%A5%E6%9C%AC%20%27x%27%20%281%29-v2-notes-all-public.edl`);
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
  });
  it("names the count header", () => { expect(MARKER_EXPORT_COUNT_HEADER).toBe("X-Marker-Count"); });
});

describe("exportNotesFromThreads", () => {
  const opts = { includeInternal: false, status: "all" } as const;
  it("drops internal roots and their replies unless asked", () => {
    const root = note({ visibility: "internal" }); const reply = note({ parentId: root.id, startFrame: null, visibility: "internal" });
    expect(exportNotesFromThreads([root, reply], opts)).toEqual([]);
    expect(exportNotesFromThreads([root, reply], { ...opts, includeInternal: true }).map((x) => x.id)).toEqual([root.id, reply.id]);
  });
  it("filters by the root's status and keeps its replies", () => {
    const open = note(); const done = note({ resolved: true }); const reply = note({ parentId: done.id, startFrame: null });
    expect(exportNotesFromThreads([open, done, reply], { ...opts, status: "resolved" }).map((x) => x.id)).toEqual([done.id, reply.id]);
    expect(exportNotesFromThreads([open, done, reply], { ...opts, status: "open" }).map((x) => x.id)).toEqual([open.id]);
  });
  it("excludes a deleted root with no live replies, and always deleted replies", () => {
    const gone = note({ deleted: true, body: "" }); const goneReply = note({ parentId: gone.id, startFrame: null, deleted: true });
    const live = note(); const deadReply = note({ parentId: live.id, startFrame: null, deleted: true });
    expect(exportNotesFromThreads([gone, goneReply, live, deadReply], opts).map((x) => x.id)).toEqual([live.id]);
  });
  it("keeps a deleted root that still has live replies as 'Note deleted'", () => {
    const gone = note({ deleted: true, body: "" }); const reply = note({ parentId: gone.id, startFrame: null, body: "Still here" });
    const out = exportNotesFromThreads([gone, reply], opts);
    expect(out.map((x) => x.id)).toEqual([gone.id, reply.id]);
    const [marker] = buildMarkers(out, ctx);
    expect(marker!.name).toBe("Note deleted");
    expect(marker!.note).toBe("— Ann: Still here");
  });
  it("applies visibility and status to a tombstone through its root", () => {
    const gone = note({ deleted: true, visibility: "internal" }); const reply = note({ parentId: gone.id, startFrame: null });
    expect(exportNotesFromThreads([gone, reply], opts)).toEqual([]);
  });
});

describe("exportFrameViolations", () => {
  it("counts roots whose frames fall outside [0, frameCount)", () => {
    const ok = [note({ startFrame: 0 }), note({ startFrame: 249 }), note({ startFrame: 10, endFrame: 250 })];
    expect(exportFrameViolations(ok, 250)).toBe(0);
    const bad = [note({ startFrame: 250 }), note({ startFrame: -1 }), note({ startFrame: 1.5 }), note({ startFrame: 10, endFrame: 251 }), note({ startFrame: 10, endFrame: 10 }), note({ startFrame: 5 })];
    expect(exportFrameViolations(bad, 250)).toBe(5);
  });
  it("ignores replies", () => { expect(exportFrameViolations([note({ parentId: "x", startFrame: null })], 250)).toBe(0); });
});
