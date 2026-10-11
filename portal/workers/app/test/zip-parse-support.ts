import { crc32 } from "node:zlib";

/**
 * An independent reader for the archives `zip-native.ts` writes (#802). It trusts nothing the writer computed: it walks the central directory, follows ZIP64 where the sentinels say to,
 * cross-checks each local header against its central entry, and recomputes the CRC-32 of the stored bytes. Used by the writer's own tests and by the caller tests.
 */
export type ParsedEntry = { name: string; crc: number; size: number; offset: number; flags: number; method: number; zip64: boolean; data: Uint8Array };
export type ParsedZip = { entries: ParsedEntry[]; zip64: boolean; length: number };

const SENTINEL = 0xffff_ffff;

export function parseZip(archive: Uint8Array): ParsedZip {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const eocd = archive.length - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) throw new Error("no end of central directory at the tail");
  let count = view.getUint16(eocd + 10, true); let centralSize = view.getUint32(eocd + 12, true); let centralOffset = view.getUint32(eocd + 16, true);
  let zip64 = false;
  if (count === 0xffff || centralSize === SENTINEL || centralOffset === SENTINEL) {
    zip64 = true;
    if (view.getUint32(eocd - 20, true) !== 0x07064b50) throw new Error("ZIP64 sentinels but no ZIP64 locator");
    const record = u64(eocd - 20 + 8);
    if (view.getUint32(record, true) !== 0x06064b50) throw new Error("ZIP64 locator does not point at a ZIP64 end record");
    count = u64(record + 32); centralSize = u64(record + 40); centralOffset = u64(record + 48);
  }
  const entries: ParsedEntry[] = []; let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central header ${index}`);
    const flags = view.getUint16(at + 8, true); const method = view.getUint16(at + 10, true); const crc = view.getUint32(at + 16, true);
    let size = view.getUint32(at + 24, true); let offset = view.getUint32(at + 42, true); const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true); const extraLength = view.getUint16(at + 30, true); const commentLength = view.getUint16(at + 32, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    let entryZip64 = false;
    if (size === SENTINEL || compressed === SENTINEL || offset === SENTINEL) {
      entryZip64 = true; let extra = at + 46 + nameLength; const end = extra + extraLength; let cursor = -1;
      while (extra + 4 <= end) { const id = view.getUint16(extra, true); const length = view.getUint16(extra + 2, true); if (id === 0x0001) { cursor = extra + 4; break; } extra += 4 + length; }
      if (cursor < 0) throw new Error(`${name}: ZIP64 sentinel without a ZIP64 extra field`);
      if (size === SENTINEL) { size = u64(cursor); cursor += 8; }
      if (compressed === SENTINEL) { if (u64(cursor) !== size) throw new Error(`${name}: compressed size differs from size`); cursor += 8; }
      if (offset === SENTINEL) { offset = u64(cursor); cursor += 8; }
    }
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`${name}: no local header at ${offset}`);
    const localFlags = view.getUint16(offset + 6, true); const localCrc = view.getUint32(offset + 14, true);
    if (localFlags & 0x0008) throw new Error(`${name}: local header declares a data descriptor`);
    if (localCrc !== crc) throw new Error(`${name}: local CRC ${localCrc} differs from central CRC ${crc}`);
    const localNameLength = view.getUint16(offset + 26, true); const localExtraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLength + localExtraLength;
    const data = archive.slice(start, start + size);
    if (data.length !== size) throw new Error(`${name}: short data`);
    if (crc32(data) !== crc) throw new Error(`${name}: stored bytes do not match the CRC-32`);
    entries.push({ name, crc, size, offset, flags, method, zip64: entryZip64, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at - centralOffset !== centralSize) throw new Error("central directory size does not match the end record");
  return { entries, zip64, length: archive.length };
}

/** Reads a response body to the end without throwing: the bytes that arrived and whether the stream errored. */
export async function drain(response: Response): Promise<{ bytes: Uint8Array; errored: boolean }> {
  const chunks: Uint8Array[] = []; let errored = false;
  const reader = response.body!.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); } } catch { errored = true; }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return { bytes, errored };
}

export const hasEocd = (bytes: Uint8Array): boolean => bytes.some((_, index) => bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06);
