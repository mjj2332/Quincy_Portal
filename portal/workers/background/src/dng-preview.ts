import { dngPreviewKey, isDngFilename } from "@quincy/shared";
import { JXL_INPUT_MAX_BYTES, JXL_MAX_PIXELS, JXL_OUTPUT_MAX_BYTES, transcodeJxlPreview } from "./jxl-preview";

/** A classic TIFF/DNG metadata read is deliberately kept well below Worker memory limits. */
export const DNG_METADATA_MAX_BYTES = 1 * 1024 * 1024;
/** Embedded previews are the only bytes copied out of a DNG, and are bounded before reading. */
export const DNG_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
/** A camera thumbnail is not sufficient for RAW review; require a review-sized preview. */
export const DNG_PREVIEW_MIN_EDGE = 640;
/** Version marker for deterministic cached preview objects. */
export const DNG_PREVIEW_CACHE_VERSION = "v1";

const MAX_IFDS = 64;
const MAX_IFD_DEPTH = 32;
const MAX_ARRAY_ITEMS = 4096;
const JPEG_EXIF_BYTES = 36;
const DNG_COMPRESSION_JPEG_XL = 52546;

export type DngPreviewFailureCode =
  | "source-missing"
  | "source-empty"
  | "read-failed"
  | "unsupported-bigtiff"
  | "malformed-tiff"
  | "metadata-limit"
  | "preview-limit"
  | "no-usable-preview";

/** A stable, log-safe error shape for callers and queue diagnostics. */
export class DngPreviewError extends Error {
  readonly code: DngPreviewFailureCode;

  constructor(code: DngPreviewFailureCode, message: string) {
    super(message);
    this.name = "DngPreviewError";
    this.code = code;
  }
}

/** The subset of R2Bucket used by the bounded extractor. */
export type DngPreviewBucket = Pick<R2Bucket, "head" | "get" | "put">;

export type JpegDimensions = {
  width: number;
  height: number;
  /** One of SOF0, SOF1, or SOF2; exposed for focused validation tests. */
  sofMarker: number;
};

export type DngPreviewExtraction = JpegDimensions & {
  jpeg: Uint8Array;
  orientation: Orientation;
  ifdOffset: number;
};

export type StoredDngPreview = DngPreviewExtraction & {
  key: string;
  cached: boolean;
};

type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type ByteOrder = "II" | "MM";

type ParsedIfd = {
  offset: number;
  nextOffset: number;
  topLevelIndex: number | null;
  newSubfileType: number | null;
  compression: number | null;
  width: number | null;
  height: number | null;
  orientation: Orientation | null;
  jpegOffset: number | null;
  jpegLength: number | null;
  stripOffsets: number[];
  stripByteCounts: number[];
  tileOffsets: number[];
  tileByteCounts: number[];
  subIfdOffsets: number[];
};

type Candidate = ParsedIfd & { isIfd1: boolean; isSubIfd: boolean };

const TIFF_TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD (classic TIFF)
};

const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_COMPRESSION = 259;
const TAG_ORIENTATION = 274;
const TAG_STRIP_OFFSETS = 273;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_SUB_IFDS = 330;
const TAG_JPEG_INTERCHANGE_FORMAT = 513;
const TAG_JPEG_INTERCHANGE_FORMAT_LENGTH = 514;

function fail(code: DngPreviewFailureCode, message: string): never {
  throw new DngPreviewError(code, message);
}

function checkedProduct(a: number, b: number, label: string): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a !== 0 && b > Number.MAX_SAFE_INTEGER / a) {
    fail("malformed-tiff", `${label} overflows the safe integer range`);
  }
  return a * b;
}

function checkedAdd(a: number, b: number, label: string): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > Number.MAX_SAFE_INTEGER - b) {
    fail("malformed-tiff", `${label} overflows the safe integer range`);
  }
  return a + b;
}

function asBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail("malformed-tiff", "TIFF metadata read is truncated");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail("malformed-tiff", "TIFF metadata read is truncated");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function readUnsigned(bytes: Uint8Array, offset: number, type: number, littleEndian: boolean): number {
  if (type === 1 || type === 2 || type === 6 || type === 7) {
    if (offset >= bytes.byteLength) fail("malformed-tiff", "TIFF value is truncated");
    return bytes[offset]!;
  }
  if (type === 3 || type === 8) return readU16(bytes, offset, littleEndian);
  if (type === 4 || type === 9 || type === 13) return readU32(bytes, offset, littleEndian);
  fail("malformed-tiff", `TIFF type ${type} is not an integer value`);
}

function supportedOrientation(value: number | undefined): Orientation | null {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 8 ? value as Orientation : null;
}

function expectedType(tag: number): ReadonlySet<number> | null {
  switch (tag) {
    case TAG_NEW_SUBFILE_TYPE:
    case TAG_IMAGE_WIDTH:
    case TAG_IMAGE_LENGTH:
    case TAG_COMPRESSION:
    case TAG_ORIENTATION:
    case TAG_STRIP_OFFSETS:
    case TAG_STRIP_BYTE_COUNTS:
    case TAG_TILE_OFFSETS:
    case TAG_TILE_BYTE_COUNTS:
    case TAG_SUB_IFDS:
    case TAG_JPEG_INTERCHANGE_FORMAT:
    case TAG_JPEG_INTERCHANGE_FORMAT_LENGTH:
      return new Set([1, 3, 4, 6, 7, 8, 9, 13]);
    default:
      return null;
  }
}

class BoundedDngReader {
  readonly size: number;
  private metadataBytes = 0;
  private rangeReads = 0;

  constructor(private readonly bucket: DngPreviewBucket, private readonly key: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 0) fail("malformed-tiff", "DNG object size is invalid");
    this.size = size;
  }

  private validateObjectRange(offset: number, length: number, label: string): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset > this.size || length > this.size - offset) {
      fail("malformed-tiff", `${label} range is outside the DNG object`);
    }
  }

  private async read(offset: number, length: number, kind: "metadata" | "preview"): Promise<Uint8Array> {
    this.validateObjectRange(offset, length, kind === "metadata" ? "TIFF metadata" : "JPEG preview");
    if (++this.rangeReads > MAX_IFDS * 8) fail("metadata-limit", "DNG range-read limit exceeded");
    if (kind === "metadata") {
      if (length > DNG_METADATA_MAX_BYTES - this.metadataBytes) fail("metadata-limit", `DNG metadata exceeds ${DNG_METADATA_MAX_BYTES} bytes`);
      this.metadataBytes += length;
    } else if (length > DNG_PREVIEW_MAX_BYTES) {
      fail("preview-limit", `Embedded JPEG preview exceeds ${DNG_PREVIEW_MAX_BYTES} bytes`);
    }
    let object: Awaited<ReturnType<DngPreviewBucket["get"]>>;
    try {
      object = await this.bucket.get(this.key, { range: { offset, length } });
    } catch {
      fail("read-failed", `Unable to read ${kind} range from DNG source`);
    }
    if (!object) fail("read-failed", `DNG source range is unavailable (${kind})`);
    let buffer: ArrayBuffer;
    try {
      buffer = await object.arrayBuffer();
    } catch {
      fail("read-failed", `Unable to read ${kind} range from DNG source`);
    }
    const bytes = asBytes(buffer);
    // R2 returns a short body only when the requested range reaches EOF. Bounds were checked
    // against HEAD first, so a short response is a truncated object or a faulty test double.
    if (bytes.byteLength !== length) fail("read-failed", `DNG ${kind} range is truncated`);
    return bytes;
  }

  metadata(offset: number, length: number): Promise<Uint8Array> {
    return this.read(offset, length, "metadata");
  }

  preview(offset: number, length: number): Promise<Uint8Array> {
    return this.read(offset, length, "preview");
  }
}

