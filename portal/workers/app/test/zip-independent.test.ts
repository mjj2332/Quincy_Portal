import { env } from "cloudflare:test";
import { crc32 } from "node:zlib";
import { describe, expect, inject, it } from "vitest";
import { createNativeZip, type NativeZipEntry, type ZipObjectEntry } from "../src/lib/zip-native";
import { drain } from "./zip-parse-support";

/**
 * Independent archive check for the native ZIP writer (#802). The archive is handed to the Node-side checker in `vitest.global-setup.ts`, which writes it to a temp file and runs
 * `python3 -m zipfile -t` on it, then extracts it. Python's reader shares no code with `zip-native.ts` and `zip-parse-support.ts`, so a header bug both of ours agree on still fails here.
 */
const MEDIA = (env as unknown as { MEDIA: R2Bucket }).MEDIA;
const prefix = `zip-independent-test/${crypto.randomUUID()}/`;
const enc = new TextEncoder();

const random = (length: number) => { const out = new Uint8Array(length); for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536))); return out; };
async function put(name: string, data: Uint8Array): Promise<ZipObjectEntry> {
  const stored = await MEDIA.put(`${prefix}${name}`, data);
  return { name, r2Key: stored.key, crc32: crc32(data), bytes: data.length, etag: stored.etag };
}
const b64 = (data: Uint8Array) => { let text = ""; for (let at = 0; at < data.length; at += 8192) text += String.fromCharCode(...data.subarray(at, at + 8192)); return btoa(text); };

async function check(entries: NativeZipEntry[], zip32Max?: number): Promise<{ archive: Uint8Array; ok: boolean; output: string; files: Record<string, string> }> {
  const zip = createNativeZip({ bucket: MEDIA, entries, ...(zip32Max === undefined ? {} : { zip32Max }) });
  const { bytes, errored } = await drain(new Response(zip.body, { headers: { "content-length": String(zip.length) } })); await zip.done;
  expect(errored).toBe(false); expect(bytes.length).toBe(zip.length);
  const reply = await fetch(`http://127.0.0.1:${inject("zipCheckPort")}/`, { method: "POST", body: bytes });
  return { archive: bytes, ...(await reply.json() as { ok: boolean; output: string; files: Record<string, string> }) };
}

async function fixture() {
  const photo = random(300_000); const raw = random(70_000); const notice = enc.encode("These are not in this download.\r\n");
  const entries: NativeZipEntry[] = [await put("photo.jpg", photo), await put("empty.txt", new Uint8Array()), await put("Café 写真.dng", raw), { name: "Left out.txt", data: notice }];
  const expected: Record<string, Uint8Array> = { "photo.jpg": photo, "empty.txt": new Uint8Array(), "Café 写真.dng": raw, "Left out.txt": notice };
  return { entries, expected };
}

describe("python3 -m zipfile -t on archives written by createNativeZip", () => {
  for (const [label, zip32Max] of [["ZIP32", undefined], ["ZIP64 (forced)", 1]] as const) {
    it(`${label}: the test passes and the extracted bytes equal the inputs`, async () => {
      const { entries, expected } = await fixture();
      const result = await check(entries, zip32Max);
      expect(result.ok, result.output).toBe(true);
      expect(Object.keys(result.files).sort()).toEqual(Object.keys(expected).sort());
      for (const [name, data] of Object.entries(expected)) expect(result.files[name], name).toBe(b64(data));
    });
  }

  it("fails on a wrong CRC, so a pass above is evidence rather than a checker that accepts anything", async () => {
    const { entries } = await fixture();
    const first = entries[0] as ZipObjectEntry;
    const result = await check([{ ...first, crc32: (first.crc32 ^ 1) >>> 0 }, ...entries.slice(1)]);
    expect(result.ok).toBe(false); expect(result.output).toMatch(/corrupted: .photo\.jpg./);
  });
});
