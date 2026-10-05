/**
 * Embedded media (#493): an image placed inside a post. The limits and the key layout live here so
 * the API, the sweep and the browser agree on them; the browser's checks are a convenience and the
 * server re-checks every one.
 */
export const EMBEDDED_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type EmbeddedImageContentType = (typeof EMBEDDED_IMAGE_CONTENT_TYPES)[number];
export const EMBEDDED_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** Video in Project discussion (#494): MP4 or MOV, no transcoding. "1 GB" is 1 GiB. */
export const EMBEDDED_VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime"] as const;
export type EmbeddedVideoContentType = (typeof EMBEDDED_VIDEO_CONTENT_TYPES)[number];
export const EMBEDDED_VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
/** The poster frame the browser captures at upload: a JPEG, so it is small. */
export const EMBEDDED_POSTER_MAX_BYTES = 2 * 1024 * 1024;
export const EMBEDDED_POSTER_CONTENT_TYPE = "image/jpeg";
/** A gigabyte on a slow connection outlives the default hour, so a video's presigned part URLs live six hours. */
export const EMBEDDED_VIDEO_PART_URL_TTL_SECONDS = 6 * 60 * 60;
export type EmbeddedMediaKind = "image" | "video";
export const EMBEDDED_MEDIA_MAX_PER_POST = 10;
/** A row that is still `uploading`, `pending` or `detached` this long is reclaimed by the daily sweep. */
export const EMBEDDED_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function isEmbeddedImageContentType(value: unknown): value is EmbeddedImageContentType {
  return typeof value === "string" && (EMBEDDED_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isEmbeddedVideoContentType(value: unknown): value is EmbeddedVideoContentType {
  return typeof value === "string" && (EMBEDDED_VIDEO_CONTENT_TYPES as readonly string[]).includes(value);
}

/** The kind a declared content type uploads as, or null when it is neither an allowed image nor an allowed video type. */
export function embeddedMediaKindFor(value: unknown): EmbeddedMediaKind | null {
  if (isEmbeddedImageContentType(value)) return "image";
  return isEmbeddedVideoContentType(value) ? "video" : null;
}

export const isEmbeddedMediaContentType = (value: unknown): value is EmbeddedImageContentType | EmbeddedVideoContentType => embeddedMediaKindFor(value) !== null;
export const embeddedMediaMaxBytes = (kind: EmbeddedMediaKind): number => (kind === "video" ? EMBEDDED_VIDEO_MAX_BYTES : EMBEDDED_MEDIA_MAX_BYTES);

/** A Project's embedded media sits under the Project's own storage prefix (`projects/<id>/`), which
 * is exactly what `DELETE /projects/:id` purges. The key never carries a user-supplied filename. */
export function embeddedMediaObjectKey(projectId: string, mediaId: string): string {
  return `projects/${projectId}/embedded-media/${mediaId}/original`;
}

/** Names the image type from an object's first bytes, or null when they are not JPEG, PNG or WebP. */
export function sniffEmbeddedImageType(head: Uint8Array): EmbeddedImageContentType | null {
  const startsWith = (offset: number, signature: readonly number[]) => signature.every((value, index) => head[offset + index] === value);
  if (head.length >= 3 && startsWith(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (head.length >= 8 && startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (head.length >= 12 && startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/** One poster per attempt: a unique key means cleaning up a failed or lost write can never delete a poster that is live. */
export function embeddedMediaPosterKey(projectId: string, mediaId: string, nonce: string): string {
  return `projects/${projectId}/embedded-media/${mediaId}/poster-${nonce}`;
}

/**
 * Names an MP4 or QuickTime container from its first bytes: an `ftyp` box at the start whose size is at least 8 (or 1, a 64-bit size).
 * The `qt  ` brand is QuickTime, every other brand is MP4. Legacy QuickTime files with no `ftyp` (they open with `wide`, `mdat`, `moov`
 * or `free`) are refused.
 */
export function sniffEmbeddedVideoType(head: Uint8Array): EmbeddedVideoContentType | null {
  if (head.length < 12) return null;
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return null;
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  if (size !== 1 && size < 8) return null;
  return head[8] === 0x71 && head[9] === 0x74 && head[10] === 0x20 && head[11] === 0x20 ? "video/quicktime" : "video/mp4";
}

export const isJpeg = (head: Uint8Array): boolean => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;

/** The sniffer for a row's kind. */
export function sniffEmbeddedMediaType(kind: EmbeddedMediaKind, head: Uint8Array): EmbeddedImageContentType | EmbeddedVideoContentType | null {
  return kind === "video" ? sniffEmbeddedVideoType(head) : sniffEmbeddedImageType(head);
}

/** A Notice board post's media (#496). The post is created after its images are uploaded, so the key cannot carry the post id: the
 * post owns the image through the D1 row (`owner_kind = 'notice_post'`, `owner_id`). The prefix sits outside `projects/`, so a
 * Project hard delete never touches it. */
export function noticeEmbeddedMediaObjectKey(mediaId: string): string {
  return `notice-board/embedded-media/${mediaId}/original`;
}
