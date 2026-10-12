import { env } from "cloudflare:test";
import { crc32 } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

declare const __PORTAL_MIGRATION_SQL__: string;
import { DELIVERY_RENDITION_VARIANTS, RENDITION_SPEC_VERSION, RENDITION_VARIANT_SPEC } from "@quincy/shared";
import { generateRenditions, type MeasuredRendition, type RenditionStore } from "../src/renditions";
import { parseQueueBody, RENDITION_DLQ_QUEUE_NAME, RENDITION_QUEUE_NAME } from "../src/queue-dispatch";

/** Delivery derivatives (#787 slice 4): `delivery_web` and `premium_preview`, selected per message. */
const asset = { id: "22222222-2222-4222-8222-222222222222", r2Key: "projects/test/edited/a/source.jpg", contentHash: "content-v2" };
const tinyWebp = Uint8Array.from(Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvJ0AHAAcQ/Y/+ByKi/wEA", "base64"));

/** A JPEG that is only a SOI, one SOF0 and an EOI: enough for a dimension reader, not a decoder. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
}
const transformOk = { "content-type": "image/jpeg", "cf-resized": "internal=ok" };

type Call = { op: string; args: unknown[] };
/** An Images binding that records the chain. `output` answers with `outputBytes`. */
function fakeImages(outputBytes: Uint8Array, calls: Call[], inputs: Array<{ bytes: Uint8Array }>) {
  const chain = (): Record<string, unknown> => ({
    transform: (...args: unknown[]) => { calls.push({ op: "transform", args }); return chain(); },
    draw: (...args: unknown[]) => { calls.push({ op: "draw", args }); return chain(); },
    output: async (...args: unknown[]) => { calls.push({ op: "output", args }); return { contentType: () => "image/jpeg", image: () => new Response(outputBytes).body!, response: () => new Response(outputBytes) }; },
  });
  return {
    input: (stream: ReadableStream<Uint8Array>) => {
      const record = { bytes: new Uint8Array(0) }; inputs.push(record);
      void new Response(stream).arrayBuffer().then((buffer) => { record.bytes = new Uint8Array(buffer); });
      calls.push({ op: "input", args: [stream] });
      return chain();
    },
  };
}

function harness(rows: Array<{ variant: string; r2Key: string; specVersion: string }> = []) {
  const saved: Array<MeasuredRendition & { assetId: string }> = []; const objects = new Map<string, { body: Uint8Array; size: number; meta?: Record<string, string> }>();
  const stored = rows.map((row) => ({ ...row }));
  const store: RenditionStore = {
    getAsset: async () => asset,
    getRenditions: async () => [...stored, ...saved.map(({ variant, r2Key, specVersion }) => ({ variant, r2Key, specVersion }))] as never,
    save: async (row) => { const index = saved.findIndex((savedRow) => savedRow.variant === row.variant); if (index === -1) saved.push(row); else saved[index] = row; },
  };
  const calls: Call[] = []; const inputs: Array<{ bytes: Uint8Array }> = []; const puts: Array<{ key: string; contentType?: string; specVersion?: string }> = [];
  const state = { imagesOutput: jpeg(1600, 1067), webSize: undefined as number | undefined };
  const env = {
    APP_ORIGIN: "https://portal.test", TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes",
    MEDIA: {
      head: async (key: string) => objects.has(key) ? {} : null,
      get: async (key: string) => { const object = objects.get(key); return object ? { size: state.webSize ?? object.size, body: new Response(object.body).body!, httpMetadata: { contentType: "image/webp" } } : null; },
      put: async (key: string, body: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => { objects.set(key, { body, size: body.byteLength, meta: options?.customMetadata }); puts.push({ key, contentType: options?.httpMetadata?.contentType, specVersion: options?.customMetadata?.specVersion }); },
    },
    get IMAGES() { return fakeImages(state.imagesOutput, calls, inputs); },
  };
  return { env, store, saved, objects, calls, inputs, puts, state, stored };
}

describe("delivery derivatives: specs", () => {
  it("names a spec version per Delivery variant and leaves the shared RENDITION_SPEC_VERSION alone", () => {
    expect(RENDITION_SPEC_VERSION).toBe("v1");
    for (const variant of DELIVERY_RENDITION_VARIANTS) expect(RENDITION_VARIANT_SPEC[variant]).toBe("v1");
  });
});

describe("delivery_web", () => {
  it("is a JPEG from the original through the signed transform path at 2048 px, q85, saved at its own spec", async () => {
    const h = harness(); const requests: string[] = [];
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async (url: string) => { requests.push(url); return new Response(jpeg(2048, 1365), { headers: transformOk }); }) as typeof fetch }, ["delivery_web"]);
    expect(result).toEqual({ generated: ["delivery_web"], skipped: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/cdn-cgi\/image\/width=2048,height=2048,fit=scale-down,quality=85,format=jpeg\//);
    expect(requests[0]).toContain(encodeURIComponent(asset.r2Key.split("/")[0]!));
    expect(h.saved).toHaveLength(1);
    const row = h.saved[0]!;
    expect(row).toMatchObject({ assetId: asset.id, variant: "delivery_web", specVersion: RENDITION_VARIANT_SPEC.delivery_web, contentType: "image/jpeg", width: 2048, height: 1365 });
    expect(row.r2Key).toMatch(/^renditions\/.+\/delivery_web\/[a-f0-9]{64}\.jpg$/);
    expect(h.puts[0]).toMatchObject({ contentType: "image/jpeg", specVersion: "v1" });
  });

  it("refuses a transform output wider than 2048 px or without a readable size", async () => {
    const h = harness();
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(jpeg(3200, 2000), { headers: transformOk })) as typeof fetch }, ["delivery_web"])).rejects.toThrow(/Invalid JPEG/);
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { headers: transformOk })) as typeof fetch }, ["delivery_web"])).rejects.toThrow(/Invalid JPEG/);
    expect(h.saved).toEqual([]); expect(h.objects.size).toBe(0);
  });

  it("is regenerated when its row is at an older spec, and skipped when current", async () => {
    const h = harness([{ variant: "delivery_web", r2Key: "renditions/old.jpg", specVersion: "v0" }]);
    h.objects.set("renditions/old.jpg", { body: new Uint8Array(1), size: 1 });
    const fetcher = (async () => new Response(jpeg(2048, 1365), { headers: transformOk })) as typeof fetch;
    expect((await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: fetcher }, ["delivery_web"])).generated).toEqual(["delivery_web"]);
    expect((await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("should not fetch"); }) as typeof fetch }, ["delivery_web"]))).toEqual({ generated: [], skipped: ["delivery_web"] });
  });
});

