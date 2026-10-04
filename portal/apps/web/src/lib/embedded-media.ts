import {
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  EMBEDDED_VIDEO_CONTENT_TYPES,
  EMBEDDED_VIDEO_MAX_BYTES,
  isEmbeddedVideoContentType,
  type EmbeddedVideoContentType,
  externalEmbeddedMediaCompleteSchema,
  externalEmbeddedMediaPresignSchema,
  isEmbeddedImageContentType,
} from "@quincy/shared";
import { apiPost } from "./api";
import { uploadMultipartFile } from "./multipart-upload";
import { captureVideoPoster } from "./video-poster";

/** Embedded images (#493). The browser's checks are a convenience: the server re-checks every one. */
export { EMBEDDED_MEDIA_MAX_PER_POST };

const MAX_MB = Math.round(EMBEDDED_MEDIA_MAX_BYTES / (1024 * 1024));

/** The auth-gated URL an embedded image is shown from. It carries the id only, never a key. */
export function embeddedMediaUrl(mediaId: string): string {
  return `/media/embedded/${encodeURIComponent(mediaId)}`;
}

/** A plain-language reason the file cannot be embedded, or null when it can. */
export function embeddedImageProblem(file: Pick<File, "type" | "size" | "name">): string | null {
  if (!isEmbeddedImageContentType(file.type)) return `${file.name || "This file"} is not a JPEG, PNG or WebP image.`;
  if (file.size <= 0) return `${file.name || "This file"} is empty.`;
  if (file.size > EMBEDDED_MEDIA_MAX_BYTES) return `${file.name || "This image"} is larger than ${MAX_MB} MB.`;
  return null;
}

export const EMBEDDED_IMAGE_ACCEPT = EMBEDDED_IMAGE_CONTENT_TYPES.join(",");

/** Where an upload belongs: a Project's discussion, or the Notice board (#496). */
export type EmbeddedMediaScope = { projectId: string } | { noticeBoard: true };

function mediaBase(scope: EmbeddedMediaScope): string {
  return "noticeBoard" in scope ? "/api/notice-board/embedded-media" : `/api/projects/${encodeURIComponent(scope.projectId)}/embedded-media`;
}

/** presign, then bytes straight to R2, then complete. Resolves with the media id once the server accepts the file. */
export async function uploadEmbeddedImage(scope: EmbeddedMediaScope, file: File, onProgress?: (percent: number) => void): Promise<string> {
  const base = mediaBase(scope);
  const presign = externalEmbeddedMediaPresignSchema.parse(await apiPost<unknown, { contentType: string; bytes: number }>(base, { contentType: file.type, bytes: file.size }));
  const completed = await uploadMultipartFile(
    file,
    { key: presign.mediaId, ...(presign.uploadId ? { uploadId: presign.uploadId } : {}), ...(presign.partUrls ? { partUrls: presign.partUrls } : {}), ...(presign.partBytes ? { partBytes: presign.partBytes } : {}), ...(presign.devDirect ? { devDirect: true } : {}) },
    `${base}/${encodeURIComponent(presign.mediaId)}/direct`,
    onProgress,
  );
  const done = externalEmbeddedMediaCompleteSchema.parse(await apiPost<unknown, { parts?: { partNumber: number; etag: string }[] }>(`${base}/${encodeURIComponent(presign.mediaId)}/complete`, completed.parts ? { parts: completed.parts } : {}));
  return done.mediaId;
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

const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });

/**
 * A Project video (#494): presign, bytes straight to R2 with byte progress and cancel, complete, then the poster frame (captured
 * in the browser while the bytes go up; best effort, so a file this browser cannot decode simply has none). Resolves with the media
 * id. A cancelled or failed upload tells the server to abort, so no reservation or object is left behind; the abort request is
 * `keepalive`, so it survives the page closing. A cancel rejects as an `AbortError`.
 */
export async function uploadEmbeddedVideo(projectId: string, file: File, options: { signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<string> {
  const { signal, onProgress } = options;
  const contentType = embeddedVideoContentType(file);
  if (!contentType) throw new Error(`${file.name || "This file"} is not an MP4 or MOV video.`);
  if (signal?.aborted) throw abortError();
  const base = mediaBase({ projectId });
  const presign = externalEmbeddedMediaPresignSchema.parse(await apiPost<unknown, { contentType: string; bytes: number }>(base, { contentType, bytes: file.size }));
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
    if (frame) await unlessCancelled(fetch(`${mediaUrl}/poster`, { method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" }, body: frame, ...(signal ? { signal } : {}) }).catch(() => undefined));
    if (signal?.aborted) throw abortError();
    return done.mediaId;
  } catch (error) {
    await abortOnServer();
    throw error;
  }
}
