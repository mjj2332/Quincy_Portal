import {
  EMBEDDED_HEIC_CONTENT_TYPES,
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  EMBEDDED_VIDEO_CONTENT_TYPES,
  EMBEDDED_VIDEO_MAX_BYTES,
  isEmbeddedVideoContentType,
  type EmbeddedVideoContentType,
  externalEmbeddedMediaCompleteSchema,
  externalEmbeddedMediaPresignSchema,
  externalEmbeddedMediaRenditionSchema,
  externalEmbeddedMediaSettingsSchema,
  isEmbeddedHeicContentType,
  isEmbeddedImageContentType,
} from "@quincy/shared";
import { ApiError, apiGet, apiPost } from "./api";
import { uploadMultipartFile } from "./multipart-upload";
import { captureVideoPoster } from "./video-poster";

/** Embedded images (#493). The browser's checks are a convenience: the server re-checks every one. */
export { EMBEDDED_MEDIA_MAX_PER_POST };

const MAX_MB = Math.round(EMBEDDED_MEDIA_MAX_BYTES / (1024 * 1024));

/** The auth-gated URL an embedded image is shown from. It carries the id only, never a key. */
export function embeddedMediaUrl(mediaId: string): string {
  return `/media/embedded/${encodeURIComponent(mediaId)}`;
}

export const EMBEDDED_IMAGE_ACCEPT = EMBEDDED_IMAGE_CONTENT_TYPES.join(",");
/** HEIC and HEIF (#495). Chrome and Safari often report no type for one, so the extensions are listed too. */
export const EMBEDDED_HEIC_ACCEPT = [...EMBEDDED_HEIC_CONTENT_TYPES, ".heic", ".heif"].join(",");

/** What an image picker accepts: HEIC joins the list only for a person the server lets upload it. */
export function embeddedImageAccept(heic: boolean): string {
  return heic ? `${EMBEDDED_IMAGE_ACCEPT},${EMBEDDED_HEIC_ACCEPT}` : EMBEDDED_IMAGE_ACCEPT;
}

/** The HEIC type to declare: the browser's own when it is one, else the one the extension names (no type at all is common). Null for anything else. */
export function embeddedHeicContentType(file: Pick<File, "type" | "name">): (typeof EMBEDDED_HEIC_CONTENT_TYPES)[number] | null {
  if (isEmbeddedHeicContentType(file.type)) return file.type;
  if (file.type !== "" && file.type !== "application/octet-stream") return null;
  const name = file.name.toLowerCase();
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return null;
}

/** Whether this is a HEIC or HEIF file (by type, or by name when the browser reports none), which the browser cannot decode itself. */
export const isEmbeddedHeicFile = (file: Pick<File, "type" | "name">): boolean => embeddedHeicContentType(file) !== null;

/** The type to declare for an image: JPEG, PNG or WebP as reported, or a HEIC when `heic` is on. Null when the file cannot be embedded as an image. */
export function embeddedImageContentType(file: Pick<File, "type" | "name">, heic: boolean): string | null {
  if (isEmbeddedImageContentType(file.type)) return file.type;
  return heic ? embeddedHeicContentType(file) : null;
}

/** A plain-language reason the file cannot be embedded, or null when it can. `heic` says whether this person may upload HEIC. */
export function embeddedImageProblem(file: Pick<File, "type" | "size" | "name">, heic = false): string | null {
  if (!embeddedImageContentType(file, heic)) return `${file.name || "This file"} is not a ${heic ? "JPEG, PNG, WebP or HEIC" : "JPEG, PNG or WebP"} image.`;
  if (file.size <= 0) return `${file.name || "This file"} is empty.`;
  if (file.size > EMBEDDED_MEDIA_MAX_BYTES) return `${file.name || "This image"} is larger than ${MAX_MB} MB.`;
  return null;
}