function fieldBytes(entry: Uint8Array, typeBytes: number, count: number, littleEndian: boolean): { bytes: Uint8Array; externalOffset: number | null; length: number } {
  const length = checkedProduct(typeBytes, count, "TIFF field length");
  if (length <= 4) return { bytes: entry.subarray(8, 8 + length), externalOffset: null, length };
  return { bytes: new Uint8Array(), externalOffset: readU32(entry, 8, littleEndian), length };
}

async function valuesForEntry(reader: BoundedDngReader, entry: Uint8Array, tag: number, type: number, count: number, littleEndian: boolean): Promise<number[]> {
  const typeBytes = TIFF_TYPE_BYTES[type];
  if (!typeBytes) fail("malformed-tiff", `TIFF tag ${tag} uses an unknown type ${type}`);
  if (count > MAX_ARRAY_ITEMS) fail("metadata-limit", `TIFF tag ${tag} has too many values`);
  const field = fieldBytes(entry, typeBytes, count, littleEndian);
  let bytes = field.bytes;
  if (field.externalOffset !== null) bytes = await reader.metadata(field.externalOffset, field.length);
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(readUnsigned(bytes, index * typeBytes, type, littleEndian));
  return values;
}

async function parseIfd(reader: BoundedDngReader, offset: number, topLevelIndex: number | null, littleEndian: boolean): Promise<ParsedIfd> {
  // The count itself is a metadata range, then the complete IFD is fetched once.  This avoids
  // one R2 subrequest per entry while still never fetching the source object wholesale.
  const countBytes = await reader.metadata(offset, 2);
  const count = readU16(countBytes, 0, littleEndian);
  const entriesBytes = checkedProduct(count, 12, "TIFF IFD entry count");
  const ifdLength = checkedAdd(checkedAdd(2, entriesBytes, "TIFF IFD length"), 4, "TIFF IFD length");
  const ifd = await reader.metadata(offset, ifdLength);
  const result: ParsedIfd = {
    offset,
    nextOffset: readU32(ifd, 2 + entriesBytes, littleEndian),
    topLevelIndex,
    newSubfileType: null,
    compression: null,
    width: null,
    height: null,
    orientation: null,
    jpegOffset: null,
    jpegLength: null,
    stripOffsets: [],
    stripByteCounts: [],
    tileOffsets: [],
    tileByteCounts: [],
    subIfdOffsets: [],
  };

  for (let index = 0; index < count; index += 1) {
    const entry = ifd.subarray(2 + index * 12, 2 + (index + 1) * 12);
    const tag = readU16(entry, 0, littleEndian);
    const type = readU16(entry, 2, littleEndian);
    const itemCount = readU32(entry, 4, littleEndian);
    const typeBytes = TIFF_TYPE_BYTES[type];
    if (!typeBytes) fail("malformed-tiff", `TIFF tag ${tag} uses an unknown type ${type}`);
    const fieldLength = checkedProduct(typeBytes, itemCount, `TIFF tag ${tag} field length`);
    // Validate every out-of-line value pointer even if the field is irrelevant to preview
    // extraction. This catches integer overflow and out-of-bounds metadata before use.
    if (fieldLength > 4) {
      const valueOffset = readU32(entry, 8, littleEndian);
      if (!Number.isSafeInteger(valueOffset) || valueOffset > reader.size || fieldLength > reader.size - valueOffset) {
        fail("malformed-tiff", `TIFF tag ${tag} value range is outside the DNG object`);
      }
    }
    const expected = expectedType(tag);
    if (!expected) continue;
    if (!expected.has(type)) fail("malformed-tiff", `TIFF tag ${tag} has an unsupported type ${type}`);
    const values = await valuesForEntry(reader, entry, tag, type, itemCount, littleEndian);
    switch (tag) {
      case TAG_NEW_SUBFILE_TYPE: result.newSubfileType = values[0] ?? null; break;
      case TAG_IMAGE_WIDTH: result.width = values[0] ?? null; break;
      case TAG_IMAGE_LENGTH: result.height = values[0] ?? null; break;
      case TAG_COMPRESSION: result.compression = values[0] ?? null; break;
      case TAG_ORIENTATION: {
        const orientation = supportedOrientation(values[0]);
        if (values.length > 0 && !orientation) fail("malformed-tiff", "TIFF Orientation must be in the range 1..8");
        result.orientation = orientation;
        break;
      }
      case TAG_JPEG_INTERCHANGE_FORMAT: result.jpegOffset = values[0] ?? null; break;
      case TAG_JPEG_INTERCHANGE_FORMAT_LENGTH: result.jpegLength = values[0] ?? null; break;
      case TAG_STRIP_OFFSETS: result.stripOffsets = values; break;
      case TAG_STRIP_BYTE_COUNTS: result.stripByteCounts = values; break;
      case TAG_TILE_OFFSETS: result.tileOffsets = values; break;
      case TAG_TILE_BYTE_COUNTS: result.tileByteCounts = values; break;
      case TAG_SUB_IFDS: result.subIfdOffsets = values.filter((value) => value !== 0); break;
      default: break;
    }
  }
  return result;
}

