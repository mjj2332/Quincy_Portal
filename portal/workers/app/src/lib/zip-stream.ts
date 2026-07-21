/**
 * Streaming ZIP writer for already-compressed media. Entries use STORE (method 0)
 * and data descriptors (GP bit 3), so bytes pass through without buffering whole
 * files. ZIP64 fields are emitted only when an entry, offset, or central directory
 * exceeds ZIP32 limits; the final ZIP64 EOCD records are emitted when required.
 */
export type ZipStreamEntry = { name: string; size: number; stream: ReadableStream<Uint8Array> };

type CentralEntry = { name: Uint8Array; crc: number; size: number; offset: number; zip64: boolean };

const encoder = new TextEncoder();
const ZIP32_MAX = 0xffff_ffff;
const ZIP16_MAX = 0xffff;
const DATA_DESCRIPTOR = 0x08074b50;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const EOCD = 0x06054b50;

function bytes(length: number, write: (view: DataView) => void) { const output = new Uint8Array(length); write(new DataView(output.buffer)); return output; }
function u16(value: number) { return bytes(2, (view) => view.setUint16(0, value, true)); }
function u32(value: number) { return bytes(4, (view) => view.setUint32(0, value, true)); }
function u64(value: number) { return bytes(8, (view) => view.setBigUint64(0, BigInt(value), true)); }
function concat(...parts: Uint8Array[]) { const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); table[value] = crc >>> 0; }
  return table;
})();
function crc32(crc: number, chunk: Uint8Array) { let next = crc; for (const byte of chunk) next = (next >>> 8) ^ crcTable[(next ^ byte) & 0xff]!; return next >>> 0; }

function uniqueName(name: string, seen: Set<string>) {
  const base = name.split(/[\\/]/).pop()?.trim() || "file";
  if (!seen.has(base)) { seen.add(base); return base; }
  const extension = base.lastIndexOf("."); const stem = extension > 0 ? base.slice(0, extension) : base; const suffix = extension > 0 ? base.slice(extension) : "";
  for (let count = 2; ; count += 1) { const candidate = `${stem} (${count})${suffix}`; if (!seen.has(candidate)) { seen.add(candidate); return candidate; } }
}

function localHeader(name: Uint8Array, zip64: boolean) {
  const extra = zip64 ? concat(u16(0x0001), u16(16), u64(0), u64(0)) : new Uint8Array();
  return concat(u32(LOCAL_HEADER), u16(zip64 ? 45 : 20), u16(0x0808), u16(0), u16(0), u16(0), u32(0), u32(zip64 ? ZIP32_MAX : 0), u32(zip64 ? ZIP32_MAX : 0), u16(name.length), u16(extra.length), name, extra);
}
function dataDescriptor(crc: number, size: number, zip64: boolean) { return concat(u32(DATA_DESCRIPTOR), u32(crc), zip64 ? u64(size) : u32(size), zip64 ? u64(size) : u32(size)); }
function centralHeader(entry: CentralEntry) {
  const extra = entry.zip64 ? concat(u16(0x0001), u16(24), u64(entry.size), u64(entry.size), u64(entry.offset)) : new Uint8Array();
  return concat(u32(CENTRAL_HEADER), u16(45), u16(entry.zip64 ? 45 : 20), u16(0x0808), u16(0), u16(0), u16(0), u32(entry.crc), u32(entry.zip64 ? ZIP32_MAX : entry.size), u32(entry.zip64 ? ZIP32_MAX : entry.size), u16(entry.name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(entry.zip64 ? ZIP32_MAX : entry.offset), entry.name, extra);
}

async function* zipChunks(entries: AsyncIterable<ZipStreamEntry>, zip32Max = ZIP32_MAX) {
  const seen = new Set<string>(); const central: CentralEntry[] = []; let offset = 0;
  for await (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError("ZIP entry sizes must be non-negative safe integers");
    const name = encoder.encode(uniqueName(entry.name, seen)); if (name.length > ZIP16_MAX) throw new RangeError("ZIP entry name is too long");
    const zip64 = entry.size > zip32Max || offset > zip32Max;
    const header = localHeader(name, zip64); yield header; offset += header.length;
    let crc = 0xffff_ffff; let actualSize = 0; const reader = entry.stream.getReader();
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; actualSize += value.length; if (actualSize > Number.MAX_SAFE_INTEGER) throw new RangeError("ZIP entry is too large"); crc = crc32(crc, value); yield value; offset += value.length; }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (actualSize !== entry.size) throw new Error(`ZIP entry size changed while streaming: ${entry.name}`);
    const finalCrc = (crc ^ 0xffff_ffff) >>> 0; const descriptor = dataDescriptor(finalCrc, actualSize, zip64); yield descriptor; offset += descriptor.length;
    central.push({ name, crc: finalCrc, size: actualSize, offset: offset - descriptor.length - actualSize - header.length, zip64 });
  }
  const centralOffset = offset;
  for (const entry of central) { const header = centralHeader(entry); yield header; offset += header.length; }
  const centralSize = offset - centralOffset;
  const needsZip64 = central.length > ZIP16_MAX || centralOffset > ZIP32_MAX || centralSize > ZIP32_MAX || central.some((entry) => entry.zip64);
  if (needsZip64) {
    const zip64Offset = offset;
    const record = concat(u32(ZIP64_EOCD), u64(44), u16(45), u16(45), u32(0), u32(0), u64(central.length), u64(central.length), u64(centralSize), u64(centralOffset));
    yield record; offset += record.length;
    const locator = concat(u32(ZIP64_LOCATOR), u32(0), u64(zip64Offset), u32(1)); yield locator; offset += locator.length;
  }
  yield concat(u32(EOCD), u16(0), u16(0), u16(needsZip64 ? ZIP16_MAX : central.length), u16(needsZip64 ? ZIP16_MAX : central.length), u32(needsZip64 ? ZIP32_MAX : centralSize), u32(needsZip64 ? ZIP32_MAX : centralOffset), u16(0));
}

/** Creates a pull-driven stream; only file metadata for the central directory is retained. */
export function createZipStream(entries: AsyncIterable<ZipStreamEntry>, zip32Max = ZIP32_MAX): ReadableStream<Uint8Array> {
  const iterator = zipChunks(entries, zip32Max);
  return new ReadableStream({ async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } }, async cancel(reason) { await iterator.return?.(reason); } });
}