/** Whether this person may upload HEIC (#495). The server decides (an Admin, or everyone once the owner turns it on); a bad answer means no. */
export async function fetchEmbeddedHeicSetting(): Promise<boolean> {
  const parsed = externalEmbeddedMediaSettingsSchema.safeParse(await apiGet<unknown>("/api/embedded-media/settings"));
  return parsed.success && parsed.data.heic;
}

/** Where an upload belongs: a Project's discussion, the Notice board (#496), or a Project's whiteboard (#501: `owner`, which the server stores as the row's owner kind). */
export type EmbeddedMediaScope = { projectId: string; owner?: "whiteboard" } | { noticeBoard: true };

function mediaBase(scope: EmbeddedMediaScope): string {
  return "noticeBoard" in scope ? "/api/notice-board/embedded-media" : `/api/projects/${encodeURIComponent(scope.projectId)}/embedded-media`;
}

const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });

/** A HEIC image's JPEG display copy could not be made (#495). Carries the media id so the uploader can Retry or remove it. */
export class RenditionFailedError extends Error {
  constructor(readonly mediaId: string) {
    super("The image could not be prepared");
    this.name = "RenditionFailedError";
  }
}

export const RENDITION_POLL_FIRST_MS = 1_000;
export const RENDITION_POLL_MAX_MS = 10_000;
const RENDITION_POLL_MAX_FAILURES = 5;
/** The wait before poll number `attempt` (from 0): 1, 2, 4, 8 seconds, then 10 seconds for ever. */
export const renditionPollDelay = (attempt: number) => Math.min(RENDITION_POLL_MAX_MS, RENDITION_POLL_FIRST_MS * 2 ** attempt);

/** Phase and abort hooks for an image upload whose display copy is made after the bytes land. */
export type EmbeddedImageUploadOptions = { signal?: AbortSignal; onPhase?: (phase: "preparing", mediaId: string) => void };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls the uploader-only status route with backoff until the display copy is ready (resolves with the id) or failed (rejects). */
async function waitForRendition(scope: EmbeddedMediaScope, mediaId: string, signal?: AbortSignal): Promise<string> {
  const url = `${mediaBase(scope)}/${encodeURIComponent(mediaId)}/rendition`;
  let failures = 0;
  for (let attempt = 0; ; attempt += 1) {
    await sleep(renditionPollDelay(attempt), signal);
    try {
      const { status } = externalEmbeddedMediaRenditionSchema.parse(await apiGet<unknown>(url, { signal }));
      failures = 0;
      if (status === "ready" || status === "not_required") return mediaId;
      if (status === "failed") throw new RenditionFailedError(mediaId);
    } catch (error) {
      if (error instanceof RenditionFailedError) throw error;
      if (signal?.aborted) throw abortError();
      // The media is gone or not ours: polling can never succeed. A blip (network, 5xx, a throttle) is worth another try.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      failures += 1;
      if (failures >= RENDITION_POLL_MAX_FAILURES) throw error;
    }
  }
}