function hasBoundedJxlDimensions(ifd: ParsedIfd): boolean {
  if (!Number.isSafeInteger(ifd.width) || !Number.isSafeInteger(ifd.height) || ifd.width === null || ifd.height === null || ifd.width <= 0 || ifd.height <= 0) return false;
  const pixels = ifd.width * ifd.height;
  return Number.isSafeInteger(pixels) && pixels <= JXL_MAX_PIXELS;
}

function isReducedPreview(ifd: ParsedIfd, isIfd1: boolean, isSubIfd: boolean): boolean {
  // Canon's EOS R5m2 review JPEG XL IFDs are SubIFDs with NewSubfileType=0. They are safe to
  // consider only after their declared dimensions have passed the same pixel bound enforced by
  // the codec; the full-resolution sensor IFD is also JPEG XL but is intentionally excluded.
  return isIfd1 || ifd.newSubfileType === 1 || ifd.newSubfileType === 0x10001 || ifd.newSubfileType === 10001
    || isSubIfd && ifd.compression === DNG_COMPRESSION_JPEG_XL && hasBoundedJxlDimensions(ifd);
}

async function parseTiff(reader: BoundedDngReader, littleEndian: boolean, firstIfdOffset: number): Promise<{ candidates: Candidate[]; orientation: Orientation }> {
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  let visited = 0;
  let rootOrientation: Orientation = 1;

  const visit = async (offset: number, topLevelIndex: number | null, depth: number, isSubIfd: boolean): Promise<void> => {
    if (offset === 0) return;
    if (depth > MAX_IFD_DEPTH) fail("metadata-limit", "DNG IFD nesting exceeds the supported depth");
    if (seen.has(offset)) fail("malformed-tiff", `DNG IFD cycle detected at offset ${offset}`);
    seen.add(offset);
    visited += 1;
    if (visited > MAX_IFDS) fail("metadata-limit", `DNG contains more than ${MAX_IFDS} IFDs`);
    const ifd = await parseIfd(reader, offset, topLevelIndex, littleEndian);
    if (topLevelIndex === 0 && ifd.orientation !== null) rootOrientation = ifd.orientation;
    const isIfd1 = topLevelIndex === 1;
    if (isReducedPreview(ifd, isIfd1, isSubIfd)) candidates.push({ ...ifd, isIfd1, isSubIfd });
    for (const child of ifd.subIfdOffsets) await visit(child, null, depth + 1, true);
    if (ifd.nextOffset !== 0) await visit(ifd.nextOffset, topLevelIndex === null ? null : topLevelIndex + 1, depth, isSubIfd);
  };

  await visit(firstIfdOffset, 0, 0, false);
  return { candidates, orientation: rootOrientation };
}

/**
 * Parse a complete JPEG container and accept only baseline, extended sequential, or progressive
 * frames. SOF3 (lossless JPEG, commonly used by raw sensor data) and every other SOF are rejected.
 */
