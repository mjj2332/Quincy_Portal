import { describe, expect, it } from "vitest";
import { enqueueRenditionSafely, RENDITION_SPEC_VERSION, renditionR2Key } from "@quincy/shared";
import { generateRenditions, type MeasuredRendition, type RenditionStore, webpDimensions } from "../src/renditions";

const asset = { id: "11111111-1111-4111-8111-111111111111", r2Key: "projects/test/raw/a/source.jpg", contentHash: "content-v1" };

// Actual 40x30 lossless WebP emitted by the installed sharp encoder, not a handcrafted header.
const tinyWebp = Uint8Array.from(Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvJ0AHAAcQ/Y/+ByKi/wEA", "base64"));

function webp(width = 40, height = 30): Uint8Array {
  const bytes = new Uint8Array(tinyWebp);
  const bits = (width - 1) | ((height - 1) << 14) | (1 << 28);
  new DataView(bytes.buffer).setUint32(21, bits >>> 0, true);
  return bytes;
}

function harness() {
  const saved: MeasuredRendition[] = []; const objects = new Set<string>(); const requests: string[] = []; let puts = 0;
  const store: RenditionStore = {
    getAsset: async () => asset,
    getRenditions: async () => saved.map(({ variant, r2Key, specVersion }) => ({ variant, r2Key, specVersion })),
    save: async (row) => { const index = saved.findIndex((savedRow) => savedRow.variant === row.variant); if (index === -1) saved.push(row); else saved[index] = row; },
  };
  const env = {
    APP_ORIGIN: "https://portal.test", TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes",
    MEDIA: {
      head: async (key: string) => objects.has(key) ? {} : null,
      put: async (key: string) => { puts += 1; objects.add(key); },
    },
  };
  return { env, store, saved, objects, requests, get puts() { return puts; } };
}

describe("durable rendition generation", () => {
  it("keeps automatic queue handoff inert by default and makes a send failure non-fatal", async () => {
    let sends = 0;
    const queue = { send: async () => { sends += 1; throw new Error("queue unavailable"); } };
    await expect(enqueueRenditionSafely({ RENDITIONS_ENABLED: false, RENDITION_QUEUE: queue }, asset.id, "test")).resolves.toBe(false);
    expect(sends).toBe(0);
    await expect(enqueueRenditionSafely({ RENDITIONS_ENABLED: true, RENDITION_QUEUE: queue }, asset.id, "test")).resolves.toBe(false);
    expect(sends).toBe(1);
  });

  it("validates and stores WebP thumb+web before recording each row", async () => {
    const h = harness();
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async (url: string) => { h.requests.push(url); return new Response(webp(), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } }); }) as typeof fetch });
    expect(result.generated).toEqual(["thumb", "web"]); expect(h.saved).toHaveLength(2); expect(h.objects.size).toBe(2);
    expect(h.saved.every((row) => /^renditions\/.+\/[a-f0-9]{64}\.webp$/.test(row.r2Key))).toBe(true);
    expect(h.saved.every((row) => row.specVersion === RENDITION_SPEC_VERSION && row.width === 40 && row.height === 30)).toBe(true);
    expect(h.requests.every((url) => url.includes("format=webp/") && url.includes("v=v2"))).toBe(true);
  });

  it("rejects Images 9401/non-image responses before R2 or D1 writes", async () => {
    const h = harness();
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response("Transformation origin is not in allowed origins list", { status: 403, headers: { "content-type": "text/plain", "cf-resized": "err=9401" } })) as typeof fetch })).rejects.toThrow("Invalid transform response");
    expect(h.saved).toEqual([]); expect(h.objects.size).toBe(0);
  });

  it("rejects malformed, header-only, truncated, and out-of-bounds WebP", async () => {
    const h = harness();
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("Invalid WebP dimensions");
    // VP8X can describe a canvas but carries no actual VP8/VP8L image bitstream.
    const headerOnly = new Uint8Array(30); headerOnly.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0]);
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(headerOnly, { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("Invalid WebP dimensions");
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(webp().slice(0, -1), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("Invalid WebP dimensions");
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(webp(641, 20), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("Invalid WebP dimensions");
    // Plausible VP8L dimensions plus arbitrary minimal bytes is not an image payload.
    const fabricated = webp(); fabricated.fill(0, 25); fabricated[20] = 0x2f;
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(fabricated, { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("Invalid WebP dimensions");
  });

  it("rejects output above the bounded transform limit before R2 or D1 writes", async () => {
    const h = harness();
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(oversized, { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("exceeds");
    expect(h.saved).toEqual([]); expect(h.objects.size).toBe(0);
  });

  it("is idempotent and retries a partial thumb/web completion safely", async () => {
    const h = harness(); let calls = 0;
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => {
      calls += 1;
      return calls === 1 ? new Response(webp(), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } }) : new Response("bad", { status: 403, headers: { "content-type": "text/plain", "cf-resized": "err=9401" } });
    }) as typeof fetch })).rejects.toThrow();
    expect(h.saved.map((row) => row.variant)).toEqual(["thumb"]);
    const retry = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(webp(), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch });
    expect(retry).toEqual({ generated: ["web"], skipped: ["thumb"] });
    const again = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("should not fetch"); }) as typeof fetch });
    expect(again).toEqual({ generated: [], skipped: ["thumb", "web"] });
  });

  it("parses dimensions from the actual VP8L image chunk", () => {
    expect(webpDimensions(webp(640, 20))).toEqual({ width: 640, height: 20 });
  });

  it("keys output with its digest and does not overwrite an orphan from a failed D1 write", async () => {
    const h = harness();
    let failSave = true;
    h.store.save = async (row) => { if (failSave) { failSave = false; throw new Error("D1 unavailable"); } h.saved.push(row); };
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(webp(), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch })).rejects.toThrow("D1 unavailable");
    expect(h.puts).toBe(1);
    await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(webp(), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch });
    // Thumb was adopted (no second put); web was generated once on the successful retry.
    expect(h.puts).toBe(2);
    expect(renditionR2Key(asset.id, asset.contentHash, "thumb", "a".repeat(64))).toContain("/" + "a".repeat(64) + ".webp");
  });
});
