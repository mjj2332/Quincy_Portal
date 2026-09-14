import { describe, expect, it } from "vitest";
import JXL_DECODER_WASM from "@jsquash/jxl/codec/dec/jxl_dec.wasm";
import { dngPreviewKey } from "@quincy/shared";
import {
  DNG_METADATA_MAX_BYTES,
  DNG_PREVIEW_MAX_BYTES,
  DNG_PREVIEW_MIN_EDGE,
  DngPreviewError,
  ensureDngPreview,
  extractDngPreview,
  injectExifOrientation,
  jpegDimensions,
} from "../src/dng-preview";
import {
  JXL_INPUT_MAX_BYTES,
  JXL_MAX_PIXELS,
  JXL_OUTPUT_MAX_BYTES,
  JxlPreviewError,
  instantiateBoundedWasm,
  transcodeJxlPreview,
} from "../src/jxl-preview";

type FakeObject = { bytes: Uint8Array; contentType?: string; customMetadata?: Record<string, string> };

class FakeR2 {
  readonly objects = new Map<string, FakeObject>();
  readonly reads: Array<{ key: string; offset: number; length: number }> = [];
  readonly puts: string[] = [];

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, httpMetadata: object.contentType ? { contentType: object.contentType } : undefined, customMetadata: object.customMetadata } : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = this.objects.get(key);
    if (!object) return null;
    if (!options?.range) return { arrayBuffer: async () => object.bytes.slice().buffer };
    const { offset, length } = options.range;
    this.reads.push({ key, offset, length });
    return { arrayBuffer: async () => object.bytes.slice(offset, offset + length).buffer };
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata });
    this.puts.push(key);
    return { key, size: bytes.byteLength };
  }
}

function jpeg(width = 640, height = 480, sofMarker = 0xc0): Uint8Array {
  const output: number[] = [0xff, 0xd8];
  const segment = (marker: number, payload: number[]) => {
    const length = payload.length + 2;
    output.push(0xff, marker, length >>> 8, length & 0xff, ...payload);
  };
  segment(0xe0, [0x4a, 0x46]);
  segment(sofMarker, [8, height >>> 8, height & 0xff, width >>> 8, width & 0xff, 1, 1, 0x11, 0]);
  segment(0xda, [1, 1, 0, 2, 0x11, 0]);
  output.push(0x01, 0xff, 0x00, 0x02, 0xff, 0xd9);
  return Uint8Array.from(output);
}

function set16(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  new DataView(bytes.buffer).setUint16(offset, value, littleEndian);
}

function set32(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  new DataView(bytes.buffer).setUint32(offset, value, littleEndian);
}

type IfdEntry = { tag: number; type: number; count: number; value: number };

function tiffWithPreview(options: { byteOrder?: "II" | "MM"; orientation?: number; preview?: Uint8Array; compression?: number; useStrip?: boolean; useTile?: boolean; newSubfileType?: number; nextIfdOverride?: number; firstIfdOverride?: number } = {}): Uint8Array {
  const littleEndian = (options.byteOrder ?? "II") === "II";
  const firstIfd = options.firstIfdOverride ?? 8;
  const ifd0Entries: IfdEntry[] = [{ tag: 274, type: 3, count: 1, value: options.orientation ?? 1 }];
  const ifd0Length = 2 + ifd0Entries.length * 12 + 4;
  const ifd1 = firstIfd + ifd0Length;
  const preview = options.preview ?? jpeg();
  const ifd1Entries: IfdEntry[] = [
    { tag: 254, type: 4, count: 1, value: options.newSubfileType ?? 1 },
    { tag: 259, type: 3, count: 1, value: options.compression ?? 6 },
    { tag: 256, type: 4, count: 1, value: 640 },
    { tag: 257, type: 4, count: 1, value: 480 },
  ];
  if (options.useStrip) {
    ifd1Entries.push({ tag: 273, type: 4, count: 1, value: 0 });
    ifd1Entries.push({ tag: 279, type: 4, count: 1, value: preview.byteLength });
  } else if (options.useTile) {
    ifd1Entries.push({ tag: 324, type: 4, count: 1, value: 0 });
    ifd1Entries.push({ tag: 325, type: 4, count: 1, value: preview.byteLength });
  } else {
    ifd1Entries.push({ tag: 513, type: 4, count: 1, value: 0 });
    ifd1Entries.push({ tag: 514, type: 4, count: 1, value: preview.byteLength });
  }
  const ifd1Length = 2 + ifd1Entries.length * 12 + 4;
  const previewOffset = ifd1 + ifd1Length;
  // The entries above carry the preview offset, so fill those values after the final offset is
  // known.  The helper intentionally writes synthetic, structurally valid classic TIFF only.
  for (const entry of ifd1Entries) {
    if (entry.tag === 273 || entry.tag === 324 || entry.tag === 513) entry.value = previewOffset;
    if (entry.tag === 279 || entry.tag === 325 || entry.tag === 514) entry.value = preview.byteLength;
  }
  const total = previewOffset + preview.byteLength + 16;
  const bytes = new Uint8Array(total);
  bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  set16(bytes, 2, 42, littleEndian);
  set32(bytes, 4, firstIfd, littleEndian);
  const writeIfd = (offset: number, entries: IfdEntry[], next: number) => {
    set16(bytes, offset, entries.length, littleEndian);
    for (const [index, entry] of entries.entries()) {
      const at = offset + 2 + index * 12;
      set16(bytes, at, entry.tag, littleEndian);
      set16(bytes, at + 2, entry.type, littleEndian);
      set32(bytes, at + 4, entry.count, littleEndian);
      if (entry.type === 3 && entry.count === 1) {
        set16(bytes, at + 8, entry.value, littleEndian);
        set16(bytes, at + 10, 0, littleEndian);
      } else set32(bytes, at + 8, entry.value, littleEndian);
    }
    set32(bytes, offset + 2 + entries.length * 12, next, littleEndian);
  };
  writeIfd(firstIfd, ifd0Entries, options.nextIfdOverride ?? ifd1);
  writeIfd(ifd1, ifd1Entries, 0);
  bytes.set(preview, previewOffset);
  return bytes;
}

