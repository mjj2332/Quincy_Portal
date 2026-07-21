/**
 * Media/ingest contracts (Implementation-Plan §2 A2, D-01).
 */

export const COLLECTION_KINDS = ["raw", "edited", "video", "floorplan", "copy"] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export const ASSET_SOURCES = ["upload", "dropbox", "tonomo"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

export const RENDITION_VARIANTS = ["thumb", "web"] as const;
export type RenditionVariant = (typeof RENDITION_VARIANTS)[number];

/** D-01: photo ingest is JPEG-only. Camera RAW never enters the portal. */
export const ACCEPTED_PHOTO_EXTENSIONS = [".jpg", ".jpeg"] as const;
export const ACCEPTED_PHOTO_MIME = "image/jpeg";

export function isAcceptedPhotoFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_PHOTO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Rendition targets: crisp QA on a 4K monitor (Implementation-Plan §2 A2). */
export const RENDITION_SPECS: Record<RenditionVariant, { maxEdge: number; quality: number }> = {
  web: { maxEdge: 3200, quality: 85 },
  thumb: { maxEdge: 640, quality: 75 },
};

/**
 * XMP star rating semantics (validated 2026-07-19 against real studio exports):
 * rating is the RDF attribute xmp:Rating="N" inside the <x:xmpmeta> packet.
 * ABSENCE of the attribute = unrated (null) — never coerce to 0.
 */
export type RatingFromMetadata = 1 | 2 | 3 | 4 | 5 | null;