describe("premium_preview", () => {
  const web = (h: ReturnType<typeof harness>) => { h.stored.push({ variant: "web", r2Key: "renditions/web.webp", specVersion: RENDITION_VARIANT_SPEC.web }); h.objects.set("renditions/web.webp", { body: tinyWebp, size: tinyWebp.byteLength }); };

  it("draws the repeated tile over the asset's own web rendition and stores a 1600 px JPEG at its own spec", async () => {
    const h = harness(); web(h);
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("premium_preview must not use the transform path"); }) as typeof fetch }, ["premium_preview"]);
    expect(result).toEqual({ generated: ["premium_preview"], skipped: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ops = h.calls.map((call) => call.op);
    expect(ops).toEqual(["input", "transform", "input", "draw", "output"]);
    expect(h.inputs[0]!.bytes).toEqual(tinyWebp);
    expect(h.calls.find((call) => call.op === "transform")!.args[0]).toEqual({ width: 1600, height: 1600, fit: "scale-down" });
    expect(h.calls.find((call) => call.op === "draw")!.args[1]).toEqual({ repeat: true, opacity: 1 });
    expect(h.calls.find((call) => call.op === "output")!.args[0]).toEqual({ format: "image/jpeg", quality: 85 });
    // The tile is a PNG, bundled into the Worker.
    expect(Array.from(h.inputs[1]!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(h.saved[0]).toMatchObject({ assetId: asset.id, variant: "premium_preview", specVersion: RENDITION_VARIANT_SPEC.premium_preview, contentType: "image/jpeg", width: 1600, height: 1067 });
    expect(h.saved[0]!.r2Key).toMatch(/^renditions\/.+\/premium_preview\/[a-f0-9]{64}\.jpg$/);
  });

  it("writes both Delivery keys when both are asked for in one message", async () => {
    const h = harness(); web(h);
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(jpeg(2048, 1365), { headers: transformOk })) as typeof fetch }, ["delivery_web", "premium_preview"]);
    expect(result.generated).toEqual(["delivery_web", "premium_preview"]);
    expect(h.saved.map((row) => row.variant).sort()).toEqual(["delivery_web", "premium_preview"]);
    expect(new Set(h.saved.map((row) => row.r2Key)).size).toBe(2);
  });

  const webFetcher = (requests: string[]) => (async (url: string) => { requests.push(url); return new Response(tinyWebp, { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } }); }) as typeof fetch;

  it("makes the missing web rendition first, in the same invocation, then draws the preview over it", async () => {
    const h = harness(); const requests: string[] = [];
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: webFetcher(requests) }, ["premium_preview"]);
    expect(result).toEqual({ generated: ["web", "premium_preview"], skipped: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/format=webp/);
    expect(h.saved.map((row) => row.variant)).toEqual(["web", "premium_preview"]);
    const webRow = h.saved[0]!;
    expect(webRow).toMatchObject({ specVersion: RENDITION_VARIANT_SPEC.web, contentType: "image/webp" });
    expect(h.objects.has(webRow.r2Key)).toBe(true);
    expect(h.objects.has(h.saved[1]!.r2Key)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.map((call) => call.op)).toEqual(["input", "transform", "input", "draw", "output"]);
    expect(h.inputs[0]!.bytes).toEqual(tinyWebp);
  });

  it("regenerates a stale-spec web rendition first, then draws over the fresh one", async () => {
    const h = harness();
    h.stored.push({ variant: "web", r2Key: "renditions/old-web.webp", specVersion: "v0" });
    h.objects.set("renditions/old-web.webp", { body: new Uint8Array([1, 2, 3]), size: 3 });
    const requests: string[] = [];
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: webFetcher(requests) }, ["premium_preview"]);
    expect(result.generated).toEqual(["web", "premium_preview"]);
    expect(requests).toHaveLength(1);
    expect(h.saved[0]!.r2Key).not.toBe("renditions/old-web.webp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.inputs[0]!.bytes).toEqual(tinyWebp);
  });

  it("does not remake a current web rendition, and does not report it", async () => {
    const h = harness(); web(h);
    const result = await generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("no fetch"); }) as typeof fetch }, ["premium_preview"]);
    expect(result).toEqual({ generated: ["premium_preview"], skipped: [] });
  });

  it("writes nothing for the preview when the freshly made web is invalid", async () => {
    const h = harness();
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch }, ["premium_preview"])).rejects.toThrow(/Invalid WebP/);
    expect(h.saved).toEqual([]); expect(h.calls).toEqual([]);
  });

  it("refuses a web rendition over the 20 MB Images input cap", async () => {
    const h = harness(); web(h); h.state.webSize = 20 * 1024 * 1024 + 1;
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("no fetch"); }) as typeof fetch }, ["premium_preview"])).rejects.toThrow(/20 MB/);
    expect(h.saved).toEqual([]);
  });

  it("refuses an Images output that is not a JPEG within 1600 px", async () => {
    const h = harness(); web(h); h.state.imagesOutput = jpeg(3200, 2000);
    await expect(generateRenditions(h.env as never, asset.id, { store: h.store, fetch: (async () => { throw new Error("no fetch"); }) as typeof fetch }, ["premium_preview"])).rejects.toThrow(/Invalid JPEG/);
    expect(h.saved).toEqual([]); expect(h.objects.size).toBe(1);
  });
});