function orientationFromExif(bytes: Uint8Array): number {
  const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xe1);
  if (marker < 0) return 0;
  // The injected packet is big-endian and has one IFD entry at marker+20.
  return (bytes[marker + 28]! << 8) | bytes[marker + 29]!;
}

function expectDngError(promise: Promise<unknown>, code: DngPreviewError["code"], message?: string) {
  return expect(promise).rejects.toSatisfy((error: unknown) => error instanceof DngPreviewError && error.code === code && (!message || String(error).includes(message)));
}

const syntheticJxl1024x683 = Uint8Array.from(
  atob("/wpSFQQrAQgIEACQAAAAQAM0QAM0QAM0QAM0wAIswAIsAEsoMt3ki+aVwomEhACoN8ag3b2ABAAARBMAgINwAAL8CAAgDLOy6zDwTzEKBSn8xwezsusw8E8xCgUp/McHs7LrMPBPMQoFKfzHB7Oy6zDwTzEKBSn8xwezsusw8E8xCgUp/McHs7LrMPBPMQoFKfzHB7Oy6zDwTzEKBSn8xwezsusw8E8xCgUp/McHowFgADAKBSn8xwejAWAAMAoFKfzHB6MBYAAwCgUp/McHowFgADAKBSn8xwc="),
  (character) => character.charCodeAt(0),
);

type SubIfdSpec = {
  width: number;
  height: number;
  compression?: number;
  preview?: Uint8Array;
};

