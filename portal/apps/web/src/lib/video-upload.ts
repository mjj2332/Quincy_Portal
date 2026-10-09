import {
  VIDEO_MAX_BYTES,
  VIDEO_UPLOAD_CONTENT_TYPE,
  mp4RejectMessage,
  probeMp4,
  videoUploadCompleteResponseSchema,
  videoUploadReserveResponseSchema,
  videoUploadRejectMessage,
  type Mp4Probe,
  type Role,
  type VideoUploadCompleteResponse,
  type VideoUploadReserveResponse,
} from "@quincy/shared";
import { ApiError, apiPost } from "./api";
import { decodeExternalResponse } from "./external-api-response";
import { PartUploadError, uploadMultipartFile } from "./multipart-upload";
import { captureVideoPoster } from "./video-poster";

/** Staff video upload (#741 4d-i): the browser's checks, then reserve, bytes, complete, poster. The server re-checks and re-probes everything; the checks here only save a doomed 2 GB upload. */

export const NOT_FAST_START_CAUTION = "This MP4 isn't fast-start, so playback may take a moment to begin. Re-export with 'fast start' / 'optimise for web' to fix it.";
export const TIMECODE_MISMATCH_CAUTION = "The file's timecode track doesn't match its frame rate, so it is ignored and timecode starts at 00:00:00:00.";
export const NOT_MP4_NAME_MESSAGE = mp4RejectMessage("not_mp4");
const UPLOADS_UNAVAILABLE = "Uploads aren't available right now.";
export const COMPLETE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export type VideoFileCheck = { ok: true; probe: Mp4Probe; cautions: string[] } | { ok: false; message: string };

/** The cautions a probe or the server's `warnings` call for, in plain words. */
export function videoCautions(input: { fastStart?: boolean; warnings: readonly string[] }): string[] {
  const out: string[] = [];
  if (input.fastStart === false || input.warnings.includes("not_fast_start")) out.push(NOT_FAST_START_CAUTION);
  if (input.warnings.includes("timecode_rate_mismatch")) out.push(TIMECODE_MISMATCH_CAUTION);
  return out;
}

/** Name, size, then the probe over `File.slice`. Nothing is requested from the server. */
export async function checkVideoFile(file: File): Promise<VideoFileCheck> {
  if (!/\.mp4$/i.test(file.name)) return { ok: false, message: NOT_MP4_NAME_MESSAGE };
  if (file.size > VIDEO_MAX_BYTES) return { ok: false, message: mp4RejectMessage("too_large") };
  try {
    const result = await probeMp4({ size: file.size, read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()) });
    if (!result.ok) return { ok: false, message: mp4RejectMessage(result.reason) };
    return { ok: true, probe: result.probe, cautions: videoCautions(result.probe) };
  } catch {
    return { ok: false, message: mp4RejectMessage("truncated") };
  }
}

/** The title a new film starts with: the filename without `.mp4`, trimmed, at most 200 characters. */
export function defaultFilmTitle(filename: string): string { return filename.replace(/\.mp4$/i, "").trim().slice(0, 200); }

export type VideoUploadTarget = { kind: "new"; title: string } | { kind: "version"; videoId: string; title: string };
export type VideoUploadPhase = "reserving" | "uploading" | "finishing" | "done" | "failed" | "cancelled";
/** What a failed row offers: send the failed part again, or ask the server to finish again (no re-upload). */
export type VideoUploadRetry = "upload" | "finish" | null;

export type VideoUploadState = {
  id: number;
  projectId: string;
  fileName: string;
  title: string;
  /** The Video this upload belongs to: known at once for a new Version, after the reserve for a new film. */
  videoId: string | null;
  version: number | null;
  percent: number;
  phase: VideoUploadPhase;
  error: string | null;
  retry: VideoUploadRetry;
  cautions: string[];
};

export type VideoUploadSettled = { videoId: string | null; version: number | null; title: string; outcome: "done" | "cancelled" };

export type VideoUploadOptions = {
  projectId: string;
  role: Role;
  file: File;
  target: VideoUploadTarget;
  probe: Mp4Probe;
  cautions: string[];
  onChange: (state: VideoUploadState) => void;
  /** The upload finished or was lost: refresh the list and tell the person. */
  onSettled?: (result: VideoUploadSettled) => void;
  /** A 401 anywhere: end the session's project data. */
  onUnauthorized?: (error: unknown) => void;
  completeDelaysMs?: readonly number[];
  partDelaysMs?: readonly number[];
};

const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
const codeOf = (error: unknown): string | undefined => { const details = error instanceof ApiError ? error.details : undefined; const code = details && typeof details === "object" ? (details as Record<string, unknown>).code : undefined; return typeof code === "string" ? code : undefined; };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One upload's whole life. It outlives the panel that started it: the store holds it. */
export class VideoUpload {
  state: VideoUploadState;
  private readonly controller = new AbortController();
  private reservation: VideoUploadReserveResponse | null = null;
  private doneParts: { partNumber: number; etag: string }[] = [];
  private poster: Promise<Blob | null> | null = null;
  private abortSent = false;
  private settled = false;
  private running = false;

