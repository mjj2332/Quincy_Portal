import {
  EMBEDDED_HEIC_CONTENT_TYPES,
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_IMAGE_MAX_DIMENSION,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  EMBEDDED_VIDEO_CONTENT_TYPES,
  EMBEDDED_VIDEO_MAX_BYTES,
  isEmbeddedVideoContentType,
  type EmbeddedVideoContentType,
  type LinkPreviewCard,
  externalEmbeddedMediaCompleteSchema,
  externalEmbeddedMediaPresignSchema,
  externalEmbeddedMediaRenditionSchema,
  isEmbeddedHeicContentType,
  isEmbeddedImageContentType,
} from "@quincy/shared";
import { uploadMultipartFile } from "./multipart-upload";
import { captureVideoPoster } from "./video-poster";

/**
 * The part of Embedded media that touches no network API of the app (#493, #835). It is the module the Review-link page may reach: nothing here imports `lib/api`, `lib/auth` or the router
 * (`guest/guest-boundary.guard.test.ts` follows imports transitively). The pure helpers (URLs, pickers, size checks), the upload flows, and the `MediaIo` they run over live here; the staff
 * `lib/embedded-media.ts` supplies a `MediaIo` over `lib/api`, and `guest/guest-api.ts` one over the guest's own routes.
 */
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

/** Where an upload belongs: a Project's discussion, the Notice board (#496), or a Project's whiteboard (#501: `owner`, which the server stores as the row's owner kind). */
export type EmbeddedMediaScope = { projectId: string; owner?: "whiteboard" | "video_note" } | { noticeBoard: true };

export const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });

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

/**
 * The pixel size the browser decodes a picked image to (#611), or null when it cannot (a HEIC, a file it cannot read, a size the server would refuse, or no decoder at all).
 * It is the size the post's `<img>` will have, so it is measured with an `Image`, which applies the photo's rotation the same way. Best effort: an upload never waits long for it or fails because of it.
 */
export function readImageDimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let url: string | null = null;
    const settle = (value: { width: number; height: number } | null) => { clearTimeout(timer); if (url) URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => settle(null), 10_000);
    try {
      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth; const height = image.naturalHeight;
        settle(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= EMBEDDED_IMAGE_MAX_DIMENSION && height <= EMBEDDED_IMAGE_MAX_DIMENSION ? { width, height } : null);
      };
      image.onerror = () => settle(null);
      url = URL.createObjectURL(file);
      image.src = url;
    } catch { settle(null); }
  });
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


/** What a presign, a completion and the poster cost one upload, over some set of routes. Each method returns the raw JSON (the flows parse it with the shared schemas) or throws. */
export type MediaIo = {
  presign(body: { contentType: string; bytes: number; owner?: "whiteboard" | "video_note" }): Promise<unknown>;
  /** Where the bytes go in dev (no presigned URL): the route that takes the PUT. */
  directUrl(mediaId: string): string;
  complete(mediaId: string, body: { parts?: { partNumber: number; etag: string }[]; width?: number; height?: number }): Promise<unknown>;
  /** The uploader's status read. A rejection carries `status` (the HTTP code) when it has one: a 4xx other than 408 and 429 ends the polling. */
  rendition(mediaId: string, signal?: AbortSignal): Promise<unknown>;
  /** Asks for a failed display copy again. Absent where there is no such route. */
  retry?(mediaId: string): Promise<unknown>;
  /** Drops an upload that will not be finished. Fire and forget. */
  abort(mediaId: string): Promise<unknown>;
  /** Stores the video's poster frame. Resolves true when the server kept it. */
  putPoster(mediaId: string, frame: Blob, signal?: AbortSignal): Promise<boolean>;
};