function tiffWithSubIfds(specs: SubIfdSpec[], orientation = 1): Uint8Array {
  const littleEndian = true;
  const rootEntryCount = 2;
  const rootOffset = 8;
  const rootLength = 2 + rootEntryCount * 12 + 4;
  const subIfdOffsetsOffset = rootOffset + rootLength;
  const childEntryCount = 6;
  const childLength = 2 + childEntryCount * 12 + 4;
  const childrenOffset = subIfdOffsetsOffset + specs.length * 4;
  const dataOffset = childrenOffset + specs.length * childLength;
  const dataLength = specs.reduce((total, spec) => total + (spec.preview?.byteLength ?? 0), 0);
  const bytes = new Uint8Array(dataOffset + dataLength + 16);
  bytes.set([0x49, 0x49, 42, 0], 0);
  set32(bytes, 4, rootOffset, littleEndian);
  const writeEntry = (offset: number, entry: IfdEntry) => {
    set16(bytes, offset, entry.tag, littleEndian);
    set16(bytes, offset + 2, entry.type, littleEndian);
    set32(bytes, offset + 4, entry.count, littleEndian);
    if (entry.type === 3 && entry.count === 1) {
      set16(bytes, offset + 8, entry.value, littleEndian);
      set16(bytes, offset + 10, 0, littleEndian);
    } else set32(bytes, offset + 8, entry.value, littleEndian);
  };
  const writeIfd = (offset: number, entries: IfdEntry[], next = 0) => {
    set16(bytes, offset, entries.length, littleEndian);
    entries.forEach((entry, index) => writeEntry(offset + 2 + index * 12, entry));
    set32(bytes, offset + 2 + entries.length * 12, next, littleEndian);
  };
  writeIfd(rootOffset, [
    { tag: 274, type: 3, count: 1, value: orientation },
    { tag: 330, type: 4, count: specs.length, value: specs.length === 1 ? childrenOffset : subIfdOffsetsOffset },
  ]);
  let nextDataOffset = dataOffset;
  specs.forEach((spec, index) => {
    const childOffset = childrenOffset + index * childLength;
    const preview = spec.preview ?? new Uint8Array([0]);
    const entries: IfdEntry[] = [
      { tag: 254, type: 4, count: 1, value: 0 },
      { tag: 259, type: 3, count: 1, value: spec.compression ?? 52546 },
      { tag: 256, type: 4, count: 1, value: spec.width },
      { tag: 257, type: 4, count: 1, value: spec.height },
      { tag: 273, type: 4, count: 1, value: nextDataOffset },
      { tag: 279, type: 4, count: 1, value: preview.byteLength },
    ];
    if (specs.length > 1) set32(bytes, subIfdOffsetsOffset + index * 4, childOffset, littleEndian);
    writeIfd(childOffset, entries);
    if (spec.preview) {
      bytes.set(spec.preview, nextDataOffset);
      nextDataOffset += spec.preview.byteLength;
    }
  });
  return bytes;
}