export function jpegDimensions(bytes: Uint8Array): JpegDimensions | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions: JpegDimensions | null = null;
  let sawScan = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) return dimensions && sawScan ? dimensions : null;
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) return null;
      if (length < 8) return null;
      const precision = bytes[offset + 2]!;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const components = bytes[offset + 7]!;
      if (precision < 1 || precision > 16 || !width || !height || length < 8 + components * 3 || dimensions) return null;
      dimensions = { width, height, sofMarker: marker };
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      // Entropy-coded data has no length field. FF00 is a stuffed byte; D0..D7 are restart
      // markers; any other marker starts a following JPEG header (needed for progressive scans).
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const markerStart = offset;
        while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) return null;
        const scanMarker = bytes[offset]!;
        offset += 1;
        if (scanMarker === 0x00 || scanMarker >= 0xd0 && scanMarker <= 0xd7) continue;
        if (scanMarker === 0xd9) return dimensions && sawScan ? dimensions : null;
        // Let the outer parser consume a marker carrying a segment length.
        offset = markerStart;
        break;
      }
    }
  }
  return null;
}

/** Backwards-friendly alias for callers that name the validator after its output. */
export const parseJpegDimensions = jpegDimensions;

/**
 * Add a compact EXIF APP1 packet carrying the DNG's orientation. It is inserted immediately
 * after SOI, before any JFIF/other application markers, and uses all eight TIFF orientations.
 */
export function injectExifOrientation(bytes: Uint8Array, orientation: Orientation): Uint8Array {
  const existing = updateExifOrientation(bytes, orientation);
  if (existing) return existing;
  const exif = new Uint8Array(32);
  exif.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // Exif\0\0
  exif.set([0x4d, 0x4d, 0x00, 0x2a], 6); // big-endian TIFF
  exif.set([0x00, 0x00, 0x00, 0x08], 10); // first IFD immediately after header
  exif.set([0x00, 0x01], 14); // one entry
  exif.set([0x01, 0x12, 0x00, 0x03], 16); // Orientation, SHORT
  exif.set([0x00, 0x00, 0x00, 0x01], 20); // one value
  exif.set([0x00, orientation, 0x00, 0x00], 24); // inline SHORT + padding
  // bytes 28..31 are the next-IFD pointer (zero)
  const result = new Uint8Array(bytes.byteLength + JPEG_EXIF_BYTES);
  result.set(bytes.subarray(0, 2), 0);
  result.set([0xff, 0xe1, 0x00, 0x22], 2); // APP1 + 34-byte segment length
  result.set(exif, 6);
  result.set(bytes.subarray(2), 2 + JPEG_EXIF_BYTES);
  return result;
}

/** Update an existing EXIF Orientation entry in place, avoiding conflicting APP1 packets. */
function updateExifOrientation(bytes: Uint8Array, orientation: Orientation): Uint8Array | null {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength && bytes[offset] === 0xff) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (marker === 0xe1 && length >= 8 && bytes[offset + 2] === 0x45 && bytes[offset + 3] === 0x78 && bytes[offset + 4] === 0x69 && bytes[offset + 5] === 0x66 && bytes[offset + 6] === 0x00 && bytes[offset + 7] === 0x00) {
      const tiff = offset + 8;
      if (tiff + 8 > bytes.byteLength) return null;
      const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      if (!littleEndian && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const ifdRelative = view.getUint32(tiff + 4, littleEndian);
      const ifd = tiff + ifdRelative;
      if (ifd + 2 > offset + length) return null;
      const count = view.getUint16(ifd, littleEndian);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > offset + length) return null;
        if (view.getUint16(entry, littleEndian) !== TAG_ORIENTATION) continue;
        const type = view.getUint16(entry + 2, littleEndian);
        const itemCount = view.getUint32(entry + 4, littleEndian);
        if (type !== 3 || itemCount < 1) return null;
        const typeBytes = itemCount === 1 ? entry + 8 : view.getUint32(entry + 8, littleEndian) + tiff;
        if (typeBytes + 2 > offset + length) return null;
        view.setUint16(typeBytes, orientation, littleEndian);
        return new Uint8Array(bytes);
      }
    }
    offset += length;
  }
  return null;
}

