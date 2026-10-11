import { env } from "cloudflare:test";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createNativeZip, nativeZipLength, type NativeZipEntry, type ZipObjectEntry } from "../src/lib/zip-native";
import { drain, hasEocd, parseZip } from "./zip-parse-support";

/** The native ZIP writer (#802): headers carry the CRC-32 and size up front, the R2 bodies are piped natively into one fixed-length stream. */
const MEDIA = (env as unknown as { MEDIA: R2Bucket }).MEDIA;
const enc = new TextEncoder();
const prefix = `zip-native-test/${crypto.randomUUID()}/`;

async function put(name: string, body: Uint8Array | string): Promise<ZipObjectEntry> {
  const data = typeof body === "string" ? enc.encode(body) : body;
  const stored = await MEDIA.put(`${prefix}${name}`, data);
  return { name, r2Key: stored.key, crc32: crc32(data), bytes: data.length, etag: stored.etag };
}
const random = (length: number) => { const out = new Uint8Array(length); for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536))); return out; };
const run = (entries: NativeZipEntry[], extra: Partial<Parameters<typeof createNativeZip>[0]> = {}) => {
  const zip = createNativeZip({ bucket: MEDIA, entries, ...extra });
  return { zip, response: new Response(zip.body, { headers: { "content-length": String(zip.length) } }) };
};

