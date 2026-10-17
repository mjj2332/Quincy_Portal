import type { ByteSource } from "@quincy/shared";

/** Thrown from a probe read when R2 cannot give the bytes the HEAD described: transient, never a rejection of the file. */
export class ProbeUnavailable extends Error {}

/** A ByteSource over a stored object. Every read is pinned to the HEAD's ETag, so a swap after the HEAD is `ProbeUnavailable`, never a verdict on the wrong bytes. */
export function r2ProbeSource(bucket: R2Bucket, key: string, head: { size: number; etag: string }): ByteSource {
  return {
    size: head.size,
    read: async (offset, length) => {
      const object = await bucket.get(key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } });
      if (!object || !("body" in object) || !object.body) throw new ProbeUnavailable("The stored video changed or is not readable");
      const bytes = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
      if (bytes.byteLength < Math.min(length, head.size - offset)) throw new ProbeUnavailable("The stored video returned a short read");
      return bytes;
    },
  };
}
