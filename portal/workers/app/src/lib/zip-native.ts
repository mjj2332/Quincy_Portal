/**
 * Native ZIP writer for already-compressed media (#802, shared with #787 slice 7). Replaces `zip-stream.ts` for the routes that stream R2 originals.
 *
 * Why it exists: R2 bodies arrive in ~4 KB chunks, and any per-chunk JavaScript (a read loop, a generator, a CRC) costs ~40 ms of Worker CPU per MB, so a few hundred MB blew the CPU limit
 * mid-download. Here the CRC-32 and size of every object are known BEFORE the first byte (the `object_crc32` table, filled by a background job), so each local header is complete, there is no data
 * descriptor, and the body goes through `body.pipeTo(fixedLength.writable, { preventClose: true })` with no JavaScript touching a byte (measured 0.05 to 0.07 ms/MB).
 *
 * The response length is exact, and that is the integrity contract: the total is computed up front (ZIP64 included) and declared as `Content-Length` through a `FixedLengthStream`. Anything that stops the
 * archive short, a changed object, a revoked grant, a lost connection, aborts the stream, so the browser sees fewer bytes than promised and fails the download instead of saving a truncated zip that looks complete.
 *
 * Entries are STORE (method 0) with the UTF-8 name flag. An entry that is a plain `{ name, data }` is held in memory and its CRC is computed here.
 */
import { crc32 } from "node:zlib";
import { uniqueName } from "./zip-stream";

/** An R2 object. `crc32`, `bytes` and `etag` come from `object_crc32`; the writer refuses the object if R2 no longer matches them. */
export type ZipObjectEntry = { name: string; r2Key: string; crc32: number; bytes: number; etag: string };
/** A small entry held in memory, such as a notice file. */
export type ZipMemoryEntry = { name: string; data: Uint8Array };
export type NativeZipEntry = ZipObjectEntry | ZipMemoryEntry;

export type NativeZipOptions = {
  bucket: Pick<R2Bucket, "get">;
  entries: readonly NativeZipEntry[];
  /**
   * Re-authorisation. Called before an entry's R2 read and again after it answered (an object entry), before a memory entry, and once with `null` before the central directory.
   * Returning false, or throwing, aborts the archive.
   */
  authorize?: (entry: NativeZipEntry | null) => Promise<boolean>;
  /** The size and offset above which an entry needs ZIP64. Injected so a test can cross the boundary with a few bytes. */
  zip32Max?: number;
};

export type NativeZip = {
  /** Exact byte length of the archive: declare it as `Content-Length`. */
  length: number;
  body: ReadableStream<Uint8Array>;
  /**
   * Settles when the pump has finished or aborted. It never rejects. While the client stays connected the open response stream keeps the request alive on its own; `waitUntil` only lets
   * the tail (the abort and the log line) finish, and does NOT extend a request whose client has already gone away.
   */
  done: Promise<void>;
};

const ZIP32_MAX = 0xffff_ffff;
const ZIP16_MAX = 0xffff;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const EOCD = 0x06054b50;
/** General purpose bit 11 (UTF-8 names) and nothing else: no data descriptor, the local header already carries the CRC and sizes. */
const FLAGS = 0x0800;
/** 1980-01-01, the DOS epoch: a zero date is not a valid one. */
const DOS_DATE = 0x0021;
const encoder = new TextEncoder();

type Writer = (view: DataView) => void;
function bytes(length: number, write: Writer): Uint8Array { const output = new Uint8Array(length); write(new DataView(output.buffer)); return output; }
function concat(parts: Uint8Array[]): Uint8Array { const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output; }

type Planned = { entry: NativeZipEntry; name: Uint8Array; crc: number; size: number; zip64: boolean; offset: number; header: Uint8Array };
type Plan = { items: Planned[]; trailer: Uint8Array; length: number };