  constructor(readonly id: number, private readonly options: VideoUploadOptions) {
    this.state = { id, projectId: options.projectId, fileName: options.file.name, title: options.target.title, videoId: options.target.kind === "version" ? options.target.videoId : null, version: null, percent: 0, phase: "reserving", error: null, retry: null, cautions: options.cautions };
  }

  private get base() { return `/api/projects/${encodeURIComponent(this.options.projectId)}/video-uploads`; }
  private set(patch: Partial<VideoUploadState>) { this.state = { ...this.state, ...patch }; this.options.onChange(this.state); }
  private fail(error: string, retry: VideoUploadRetry) { this.set({ phase: "failed", error, retry }); }
  private settle(outcome: "done" | "cancelled") {
    if (this.settled && outcome !== "done") return;
    this.settled = true;
    this.options.onSettled?.({ videoId: this.reservation?.videoId ?? (this.options.target.kind === "version" ? this.options.target.videoId : null), version: this.state.version, title: this.state.title, outcome });
  }

  /** Cancel at any phase. Safe to call twice. */
  cancel(): void {
    if (this.state.phase === "done" || this.state.phase === "cancelled") return;
    this.controller.abort();
    const hadFailed = this.state.phase === "failed";
    this.set({ phase: "cancelled", error: null, retry: null });
    if (hadFailed || this.running) void this.abortOnServer(true);
    this.settle("cancelled");
  }

