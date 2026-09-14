/**
 * Runtime-neutral contracts for camera RAW media.
 *
 * The ordinary upload gate remains JPEG-only (`media.ts`).  Dropbox RAW imports use
 * this leaf to identify DNG sources without widening that global upload contract.
 */

export const DNG_EXTENSION = ".dng" as const;
export const DNG_CONTENT_TYPE = "image/x-adobe-dng" as const;

/** The content type stored for a RAW source, when its filename is supported. */
export type RawMediaContentType = typeof DNG_CONTENT_TYPE | "image/jpeg";

/**
 * Match a filename's complete extension, case-insensitively.  In particular, a name
 * containing `.dng` in the middle is not a DNG source.
 */
export function isDngFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(DNG_EXTENSION);
}

/**
 * Dropbox's source metadata is based on the original filename, not a client-provided
 * MIME hint.  JPEG remains the existing source type; DNG is the only additional RAW type.
 */
export function rawMediaContentType(filename: string): RawMediaContentType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(DNG_EXTENSION)) return DNG_CONTENT_TYPE;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

/** Return whether a filename is an importable RAW or JPEG source. */
export function isRawMediaFilename(filename: string): boolean {
  return rawMediaContentType(filename) !== null;
}

/**
 * Derive the embedded-preview object key from its immutable original key.
 *
 * Keeping the derivative beside the original means project-prefix enumeration purges both
 * objects without a database column or a second ownership index.  The original key is never
 * modified or overwritten.
 */
export function dngPreviewKey(originalKey: string): string {
  if (!originalKey || originalKey.includes("\0")) throw new Error("DNG original key is invalid");
  return `${originalKey}.preview.jpg`;
}
