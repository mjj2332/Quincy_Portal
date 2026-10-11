import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoNoteThreadDto } from "@quincy/shared";
import {
  filenameFromContentDisposition, markerExportCount, markerExportSummary, markerExportFailureMessage, markerExportUrl, requestMarkerExport, DEFAULT_MARKER_EXPORT_OPTIONS,
} from "./video-marker-export";

const P = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const person = { id: "x", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
let seq = 0;
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, assetId: A, parentId: null, author: { kind: "staff", person }, authorRole: "editor", visibility: "public",
  startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "b", deleted: false, resolved: null, revision: 1, createdAt: `2026-10-10T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  editedAt: null, copiedFrom: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;
const args = (fetchImpl: typeof fetch, signal = new AbortController().signal) => ({ projectId: P, assetId: A, title: "Film", version: 2, format: "edl" as const, options: DEFAULT_MARKER_EXPORT_OPTIONS, signal, fetchImpl });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.restoreAllMocks(); });

describe("markerExportUrl", () => {
  it("spells every option, defaults included", () => {
    expect(markerExportUrl(P, A, "edl", DEFAULT_MARKER_EXPORT_OPTIONS)).toBe(`/api/projects/${P}/video-versions/${A}/marker-export?format=edl&includeInternal=false&status=all`);
    expect(markerExportUrl(P, A, "fcpxml", { includeInternal: true, status: "resolved" })).toBe(`/api/projects/${P}/video-versions/${A}/marker-export?format=fcpxml&includeInternal=true&status=resolved`);
  });
});

describe("markerExportCount", () => {
  it("reports the notes behind the markers: two notes on one frame are one marker", () => {
    const summary = markerExportSummary([note({ startFrame: 10 }), note({ startFrame: 10 }), note({ startFrame: 20 })], DEFAULT_MARKER_EXPORT_OPTIONS);
    expect(summary).toEqual({ markers: 2, notes: 3 });
  });
  it("uses the shared selection: internal off by default, same-frame merge, tombstone with live replies kept", () => {
    const internal = note({ visibility: "internal", startFrame: 30 });
    const a = note({ startFrame: 10 }); const b = note({ startFrame: 10 });
    const resolved = note({ startFrame: 50, resolved: { at: "2026-10-10T00:00:00.000Z", by: person } });
    const tomb = note({ startFrame: 70, deleted: true, body: "" });
    const tombWithReply = { ...tomb, replies: [{ ...note({ parentId: tomb.id, startFrame: null }), replies: undefined }] } as unknown as VideoNoteThreadDto;
    const emptyTomb = note({ startFrame: 90, deleted: true, body: "" });
    const all = [internal, a, b, resolved, tombWithReply, emptyTomb];
    expect(markerExportCount(all, DEFAULT_MARKER_EXPORT_OPTIONS)).toBe(3); // frames 10 (merged), 50, 70
    expect(markerExportCount(all, { includeInternal: true, status: "all" })).toBe(4);
    expect(markerExportCount(all, { includeInternal: false, status: "open" })).toBe(2);
    expect(markerExportCount(all, { includeInternal: false, status: "resolved" })).toBe(1);
    expect(markerExportCount([], DEFAULT_MARKER_EXPORT_OPTIONS)).toBe(0);
  });
});

describe("filenameFromContentDisposition", () => {
  it("prefers the RFC 5987 name and decodes it", () => {
    expect(filenameFromContentDisposition(`attachment; filename="Caf_.edl"; filename*=UTF-8''Caf%C3%A9-v2.edl`)).toBe("Café-v2.edl");
  });
  it("falls back to the quoted name, strips paths, and is null when absent", () => {
    expect(filenameFromContentDisposition(`attachment; filename="../a/b.edl"`)).toBe("_a_b.edl");
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition("attachment")).toBeNull();
  });
});

describe("requestMarkerExport", () => {
  it("sends GET with credentials and the signal, and reads filename and count from the headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("TITLE", { status: 200, headers: { "content-disposition": `attachment; filename="x.edl"; filename*=UTF-8''Fran%C3%A7ais-v2-notes-all-public.edl`, "X-Marker-Count": "4" } }));
    const controller = new AbortController();
    const result = await requestMarkerExport(args(fetchImpl as unknown as typeof fetch, controller.signal));
    expect(fetchImpl).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/marker-export?format=edl&includeInternal=false&status=all`, { method: "GET", credentials: "include", signal: controller.signal });
    expect(result).toMatchObject({ ok: true, filename: "Français-v2-notes-all-public.edl", count: 4 });
    expect(result.ok && await result.blob.text()).toBe("TITLE");
  });
  it("accepts an empty file (count 0)", async () => {
    const result = await requestMarkerExport(args((async () => new Response("", { status: 200, headers: { "X-Marker-Count": "0" } })) as typeof fetch));
    expect(result).toMatchObject({ ok: true, count: 0 });
    expect(result.ok && result.blob.size).toBe(0);
  });
  it("falls back to the shared filename when the header is missing", async () => {
    const result = await requestMarkerExport(args((async () => new Response("x", { status: 200 })) as typeof fetch));
    expect(result).toMatchObject({ ok: true, filename: "Film-v2-notes-all-public.edl", count: null });
  });
  it.each([
    [422, { code: "too_many_markers", count: 1200, limit: 999 }, { kind: "overflow", count: 1200, limit: 999 }],
    [422, { code: "export_frames_out_of_range", count: 2 }, { kind: "range" }],
    [404, { error: "Not found" }, { kind: "unavailable" }],
    [403, { error: "Forbidden" }, { kind: "forbidden" }],
    [409, { code: "project_archived" }, { kind: "archived" }],
    [401, { error: "x" }, { kind: "unauthorized" }],
    [500, { error: "x" }, { kind: "failed" }],
  ])("status %i is a failure and never reaches a Blob", async (status, body, failure) => {
    const blob = vi.spyOn(Response.prototype, "blob");
    const result = await requestMarkerExport(args((async () => json(status, body)) as typeof fetch));
    expect(result).toEqual({ ok: false, failure });
    expect(blob).not.toHaveBeenCalled();
  });
  it("a network error is a retryable failure; an abort is neither", async () => {
    expect(await requestMarkerExport(args((async () => { throw new TypeError("offline"); }) as typeof fetch))).toEqual({ ok: false, failure: { kind: "failed" } });
    const controller = new AbortController();
    const fetchImpl = (async (_u: string, init: RequestInit) => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); void init; }) as unknown as typeof fetch;
    expect(await requestMarkerExport(args(fetchImpl, controller.signal))).toEqual({ ok: false, aborted: true });
  });
  it("an abort that lands after the body was read still discards the file", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => { const r = new Response("x", { status: 200 }); const blob = r.blob.bind(r); r.blob = async () => { const b = await blob(); controller.abort(); return b; }; return r; }) as typeof fetch;
    expect(await requestMarkerExport(args(fetchImpl, controller.signal))).toEqual({ ok: false, aborted: true });
  });
});

describe("markerExportFailureMessage", () => {
  it("uses the plan copy", () => {
    expect(markerExportFailureMessage({ kind: "overflow", count: 1200, limit: 999 })).toBe("This export has 1200 markers. Resolve EDL supports up to 999. Download FCPXML or choose fewer notes.");
    expect(markerExportFailureMessage({ kind: "archived" })).toBe("This Project is archived. Notes cannot be exported.");
  });
});
