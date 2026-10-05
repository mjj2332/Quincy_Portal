/**
 * Embedded media (#493): an image placed inside a post. The limits and the key layout live here so
 * the API, the sweep and the browser agree on them; the browser's checks are a convenience and the
 * server re-checks every one.
 */
export const EMBEDDED_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type EmbeddedImageContentType = (typeof EMBEDDED_IMAGE_CONTENT_TYPES)[number];
/**
 * HEIC / HEIF images (#495), a separate list on purpose: `EMBEDDED_IMAGE_CONTENT_TYPES` feeds the serving content type and the picker, and a
 * HEIC original is never served. A HEIC row is `kind = 'image'` with a JPEG display copy made by the background Worker.
 */
export const EMBEDDED_HEIC_CONTENT_TYPES = ["image/heic", "image/heif"] as const;
export type EmbeddedHeicContentType = (typeof EMBEDDED_HEIC_CONTENT_TYPES)[number];
/** The longest edge of a HEIC display copy. Larger photos are scaled down to it. */
export const EMBEDDED_DISPLAY_MAX_EDGE = 4096;
export const EMBEDDED_DISPLAY_CONTENT_TYPE = "image/jpeg";
/** The `embedded_media.rendition_status` values: `not_required` for every upload that needs no display copy. */
export const EMBEDDED_RENDITION_STATUSES = ["not_required", "pending", "ready", "failed"] as const;
export type EmbeddedRenditionStatus = (typeof EMBEDDED_RENDITION_STATUSES)[number];
/** The feature flag that opens HEIC to everyone; until it is on, only an Admin can upload HEIC. */
export const EMBEDDED_HEIC_UPLOADS_FLAG = "embedded_heic_uploads";
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

export function isEmbeddedHeicContentType(value: unknown): value is EmbeddedHeicContentType {
  return typeof value === "string" && (EMBEDDED_HEIC_CONTENT_TYPES as readonly string[]).includes(value);
}

/** The kind a declared content type uploads as, or null when it is neither an allowed image (HEIC included) nor an allowed video type. */
export function embeddedMediaKindFor(value: unknown): EmbeddedMediaKind | null {
  if (isEmbeddedImageContentType(value) || isEmbeddedHeicContentType(value)) return "image";
  return isEmbeddedVideoContentType(value) ? "video" : null;
}

/** A type the original may be served as. HEIC is excluded: its original is never served (#495). */
export const isEmbeddedMediaContentType = (value: unknown): value is EmbeddedImageContentType | EmbeddedVideoContentType => isEmbeddedImageContentType(value) || isEmbeddedVideoContentType(value);
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

/** The 4-character brands of an `ftyp` box: the major brand and every compatible brand, read from the bytes available (at most the box). Null when it is not an `ftyp` box. */
function ftypBrands(head: Uint8Array): string[] | null {
  if (head.length < 16) return null;
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return null;
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  if (size < 16) return null; // 0 (to end of file) and 1 (64-bit size) are not used by a real HEIF `ftyp`
  const end = Math.min(size, head.length);
  const brands: string[] = [String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(String.fromCharCode(head[offset]!, head[offset + 1]!, head[offset + 2]!, head[offset + 3]!));
  return brands;
}

/** Brands of an HEVC-coded HEIF image (HEIC). `mif1` and `msf1` alone are generic HEIF and may hold AVIF, so they never count. */
const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
/** Any brand that names a HEIF or AVIF still image or image sequence: a video container never carries one. */
const HEIF_FAMILY_BRANDS: ReadonlySet<string> = new Set([...HEIC_BRANDS, "mif1", "msf1", "avif", "avis"]);

/**
 * True when the bytes open with an `ftyp` box naming an HEVC HEIF image: the major brand or any compatible brand is `heic`, `heix`, `heim`,
 * `heis`, `hevc`, `hevx`, `hevm` or `hevs`. Read at least 64 bytes: the box is 24 bytes for a Samsung photo and longer for an iPhone's. AVIF
 * and a bare `mif1` / `msf1` (no HEVC brand) are refused.
 */
export function sniffHeifImage(head: Uint8Array): boolean {
  const brands = ftypBrands(head);
  return brands !== null && brands.some((brand) => HEIC_BRANDS.has(brand));
}

/** One poster per attempt: a unique key means cleaning up a failed or lost write can never delete a poster that is live. */
export function embeddedMediaPosterKey(projectId: string, mediaId: string, nonce: string): string {
  return `projects/${projectId}/embedded-media/${mediaId}/poster-${nonce}`;
}

/**
 * Names an MP4 or QuickTime container from its first bytes: an `ftyp` box at the start whose size is at least 8 (or 1, a 64-bit size).
 * The `qt  ` brand is QuickTime, every other brand is MP4. Legacy QuickTime files with no `ftyp` (they open with `wide`, `mdat`, `moov`
 * or `free`) are refused, and so is a box that names a HEIF or AVIF brand (a still image, not a video).
 */
export function sniffEmbeddedVideoType(head: Uint8Array): EmbeddedVideoContentType | null {
  if (head.length < 12) return null;
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return null;
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  if (size !== 1 && size < 8) return null;
  // HEIC and AVIF stills share the `ftyp` box with MP4, so a photo declared as a video would otherwise be stored as one (#495).
  if (ftypBrands(head)?.some((brand) => HEIF_FAMILY_BRANDS.has(brand))) return null;
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

export type JpegInspection = { width: number; height: number; metadata: boolean };

/**
 * Reads a JPEG's marker segments up to the start of scan: its size from the first SOF marker, and whether any EXIF or XMP segment (APP1) is present.
 * Returns null when the bytes are not a well-formed JPEG header (no SOI, a truncated segment, no SOF before SOS, a zero size). It is not a decoder:
 * Cloudflare's `cf-resized` header remains the decode gate. A HEIC display copy must come back with `metadata: false` so GPS and camera data never reach a reader (#495).
 */
export function inspectJpeg(bytes: Uint8Array): JpegInspection | null {
  if (!isJpeg(bytes)) return null;
  let offset = 2; let size: { width: number; height: number } | null = null; let metadata = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; } // standalone markers
    if (marker === 0xd9) return null; // EOI before a scan
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const data = offset + 4;
    if (marker === 0xe1) {
      const ascii = (at: number, count: number) => String.fromCharCode(...bytes.subarray(data + at, data + at + count));
      if (ascii(0, 6) === "Exif\0\0" || ascii(0, 29) === "http://ns.adobe.com/xap/1.0/\0" || ascii(0, 5) === "http:") metadata = true;
    }
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8 || size) return null;
      size = { height: (bytes[data + 1]! << 8) | bytes[data + 2]!, width: (bytes[data + 3]! << 8) | bytes[data + 4]! };
    }
    if (marker === 0xda) break; // start of scan: the entropy-coded data follows, no metadata segments after it
    offset += 2 + length;
  }
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { ...size, metadata };
}

/**
 * A HEIC row's JPEG display copy (#495). One key per attempt, so cleaning up a failed or lost write can never delete a copy that is live.
 * It sits under the owner's own prefix: a Project hard delete's prefix purge covers it, and a Notice board key stays outside `projects/`.
 */
export function embeddedMediaDisplayKey(projectId: string | null, mediaId: string, nonce: string): string {
  return projectId === null ? `notice-board/embedded-media/${mediaId}/display-${nonce}.jpg` : `projects/${projectId}/embedded-media/${mediaId}/display-${nonce}.jpg`;
}
