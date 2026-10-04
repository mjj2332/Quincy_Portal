import {
  EMBEDDED_IMAGE_CONTENT_TYPES,
  EMBEDDED_MEDIA_MAX_BYTES,
  EMBEDDED_MEDIA_MAX_PER_POST,
  externalEmbeddedMediaCompleteSchema,
  externalEmbeddedMediaPresignSchema,
  isEmbeddedImageContentType,
} from "@quincy/shared";
import { apiPost } from "./api";
import { uploadMultipartFile } from "./multipart-upload";

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
