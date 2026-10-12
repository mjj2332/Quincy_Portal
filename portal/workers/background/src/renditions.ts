import { crc32 } from "node:zlib";
import { assetRenditions, assets } from "@quincy/db/schema";
import {
  ANY_RENDITION_VARIANTS,
  DEFAULT_RENDITION_VARIANTS,
  DELIVERY_RENDITION_SPECS,
  issueTransformSource,
  RENDITION_SPECS,
  RENDITION_VARIANT_SPEC,
  renditionR2Key,
  TRANSFORM_CACHE_VERSION,
  isDngFilename,
  type AnyRenditionVariant,
  type DeliveryRenditionVariant,
} from "@quincy/shared";
import { and, eq, inArray } from "drizzle-orm";

import type { Env } from "./env";
import { dbFor } from "./lib/db";
import { user } from "@quincy/db/schema";
import { DngPreviewError, ensureDngPreview } from "./dng-preview";
import deliveryWatermarkTile from "../assets/delivery-watermark-tile.png";

const MAX_RENDITION_BYTES = 16 * 1024 * 1024;
/** The Images binding's documented `.input()` cap. */
const IMAGES_INPUT_MAX_BYTES = 20 * 1024 * 1024;

const isDeliveryVariant = (variant: AnyRenditionVariant): variant is DeliveryRenditionVariant => variant === "delivery_web" || variant === "premium_preview";

export type RenditionAsset = { id: string; r2Key: string; contentHash: string | null; originalFilename?: string };
export type StoredRendition = { variant: AnyRenditionVariant; r2Key: string; specVersion: string };
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
    getAsset: (assetId) => db.select({ id: assets.id, r2Key: assets.r2Key, contentHash: assets.contentHash, originalFilename: assets.originalFilename })
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

function transformUrl(origin: string, key: string, variant: "thumb" | "web" | "delivery_web", secret: string | undefined, principalId: string, authorizationEpoch: number): Promise<string> {
  // `delivery_web` is a JPEG for the client page; the QA pair stays WebP.
  const options = variant === "delivery_web"
    ? `width=${DELIVERY_RENDITION_SPECS.delivery_web.maxEdge},height=${DELIVERY_RENDITION_SPECS.delivery_web.maxEdge},fit=scale-down,quality=${DELIVERY_RENDITION_SPECS.delivery_web.quality},format=jpeg`
    : `width=${RENDITION_SPECS[variant].maxEdge},height=${RENDITION_SPECS[variant].maxEdge},fit=scale-down,quality=${RENDITION_SPECS[variant].quality},format=webp`;
  return signedTransformUrl(origin, key, options, secret, principalId, authorizationEpoch);
}

/** Width and height from a baseline or progressive JPEG's SOF marker; null if it is not a JPEG with one. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!; const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** The Image Transformations URL for `key` with `options` (the part after `/cdn-cgi/image/`), over a freshly signed `/__transform-source` URL. */
export function signedTransformUrl(origin: string, key: string, options: string, secret: string | undefined, principalId: string, authorizationEpoch: number): Promise<string> {
  return issueTransformSource(secret, key, principalId, authorizationEpoch).then((issued) => {
    if (!issued) throw new Error("TRANSFORM_SOURCE_SECRET is required for rendition generation");
    const source = new URL(`/__transform-source/${key.split("/").map(encodeURIComponent).join("/")}`, origin);
    source.searchParams.set("v", TRANSFORM_CACHE_VERSION);
    source.searchParams.set("exp", String(issued.expiresAt));
    source.searchParams.set("p", principalId);
    source.searchParams.set("ae", String(authorizationEpoch));
    source.searchParams.set("sig", issued.signature);
    return new URL(`/cdn-cgi/image/${options}/${source.href}`, origin).href;
  });
}

export type RenditionGenerationEnv = Pick<Env, "APP_ORIGIN" | "TRANSFORM_SOURCE_SECRET" | "TRANSFORM_SOURCE_PRINCIPAL_ID" | "TRANSFORM_SOURCE_AUTHORIZATION_EPOCH" | "MEDIA"> & { DB?: D1Database; IMAGES?: ImagesBinding };
type TransformPrincipal = { id: string; authorizationEpoch: number };

export async function resolveTransformPrincipal(env: RenditionGenerationEnv): Promise<TransformPrincipal> {
  // Production calls use the D1-backed default dependency. Select a current active internal
  // principal so the app-side source wrapper can perform its required epoch read; never sign
  // with the reserved system actor or a stale deployment-time epoch. Injected test fetchers keep
  // the small pure harness independent of D1.
  if (!env.DB) {
    const principalId = env.TRANSFORM_SOURCE_PRINCIPAL_ID ?? "00000000-0000-4000-8000-000000000000";
    const configuredEpoch = Number(env.TRANSFORM_SOURCE_AUTHORIZATION_EPOCH ?? "0");
    return { id: principalId, authorizationEpoch: Number.isSafeInteger(configuredEpoch) && configuredEpoch >= 0 ? configuredEpoch : 0 };
  }
  const configured = env.TRANSFORM_SOURCE_PRINCIPAL_ID
    ? eq(user.id, env.TRANSFORM_SOURCE_PRINCIPAL_ID)
    : inArray(user.role, ["admin", "editor"]);
  const principal = await dbFor(env as Env).select({ id: user.id, authorizationEpoch: user.authorizationEpoch })
    .from(user)
    .where(and(eq(user.active, true), configured))
    .orderBy(user.id)
    .get();
  if (!principal) throw new Error("No active internal transform principal is available");
  return { id: principal.id, authorizationEpoch: principal.authorizationEpoch };
}