/** Polls the uploader-only status route with backoff until the display copy is ready (resolves with the id) or failed (rejects). */
async function waitForRendition(io: MediaIo, mediaId: string, signal?: AbortSignal): Promise<string> {
  let failures = 0;
  for (let attempt = 0; ; attempt += 1) {
    await sleep(renditionPollDelay(attempt), signal);
    try {
      const { status } = externalEmbeddedMediaRenditionSchema.parse(await io.rendition(mediaId, signal));
      failures = 0;
      if (status === "ready" || status === "not_required") return mediaId;
      if (status === "failed") throw new RenditionFailedError(mediaId);
    } catch (error) {
      if (error instanceof RenditionFailedError) throw error;
      if (signal?.aborted) throw abortError();
      // The media is gone or not ours: polling can never succeed. A blip (network, 5xx, a throttle) is worth another try.
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) throw error;
      failures += 1;
      if (failures >= RENDITION_POLL_MAX_FAILURES) throw error;
    }
  }
}

/** Retry a failed display copy: the server sets it pending again and queues the conversion, then this resumes polling. Resolves with the id at ready. */
export async function retryRenditionVia(io: MediaIo, mediaId: string, options: EmbeddedImageUploadOptions = {}): Promise<string> {
  const { signal, onPhase } = options;
  if (signal?.aborted) throw abortError();
  await io.retry?.(mediaId);
  onPhase?.("preparing", mediaId);
  return waitForRendition(io, mediaId, signal);
}

/**
 * presign, then bytes straight to R2, then complete. Resolves with the media id once the server accepts the file. A HEIC (#495) is not
 * usable yet when `complete` answers: its JPEG is made in the background, so this reports `preparing`, polls the status route (1, 2, 4
 * seconds, capped at 10) and resolves at `ready`, or rejects with a `RenditionFailedError` at `failed`. The `signal` stops the polling.
 */
export async function uploadImageVia(io: MediaIo, file: File, onProgress?: (percent: number) => void, options: EmbeddedImageUploadOptions = {}, owner?: "whiteboard" | "video_note"): Promise<string> {
  const { signal } = options;
  const contentType = embeddedImageContentType(file, true) ?? file.type;
  if (signal?.aborted) throw abortError();
  // The size is read while the upload runs and sent with the completion (#611). A HEIC is not measured: the server uses its JPEG copy's size.
  const measured = isEmbeddedHeicContentType(contentType) ? Promise.resolve(null) : readImageDimensions(file);
  const presign = externalEmbeddedMediaPresignSchema.parse(await io.presign({ contentType, bytes: file.size, ...(owner ? { owner } : {}) }));
  // From here the helper owns the reservation: a cancel before the copy is `preparing` (the owner learns the id only then) aborts it here,
  // even when presign answered after the owner went away. The Notice board has no abort route, so its `abort` leaves that to the sweep.
  const aborting = () => io.abort(presign.mediaId);
  const cancelled = new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(abortError()), { once: true }); });
  cancelled.catch(() => undefined);
  const unlessCancelled = <T,>(work: Promise<T>): Promise<T> => signal ? Promise.race([work, cancelled]) : work;
  let preparing = false;
  try {
    if (signal?.aborted) throw abortError();
    const completed = await unlessCancelled(uploadMultipartFile(
      file,
      { key: presign.mediaId, ...(presign.uploadId ? { uploadId: presign.uploadId } : {}), ...(presign.partUrls ? { partUrls: presign.partUrls } : {}), ...(presign.partBytes ? { partBytes: presign.partBytes } : {}), ...(presign.devDirect ? { devDirect: true } : {}) },
      io.directUrl(presign.mediaId),
      onProgress,
      signal ? { signal } : undefined,
    ));
    if (signal?.aborted) throw abortError();
    const size = await unlessCancelled(measured);
    const done = externalEmbeddedMediaCompleteSchema.parse(await unlessCancelled(io.complete(presign.mediaId, { ...(completed.parts ? { parts: completed.parts } : {}), ...(size ?? {}) })));
    if (signal?.aborted) throw abortError();
    if (done.rendition === "failed") throw new RenditionFailedError(done.mediaId);
    if (done.rendition === "pending") {
      preparing = true;
      options.onPhase?.("preparing", done.mediaId);
      return waitForRendition(io, done.mediaId, signal);
    }
    return done.mediaId;
  } catch (error) {
    if (!preparing && !(error instanceof RenditionFailedError) && signal?.aborted) await aborting();
    throw error;
  }
}

