import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_POST,
  attachmentCompleteResponseSchema,
  attachmentExtension,
  attachmentPresignResponseSchema,
  attachmentRefusal,
  attachmentRefusalMessage,
  normalizeAttachmentName,
} from "@quincy/shared";
import { embeddedImageContentType, embeddedVideoContentType } from "./embedded-media-core";
import { uploadMultipartFile } from "./multipart-upload";

/**
 * Attachments (#945, tracer #952): any file shared on a post and downloaded, never shown inline. The part that touches no network API of the
 * app, so the Review-link page may reach it (#956; `guest/guest-boundary.guard.test.ts`): the path split, the composer's checks, the upload flow
 * over an `AttachmentIo`, and the transport the editor is given. The staff `lib/attachments.ts` supplies an `AttachmentIo` over `lib/api`.
 *
 * The composer's checks are a convenience: the server re-checks every one, and its refusal is what the author is shown when the two disagree.
 */
export { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_POST };

/** Where an Attachment is downloaded from. It carries the id only, never a name or a key. */
export function attachmentUrl(attachmentId: string): string {
  return `/media/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * Whether a picked, pasted or dropped file goes down the Embedded media path (#952 D8): a photo the person may embed (JPEG, PNG, WebP, and HEIC
 * only when this person may upload it) or, where the surface takes video, an MP4 or MOV. By type, never by size: a 30 MB JPEG is still a photo,
 * refused as one. Anything else is an Attachment (owner decision A3: GIF, TIFF, raw, WebM, HEIC while HEIC is off).
 */
export function isEmbeddedMediaFile(file: Pick<File, "type" | "name">, options: { heic: boolean; video: boolean }): boolean {
  if (embeddedImageContentType(file, options.heic)) return true;
  return options.video && embeddedVideoContentType(file) !== null;
}

/** A plain-language reason the file cannot be attached, or null when it can. */
export function attachmentProblem(file: Pick<File, "type" | "size" | "name">, maxBytes: number = ATTACHMENT_MAX_BYTES): string | null {
  const name = normalizeAttachmentName(file.name);
  if (!name) return "This file has no usable name.";
  const refusal = attachmentRefusal(name, file.type);
  if (refusal) return attachmentRefusalMessage(file.name, refusal);
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > maxBytes) return `${file.name} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the most a file can be.`;
  return null;
}

export const attachmentCountMessage = (max: number) => `A post can hold ${max} attachments at most.`;

/** What a chip's icon shows, by extension. */
export type AttachmentKind = "pdf" | "sheet" | "document" | "slides" | "archive" | "image" | "audio" | "video" | "file";
const KIND_BY_EXTENSION: Record<string, AttachmentKind> = Object.fromEntries(([
  ["pdf", ["pdf"]],
  ["sheet", ["xls", "xlsx", "xlsb", "ods", "csv", "tsv", "numbers"]],
  ["document", ["doc", "docx", "odt", "rtf", "txt", "md", "pages"]],
  ["slides", ["ppt", "pptx", "odp", "key"]],
  ["archive", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"]],
  ["image", ["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp", "heic", "heif", "psd", "ai", "eps", "raw", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "xmp"]],
  ["audio", ["mp3", "wav", "aac", "m4a", "flac", "ogg", "aif", "aiff"]],
  ["video", ["mp4", "mov", "m4v", "webm", "avi", "mkv", "mxf", "braw", "r3d"]],
] as const).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind])));

export function attachmentKindFor(name: string): AttachmentKind {
  const extension = attachmentExtension(name);
  return (extension && KIND_BY_EXTENSION[extension]) || "file";
}

/** What one upload costs, over some set of routes. Each method returns the raw JSON (the flow parses it with the shared schemas) or throws. */
export type AttachmentIo = {
  presign(body: { name: string; contentType: string; bytes: number }): Promise<unknown>;
  /** Where the bytes go in dev (no presigned URL): the route that takes the PUT. */
  directUrl(attachmentId: string): string;
  complete(attachmentId: string, body: { parts?: { partNumber: number; etag: string }[] }): Promise<unknown>;
  /** Drops an upload that will not be finished. Fire and forget. */
  abort(attachmentId: string): Promise<unknown>;
};

export type AttachmentUploadOptions = { signal?: AbortSignal; onProgress?: (percent: number) => void };

const abortError = () => Object.assign(new Error("Upload cancelled"), { name: "AbortError" });

/**
 * The server refused the file itself (a blocked type, too large, a bad name, too many), so sending it again cannot help: a 4xx other than 408
 * and 429. A network failure, a throttle or a 5xx is worth a Retry.
 */
export function isAttachmentRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * presign, the bytes straight to R2 with byte progress and cancel, then complete; resolves with the Attachment's id. From the presign on, a
 * cancel or a failure tells the server to abort, so no reservation or object is left behind. A cancel rejects as an `AbortError`.
 */
export async function uploadAttachmentVia(io: AttachmentIo, file: File, options: AttachmentUploadOptions = {}): Promise<string> {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw abortError();
  const presign = attachmentPresignResponseSchema.parse(await io.presign({ name: file.name, contentType: file.type, bytes: file.size }));
  // A cancel is not queued behind the completion call: it is raced against the signal, so the abort goes out the moment the author cancels.
  const cancelled = new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(abortError()), { once: true }); });
  cancelled.catch(() => undefined);
  const unlessCancelled = <T,>(work: Promise<T>): Promise<T> => signal ? Promise.race([work, cancelled]) : work;
  try {
    if (signal?.aborted) throw abortError();
    const completed = await uploadMultipartFile(
      file,
      { key: presign.attachmentId, ...(presign.uploadId ? { uploadId: presign.uploadId } : {}), ...(presign.partUrls ? { partUrls: presign.partUrls } : {}), ...(presign.partBytes ? { partBytes: presign.partBytes } : {}), ...(presign.devDirect ? { devDirect: true } : {}) },
      io.directUrl(presign.attachmentId),
      undefined,
      { ...(signal ? { signal } : {}), onBytes: (loaded, total) => onProgress?.(Math.min(100, Math.round((loaded / total) * 100))) },
    );
    if (signal?.aborted) throw abortError();
    const done = attachmentCompleteResponseSchema.parse(await unlessCancelled(io.complete(presign.attachmentId, completed.parts ? { parts: completed.parts } : {})));
    return done.attachmentId;
  } catch (error) {
    await io.abort(presign.attachmentId);
    throw error;
  }
}

/**
 * What the rich-text editor needs to attach files (#952): injected by the host, so the editor itself imports no network module. Absent, the
 * editor's picker, paste and drop behave exactly as before (Video notes and Guest notes, until their tickets).
 */
export type EditorAttachmentTransport = {
  maxPerPost: number;
  maxBytes: number;
  url: (attachmentId: string) => string;
  upload: (file: File, options: AttachmentUploadOptions) => Promise<string>;
};
