import { assetRenditions, assets } from "@quincy/db/schema";
import {
  issueTransformSource,
  RENDITION_SPECS,
  RENDITION_SPEC_VERSION,
  renditionR2Key,
  TRANSFORM_CACHE_VERSION,
  type RenditionVariant,
} from "@quincy/shared";
import { and, eq } from "drizzle-orm";

import type { Env } from "./env";
import { dbFor } from "./lib/db";

const MAX_RENDITION_BYTES = 16 * 1024 * 1024;

export type RenditionAsset = { id: string; r2Key: string; contentHash: string | null };
export type StoredRendition = { variant: RenditionVariant; r2Key: string; specVersion: string };
export type RenditionContentType = "image/webp" | "image/jpeg";
export type MeasuredRendition = StoredRendition & { bytes: number; contentType: RenditionContentType; width: number | null; height: number | null };

export interface RenditionStore {
  getAsset(assetId: string): Promise<RenditionAsset | undefined>;
  getRenditions(assetId: string): Promise<StoredRendition[]>;
  save(rendition: MeasuredRendition & { assetId: string }): Promise<void>;
}

export function createRenditionStore(env: Env): RenditionStore {
  const db = dbFor(env);
  return {
    getAsset: (assetId) => db.select({ id: assets.id, r2Key: assets.r2Key, contentHash: assets.contentHash })
      .from(assets).where(and(eq(assets.id, assetId), eq(assets.kind, "photo"))).get(),
    getRenditions: (assetId) => db.select({ variant: assetRenditions.variant, r2Key: assetRenditions.r2Key, specVersion: assetRenditions.specVersion })
      .from(assetRenditions).where(eq(assetRenditions.assetId, assetId)).all(),
    async save(rendition) {
      await db.insert(assetRenditions).values({
        id: crypto.randomUUID(), assetId: rendition.assetId, variant: rendition.variant,
        r2Key: rendition.r2Key, bytes: rendition.bytes, contentType: rendition.contentType,
        width: rendition.width, height: rendition.height, specVersion: rendition.specVersion, createdAt: new Date(),
      }).onConflictDoUpdate({
        target: [assetRenditions.assetId, assetRenditions.variant],
        set: {
          r2Key: rendition.r2Key, bytes: rendition.bytes, contentType: rendition.contentType,
          width: rendition.width, height: rendition.height, specVersion: rendition.specVersion, createdAt: new Date(),
        },
      });
    },
  };
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit = MAX_RENDITION_BYTES): Promise<Uint8Array> {
  if (!body) throw new Error("Transformation response has no body");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`Transformation output exceeds ${limit} byte limit`);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (total === 0) throw new Error("Transformation output is empty");
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/**
 * Validates an entire static WebP RIFF container without a Node decoder. VP8X only describes
 * canvas/metadata, so it is deliberately insufficient: an actual VP8 or VP8L image chunk
 * with a structurally plausible coded payload is required. This is deliberately not a full
 * decoder (Workers has none); Cloudflare's image response metadata remains the decode gate.
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (bytes.byteLength < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null;
  let offset = 12;
  let image: { width: number; height: number } | null = null;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return null;
    const name = ascii(offset, 4); const length = view.getUint32(offset + 4, true); const data = offset + 8;
    const paddedEnd = data + length + (length & 1);
    if (paddedEnd > bytes.byteLength) return null;
    if (name === "VP8 ") {
      // Frame tag (3), key-frame marker (3), dimensions (4), and a complete first partition.
      const frameTag = bytes[data]! | (bytes[data + 1]! << 8) | (bytes[data + 2]! << 16);
      const firstPartitionLength = frameTag >>> 5;
      if (length < 18 || (frameTag & 1) !== 0 || firstPartitionLength < 8 || firstPartitionLength > length - 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null;
      const width = (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff;
      const height = (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff;
      if (!width || !height || image) return null;
      image = { width, height };
    } else if (name === "VP8L") {
      // Signature + image header + a non-degenerate entropy payload. A full VP8L decode is
      // unavailable in a Worker, but a short/header-only or uniform fabricated payload is
      // never accepted as a transform result.
      if (length < 13 || bytes[data] !== 0x2f || image) return null;
      const bits = view.getUint32(data + 1, true);
      if ((bits >>> 29) !== 0) return null; // VP8L version is exactly zero.
      const coded = bytes.slice(data + 5, data + length);
      if (coded.every((value) => value === coded[0])) return null;
      image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    offset = paddedEnd;
  }
  return offset === bytes.byteLength ? image : null;
}

function validDimensions(dimensions: { width: number; height: number } | null, maxEdge: number): dimensions is { width: number; height: number } {
  return Boolean(dimensions && dimensions.width > 0 && dimensions.height > 0 && dimensions.width <= maxEdge && dimensions.height <= maxEdge);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy to an ArrayBuffer: Workers accepts Uint8Array, while TS 7 distinguishes a possible
  // SharedArrayBuffer view from WebCrypto's BufferSource type.
  return crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer).then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function transformUrl(origin: string, key: string, variant: RenditionVariant, secret: string | undefined): Promise<string> {
  const spec = RENDITION_SPECS[variant];
  return issueTransformSource(secret, key).then((issued) => {
    if (!issued) throw new Error("TRANSFORM_SOURCE_SECRET is required for rendition generation");
    const source = new URL(`/__transform-source/${key.split("/").map(encodeURIComponent).join("/")}`, origin);
    source.searchParams.set("v", TRANSFORM_CACHE_VERSION);
    source.searchParams.set("exp", String(issued.expiresAt));
    source.searchParams.set("sig", issued.signature);
    return new URL(`/cdn-cgi/image/width=${spec.maxEdge},height=${spec.maxEdge},fit=scale-down,quality=${spec.quality},format=webp/${source.href}`, origin).href;
  });
}

export async function generateRenditions(
  env: Pick<Env, "APP_ORIGIN" | "TRANSFORM_SOURCE_SECRET" | "MEDIA">,
  assetId: string,
  // fetch MUST be wrapped, not passed bare: calling `dependencies.fetch(...)` invokes native
  // fetch with `this = dependencies`, which throws "Illegal invocation". The arrow calls the
  // free global fetch with correct binding. (Injected test fetchers are unaffected.)
  dependencies: { store: RenditionStore; fetch: typeof fetch } = { store: createRenditionStore(env as Env), fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
): Promise<{ generated: RenditionVariant[]; skipped: RenditionVariant[] }> {
  const asset = await dependencies.store.getAsset(assetId);
  if (!asset) return { generated: [], skipped: ["thumb", "web"] };
  const existing = new Map((await dependencies.store.getRenditions(assetId)).map((row) => [row.variant, row]));
  const generated: RenditionVariant[] = []; const skipped: RenditionVariant[] = [];
  for (const variant of ["thumb", "web"] as const) {
    const previous = existing.get(variant);
    if (previous?.specVersion === RENDITION_SPEC_VERSION && await env.MEDIA.head(previous.r2Key)) { skipped.push(variant); continue; }
    const response = await dependencies.fetch(await transformUrl(env.APP_ORIGIN, asset.r2Key, variant, env.TRANSFORM_SOURCE_SECRET), { headers: { accept: "image/webp" } });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const resized = response.headers.get("cf-resized");
    if (!response.ok || (contentType !== "image/webp" && contentType !== "image/jpeg") || /(?:^|[;,\s])err=/i.test(resized ?? "") || !/(?:^|[;,\s])internal=ok/i.test(resized ?? "")) {
      throw new Error(`Invalid transform response for ${assetId}/${variant}: status=${response.status} content-type=${contentType ?? "missing"} cf-resized=${resized ?? "missing"}`);
    }
    const body = await readBounded(response.body);
    let width: number | null = null; let height: number | null = null;
    if (contentType === "image/webp") {
      const dimensions = webpDimensions(body);
      if (!validDimensions(dimensions, RENDITION_SPECS[variant].maxEdge)) throw new Error(`Invalid WebP dimensions for ${assetId}/${variant}`);
      width = dimensions.width; height = dimensions.height;
    } else if (!isJpeg(body)) {
      throw new Error(`Invalid JPEG output for ${assetId}/${variant}`);
    }
    const outputDigest = await sha256Hex(body);
    const r2Key = renditionR2Key(asset.id, asset.contentHash, variant, outputDigest, contentType);
    // Never overwrite an immutable rendition object. If a prior attempt wrote R2 then lost its
    // D1 update, the deterministic digest key is adopted below; an untracked orphan is safe.
    if (!await env.MEDIA.head(r2Key)) {
      await env.MEDIA.put(r2Key, body, { httpMetadata: { contentType }, customMetadata: { specVersion: RENDITION_SPEC_VERSION, assetId, variant, outputDigest } });
    }
    await dependencies.store.save({ assetId, variant, r2Key, specVersion: RENDITION_SPEC_VERSION, bytes: body.byteLength, contentType, width, height });
    generated.push(variant);
  }
  return { generated, skipped };
}