function localHeader(name: Uint8Array, crc: number, size: number, zip64: boolean): Uint8Array {
  const extraLength = zip64 ? 20 : 0;
  return bytes(30 + name.length + extraLength, (view) => {
    view.setUint32(0, LOCAL_HEADER, true); view.setUint16(4, zip64 ? 45 : 20, true); view.setUint16(6, FLAGS, true); view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true); view.setUint32(18, zip64 ? ZIP32_MAX : size, true); view.setUint32(22, zip64 ? ZIP32_MAX : size, true);
    view.setUint16(26, name.length, true); view.setUint16(28, extraLength, true);
    new Uint8Array(view.buffer).set(name, 30);
    if (zip64) { const at = 30 + name.length; view.setUint16(at, 0x0001, true); view.setUint16(at + 2, 16, true); view.setBigUint64(at + 4, BigInt(size), true); view.setBigUint64(at + 12, BigInt(size), true); }
  });
}

function centralHeader(item: Planned): Uint8Array {
  const extraLength = item.zip64 ? 28 : 0;
  return bytes(46 + item.name.length + extraLength, (view) => {
    view.setUint32(0, CENTRAL_HEADER, true); view.setUint16(4, 45, true); view.setUint16(6, item.zip64 ? 45 : 20, true); view.setUint16(8, FLAGS, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true); view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, item.crc, true); view.setUint32(20, item.zip64 ? ZIP32_MAX : item.size, true); view.setUint32(24, item.zip64 ? ZIP32_MAX : item.size, true);
    view.setUint16(28, item.name.length, true); view.setUint16(30, extraLength, true); view.setUint16(32, 0, true); view.setUint16(34, 0, true); view.setUint16(36, 0, true); view.setUint32(38, 0, true);
    view.setUint32(42, item.zip64 ? ZIP32_MAX : item.offset, true);
    new Uint8Array(view.buffer).set(item.name, 46);
    if (item.zip64) { const at = 46 + item.name.length; view.setUint16(at, 0x0001, true); view.setUint16(at + 2, 24, true); view.setBigUint64(at + 4, BigInt(item.size), true); view.setBigUint64(at + 12, BigInt(item.size), true); view.setBigUint64(at + 20, BigInt(item.offset), true); }
  });
}

/** Names, offsets, every header and the trailer. Pure, so the length it reports is the length the pump then writes. */
function plan(entries: readonly NativeZipEntry[], zip32Max: number): Plan {
  const seen = new Set<string>(); const items: Planned[] = []; let offset = 0;
  for (const entry of entries) {
    const memory = "data" in entry;
    const size = memory ? entry.data.length : entry.bytes;
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("ZIP entry sizes must be non-negative safe integers");
    const crc = memory ? crc32(entry.data) : entry.crc32;
    if (!Number.isInteger(crc) || crc < 0 || crc > ZIP32_MAX) throw new TypeError("ZIP entry CRC-32 must be an unsigned 32-bit integer");
    const name = encoder.encode(uniqueName(entry.name, seen));
    if (name.length > ZIP16_MAX) throw new RangeError("ZIP entry name is too long");
    // ZIP stores 0xFFFFFFFF in a 32-bit field to mean "see the ZIP64 extra", so a value equal to the sentinel cannot be written as a plain one: ZIP64 starts AT the limit.
    const zip64 = size >= zip32Max || offset >= zip32Max;
    const header = localHeader(name, crc, size, zip64);
    items.push({ entry, name, crc, size, zip64, offset, header });
    offset += header.length + size;
    if (!Number.isSafeInteger(offset)) throw new RangeError("ZIP archive length must be a safe integer");
  }
  const central = concat(items.map(centralHeader));
  const centralOffset = offset;
  // The same rule for the end record: 0xFFFF entries, or a central directory size or offset of 0xFFFFFFFF, are the sentinels themselves.
  const needsZip64 = items.length >= ZIP16_MAX || centralOffset >= zip32Max || central.length >= zip32Max || items.some((item) => item.zip64);
  const tail: Uint8Array[] = [central];
  if (needsZip64) {
    const zip64Offset = centralOffset + central.length;
    tail.push(bytes(56, (view) => { view.setUint32(0, ZIP64_EOCD, true); view.setBigUint64(4, 44n, true); view.setUint16(12, 45, true); view.setUint16(14, 45, true); view.setUint32(16, 0, true); view.setUint32(20, 0, true); view.setBigUint64(24, BigInt(items.length), true); view.setBigUint64(32, BigInt(items.length), true); view.setBigUint64(40, BigInt(central.length), true); view.setBigUint64(48, BigInt(centralOffset), true); }));
    tail.push(bytes(20, (view) => { view.setUint32(0, ZIP64_LOCATOR, true); view.setUint32(4, 0, true); view.setBigUint64(8, BigInt(zip64Offset), true); view.setUint32(16, 1, true); }));
  }
  tail.push(bytes(22, (view) => {
    view.setUint32(0, EOCD, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true);
    view.setUint16(8, needsZip64 ? ZIP16_MAX : items.length, true); view.setUint16(10, needsZip64 ? ZIP16_MAX : items.length, true);
    view.setUint32(12, needsZip64 ? ZIP32_MAX : central.length, true); view.setUint32(16, needsZip64 ? ZIP32_MAX : centralOffset, true); view.setUint16(20, 0, true);
  }));
  const trailer = concat(tail);
  const length = centralOffset + trailer.length;
  if (!Number.isSafeInteger(length)) throw new RangeError("ZIP archive length must be a safe integer");
  return { items, trailer, length };
}