describe("generate_renditions message", () => {
  const legacy = { type: "generate_renditions", assetId: "a-1" };
  it("parses a message without variants exactly as before (replay and DLQ unchanged)", () => {
    for (const queue of [RENDITION_QUEUE_NAME, RENDITION_DLQ_QUEUE_NAME]) expect(parseQueueBody(queue, legacy)).toEqual({ queue, body: legacy });
  });
  it("carries a valid variants list through and rejects an unknown or malformed one", () => {
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { ...legacy, variants: ["delivery_web", "premium_preview"] })).toEqual({ queue: RENDITION_QUEUE_NAME, body: { ...legacy, variants: ["delivery_web", "premium_preview"] } });
    for (const variants of [["huge"], "web", [], [1], ["web", "web"]]) expect(parseQueueBody(RENDITION_QUEUE_NAME, { ...legacy, variants }), JSON.stringify(variants)).toBeNull();
  });
});

describe("delivery_web CRC-32 (#787 slice 7)", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  beforeAll(async () => {
    for (const chunk of __PORTAL_MIGRATION_SQL__.split("--> statement-breakpoint")) {
      const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
      for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await (env as unknown as { DB: D1Database }).DB.exec(`${flat};`); }
    }
  });
  beforeAll(async () => {
    const now = Date.now();
    await (env as unknown as { DB: D1Database }).DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('d3333333-3333-4333-8333-333333333333', 'Transform Editor', 'transform-editor@example.test', 1, 'editor', 1, ?, ?)").bind(now, now).run();
  });
  beforeEach(async () => { await (env as unknown as { DB: D1Database }).DB.prepare("DELETE FROM object_crc32").run(); consoleError.mockClear(); });
  const DB = () => (env as unknown as { DB: D1Database }).DB;
  /** The harness with a real D1 and an R2 fake that reports an etag, as the real bucket does. */
  function withCrc(options: { db?: unknown; preexisting?: boolean } = {}) {
    const h = harness(); const etags = new Map<string, string>();
    const base = h.env.MEDIA;
    const media = {
      ...base,
      head: async (key: string) => (h.objects.has(key) ? { etag: etags.get(key) ?? "adopted-etag" } : null),
      put: async (key: string, body: Uint8Array, opts?: unknown) => { await base.put(key, body, opts as never); etags.set(key, `etag-of-${key.slice(-12)}`); return { etag: etags.get(key)! }; },
    };
    const env2 = { get APP_ORIGIN() { return h.env.APP_ORIGIN; }, get TRANSFORM_SOURCE_SECRET() { return h.env.TRANSFORM_SOURCE_SECRET; }, MEDIA: media, DB: options.db ?? DB() };
    return { h, env: env2, etags };
  }
  const run = (e: unknown, h: ReturnType<typeof harness>, body = jpeg(2048, 1365)) => generateRenditions(e as never, asset.id, { store: h.store, fetch: (async () => new Response(body, { headers: transformOk })) as typeof fetch }, ["delivery_web"]);
  const row = (key: string) => DB().prepare("SELECT crc32, bytes, etag FROM object_crc32 WHERE r2_key = ?").bind(key).first<{ crc32: number; bytes: number; etag: string }>();

  it("records the CRC-32, length and R2 etag of the object it wrote", async () => {
    const { h, env: e, etags } = withCrc(); const body = jpeg(2048, 1365);
    await run(e, h, body);
    const key = h.saved[0]!.r2Key;
    expect(await row(key)).toEqual({ crc32: crc32(Buffer.from(body)), bytes: body.byteLength, etag: etags.get(key) });
  });
  it("records an adopted object (an earlier attempt wrote it) with the etag R2 reports", async () => {
    const { h, env: e, etags } = withCrc(); const body = jpeg(2048, 1365);
    await run(e, h, body); const key = h.saved[0]!.r2Key; await DB().prepare("DELETE FROM object_crc32").run(); h.saved.length = 0; etags.delete(key);
    await run(e, h, body);
    expect(h.puts).toHaveLength(1);
    expect(await row(key)).toEqual({ crc32: crc32(Buffer.from(body)), bytes: body.byteLength, etag: "adopted-etag" });
  });
  it("replaces a stale row for the same key", async () => {
    const { h, env: e, etags } = withCrc(); const body = jpeg(2048, 1365);
    await run(e, h, body); const key = h.saved[0]!.r2Key;
    await DB().prepare("UPDATE object_crc32 SET crc32 = 1, bytes = 1, etag = 'old' WHERE r2_key = ?").bind(key).run();
    h.objects.delete(key); h.saved.length = 0; await run(e, h, body);
    expect(await row(key)).toMatchObject({ crc32: crc32(Buffer.from(body)), etag: etags.get(key) });
  });
  it("a failing CRC write keeps the rendition and logs", async () => {
    // Only the CRC upsert fails; the transform principal is still read from the real D1.
    const failing = { prepare: (sql: string) => (sql.includes("object_crc32") ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : DB().prepare(sql)) };
    const { h, env: e } = withCrc({ db: failing });
    expect(await run(e, h)).toEqual({ generated: ["delivery_web"], skipped: [] });
    expect(h.saved).toHaveLength(1); expect(consoleError).toHaveBeenCalled();
  });
  it("records nothing for another variant, and skips quietly with no DB binding or no etag", async () => {
    const { h, env: e } = withCrc();
    await generateRenditions(e as never, asset.id, { store: h.store, fetch: (async () => new Response(tinyWebp, { headers: { "content-type": "image/webp", "cf-resized": "internal=ok" } })) as typeof fetch }, ["thumb"]).catch(() => undefined);
    expect((await DB().prepare("SELECT COUNT(*) AS n FROM object_crc32").first<{ n: number }>())!.n).toBe(0);
    const plain = harness(); await run(plain.env, plain);
    expect(plain.saved).toHaveLength(1);
    expect((await DB().prepare("SELECT COUNT(*) AS n FROM object_crc32").first<{ n: number }>())!.n).toBe(0);
  });
});