/**
 * Builds the requested variants of one photo, in the canonical order (`thumb`, `web`, `delivery_web`, `premium_preview`). With no `variants` it builds the QA pair, as before #787.
 * Each variant is skipped when a row at ITS OWN spec version (`RENDITION_VARIANT_SPEC`) and its object exist, so a Delivery spec bump regenerates only that variant.
 * `premium_preview` is derived from the asset's own current `web` rendition, never from the original: when that rendition is missing or stale it first makes that `web` in the same invocation.
 */
export async function generateRenditions(
  env: RenditionGenerationEnv,
  assetId: string,
  // fetch MUST be wrapped, not passed bare: calling `dependencies.fetch(...)` invokes native
  // fetch with `this = dependencies`, which throws "Illegal invocation". The arrow calls the
  // free global fetch with correct binding. (Injected test fetchers are unaffected.)
  dependencies?: { store: RenditionStore; fetch: typeof fetch },
  variants: readonly AnyRenditionVariant[] = DEFAULT_RENDITION_VARIANTS,
): Promise<{ generated: AnyRenditionVariant[]; skipped: AnyRenditionVariant[] }> {
  const resolvedDependencies = dependencies ?? { store: createRenditionStore(env as Env), fetch: (...args: Parameters<typeof fetch>) => fetch(...args) };
  const wanted = ANY_RENDITION_VARIANTS.filter((variant) => variants.includes(variant));
  const asset = await resolvedDependencies.store.getAsset(assetId);
  if (!asset) return { generated: [], skipped: wanted };
  const existing = new Map((await resolvedDependencies.store.getRenditions(assetId)).map((row) => [row.variant, row]));
  // The preview is drawn over `web`. When that row is missing or stale (right after a supersede carry, say) make it first, in this invocation, rather than throwing into retries and the DLQ.
  // A current `web` is left alone, and unreported, so the result still names only what was asked for.
  const currentWeb = existing.get("web");
  const webUsable = currentWeb?.specVersion === RENDITION_VARIANT_SPEC.web && Boolean(await env.MEDIA.head(currentWeb.r2Key));
  const work = wanted.includes("premium_preview") && !wanted.includes("web") && !webUsable
    ? ANY_RENDITION_VARIANTS.filter((variant) => variant === "web" || wanted.includes(variant))
    : wanted;
  const generated: AnyRenditionVariant[] = []; const skipped: AnyRenditionVariant[] = [];
  let principal: TransformPrincipal | null = null;
  let sourceKey: string | null = null;
  for (const variant of work) {
    const previous = existing.get(variant);
    const spec = RENDITION_VARIANT_SPEC[variant];
    if (previous?.specVersion === spec && await env.MEDIA.head(previous.r2Key)) { skipped.push(variant); continue; }
    let body: Uint8Array; let contentType: RenditionContentType; let width: number | null = null; let height: number | null = null;
    if (variant === "premium_preview") {
      ({ body, width, height } = await watermarkedPreview(env, asset, existing.get("web")));
      contentType = "image/jpeg";
    } else {
      principal ??= await resolveTransformPrincipal(env);
      if (sourceKey === null) {
        sourceKey = asset.r2Key;
        if (isDngFilename(asset.originalFilename ?? asset.r2Key)) {
          try {
            sourceKey = (await ensureDngPreview(env.MEDIA, asset.r2Key)).key;
          } catch (error) {
            if (error instanceof DngPreviewError) throw error;
            const detail = error instanceof Error ? error.message : "embedded JPEG preview is unavailable";
            throw new Error(`DNG preview unavailable for ${assetId}: ${detail}`);
          }
        }
      }
      const response = await resolvedDependencies.fetch(await transformUrl(env.APP_ORIGIN, sourceKey, variant, env.TRANSFORM_SOURCE_SECRET, principal.id, principal.authorizationEpoch), { headers: { accept: variant === "delivery_web" ? "image/jpeg" : "image/webp" } });
      const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const resized = response.headers.get("cf-resized");
      if (!response.ok || (responseType !== "image/webp" && responseType !== "image/jpeg") || /(?:^|[;,\s])err=/i.test(resized ?? "") || !/(?:^|[;,\s])internal=ok/i.test(resized ?? "")) {
        throw new Error(`Invalid transform response for ${assetId}/${variant}: status=${response.status} content-type=${responseType ?? "missing"} cf-resized=${resized ?? "missing"}`);
      }
      contentType = responseType;
      body = await readBounded(response.body);
      if (variant === "delivery_web") {
        // A client-facing JPEG: it must be a JPEG with a readable size inside the spec's edge, never a pass-through.
        const dimensions = contentType === "image/jpeg" && isJpeg(body) ? jpegDimensions(body) : null;
        if (!validDimensions(dimensions, DELIVERY_RENDITION_SPECS.delivery_web.maxEdge)) throw new Error(`Invalid JPEG output for ${assetId}/${variant}`);
        width = dimensions.width; height = dimensions.height;
      } else if (contentType === "image/webp") {
        const dimensions = webpDimensions(body);
        if (!validDimensions(dimensions, RENDITION_SPECS[variant].maxEdge)) throw new Error(`Invalid WebP dimensions for ${assetId}/${variant}`);
        width = dimensions.width; height = dimensions.height;
      } else if (!isJpeg(body)) {
        throw new Error(`Invalid JPEG output for ${assetId}/${variant}`);
      }
    }
    const outputDigest = await sha256Hex(body);
    const r2Key = renditionR2Key(asset.id, asset.contentHash, variant, outputDigest, contentType);
    // Never overwrite an immutable rendition object. If a prior attempt wrote R2 then lost its
    // D1 update, the deterministic digest key is adopted below; an untracked orphan is safe.
    let stored = await env.MEDIA.head(r2Key);
    if (!stored) {
      stored = await env.MEDIA.put(r2Key, body, { httpMetadata: { contentType }, customMetadata: { specVersion: spec, assetId, variant, outputDigest } });
    }
    // The Web-size zip (#787 slice 7) needs this object's CRC-32 before its first byte. We hold the bytes now, so it costs nothing to record it here instead of reading the object back in a second job.
    if (variant === "delivery_web") await recordObjectCrc(env, r2Key, body, stored?.etag);
    await resolvedDependencies.store.save({ assetId, variant, r2Key, specVersion: spec, bytes: body.byteLength, contentType, width, height });
    existing.set(variant, { variant, r2Key, specVersion: spec });
    generated.push(variant);
  }
  return { generated, skipped };
}