  /** Tell the server to drop the reservation, at most once. A 409 `upload_completed` means the cancel lost the race. */
  private async abortOnServer(fromCancel = false): Promise<void> {
    if (this.abortSent || !this.reservation) return;
    this.abortSent = true;
    try {
      const response = await fetch(`${this.base}/${encodeURIComponent(this.reservation.reservationId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" });
      if (fromCancel && response.status === 409) {
        const body = await response.json().catch(() => undefined) as { code?: string } | undefined;
        if (body?.code === "upload_completed") { this.set({ phase: "done", error: null }); this.settle("done"); }
      }
    } catch { /* the sweep cleans up an abandoned reservation */ }
  }

  start(): void { void this.run(); }

  /** Manual retry of what failed: the failed part (resuming after the parts already stored), or the finish call. */
  retry(): void {
    if (this.state.phase !== "failed" || !this.state.retry || this.running) return;
    const kind = this.state.retry;
    this.set({ error: null, retry: null });
    void this.run(kind);
  }

  private async run(from: "upload" | "finish" | "reserve" = "reserve"): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (from === "reserve") await this.reserve();
      if (from !== "finish") await this.sendBytes();
      await this.finish();
    } catch (error) {
      if (isAbort(error) || this.controller.signal.aborted) return;
      this.options.onUnauthorized?.(error);
      this.fail(error instanceof Error ? error.message : "The upload failed.", null);
      await this.abortOnServer();
    } finally { this.running = false; }
  }

  /** A request that cannot be cancelled is raced against the signal, so Cancel is never queued behind it. */
  private async unlessCancelled<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) throw abortError();
    return await Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true }))]);
  }

  private async reserve(): Promise<void> {
    const { options } = this;
    const body = {
      ...(options.target.kind === "new" ? { title: options.target.title } : { videoId: options.target.videoId }),
      filename: options.file.name,
      bytes: options.file.size,
      contentType: VIDEO_UPLOAD_CONTENT_TYPE,
      clientProbe: { fps: options.probe.fps, frameCount: options.probe.frameCount, width: options.probe.width, height: options.probe.height, durationMs: options.probe.durationMs, codec: options.probe.codec },
    };
    const request = apiPost<unknown, typeof body>(this.base, body).then((raw) => (options.role === "external_editor" ? decodeExternalResponse("video-upload-reserve", raw) : videoUploadReserveResponseSchema.parse(raw)) as VideoUploadReserveResponse);
    let reservation: VideoUploadReserveResponse;
    try { reservation = await this.unlessCancelled(request); }
    catch (error) {
      if (isAbort(error)) { void request.then((late) => { this.reservation = late; return this.abortOnServer(); }, () => undefined); throw error; }
      this.options.onUnauthorized?.(error);
      this.fail(reserveErrorMessage(error), null);
      throw abortError(); // nothing was reserved: stop quietly
    }
    this.reservation = reservation;
    this.set({ version: reservation.version, videoId: reservation.videoId, phase: "uploading", percent: 0 });
  }

  private async sendBytes(): Promise<void> {
    const reservation = this.reservation!;
    this.set({ phase: "uploading", error: null });
    this.poster ??= captureVideoPoster(this.options.file).catch(() => null);
    try {
      const completed = await uploadMultipartFile(
        this.options.file,
        { key: reservation.reservationId, ...(reservation.uploadId ? { uploadId: reservation.uploadId } : {}), ...(reservation.partUrls ? { partUrls: reservation.partUrls } : {}), ...(reservation.partBytes ? { partBytes: reservation.partBytes } : {}), ...(reservation.devDirect ? { devDirect: true } : {}) },
        `${this.base}/${encodeURIComponent(reservation.reservationId)}/direct`,
        undefined,
        {
          signal: this.controller.signal,
          retry: { attempts: 3, ...(this.options.partDelaysMs ? { delaysMs: this.options.partDelaysMs } : {}) },
          doneParts: this.doneParts,
          onPart: (part) => { this.doneParts = [...this.doneParts.filter((existing) => existing.partNumber !== part.partNumber), part]; },
          onBytes: (loaded, total) => this.set({ percent: Math.min(100, Math.round((loaded / total) * 100)) }),
        },
      );
      this.uploaded = completed;
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof PartUploadError && error.retryable) {
        this.fail(`${error.message} Check your connection, then retry.`, "upload");
        throw abortError(); // parked, waiting for the person: not a terminal failure
      }
      this.fail(error instanceof Error ? error.message : "The upload failed.", null);
      await this.abortOnServer();
      throw abortError();
    }
  }
  private uploaded: { uploadId?: string; parts?: { partNumber: number; etag: string }[] } = {};

  private async finish(): Promise<void> {
    const reservation = this.reservation!;
    const delays = this.options.completeDelaysMs ?? COMPLETE_RETRY_DELAYS_MS;
    this.set({ phase: "finishing", percent: 100 });
    const url = `${this.base}/${encodeURIComponent(reservation.reservationId)}/complete`;
    const body = this.uploaded.parts ? { parts: this.uploaded.parts } : {};
    for (let attempt = 0; ; attempt += 1) {
      try {
        const raw = await this.unlessCancelled(apiPost<unknown, typeof body>(url, body));
        const done = (this.options.role === "external_editor" ? decodeExternalResponse("video-upload-complete", raw) : videoUploadCompleteResponseSchema.parse(raw)) as VideoUploadCompleteResponse;
        await this.afterComplete(done);
        return;
      } catch (error) {
        if (isAbort(error)) throw error;
        this.options.onUnauthorized?.(error);
        const code = codeOf(error);
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 422 && code === "video_rejected") { this.fail(rejectionMessage(error), null); await this.abortOnServer(); throw abortError(); }
        if (status === 409 && code === "upload_unavailable") { this.fail(error instanceof Error ? error.message : "This upload has expired. Start a new one.", null); await this.abortOnServer(); throw abortError(); }
        if (status === 400 && code === "upload_missing") { this.fail("The file did not finish uploading. Upload it again.", null); await this.abortOnServer(); throw abortError(); }
        const transient = status === 0 || (status === 503 && code === "probe_unavailable") || (status === 409 && code === "completion_failed") || status >= 500;
        if (!transient) { this.fail(error instanceof Error ? error.message : "The upload could not be finished.", null); await this.abortOnServer(); throw abortError(); }
        if (attempt >= delays.length) { this.fail("The upload is stored, but finishing it did not work. Retry finishing; the file is not sent again.", "finish"); throw abortError(); }
        await sleep(delays[attempt]!, this.controller.signal);
      }
    }
  }

  private async afterComplete(done: VideoUploadCompleteResponse): Promise<void> {
    const cautions = [...new Set([...this.state.cautions, ...videoCautions({ warnings: done.warnings })])];
    this.set({ version: done.version.version, title: done.video.title, cautions });
    const blob = this.poster ? await this.unlessCancelled(this.poster).catch((error) => { if (isAbort(error)) throw error; return null; }) : null;
    if (blob) {
      try {
        await this.unlessCancelled(fetch(`/api/projects/${encodeURIComponent(this.options.projectId)}/video-versions/${encodeURIComponent(done.version.assetId)}/poster`, { method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" }, body: blob, signal: this.controller.signal }).then(() => undefined, () => undefined));
      } catch (error) { if (isAbort(error)) throw error; }
    }
    this.set({ phase: "done", percent: 100, error: null, retry: null });
    this.settle("done");
  }
}

function rejectionMessage(error: unknown): string {
  const details = error instanceof ApiError ? error.details : undefined;
  const reason = details && typeof details === "object" ? (details as Record<string, unknown>).reason : undefined;
  if (typeof reason === "string") return videoUploadRejectMessage(reason);
  return error instanceof Error ? error.message : "This file cannot be used. Export it again as an H.264 .mp4.";
}

function reserveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return UPLOADS_UNAVAILABLE;
    return error.message;
  }
  return error instanceof Error ? error.message : "The upload could not be started.";
}
