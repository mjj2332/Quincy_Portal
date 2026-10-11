import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeZip, type NativeZipEntry, type ZipObjectEntry } from "../../../workers/app/src/lib/zip-native";

/**
 * An independent check of the native ZIP writer (#802): the archive is written to disk and read back by Python's `zipfile` and, when installed, Info-ZIP `unzip`, neither of which shares a line
 * of code with the writer or the in-repo parser. Both test every entry's CRC-32 against its stored bytes. `FixedLengthStream` is workerd-only, so a pass-through TransformStream stands in for it
 * here; the length it would enforce is asserted by hand.
 */
const g = globalThis as unknown as { FixedLengthStream?: unknown };
let dir = ""; let previous: unknown;
beforeAll(() => {
  previous = g.FixedLengthStream;
  g.FixedLengthStream = class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } };
  dir = mkdtempSync(join(tmpdir(), "zip-native-"));
});
afterAll(() => { g.FixedLengthStream = previous; rmSync(dir, { recursive: true, force: true }); });

const enc = new TextEncoder();
function bucketOf(objects: Map<string, Uint8Array>): Pick<R2Bucket, "get"> {
  return { get: async (key: string) => { const data = objects.get(key); return data ? ({ key, size: data.length, etag: `etag-${key}`, body: new Blob([data as BlobPart]).stream() } as unknown as R2ObjectBody) : null; } } as Pick<R2Bucket, "get">;
}
async function archive(zip32Max?: number): Promise<{ bytes: Uint8Array; length: number }> {
  const objects = new Map<string, Uint8Array>(); const entries: NativeZipEntry[] = [];
  const random = new Uint8Array(200_000); for (let at = 0; at < random.length; at += 65_536) crypto.getRandomValues(random.subarray(at, Math.min(random.length, at + 65_536)));
  for (const [name, data] of [["photo.jpg", random], ["note.txt", enc.encode("hello zip")], ["empty.bin", new Uint8Array(0)]] as const) {
    objects.set(`k/${name}`, data);
    entries.push({ name, r2Key: `k/${name}`, crc32: crc32(data), bytes: data.length, etag: `etag-k/${name}` } satisfies ZipObjectEntry);
  }
  entries.push({ name: "Left out.txt", data: enc.encode("These are not in this download.\r\n") });
  const zip = createNativeZip({ bucket: bucketOf(objects), entries, ...(zip32Max === undefined ? {} : { zip32Max }) });
  const bytes = new Uint8Array(await new Response(zip.body).arrayBuffer()); await zip.done;
  return { bytes, length: zip.length };
}
function check(label: string, bytes: Uint8Array) {
  const file = join(dir, `${label}.zip`); writeFileSync(file, bytes);
  const python = spawnSync("python3", ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" });
  expect(python.status, python.stderr + python.stdout).toBe(0);
  // `zipfile -t` exits 0 even for a corrupt member and reports it on stdout, so the output is what is asserted.
  expect(python.stdout).toContain("Done testing"); expect(python.stdout).not.toContain("corrupted");
  const unzip = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
  if (unzip.error) return; // not installed
  expect(unzip.status, unzip.stdout + unzip.stderr).toBe(0);
  expect(unzip.stdout).toMatch(/No errors detected/);
}

describe("native ZIP archives, read by tools that are not ours", () => {
  it("a ZIP32 archive tests clean and is exactly the declared length", async () => {
    const { bytes, length } = await archive(); expect(bytes.length).toBe(length); check("zip32", bytes);
  });
  it("a ZIP64-forced archive tests clean and is exactly the declared length", async () => {
    const { bytes, length } = await archive(1); expect(bytes.length).toBe(length);
    expect(bytes.length).toBeGreaterThan((await archive()).length); check("zip64", bytes);
  });
  it("negative control: the same tools reject an archive with one flipped data byte", async () => {
    const { bytes } = await archive(); const bad = bytes.slice(); bad[100] = bad[100]! ^ 0xff;
    const file = join(dir, "bad.zip"); writeFileSync(file, bad);
    expect(spawnSync("python3", ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" }).stdout).toContain("corrupted");
  });
});