function previewRange(ifd: ParsedIfd): { offset: number; length: number } | null {
  if (ifd.jpegOffset !== null && ifd.jpegLength !== null) {
    if (ifd.jpegOffset === 0 || ifd.jpegLength === 0) return null;
    return { offset: ifd.jpegOffset, length: ifd.jpegLength };
  }
  if (ifd.stripOffsets.length === 1 && ifd.stripByteCounts.length === 1 && ifd.stripOffsets[0] !== 0 && ifd.stripByteCounts[0] !== 0) {
    return { offset: ifd.stripOffsets[0]!, length: ifd.stripByteCounts[0]! };
  }
  if (ifd.tileOffsets.length === 1 && ifd.tileByteCounts.length === 1 && ifd.tileOffsets[0] !== 0 && ifd.tileByteCounts[0] !== 0) {
    return { offset: ifd.tileOffsets[0]!, length: ifd.tileByteCounts[0]! };
  }
  return null;
}

function jxlPreviewRange(ifd: ParsedIfd): { offset: number; length: number } | null {
  if (ifd.stripOffsets.length === 1 && ifd.stripByteCounts.length === 1 && ifd.stripOffsets[0] !== 0 && ifd.stripByteCounts[0] !== 0) {
    return { offset: ifd.stripOffsets[0]!, length: ifd.stripByteCounts[0]! };
  }
  if (ifd.tileOffsets.length === 1 && ifd.tileByteCounts.length === 1 && ifd.tileOffsets[0] !== 0 && ifd.tileByteCounts[0] !== 0) {
    return { offset: ifd.tileOffsets[0]!, length: ifd.tileByteCounts[0]! };
  }
  return null;
}

/**
 * Extract a usable embedded JPEG from a classic TIFF/DNG R2 object.
 *
 * Only bounded ranged reads are performed: an 8-byte header, complete IFD metadata (up to
 * 1 MiB in aggregate), and one candidate JPEG (up to 16 MiB). The original object is never
 * copied or rewritten.
 */
