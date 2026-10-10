import type { ExportNote } from "./video-nle-export";

/**
 * NLE marker export API (#741, 8): the query contract, the one note-selection function the worker and the web share, the frame check and the
 * filename builder. The rules live here once; docs/plans/741-8-9.md (Settled decisions) is the spec.
 */

export const MARKER_EXPORT_FORMATS = ["edl", "fcpxml"] as const;
export type MarkerExportFormat = (typeof MARKER_EXPORT_FORMATS)[number];
export const MARKER_EXPORT_STATUSES = ["all", "open", "resolved"] as const;
export type MarkerExportStatus = (typeof MARKER_EXPORT_STATUSES)[number];

/** Response header carrying the post-merge marker count. */
export const MARKER_EXPORT_COUNT_HEADER = "X-Marker-Count";

export type MarkerExportQuery = { format: MarkerExportFormat; includeInternal: boolean; status: MarkerExportStatus };

const QUERY_KEYS = new Set(["format", "includeInternal", "status"]);

/** Strict parse: `format` required, `includeInternal` (default false) and `status` (default all) optional; unknown, repeated or unsupported values are refused. */
export function parseMarkerExportQuery(params: URLSearchParams): { ok: true; value: MarkerExportQuery } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!QUERY_KEYS.has(key)) return { ok: false, error: `Unknown parameter "${key}".` };
    if (seen.has(key)) return { ok: false, error: `Repeated parameter "${key}".` };
    seen.add(key);
  }
  const format = params.get("format");
  if (format !== "edl" && format !== "fcpxml") return { ok: false, error: "format must be edl or fcpxml." };
  const internal = params.get("includeInternal") ?? "false";
  if (internal !== "true" && internal !== "false") return { ok: false, error: "includeInternal must be true or false." };
  const status = params.get("status") ?? "all";
  if (status !== "all" && status !== "open" && status !== "resolved") return { ok: false, error: "status must be all, open or resolved." };
  return { ok: true, value: { format, includeInternal: internal === "true", status } };
}

/** A note row as the selection sees it: the exporter's shape plus whether the row is a tombstone (a deleted note). */
export type ExportSourceNote = ExportNote & { deleted: boolean };

/**
 * Note rows (roots and replies, any order) to the notes an export holds. Visibility and status filter by the ROOT and replies follow it. Deleted replies never export.
 * A deleted root with no live reply is excluded; one that still has live replies is kept (marked `deleted`, so it exports as "Note deleted") so no feedback disappears.
 */
export function exportNotesFromThreads(rows: readonly ExportSourceNote[], options: { includeInternal: boolean; status: MarkerExportStatus }): ExportNote[] {
  const liveReplies = new Map<string, ExportSourceNote[]>();
  for (const row of rows) {
    if (row.parentId === null || row.deleted) continue;
    const list = liveReplies.get(row.parentId) ?? [];
    list.push(row);
    liveReplies.set(row.parentId, list);
  }
  const out: ExportNote[] = [];
  for (const root of rows) {
    if (root.parentId !== null) continue;
    if (!options.includeInternal && root.visibility !== "public") continue;
    if (options.status === "open" && root.resolved) continue;
    if (options.status === "resolved" && !root.resolved) continue;
    const replies = liveReplies.get(root.id) ?? [];
    if (root.deleted && replies.length === 0) continue;
    const { deleted, ...note } = root;
    out.push(deleted ? { ...note, deleted: true } : note);
    for (const reply of replies) { const { deleted: _deleted, ...replyNote } = reply; out.push(replyNote); }
  }
  return out;
}

/** How many selected roots have frames outside the Version: a point needs integer 0 <= start < frameCount, a range integer start < end <= frameCount. */
export function exportFrameViolations(notes: readonly ExportNote[], frameCount: number): number {
  let count = 0;
  for (const n of notes) {
    if (n.parentId !== null) continue;
    const start = n.startFrame; const end = n.endFrame;
    const startOk = start !== null && Number.isInteger(start) && start >= 0 && start < frameCount;
    const endOk = end === null || (startOk && Number.isInteger(end) && end > start! && end <= frameCount);
    if (!startOk || !endOk) count += 1;
  }
  return count;
}

const TITLE_MAX_BYTES = 120;
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩؜]/g;
const RESERVED = /[\\/:*?"<>|]/g;

function boundedTitle(raw: string): string {
  const cleaned = raw.normalize("NFC").replace(FORBIDDEN, "").replace(RESERVED, "_").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "");
  const encoder = new TextEncoder();
  let out = ""; let bytes = 0;
  for (const ch of cleaned) { const size = encoder.encode(ch).length; if (bytes + size > TITLE_MAX_BYTES) break; out += ch; bytes += size; }
  out = out.replace(/[.\s]+$/g, "");
  return out === "" ? "video" : out;
}

export type MarkerExportNameInput = { title: string; version: number; status: MarkerExportStatus; includeInternal: boolean; format: MarkerExportFormat };

/** The one filename builder: the server header and the menu preview both use it. */
export function markerExportFilename(input: MarkerExportNameInput): { filename: string } {
  const extension = input.format === "edl" ? "edl" : "fcpxml";
  return { filename: `${boundedTitle(input.title)}-v${input.version}-notes-${input.status}-${input.includeInternal ? "with-internal" : "public"}.${extension}` };
}

/** `attachment` with a quoted ASCII fallback and the RFC 5987 UTF-8 filename. Never interpolates an unsanitised title. */
export function markerExportContentDisposition(input: MarkerExportNameInput): string {
  const { filename } = markerExportFilename(input);
  const fallback = [...filename].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== "%" && ch !== '"' && ch !== "\\" ? ch : "_")).join("");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