/** The exact byte length `createNativeZip` will produce for these entries. */
export function nativeZipLength(entries: readonly NativeZipEntry[], zip32Max = ZIP32_MAX): number { return plan(entries, zip32Max).length; }

export function createNativeZip(options: NativeZipOptions): NativeZip {
  const { bucket, authorize } = options;
  const layout = plan(options.entries, options.zip32Max ?? ZIP32_MAX);
  const fixed = new FixedLengthStream(layout.length);
  const out = fixed.writable;
  const write = async (chunk: Uint8Array) => { const writer = out.getWriter(); try { await writer.write(chunk); } finally { writer.releaseLock(); } };
  const allow = async (entry: NativeZipEntry | null, reason: string) => { if (authorize && !await authorize(entry)) throw new Error(`ZIP aborted: ${reason}`); };

  async function pump(): Promise<void> {
    for (const item of layout.items) {
      const entry = item.entry;
      if ("data" in entry) { await allow(entry, "access lost"); await write(item.header); await write(entry.data); continue; }
      await allow(entry, "access lost");
      // A conditional GET: if the object was replaced since its CRC was taken, R2 answers without a body and the archive stops here.
      const object = await bucket.get(entry.r2Key, { onlyIf: { etagMatches: entry.etag } });
      if (!object) throw new Error(`ZIP aborted: object missing ${entry.r2Key}`);
      if (!("body" in object) || !object.body) throw new Error(`ZIP aborted: object changed ${entry.r2Key}`);
      const body = object.body;
      try {
        if (object.size !== entry.bytes || object.etag !== entry.etag) throw new Error(`ZIP aborted: object changed ${entry.r2Key}`);
        // A removal during the fetch must not put the removed object's bytes in the archive: authorise again after R2 answered and before a byte is piped.
        await allow(entry, "access lost after read");
        await write(item.header);
      } catch (error) { await body.cancel().catch(() => undefined); throw error; }
      await body.pipeTo(out, { preventClose: true });
    }
    await allow(null, "access lost before the central directory");
    await write(layout.trailer);
    await out.close();
  }

  const done = pump().catch(async (error: unknown) => {
    console.error("Native ZIP aborted", { error: error instanceof Error ? error.message : String(error) });
    await out.abort(error).catch(() => undefined);
  });
  return { length: layout.length, body: fixed.readable, done };
}

/** A `200` zip response with the exact `Content-Length`; the pump is handed to `waitUntil`. */
export function nativeZipResponse(zip: NativeZip, waitUntil: (promise: Promise<unknown>) => void, headers: Record<string, string>): Response {
  waitUntil(zip.done);
  return new Response(zip.body, { status: 200, headers: { ...headers, "content-type": "application/zip", "content-length": String(zip.length) } });
}