export async function extractDngPreview(bucket: DngPreviewBucket, originalKey: string): Promise<DngPreviewExtraction> {
  let head: Awaited<ReturnType<DngPreviewBucket["head"]>>;
  try {
    head = await bucket.head(originalKey);
  } catch {
    fail("read-failed", "Unable to inspect DNG source in R2");
  }
  if (!head) fail("source-missing", "DNG source object was not found in R2");
  if (head.size === 0) fail("source-empty", "DNG source object is empty");
  const reader = new BoundedDngReader(bucket, originalKey, head.size);
  const header = await reader.metadata(0, Math.min(8, head.size));
  if (header.byteLength < 8) fail("malformed-tiff", "DNG TIFF header is truncated");
  let littleEndian: boolean;
  if (header[0] === 0x49 && header[1] === 0x49) littleEndian = true;
  else if (header[0] === 0x4d && header[1] === 0x4d) littleEndian = false;
  else fail("malformed-tiff", "DNG TIFF byte order must be II or MM");
  const version = readU16(header, 2, littleEndian);
  if (version === 43) fail("unsupported-bigtiff", "BigTIFF DNG previews are unsupported");
  if (version !== 42) fail("malformed-tiff", `Unsupported TIFF version ${version}`);
  const firstIfdOffset = readU32(header, 4, littleEndian);
  if (firstIfdOffset === 0) fail("no-usable-preview", "DNG contains no IFD");
  if (firstIfdOffset < 8 || firstIfdOffset >= head.size) fail("malformed-tiff", "First DNG IFD offset is outside the object");
  const parsed = await parseTiff(reader, littleEndian, firstIfdOffset);
  let lastReason = "no reduced preview IFD";
  for (const candidate of parsed.candidates) {
    if (candidate.compression === DNG_COMPRESSION_JPEG_XL) {
      // A Canon EOS R5m2 writes the review previews as JPEG XL in SubIFDs while the full raw
      // sensor IFD uses the same compression value. Never treat an IFD1 or a non-SubIFD JXL as a
      // review source, and reject oversized declarations before asking R2 for compressed bytes.
      if (!candidate.isSubIfd) {
        lastReason = "JPEG XL preview is not in a SubIFD";
        continue;
      }
      if (!hasBoundedJxlDimensions(candidate)) {
        lastReason = `JPEG XL preview dimensions exceed the ${JXL_MAX_PIXELS}-pixel limit`;
        continue;
      }
      const range = jxlPreviewRange(candidate);
      if (!range) {
        lastReason = "JPEG XL preview IFD has no complete single strip or tile";
        continue;
      }
      if (range.length > JXL_INPUT_MAX_BYTES) {
        lastReason = `Embedded JPEG XL preview exceeds ${JXL_INPUT_MAX_BYTES} bytes`;
        continue;
      }
      let jxl: Uint8Array;
      try {
        jxl = await reader.preview(range.offset, range.length);
      } catch (error) {
        if (error instanceof DngPreviewError && error.code === "malformed-tiff") throw error;
        lastReason = error instanceof Error ? error.message : "JPEG XL preview range is unavailable";
        continue;
      }
      let transcoded: Awaited<ReturnType<typeof transcodeJxlPreview>>;
      try {
        transcoded = await transcodeJxlPreview(jxl, candidate.width!, candidate.height!);
      } catch (error) {
        lastReason = error instanceof Error ? error.message : "JPEG XL preview could not be decoded";
        continue;
      }
      const dimensions = jpegDimensions(transcoded.jpeg);
      if (!dimensions || dimensions.width !== candidate.width || dimensions.height !== candidate.height) {
        lastReason = "JPEG XL encoder returned a JPEG with unexpected dimensions";
        continue;
      }
      if (Math.max(dimensions.width, dimensions.height) < DNG_PREVIEW_MIN_EDGE) {
        lastReason = `embedded JPEG XL preview is smaller than the ${DNG_PREVIEW_MIN_EDGE}px review floor`;
        continue;
      }
      const orientation = candidate.orientation ?? parsed.orientation;
      const output = injectExifOrientation(transcoded.jpeg, orientation);
      if (output.byteLength > DNG_PREVIEW_MAX_BYTES || output.byteLength > JXL_OUTPUT_MAX_BYTES + JPEG_EXIF_BYTES) {
        lastReason = `encoded JPEG preview exceeds ${DNG_PREVIEW_MAX_BYTES} bytes after EXIF injection`;
        continue;
      }
      return { ...dimensions, jpeg: output, orientation, ifdOffset: candidate.offset };
    }
    // DNGs in the field use both old-style JPEG (6) and the newer DCT JPEG (7). Some newer
    // DNG writers label a reduced DCT preview with 34892; the JPEG SOF gate below remains the
    // authority and rejects lossless SOF3 raw data regardless of this container label.
    if (candidate.compression !== null && candidate.compression !== 6 && candidate.compression !== 7 && candidate.compression !== 34892) {
      lastReason = `preview IFD compression ${candidate.compression} is not JPEG`;
      continue;
    }
    const range = previewRange(candidate);
    if (!range) {
      lastReason = "preview IFD has no complete single JPEG strip/tile or 513/514 range";
      continue;
    }
    if (range.length > DNG_PREVIEW_MAX_BYTES - JPEG_EXIF_BYTES) {
      lastReason = `embedded JPEG preview exceeds ${DNG_PREVIEW_MAX_BYTES} bytes`;
      continue;
    }
    let jpeg: Uint8Array;
    try {
      jpeg = await reader.preview(range.offset, range.length);
    } catch (error) {
      if (error instanceof DngPreviewError && (error.code === "preview-limit" || error.code === "malformed-tiff")) throw error;
      lastReason = error instanceof Error ? error.message : "preview range is unavailable";
      continue;
    }
    const dimensions = jpegDimensions(jpeg);
    if (!dimensions) {
      lastReason = "embedded preview is not a complete baseline/progressive JPEG";
      continue;
    }
    if (Math.max(dimensions.width, dimensions.height) < DNG_PREVIEW_MIN_EDGE) {
      lastReason = `embedded JPEG preview is smaller than the ${DNG_PREVIEW_MIN_EDGE}px review floor`;
      continue;
    }
    const orientation = candidate.orientation ?? parsed.orientation;
    const output = injectExifOrientation(jpeg, orientation);
    if (output.byteLength > DNG_PREVIEW_MAX_BYTES) {
      lastReason = `embedded JPEG preview exceeds ${DNG_PREVIEW_MAX_BYTES} bytes after EXIF injection`;
      continue;
    }
    return { ...dimensions, jpeg: output, orientation, ifdOffset: candidate.offset };
  }
  fail("no-usable-preview", `No usable JPEG preview in DNG: ${lastReason}`);
}

