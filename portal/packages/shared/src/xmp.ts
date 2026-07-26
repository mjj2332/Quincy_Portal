/**
 * XMP star-rating extraction (spike ④, Implementation-Plan §2 A2).
 *
 * Validated 2026-07-19 against 44 real studio Lightroom exports
 * (`test-data/Test Images with star rating/`): the rating is the RDF attribute
 * `xmp:Rating="N"` inside the `<x:xmpmeta>…</x:xmpmeta>` packet, which sits
 * in an APP1 segment near the start of the JPEG. A header range-read is
 * enough — no full decode.
 *
 * Semantics: ABSENCE of xmp:Rating = unrated → null. Never coerce to 0.
 * (xmp:Rating="0" explicitly present would mean an explicit zero; Lightroom
 * omits the attribute for unrated frames, and -1 means "rejected".)
 */

/** How many leading bytes to read to reliably capture the XMP packet. */
export const XMP_SCAN_BYTES = 256 * 1024;

export type XmpRating = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export function parseXmpRating(headerBytes: ArrayBuffer | Uint8Array): XmpRating | null {
  const bytes = headerBytes instanceof Uint8Array ? headerBytes : new Uint8Array(headerBytes);
  // XMP packets are UTF-8 XML; decode leniently and search textually.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);

  const packetStart = text.indexOf("<x:xmpmeta");
  if (packetStart === -1) return null;
  const packetEnd = text.indexOf("</x:xmpmeta>", packetStart);
  const packet = packetEnd === -1 ? text.slice(packetStart) : text.slice(packetStart, packetEnd);

  // Attribute form (Lightroom): xmp:Rating="1"  — allow single or double quotes.
  const attr = packet.match(/xmp:Rating\s*=\s*["'](-?\d+)["']/);
  // Element form (some writers): <xmp:Rating>3</xmp:Rating>
  const elem = packet.match(/<xmp:Rating>\s*(-?\d+)\s*<\/xmp:Rating>/);

  const raw = attr?.[1] ?? elem?.[1];
  if (raw === undefined) return null;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < -1 || value > 5) return null;
  return value as XmpRating;
}

/**
 * Store-ready mapping: portal star ratings are 1–5;
 * unrated (null), explicit 0, and rejected (-1) all store as null stars.
 */
export function xmpRatingToStars(rating: XmpRating | null): 1 | 2 | 3 | 4 | 5 | null {
  return rating !== null && rating >= 1 ? (rating as 1 | 2 | 3 | 4 | 5) : null;
}