describe("createNativeZip", () => {
  it("writes an archive that parses, whose CRCs verify and whose byte length equals the declared length", async () => {
    const photo = random(300_000); const small = await put("a.jpg", photo); const other = await put("b.raw", "second entry bytes");
    const notice = enc.encode("These are not in this download.\r\n");
    const { zip, response } = run([small, other, { name: "Left out.txt", data: notice }]);
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(false);
    expect(bytes.length).toBe(zip.length);
    expect(zip.length).toBe(nativeZipLength([small, other, { name: "Left out.txt", data: notice }]));
    const parsed = parseZip(bytes);
    expect(parsed.zip64).toBe(false);
    expect(parsed.entries.map((entry) => entry.name)).toEqual(["a.jpg", "b.raw", "Left out.txt"]);
    expect(parsed.entries[0]!.data).toEqual(photo);
    expect(new TextDecoder().decode(parsed.entries[1]!.data)).toBe("second entry bytes");
    expect(parsed.entries[2]!.crc).toBe(crc32(notice));
    for (const entry of parsed.entries) { expect(entry.flags & 0x0008, entry.name).toBe(0); expect(entry.method).toBe(0); }
  });

  it("writes a valid archive for an entry larger than one pipe chunk and for an empty entry", async () => {
    const big = await put("big.bin", random(3 * 1024 * 1024 + 17)); const empty = await put("empty.txt", "");
    const { zip, response } = run([big, empty]);
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(false); expect(bytes.length).toBe(zip.length);
    expect(parseZip(bytes).entries.map((entry) => [entry.name, entry.size])).toEqual([["big.bin", 3 * 1024 * 1024 + 17], ["empty.txt", 0]]);
  });

  it("dedupes colliding names the way the old writer did, and never lets a path through", async () => {
    const one = await put("one", "1"); const two = await put("two", "2");
    const { zip, response } = run([{ ...one, name: "Same v1.mp4" }, { ...two, name: "Same v1.mp4" }, { name: "../evil/x.txt", data: enc.encode("x") }]);
    const { bytes } = await drain(response); await zip.done;
    expect(parseZip(bytes).entries.map((entry) => entry.name)).toEqual(["Same v1.mp4", "Same v1 (2).mp4", "x.txt"]);
  });

  it("writes ZIP64 headers and end records when a size passes the injected threshold, still with an exact length", async () => {
    const a = await put("a", "hello"); const b = await put("b", "world!");
    const { zip, response } = run([a, b], { zip32Max: 1 });
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(false); expect(bytes.length).toBe(zip.length);
    expect(zip.length).toBe(nativeZipLength([a, b], 1));
    const parsed = parseZip(bytes);
    expect(parsed.zip64).toBe(true);
    expect(parsed.entries.every((entry) => entry.zip64)).toBe(true);
    expect(parsed.entries.map((entry) => new TextDecoder().decode(entry.data))).toEqual(["hello", "world!"]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(4, true)).toBe(45);
    expect(view.getUint32(18, true)).toBe(0xffff_ffff); expect(view.getUint32(22, true)).toBe(0xffff_ffff);
    expect([...bytes.slice(-98, -94)]).toEqual([0x50, 0x4b, 0x06, 0x06]);
    expect([...bytes.slice(-42, -38)]).toEqual([0x50, 0x4b, 0x06, 0x07]);
  });

  it("is longer in ZIP64 form than in ZIP32 form, by exactly the extra fields", async () => {
    const a = await put("a", "hello");
    expect(nativeZipLength([a], 1)).toBeGreaterThan(nativeZipLength([a]));
  });

  it("aborts when the object's etag no longer matches: fewer bytes than the declared length and no end of central directory", async () => {
    const first = await put("first", random(50_000)); const second = await put("second", random(50_000));
    await MEDIA.put(second.r2Key, random(50_000)); // overwritten after its CRC was taken: same size, new etag
    const { zip, response } = run([first, second]);
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(true);
    expect(bytes.length).toBeLessThan(zip.length);
    expect(hasEocd(bytes)).toBe(false);
  });

  it("aborts when the stored object is a different size from the recorded one", async () => {
    const first = await put("first", "short");
    const { zip, response } = run([{ ...first, bytes: first.bytes + 1 }]);
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(true); expect(bytes.length).toBeLessThan(zip.length); expect(hasEocd(bytes)).toBe(false);
  });

  it("aborts when an object is missing", async () => {
    const first = await put("first", "x"); await MEDIA.delete(first.r2Key);
    const { zip, response } = run([first]);
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(true); expect(bytes.length).toBeLessThan(zip.length); expect(hasEocd(bytes)).toBe(false);
  });

  it("aborts when re-authorisation returns false before an entry, and never reads that entry", async () => {
    const first = await put("first", random(10_000)); const second = await put("second", random(10_000));
    let reads = 0; const bucket = { get: (key: string, options?: R2GetOptions) => { if (key === second.r2Key) reads += 1; return MEDIA.get(key, options); } } as unknown as R2Bucket;
    const { zip, response } = run([first, second], { bucket, authorize: async (entry) => !(entry && "r2Key" in entry && entry.r2Key === second.r2Key) });
    const { bytes, errored } = await drain(response); await zip.done;
    expect(errored).toBe(true); expect(reads).toBe(0);
    expect(bytes.length).toBeLessThan(zip.length); expect(hasEocd(bytes)).toBe(false);
  });

  it("aborts when re-authorisation fails after the read and before the bytes are piped", async () => {
    const first = await put("first", random(10_000));
    let calls = 0;
    const { zip, response } = run([first], { authorize: async () => { calls += 1; return calls < 2; } });
    const { bytes, errored } = await drain(response); await zip.done;
    expect(calls).toBe(2); expect(errored).toBe(true); expect(bytes.length).toBeLessThan(zip.length); expect(hasEocd(bytes)).toBe(false);
  });

  it("re-authorises once more before the central directory, and aborts without it when that fails", async () => {
    const first = await put("first", random(10_000));
    const seen: Array<string | null> = [];
    const { zip, response } = run([first], { authorize: async (entry) => { seen.push(entry === null ? null : entry.name); return entry !== null; } });
    const { bytes, errored } = await drain(response); await zip.done;
    expect(seen.at(-1)).toBeNull();
    expect(errored).toBe(true); expect(bytes.length).toBeLessThan(zip.length); expect(hasEocd(bytes)).toBe(false);
  });

  it("passes a conditional GET to R2 on the recorded etag", async () => {
    const first = await put("first", "x"); const seen: Array<R2GetOptions | undefined> = [];
    const bucket = { get: (key: string, options?: R2GetOptions) => { seen.push(options); return MEDIA.get(key, options); } } as unknown as R2Bucket;
    const { zip, response } = run([first], { bucket }); await drain(response); await zip.done;
    expect(seen[0]).toEqual({ onlyIf: { etagMatches: first.etag } });
  });
});

describe("createNativeZip stops", () => {
  const counting = () => { const reads: string[] = []; const bucket = { get: (key: string, options?: R2GetOptions) => { reads.push(key); return MEDIA.get(key, options); } } as unknown as R2Bucket; return { reads, bucket }; };

  it("reads nothing after an entry fails its etag check", async () => {
    const first = await put("first", random(20_000)); const second = await put("second", random(20_000)); const third = await put("third", random(20_000));
    await MEDIA.put(first.r2Key, random(20_000));
    const { reads, bucket } = counting();
    const { zip, response } = run([first, second, third], { bucket });
    const { errored } = await drain(response); await zip.done;
    expect(errored).toBe(true); expect(reads).toEqual([first.r2Key]);
  });

  it("stops reading when the client cancels the download, and settles", async () => {
    const big = await put("big", random(4 * 1024 * 1024)); const second = await put("second", random(1000)); const third = await put("third", random(1000));
    const { reads, bucket } = counting();
    const { zip, response } = run([big, second, third], { bucket });
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel("client went away");
    await zip.done;
    expect(reads).toEqual([big.r2Key]);
  });

  it("settles without rejecting when authorize throws", async () => {
    const first = await put("first", "x");
    const { zip, response } = run([first], { authorize: async () => { throw new Error("D1 unavailable"); } });
    const { errored } = await drain(response);
    await expect(zip.done).resolves.toBeUndefined(); expect(errored).toBe(true);
  });
});