/** Resolve an existing deterministic preview or extract and cache it once. */
export async function ensureDngPreview(bucket: DngPreviewBucket, originalKey: string): Promise<StoredDngPreview> {
  const key = dngPreviewKey(originalKey);
  const existing = await bucket.head(key);
  if (existing && existing.size > JPEG_EXIF_BYTES && existing.size <= DNG_PREVIEW_MAX_BYTES && existing.httpMetadata?.contentType?.toLowerCase() === "image/jpeg") {
    // HEAD metadata is a cheap fast path, but never trust a deterministic key or custom marker
    // without validating the bounded cached bytes. This also repairs an operator-written object
    // that happens to have the right key but is not a review-sized JPEG.
    try {
      const cached = await bucket.get(key, { range: { offset: 0, length: existing.size } });
      if (cached) {
        const bytes = asBytes(await cached.arrayBuffer());
        if (bytes.byteLength === existing.size) {
          const dimensions = jpegDimensions(bytes);
          if (dimensions && Math.max(dimensions.width, dimensions.height) >= DNG_PREVIEW_MIN_EDGE) {
            const marker = existing.customMetadata?.dngPreviewVersion;
            const orientation = marker === DNG_PREVIEW_CACHE_VERSION ? supportedOrientation(Number(existing.customMetadata?.orientation)) ?? 1 : 1;
            const width = marker === DNG_PREVIEW_CACHE_VERSION ? Number(existing.customMetadata?.width) : dimensions.width;
            const height = marker === DNG_PREVIEW_CACHE_VERSION ? Number(existing.customMetadata?.height) : dimensions.height;
            return { key, ...dimensions, jpeg: bytes, width: Number.isSafeInteger(width) && width > 0 ? width : dimensions.width, height: Number.isSafeInteger(height) && height > 0 ? height : dimensions.height, orientation, ifdOffset: marker === DNG_PREVIEW_CACHE_VERSION ? Number(existing.customMetadata?.ifdOffset) || 0 : 0, cached: true };
          }
        }
      }
    } catch {
      // Fall through to re-extraction; the original remains authoritative and is never changed.
    }
  }
  const extracted = await extractDngPreview(bucket, originalKey);
  await bucket.put(key, extracted.jpeg, {
    httpMetadata: {
      contentType: "image/jpeg",
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: {
      dngPreviewVersion: DNG_PREVIEW_CACHE_VERSION,
      width: String(extracted.width),
      height: String(extracted.height),
      orientation: String(extracted.orientation),
      sofMarker: String(extracted.sofMarker),
      ifdOffset: String(extracted.ifdOffset),
    },
  });
  return { ...extracted, key, cached: false };
}

/** Return the deterministic preview key for DNGs and leave JPEG sources unchanged. */
export async function resolveDngSource(bucket: DngPreviewBucket, originalKey: string, originalFilename: string): Promise<{ key: string; contentType: "image/jpeg"; preview: StoredDngPreview | null }> {
  if (!isDngFilename(originalFilename)) return { key: originalKey, contentType: "image/jpeg", preview: null };
  const preview = await ensureDngPreview(bucket, originalKey);
  return { key: preview.key, contentType: "image/jpeg", preview };
}