/**
 * A video (#494): presign, bytes straight to R2 with byte progress and cancel, complete, then the poster frame (captured
 * in the browser while the bytes go up; best effort, so a file this browser cannot decode simply has none). Resolves with the media
 * id. A cancelled or failed upload tells the server to abort, so no reservation or object is left behind. A cancel rejects as an `AbortError`.
 */
export async function uploadVideoVia(io: MediaIo, file: File, options: { signal?: AbortSignal; onProgress?: (percent: number) => void; owner?: "whiteboard" | "video_note"; /** Told, just before the media id is returned, whether the server kept a poster frame (#556): a posterless video must not ask for `/poster`. */ onPoster?: (stored: boolean) => void } = {}): Promise<string> {
  const { signal, onProgress, owner, onPoster } = options;
  const contentType = embeddedVideoContentType(file);
  if (!contentType) throw new Error(`${file.name || "This file"} is not an MP4 or MOV video.`);
  if (signal?.aborted) throw abortError();
  const presign = externalEmbeddedMediaPresignSchema.parse(await io.presign({ contentType, bytes: file.size, ...(owner ? { owner } : {}) }));
  let abortSent: Promise<unknown> | null = null;
  const abortOnServer = () => abortSent ??= io.abort(presign.mediaId);
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
      io.directUrl(presign.mediaId),
      undefined,
      { signal, onBytes: (loaded, total) => onProgress?.(Math.min(100, Math.round((loaded / total) * 100))) },
    );
    if (signal?.aborted) throw abortError();
    const done = externalEmbeddedMediaCompleteSchema.parse(await unlessCancelled(io.complete(presign.mediaId, completed.parts ? { parts: completed.parts } : {})));
    const frame = await unlessCancelled(poster);
    if (signal?.aborted) throw abortError();
    const stored = frame ? await unlessCancelled(io.putPoster(presign.mediaId, frame, signal)) : false;
    if (signal?.aborted) throw abortError();
    onPoster?.(stored);
    return done.mediaId;
  } catch (error) {
    await abortOnServer();
    throw error;
  }
}

/**
 * What the rich-text editor needs to put media into a post and to draft one: injected by the host, so the editor itself imports no network module. The staff wrapper
 * (`QuincyRichTextEditor`) builds it from `lib/embedded-media`, the Review-link page's from `guest/guest-api.ts`.
 */
export type EditorMediaTransport = {
  /** Whether this person may upload HEIC (#495). */
  heicEnabled: boolean;
  /** Whether a video can be added (a Project's discussion and a video note take them; the Notice board does not). */
  video: boolean;
  /** Where an embedded medium's bytes and poster are read from, for the editor's own previews. */
  mediaUrl: (mediaId: string) => string;
  posterUrl: (mediaId: string) => string;
  uploadImage: (file: File, onProgress: (percent: number) => void, options: EmbeddedImageUploadOptions) => Promise<string>;
  uploadVideo: (file: File, options: { signal?: AbortSignal; onProgress?: (percent: number) => void; onPoster?: (stored: boolean) => void }) => Promise<string>;
  /** Drops an image the person removed while it was being prepared. */
  abort: (mediaId: string) => Promise<unknown>;
  /** Asks again for a failed display copy; absent where there is no such route. */
  retryRendition?: (mediaId: string, options: EmbeddedImageUploadOptions) => Promise<string>;
};

/** Link previews (#497), when a surface takes them: the card for an address just linked, or null. */
export type LinkPreviewRequest = (url: string, signal?: AbortSignal) => Promise<LinkPreviewCard | null>;
