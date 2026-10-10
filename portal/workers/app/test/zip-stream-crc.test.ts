import { describe, expect, it } from "vitest";
import { createZipStream, zipCrc32 } from "../src/lib/zip-stream";

// Reference: the JavaScript table implementation zip-stream.ts used before PR 14-0.
const referenceTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) { let crc = value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); table[value] = crc >>> 0; }
  return table;
})();
function referenceCrc(chunks: Uint8Array[]) {
  let crc = 0xffff_ffff;
  for (const chunk of chunks) for (const byte of chunk) crc = (crc >>> 8) ^ referenceTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffff_ffff) >>> 0;
}
function nativeCrc(chunks: Uint8Array[]) { let crc = 0; for (const chunk of chunks) crc = zipCrc32(chunk, crc); return crc; }

function fill(length: number, seed: number) { const out = new Uint8Array(length); let state = seed; for (let i = 0; i < length; i += 1) { state = (Math.imul(state, 1103515245) + 12345) >>> 0; out[i] = state >>> 24; } return out; }
function split(data: Uint8Array, sizes: number[]) { const parts: Uint8Array[] = []; let at = 0; for (const size of sizes) { parts.push(data.slice(at, at + size)); at += size; } parts.push(data.slice(at)); return parts; }

describe("zip CRC-32", () => {
  it("matches the known vector", () => {
    expect(zipCrc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(zipCrc32(new Uint8Array())).toBe(0);
  });

  it("is byte-identical to the old table implementation, chunked and unchunked", () => {
    for (const [length, seed] of [[0, 1], [1, 2], [7, 3], [255, 4], [4096, 5], [65537, 6], [300_000, 7]] as const) {
      const data = fill(length, seed);
      const expected = referenceCrc([data]);
      expect(nativeCrc([data])).toBe(expected);
      expect(nativeCrc(split(data, [0, 1, 3, 100, 0, 1000]))).toBe(expected);
      expect(referenceCrc(split(data, [0, 1, 3, 100, 0, 1000]))).toBe(expected);
    }
    expect(nativeCrc([])).toBe(referenceCrc([]));
    expect(nativeCrc([new Uint8Array(), new Uint8Array()])).toBe(referenceCrc([]));
  });

  it("keeps the archive byte-for-byte identical to the golden captured before the swap", async () => {
    const stream = (parts: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
    async function* entries() {
      const first = fill(3000, 1); const second = fill(10, 2);
      yield { name: "a.bin", size: 3000, stream: stream([first.slice(0, 1000), first.slice(1000)]) };
      yield { name: "empty.txt", size: 0, stream: stream([]) };
      yield { name: "a.bin", size: 10, stream: stream([second]) };
    }
    const reader = createZipStream(entries()).getReader(); const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value!); }
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", output))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(output.length).toBe(3354);
    expect(digest).toBe("7fc7bf59ba7a392ccea315067ec802a9cc604d770c470cfd8d94d9e7930a7235");
  });
});
