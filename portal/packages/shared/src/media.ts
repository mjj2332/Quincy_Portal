/**
 * Media/ingest contracts (Implementation-Plan §2 A2, D-01).
 */

export const COLLECTION_KINDS = ["raw", "edited", "video", "floorplan", "copy"] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export const ASSET_SOURCES = ["upload", "dropbox", "tonomo"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

export const RENDITION_VARIANTS = ["thumb", "web"] as const;
export type RenditionVariant = (typeof RENDITION_VARIANTS)[number];

/** Bump when rendition options or validation requirements change. */
export const RENDITION_SPEC_VERSION = "v1";
/** Bump to make a repaired transform URL distinct from previously cached failures. */
export const TRANSFORM_CACHE_VERSION = "v2";

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

export function renditionR2Key(
  assetId: string,
  contentHash: string | null,
  variant: RenditionVariant,
  outputDigest: string,
  contentType: "image/webp" | "image/jpeg",
): string {
  // Asset IDs identify immutable source rows. Keep a content component too, so a future
  // re-ingest/import cannot accidentally share a derivative key with different bytes.
  const content = encodeURIComponent(contentHash || "source-unknown");
  if (!/^[a-f0-9]{64}$/i.test(outputDigest)) throw new Error("Rendition output digest must be a SHA-256 hex digest");
  // The output digest makes each successfully written object immutable. A retry after an R2
  // success / D1 failure adopts this key after HEAD instead of overwriting it.
  const extension = contentType === "image/jpeg" ? "jpg" : "webp";
  return `renditions/${assetId}/${content}/${RENDITION_SPEC_VERSION}/${variant}/${outputDigest.toLowerCase()}.${extension}`;
}

/**
 * XMP star rating semantics (validated 2026-07-19 against real studio exports):
 * rating is the RDF attribute xmp:Rating="N" inside the <x:xmpmeta> packet.
 * ABSENCE of the attribute = unrated (null) — never coerce to 0.
 */
export type RatingFromMetadata = 1 | 2 | 3 | 4 | 5 | null;