/**
 * Upserts `object_crc32` for a rendition object this run just wrote or adopted: the CRC-32 of the bytes in hand, their length and the R2 etag of the stored object. Best effort: a failed write is logged and
 * the rendition still stands, because the hourly object CRC sweep queues the same key for the background job. Skipped when there is no `DB` binding or R2 gave no etag.
 */
async function recordObjectCrc(env: RenditionGenerationEnv, r2Key: string, body: Uint8Array, etag: string | undefined): Promise<void> {
  if (!env.DB || !etag) return;
  try {
    await env.DB.prepare(`INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (r2_key) DO UPDATE SET crc32 = excluded.crc32, bytes = excluded.bytes, etag = excluded.etag, computed_at = excluded.computed_at`)
      .bind(r2Key, crc32(body), body.byteLength, etag, Date.now()).run();
  } catch (error) {
    console.error("Delivery web CRC-32 write failed; the object CRC sweep repairs it", { r2Key, error });
  }
}

/**
 * The locked-photo preview (#787): the asset's own `web` rendition, scaled to 1600 px, with the repeated watermark tile burned in by the Images binding, as a JPEG. The tile PNG carries its own
 * opacity, so the draw opacity is 1. The binding caps its input at 20 MB, and the watermark must never be drawn over anything but the asset's own current `web` rendition.
 */
async function watermarkedPreview(env: RenditionGenerationEnv, asset: RenditionAsset, web: StoredRendition | undefined): Promise<{ body: Uint8Array; width: number | null; height: number | null }> {
  if (!web || web.specVersion !== RENDITION_VARIANT_SPEC.web) throw new Error(`premium_preview for ${asset.id} needs a current web rendition and has none`);
  if (!env.IMAGES) throw new Error("IMAGES binding is required for premium_preview");
  const source = await env.MEDIA.get(web.r2Key);
  if (!source) throw new Error(`premium_preview for ${asset.id}: the web rendition object is missing`);
  if (source.size > IMAGES_INPUT_MAX_BYTES) { await source.body.cancel(); throw new Error(`premium_preview for ${asset.id}: the web rendition exceeds the 20 MB Images input cap`); }
  const edge = DELIVERY_RENDITION_SPECS.premium_preview.maxEdge;
  // Resize first: the output canvas is the base image's size, so drawing at 3200 px and shrinking afterwards would shrink the tile with it.
  const result = await env.IMAGES.input(source.body)
    .transform({ width: edge, height: edge, fit: "scale-down" })
    .draw(env.IMAGES.input(new Response(deliveryWatermarkTile).body!), { repeat: true, opacity: 1 })
    .output({ format: "image/jpeg", quality: DELIVERY_RENDITION_SPECS.premium_preview.quality });
  const body = await readBounded(result.image());
  const dimensions = isJpeg(body) ? jpegDimensions(body) : null;
  if (!validDimensions(dimensions, edge)) throw new Error(`Invalid JPEG output for ${asset.id}/premium_preview`);
  return { body, width: dimensions.width, height: dimensions.height };
}