/** Planning math only: no bytes are read, so the sentinels can be crossed without 4 GiB of data. */
describe("nativeZipLength at the ZIP64 sentinels", () => {
  const object = (bytes: number, name = "a"): ZipObjectEntry => ({ name, r2Key: `k/${name}`, crc32: 0, bytes, etag: "e" });
  const memory = (size: number, name: string): NativeZipEntry => ({ name, data: new Uint8Array(size) });
  const SENTINEL = 0xffff_ffff;
  // A one-letter entry: 30 + name + data in the file, 46 + name in the central directory; the ZIP32 end record is 22.
  const zip32Length = (bytes: number) => 30 + 1 + bytes + 46 + 1 + 22;
  // ZIP64 adds a 20 byte local extra, a 28 byte central extra, and the 56 byte end record plus the 20 byte locator.
  const LOCAL_EXTRA = 20; const CENTRAL_EXTRA = 28; const TRAILER_EXTRA = 56 + 20;

  it("stays ZIP32 while the central directory still starts below the sentinel", () => {
    // 31 bytes of header and name, so the central directory starts at 0xFFFFFFFE.
    expect(nativeZipLength([object(SENTINEL - 32)])).toBe(zip32Length(SENTINEL - 32));
  });
  it("one byte more puts the central directory offset on the sentinel: the trailer goes ZIP64, the entry does not", () => {
    expect(nativeZipLength([object(SENTINEL - 31)])).toBe(zip32Length(SENTINEL - 31) + TRAILER_EXTRA);
  });
  it("switches to ZIP64 at exactly 0xFFFFFFFF, the value that is itself the sentinel", () => {
    expect(nativeZipLength([object(SENTINEL)])).toBe(zip32Length(SENTINEL) + LOCAL_EXTRA + CENTRAL_EXTRA + TRAILER_EXTRA);
  });
  it("trips an entry's size at the limit itself, not one past it", () => {
    // At 99 the entry is plain, but the central directory then starts at 130, past the limit, so only the trailer goes ZIP64.
    expect(nativeZipLength([object(99)], 100)).toBe(zip32Length(99) + TRAILER_EXTRA);
    expect(nativeZipLength([object(100)], 100)).toBe(zip32Length(100) + LOCAL_EXTRA + CENTRAL_EXTRA + TRAILER_EXTRA);
  });
  it("trips an entry's offset at the limit itself: that entry alone goes ZIP64, and the trailer follows", () => {
    // `b` starts at 31 + 69 = 100.
    const entries = [object(69, "a"), object(0, "b")]; const plain = 100 + 31 + 47 + 47 + 22;
    expect(nativeZipLength(entries, 100)).toBe(plain + LOCAL_EXTRA + CENTRAL_EXTRA + TRAILER_EXTRA);
    // One more and the entry stays ZIP32, but the central directory then starts at 131, past the limit: the trailer alone.
    expect(nativeZipLength(entries, 101)).toBe(plain + TRAILER_EXTRA);
  });
  it("trips the central directory offset at the limit itself", () => {
    // Two 20 byte entries: 51 bytes each, so the central directory starts at 102 and is 94 bytes long.
    const entries = [memory(20, "a"), memory(20, "b")]; const plain = 102 + 94 + 22;
    expect(nativeZipLength(entries, 103)).toBe(plain);
    expect(nativeZipLength(entries, 102)).toBe(plain + TRAILER_EXTRA);
  });
  it("trips the central directory size at the limit itself", () => {
    const entries = [memory(10, "a"), memory(10, "b")]; const plain = 82 + 94 + 22;
    expect(nativeZipLength(entries, 95)).toBe(plain);
    expect(nativeZipLength(entries, 94)).toBe(plain + TRAILER_EXTRA);
  });
  it("switches to the ZIP64 end record at 0xFFFF entries, not at 0xFFFE", () => {
    const many = (count: number): NativeZipEntry[] => Array.from({ length: count }, (_, index) => memory(0, `f${index}`));
    const zip32 = (count: number) => { let total = 22; for (let index = 0; index < count; index += 1) total += 76 + 2 * `f${index}`.length; return total; };
    expect(nativeZipLength(many(0xfffe))).toBe(zip32(0xfffe));
    expect(nativeZipLength(many(0xffff))).toBe(zip32(0xffff) + TRAILER_EXTRA);
  });
  it("rejects an archive whose total is not a safe integer", () => {
    expect(() => nativeZipLength([object(Number.MAX_SAFE_INTEGER - 10), object(100, "b")])).toThrow(/safe integer/);
  });
});