/** Retry a failed display copy: the server sets it pending again and queues the conversion, then this resumes polling. Resolves with the id at ready. */
export async function retryEmbeddedRendition(scope: EmbeddedMediaScope, mediaId: string, options: EmbeddedImageUploadOptions = {}): Promise<string> {
  const { signal, onPhase } = options;
  if (signal?.aborted) throw abortError();
  try { await apiPost<unknown, Record<string, never>>(`${mediaBase(scope)}/${encodeURIComponent(mediaId)}/rendition/retry`, {}); }
  catch (error) {
    // 409 means it is no longer failed (a second Retry won, or it finished): the status route says which.
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
  onPhase?.("preparing", mediaId);
  return waitForRendition(scope, mediaId, signal);
}

/**
 * Tells the server to drop an image upload the person removed while it was being prepared (or after it failed), so no reservation or
 * object is left behind. A Project has an abort route; the Notice board has none, so there the row is just forgotten and the sweep
 * reclaims it. Fire and forget, and `keepalive` so it survives the page closing.
 */
export function abortEmbeddedImage(scope: EmbeddedMediaScope, mediaId: string): Promise<unknown> {
  if ("noticeBoard" in scope) return Promise.resolve();
  return fetch(`${mediaBase(scope)}/${encodeURIComponent(mediaId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
}

/**
 * presign, then bytes straight to R2, then complete. Resolves with the media id once the server accepts the file. A HEIC (#495) is not
 * usable yet when `complete` answers: its JPEG is made in the background, so this reports `preparing`, polls the status route (1, 2, 4
 * seconds, capped at 10) and resolves at `ready`, or rejects with a `RenditionFailedError` at `failed`. The `signal` stops the polling.
 */
export async function uploadEmbeddedImage(scope: EmbeddedMediaScope, file: File, onProgress?: (percent: number) => void, options: EmbeddedImageUploadOptions = {}): Promise<string> {
  const { signal } = options;
  const base = mediaBase(scope);
  const owner = "projectId" in scope && scope.owner ? { owner: scope.owner } : {};
  const contentType = embeddedImageContentType(file, true) ?? file.type;
  if (signal?.aborted) throw abortError();
  const presign = externalEmbeddedMediaPresignSchema.parse(await apiPost<unknown, { contentType: string; bytes: number; owner?: "whiteboard" }>(base, { contentType, bytes: file.size, ...owner }));
  // From here the helper owns the reservation: a cancel before the copy is `preparing` (the owner learns the id only then) aborts it here,
  // even when presign answered after the owner went away. The Notice board has no abort route, so `abortEmbeddedImage` leaves that to the sweep.
  const aborting = () => abortEmbeddedImage(scope, presign.mediaId);
  const cancelled = new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(abortError()), { once: true }); });
  cancelled.catch(() => undefined);
  const unlessCancelled = <T,>(work: Promise<T>): Promise<T> => signal ? Promise.race([work, cancelled]) : work;
  let preparing = false;
  try {
    if (signal?.aborted) throw abortError();
    const completed = await unlessCancelled(uploadMultipartFile(
      file,
      { key: presign.mediaId, ...(presign.uploadId ? { uploadId: presign.uploadId } : {}), ...(presign.partUrls ? { partUrls: presign.partUrls } : {}), ...(presign.partBytes ? { partBytes: presign.partBytes } : {}), ...(presign.devDirect ? { devDirect: true } : {}) },
      `${base}/${encodeURIComponent(presign.mediaId)}/direct`,
      onProgress,
      signal ? { signal } : undefined,
    ));
    if (signal?.aborted) throw abortError();
    const done = externalEmbeddedMediaCompleteSchema.parse(await unlessCancelled(apiPost<unknown, { parts?: { partNumber: number; etag: string }[] }>(`${base}/${encodeURIComponent(presign.mediaId)}/complete`, completed.parts ? { parts: completed.parts } : {})));
    if (signal?.aborted) throw abortError();
    if (done.rendition === "failed") throw new RenditionFailedError(done.mediaId);
    if (done.rendition === "pending") {
      preparing = true;
      options.onPhase?.("preparing", done.mediaId);
      return waitForRendition(scope, done.mediaId, signal);
    }
    return done.mediaId;
  } catch (error) {
    if (!preparing && !(error instanceof RenditionFailedError) && signal?.aborted) await aborting();
    throw error;
  }
}

/** Where a Project video's poster frame is shown from. Id only, like the video. */
export function embeddedMediaPosterUrl(mediaId: string): string {
  return `${embeddedMediaUrl(mediaId)}/poster`;
}

export const EMBEDDED_VIDEO_ACCEPT = [...EMBEDDED_VIDEO_CONTENT_TYPES, ".mp4", ".mov"].join(",");

/** The type to declare for a video: the browser's own when it is one we take, else the one its extension names (some systems report none for a .mov). */
export function embeddedVideoContentType(file: Pick<File, "type" | "name">): EmbeddedVideoContentType | null {
  if (isEmbeddedVideoContentType(file.type)) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/quicktime";
  return null;
}

/** A plain-language reason the file cannot be embedded as a video, or null when it can. */
export function embeddedVideoProblem(file: Pick<File, "type" | "size" | "name">): string | null {
  if (!embeddedVideoContentType(file)) return `${file.name || "This file"} is not an MP4 or MOV video.`;
  if (file.size <= 0) return `${file.name || "This file"} is empty.`;
  if (file.size > EMBEDDED_VIDEO_MAX_BYTES) return `${file.name || "This video"} is larger than ${Math.round(EMBEDDED_VIDEO_MAX_BYTES / 1024 ** 3)} GB.`;
  return null;
}

/**
 * A Project video (#494): presign, bytes straight to R2 with byte progress and cancel, complete, then the poster frame (captured
 * in the browser while the bytes go up; best effort, so a file this browser cannot decode simply has none). Resolves with the media
 * id. A cancelled or failed upload tells the server to abort, so no reservation or object is left behind; the abort request is
 * `keepalive`, so it survives the page closing. A cancel rejects as an `AbortError`.
 */
export async function uploadEmbeddedVideo(projectId: string, file: File, options: { signal?: AbortSignal; onProgress?: (percent: number) => void; owner?: "whiteboard"; /** Told, just before the media id is returned, whether the server kept a poster frame (#556): a posterless video must not ask for `/poster`. */ onPoster?: (stored: boolean) => void } = {}): Promise<string> {
  const { signal, onProgress, owner, onPoster } = options;
  const contentType = embeddedVideoContentType(file);
  if (!contentType) throw new Error(`${file.name || "This file"} is not an MP4 or MOV video.`);
  if (signal?.aborted) throw abortError();
  const base = mediaBase({ projectId });
  const presign = externalEmbeddedMediaPresignSchema.parse(await apiPost<unknown, { contentType: string; bytes: number; owner?: "whiteboard" }>(base, { contentType, bytes: file.size, ...(owner ? { owner } : {}) }));
  const mediaUrl = `${base}/${encodeURIComponent(presign.mediaId)}`;
  let abortSent: Promise<unknown> | null = null;
  const abortOnServer = () => abortSent ??= fetch(`${mediaUrl}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
  // A cancel is not queued behind a step that cannot be cancelled (the completion call, the poster capture): each of those is raced
  // against the signal, so the abort goes out the moment the user cancels and nothing further is requested.
  const cancelled = new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(abortError()), { once: true }); });
  cancelled.catch(() => undefined);
  const unlessCancelled = <T,>(work: Promise<T>): Promise<T> => signal ? Promise.race([work, cancelled]) : work;
  try {
    if (signal?.aborted) throw abortError();
    const poster = captureVideoPoster(file).catch(() => null);
    const completed = await uploadMultipartFile(
      file,
      { key: presign.mediaId, ...(presign.uploadId ? { uploadId: presign.uploadId } : {}), ...(presign.partUrls ? { partUrls: presign.partUrls } : {}), ...(presign.partBytes ? { partBytes: presign.partBytes } : {}), ...(presign.devDirect ? { devDirect: true } : {}) },
      `${mediaUrl}/direct`,
      undefined,
      { signal, onBytes: (loaded, total) => onProgress?.(Math.min(100, Math.round((loaded / total) * 100))) },
    );
    if (signal?.aborted) throw abortError();
    const done = externalEmbeddedMediaCompleteSchema.parse(await unlessCancelled(apiPost<unknown, { parts?: { partNumber: number; etag: string }[] }>(`${mediaUrl}/complete`, completed.parts ? { parts: completed.parts } : {})));
    const frame = await unlessCancelled(poster);
    if (signal?.aborted) throw abortError();
    const stored = frame ? await unlessCancelled(fetch(`${mediaUrl}/poster`, { method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" }, body: frame, ...(signal ? { signal } : {}) }).then((response) => response.ok, () => false)) : false;
    if (signal?.aborted) throw abortError();
    onPoster?.(stored);
    return done.mediaId;
  } catch (error) {
    await abortOnServer();
    throw error;
  }
}