describe("bounded DNG embedded JPEG previews", () => {
  it("transcodes a bounded Canon-style JPEG XL SubIFD and preserves orientation", async () => {
    const bucket = new FakeR2();
    const key = "projects/p/raw/r5m2.DNG";
    bucket.objects.set(key, {
      bytes: tiffWithSubIfds([
        { width: 8192, height: 5464, preview: new Uint8Array([1, 2, 3]) },
        { width: 1024, height: 683, preview: syntheticJxl1024x683 },
      ], 6),
    });
    const extracted = await extractDngPreview(bucket as never, key);
    expect(extracted.ifdOffset).toBeGreaterThan(0);
    expect(extracted.width).toBe(1024);
    expect(extracted.height).toBe(683);
    expect(extracted.orientation).toBe(6);
    expect(jpegDimensions(extracted.jpeg)).toMatchObject({ width: 1024, height: 683 });
    expect(orientationFromExif(extracted.jpeg)).toBe(6);
    expect(bucket.reads.some((read) => read.length === 3)).toBe(false);
    expect(bucket.reads.every((read) => read.length <= JXL_INPUT_MAX_BYTES)).toBe(true);
    expect(extracted.jpeg.byteLength).toBeLessThanOrEqual(JXL_OUTPUT_MAX_BYTES + 36);
  });

  it("rejects a declared raw-sensor-sized JPEG XL SubIFD before reading or decoding it", async () => {
    const bucket = new FakeR2();
    const key = "projects/p/raw/r5m2-raw-only.DNG";
    const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    bucket.objects.set(key, { bytes: tiffWithSubIfds([{ width: 8192, height: 5464, preview: raw }]) });
    await expectDngError(extractDngPreview(bucket as never, key), "no-usable-preview", "no reduced preview IFD");
    expect(bucket.reads.some((read) => read.length === raw.byteLength)).toBe(false);
  });

  it("enforces the JXL input and declared-pixel bounds before invoking a codec", async () => {
    await expect(transcodeJxlPreview(new Uint8Array(JXL_INPUT_MAX_BYTES + 1), 1, 1)).rejects.toMatchObject({ code: "input-limit" } satisfies Partial<JxlPreviewError>);
    await expect(transcodeJxlPreview(new Uint8Array(1), JXL_MAX_PIXELS + 1, 1)).rejects.toMatchObject({ code: "invalid-dimensions" } satisfies Partial<JxlPreviewError>);
    await expect(transcodeJxlPreview(syntheticJxl1024x683, 1024, 682)).rejects.toMatchObject({ code: "dimension-mismatch" } satisfies Partial<JxlPreviewError>);
  });

  it("serializes concurrent codec calls while reusing the bounded codec instances", async () => {
    const outputs = await Promise.all([
      transcodeJxlPreview(syntheticJxl1024x683, 1024, 683),
      transcodeJxlPreview(syntheticJxl1024x683, 1024, 683),
      transcodeJxlPreview(syntheticJxl1024x683, 1024, 683),
    ]);
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(output.width).toBe(1024);
      expect(output.height).toBe(683);
      expect(output.jpeg.byteLength).toBeGreaterThan(0);
      expect(output.jpeg.byteLength).toBeLessThanOrEqual(JXL_OUTPUT_MAX_BYTES);
    }
  });

  it("keeps native WebAssembly memory growth behind the configured facade", () => {
    const imports: WebAssembly.Imports = {};
    for (const imported of WebAssembly.Module.imports(JXL_DECODER_WASM)) {
      const namespace = (imports[imported.module] ??= {});
      if (!(imported.name in namespace)) namespace[imported.name] = () => 0;
    }
    let captured: WebAssembly.Instance | undefined;
    const exports = instantiateBoundedWasm(JXL_DECODER_WASM, "w", 64 * 1024 * 1024)(imports, (instance) => { captured = instance; });
    expect(exports.w).toBeDefined();
    expect(captured?.exports.w).toBe(exports.w);
    const initialPages = (exports.w as WebAssembly.Memory).buffer.byteLength / (64 * 1024);
    expect((exports.w as WebAssembly.Memory).grow(0)).toBe(initialPages);
    expect(() => (exports.w as WebAssembly.Memory).grow(1024)).toThrow(/cap/);
  });

  it("reads only bounded ranges, supports II/MM, and injects all eight EXIF orientations", async () => {
    for (const byteOrder of ["II", "MM"] as const) {
      for (let orientation = 1; orientation <= 8; orientation += 1) {
        const bucket = new FakeR2();
        const originalKey = `projects/p/raw/dropbox/capture-${byteOrder}-${orientation}.DNG`;
        bucket.objects.set(originalKey, { bytes: tiffWithPreview({ byteOrder, orientation }) });
        const extracted = await extractDngPreview(bucket as never, originalKey);
        expect(extracted.width).toBe(640);
        expect(extracted.height).toBe(480);
        expect(extracted.orientation).toBe(orientation);
        expect(orientationFromExif(extracted.jpeg)).toBe(orientation);
        expect(bucket.reads.every((read) => read.length <= DNG_PREVIEW_MAX_BYTES && read.length < bucket.objects.get(originalKey)!.bytes.byteLength)).toBe(true);
      }
    }
  });

  it("accepts a single complete strip or tile and caches the deterministic JPEG sibling", async () => {
    for (const layout of [{ useStrip: true }, { useTile: true }]) {
      const bucket = new FakeR2();
      const originalKey = "projects/p/raw/dropbox/capture.DNG";
      bucket.objects.set(originalKey, { bytes: tiffWithPreview(layout) });
      const result = await ensureDngPreview(bucket as never, originalKey);
      expect(result.key).toBe(dngPreviewKey(originalKey));
      expect(result.cached).toBe(false);
      expect(bucket.puts).toEqual([dngPreviewKey(originalKey)]);
      expect(bucket.objects.get(result.key)?.contentType).toBe("image/jpeg");
      expect(bucket.objects.get(result.key)?.bytes).toEqual(result.jpeg);
    }
  });

  it("accepts baseline and progressive JPEGs but rejects lossless SOF3 raw data", async () => {
    expect(jpegDimensions(jpeg(640, 480, 0xc0))).toMatchObject({ width: 640, height: 480, sofMarker: 0xc0 });
    expect(jpegDimensions(jpeg(640, 480, 0xc1))).toMatchObject({ width: 640, height: 480, sofMarker: 0xc1 });
    expect(jpegDimensions(jpeg(640, 480, 0xc2))).toMatchObject({ width: 640, height: 480, sofMarker: 0xc2 });
    expect(jpegDimensions(jpeg(640, 480, 0xc3))).toBeNull();
    const bucket = new FakeR2();
    const key = "projects/p/raw/raw.DNG";
    bucket.objects.set(key, { bytes: tiffWithPreview({ preview: jpeg(640, 480, 0xc3) }) });
    await expectDngError(extractDngPreview(bucket as never, key), "no-usable-preview", "complete baseline/progressive JPEG");
  });

  it("rejects IFD cycles, out-of-bounds pointers, and unsupported BigTIFF explicitly", async () => {
    const cycleBucket = new FakeR2();
    const cycleKey = "projects/p/raw/cycle.DNG";
    const cycleBytes = tiffWithPreview({ nextIfdOverride: 26 });
    cycleBucket.objects.set(cycleKey, { bytes: cycleBytes });
    // IFD1 starts at offset 26; pointing its next link back to itself is a cycle.
    set32(cycleBytes, 26 + 2 + 6 * 12, 26, true);
    await expectDngError(extractDngPreview(cycleBucket as never, cycleKey), "malformed-tiff", "cycle");

    const boundsBucket = new FakeR2();
    const boundsKey = "projects/p/raw/bounds.DNG";
    const boundsBytes = tiffWithPreview();
    set32(boundsBytes, 26 + 2 + 4 * 12 + 8, boundsBytes.byteLength + 1, true);
    boundsBucket.objects.set(boundsKey, { bytes: boundsBytes });
    await expectDngError(extractDngPreview(boundsBucket as never, boundsKey), "malformed-tiff", "outside");

    const bigBucket = new FakeR2();
    const bigKey = "projects/p/raw/big.DNG";
    const bigBytes = new Uint8Array(16);
    bigBytes.set([0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
    bigBucket.objects.set(bigKey, { bytes: bigBytes });
    await expectDngError(extractDngPreview(bigBucket as never, bigKey), "unsupported-bigtiff", "BigTIFF");
  });

  it("does not read an oversized preview, rejects metadata above the cap, and reports no preview", async () => {
    const oversizedBucket = new FakeR2();
    const oversizedKey = "projects/p/raw/oversized.DNG";
    const oversizedBytes = new Uint8Array(DNG_PREVIEW_MAX_BYTES + 1024);
    oversizedBytes.set(tiffWithPreview({ preview: new Uint8Array(0) }));
    // The JPEG range is structurally in-bounds but above the preview cap, so it must be skipped
    // before R2 is asked for the range.
    const oversizedLength = DNG_PREVIEW_MAX_BYTES + 1;
    set32(oversizedBytes, 26 + 2 + 4 * 12 + 8, 200, true);
    set32(oversizedBytes, 26 + 2 + 5 * 12 + 8, oversizedLength, true);
    oversizedBucket.objects.set(oversizedKey, { bytes: oversizedBytes });
    await expectDngError(extractDngPreview(oversizedBucket as never, oversizedKey), "no-usable-preview", "exceeds");
    expect(oversizedBucket.reads.some((read) => read.offset === 200)).toBe(false);

    const noPreviewBucket = new FakeR2();
    const noPreviewKey = "projects/p/raw/no-preview.DNG";
    noPreviewBucket.objects.set(noPreviewKey, { bytes: tiffWithPreview({ compression: 1, preview: new Uint8Array([1, 2, 3]) }) });
    await expectDngError(extractDngPreview(noPreviewBucket as never, noPreviewKey), "no-usable-preview", "compression 1");

    // A pair of otherwise-valid large IFDs proves aggregate metadata accounting rather than
    // relying on a huge object read. The second IFD is never fetched in full after the cap trips.
    const metadataBucket = new FakeR2();
    const metadataKey = "projects/p/raw/metadata.DNG";
    const largeIfdBytes = new Uint8Array(2 * (2 + 65535 * 12 + 4) + 64);
    largeIfdBytes.set([0x49, 0x49, 42, 0, 8, 0, 0, 0], 0);
    set16(largeIfdBytes, 8, 65535, true);
    for (let index = 0; index < 65535; index += 1) set16(largeIfdBytes, 8 + 2 + index * 12 + 2, 1, true);
    set32(largeIfdBytes, 8 + 2 + 65535 * 12, 8 + 2 + 65535 * 12 + 4, true);
    const second = 8 + 2 + 65535 * 12 + 4;
    set16(largeIfdBytes, second, 65535, true);
    metadataBucket.objects.set(metadataKey, { bytes: largeIfdBytes });
    await expectDngError(extractDngPreview(metadataBucket as never, metadataKey), "metadata-limit");
  });

  it("enforces the review-sized minimum so a camera thumbnail cannot masquerade as a RAW preview", async () => {
    const bucket = new FakeR2();
    const key = "projects/p/raw/tiny.DNG";
    bucket.objects.set(key, { bytes: tiffWithPreview({ preview: jpeg(DNG_PREVIEW_MIN_EDGE - 1, 320) }) });
    await expectDngError(extractDngPreview(bucket as never, key), "no-usable-preview", "review floor");
  });

  it("keeps orientation injection bounded and preserves the original JPEG bytes after SOI", () => {
    const source = jpeg();
    const output = injectExifOrientation(source, 8);
    expect(output.slice(-source.byteLength + 2)).toEqual(source.slice(2));
    expect(output.byteLength).toBe(source.byteLength + 36);
  });
});
