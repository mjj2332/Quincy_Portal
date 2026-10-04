/**
 * Embedded media (#493): an image placed inside a post. The limits and the key layout live here so
 * the API, the sweep and the browser agree on them; the browser's checks are a convenience and the
 * server re-checks every one.
 */
export const EMBEDDED_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type EmbeddedImageContentType = (typeof EMBEDDED_IMAGE_CONTENT_TYPES)[number];
export const EMBEDDED_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const EMBEDDED_MEDIA_MAX_PER_POST = 10;
/** A row that is still `uploading`, `pending` or `detached` this long is reclaimed by the daily sweep. */
export const EMBEDDED_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function isEmbeddedImageContentType(value: unknown): value is EmbeddedImageContentType {
  return typeof value === "string" && (EMBEDDED_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

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
