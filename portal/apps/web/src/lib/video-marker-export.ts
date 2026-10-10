import {
  buildMarkers, exportNotesFromThreads, markerExportFilename, MARKER_EXPORT_COUNT_HEADER, EDL_MAX_EVENTS,
  type ExportContext, type ExportSourceNote, type MarkerExportFormat, type MarkerExportStatus, type VideoNoteDto, type VideoNoteThreadDto,
} from "@quincy/shared";

/**
 * NLE marker export, web side (#741 9): the request, the count preview and the save. The selection rules live in `@quincy/shared`
 * (`exportNotesFromThreads`, `buildMarkers`), so the preview count and the server's file cannot drift. A response is only ever turned
 * into a Blob after its status was checked: an error body is never written into a file.
 */

export type MarkerExportOptions = { includeInternal: boolean; status: MarkerExportStatus };
export const DEFAULT_MARKER_EXPORT_OPTIONS: MarkerExportOptions = { includeInternal: false, status: "all" };
export const EDL_LIMIT = EDL_MAX_EVENTS;

const enc = encodeURIComponent;

/** The one request URL; the query is spelled out so a default is never left to the server. */
export function markerExportUrl(projectId: string, assetId: string, format: MarkerExportFormat, options: MarkerExportOptions): string {
  const query = new URLSearchParams({ format, includeInternal: String(options.includeInternal), status: options.status });
  return `/api/projects/${enc(projectId)}/video-versions/${enc(assetId)}/marker-export?${query.toString()}`;
}

function authorName(note: VideoNoteDto): string { return note.author.kind === "staff" ? note.author.person.name : note.author.name; }

function sourceRow(note: VideoNoteDto): ExportSourceNote {
  return {
    id: note.id, parentId: note.parentId, authorName: authorName(note), body: note.body, startFrame: note.startFrame, endFrame: note.endFrame,
    resolved: note.resolved !== null, visibility: note.visibility, createdAt: Date.parse(note.createdAt), deleted: note.deleted,
  };
}

/** How many markers the server would write for these options: the shared selection, then the shared same-frame merge. `buildMarkers` reads only `includeInternal` from its context. */
export function markerExportCount(threads: readonly VideoNoteThreadDto[], options: MarkerExportOptions): number {
  const rows = threads.flatMap((thread) => { const { replies, ...root } = thread; return [sourceRow(root), ...replies.map(sourceRow)]; });
  const notes = exportNotesFromThreads(rows, options);
  return buildMarkers(notes, { includeInternal: options.includeInternal } as ExportContext).length;
}

export function markerExportPreviewName(title: string, version: number, format: MarkerExportFormat, options: MarkerExportOptions): string {
  return markerExportFilename({ title, version, format, ...options }).filename;
}

/** The filename a response names: RFC 5987 `filename*` first, then the quoted fallback. Path separators never survive. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) { try { name = decodeURIComponent(star[1]!.trim()); } catch { name = null; } }
  if (name === null) { const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header); if (plain) name = plain[1]!.replace(/\\(.)/g, "$1").trim(); }
  if (name === null) return null;
  const cleaned = name.replace(/[\\/\u0000-\u001f]/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? null : cleaned;
}

export type MarkerExportFailure =
  | { kind: "overflow"; count: number; limit: number }
  | { kind: "range" }
  | { kind: "unavailable" }
  | { kind: "forbidden" }
  | { kind: "archived" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

export type MarkerExportResult =
  | { ok: true; blob: Blob; filename: string; count: number | null }
  | { ok: false; aborted: true }
  | { ok: false; aborted?: false; failure: MarkerExportFailure };

async function failureOf(response: Response): Promise<MarkerExportFailure> {
  const body = await response.json().catch(() => null) as { code?: unknown; count?: unknown; limit?: unknown } | null;
  const status = response.status;
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "unavailable" };
  if (status === 409) return { kind: "archived" };
  if (status === 422 && body?.code === "too_many_markers") return { kind: "overflow", count: typeof body.count === "number" ? body.count : 0, limit: typeof body.limit === "number" ? body.limit : EDL_LIMIT };
  if (status === 422) return { kind: "range" };
  return { kind: "failed" };
}

/** Fetch the file. Status first, Blob only for a 200. Abort resolves `{ aborted }`, never a failure message. */
export async function requestMarkerExport(input: {
  projectId: string; assetId: string; title: string; version: number; format: MarkerExportFormat; options: MarkerExportOptions; signal: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<MarkerExportResult> {
  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(markerExportUrl(input.projectId, input.assetId, input.format, input.options), { method: "GET", credentials: "include", signal: input.signal });
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, aborted: true };
    return { ok: false, failure: { kind: "failed" } };
  }
  if (!response.ok) return input.signal.aborted ? { ok: false, aborted: true } : { ok: false, failure: await failureOf(response) };
  let blob: Blob;
  try { blob = await response.blob(); } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, aborted: true };
    return { ok: false, failure: { kind: "failed" } };
  }
  if (input.signal.aborted) return { ok: false, aborted: true };
  const header = response.headers.get(MARKER_EXPORT_COUNT_HEADER);
  const parsed = header === null ? NaN : Number(header);
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition"))
    ?? markerExportPreviewName(input.title, input.version, input.format, input.options);
  return { ok: true, blob, filename, count: Number.isInteger(parsed) && parsed >= 0 ? parsed : null };
}

/** Hand a Blob to the browser as a download: a temporary object URL on a temporary anchor, both gone afterwards. */
export function saveBlob(blob: Blob, filename: string, revokeDelayMs = 1000): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, revokeDelayMs);
}

export function markerExportFailureMessage(failure: MarkerExportFailure): string {
  switch (failure.kind) {
    case "overflow": return `This export has ${failure.count} markers. Resolve EDL supports up to ${failure.limit}. Download FCPXML or choose fewer notes.`;
    case "range": return "Some notes are outside this Version. Export could not be created.";
    case "unavailable": return "Export is unavailable. Refresh this Project and try again.";
    case "forbidden": return "You don’t have permission to export these notes.";
    case "archived": return "This Project is archived. Notes cannot be exported.";
    case "unauthorized": return "Your session ended. Sign in again to export.";
    case "failed": return "Export could not be downloaded. Try again.";
  }
}

export const MARKER_EXPORT_PREPARING = "Preparing export…";
export const MARKER_EXPORT_EMPTY = "No notes matched these export options. An empty file was downloaded.";
