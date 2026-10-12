import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { Hono } from "hono";
import { DELIVERY_ZIP_MAX_BYTES, DELIVERY_ZIP_MAX_PHOTOS, RENDITION_VARIANT_SPEC, deliveryZipManifestSchema } from "@quincy/shared";
import type { AppEnv } from "../src/env";
import { mountDeliveryZips, deliveryZipTestHooks } from "../src/delivery/zips";
import { NATIVE_ZIP_FLAG } from "../src/lib/object-crc";
import { baseEnv, database, ids, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { clearGuestRows, guestFetch, HYGIENE } from "./guest-support";
import { seedVideoVersion } from "./video-review-support";
import { drain, parseZip } from "./zip-parse-support";

/**
 * The photo zips of the public Client Delivery page (#787 slice 7): manifest, prepare and photos.zip. See docs/plans/787-7.md. Native writer only, public labels as names, locks settled in D1 before R2,
 * every entry re-authorised, a miss is the byte-identical /d stub.
 */
const SLUG = "12-test-street-bcdfgh";
const SECRET_NAME = "SECRET-CLIENT-NAME.jpg";
const text = (value: string) => new TextEncoder().encode(value);
const path = (rest: string, slug = SLUG) => `/d/api/pages/${slug}/zips/${rest}`;
const manifestPath = (size = "web") => path(size); const preparePath = (size = "web") => path(`${size}/prepare`); const zipPath = (size = "web") => path(`${size}/photos.zip`);
const snapshot = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });
const expectStub = async (response: Response) => expect(await snapshot(response)).toEqual(await snapshot(await guestFetch("/d")));
const count = async (sql: string) => (await database.DB.prepare(sql).first<{ n: number }>())!.n;
const audits = () => count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'delivery.download_all'");
const quota = (kind: string) => count(`SELECT COALESCE(SUM(count), 0) AS n FROM guest_rate_limits WHERE bucket LIKE '${kind}:%'`);
const workRows = () => count("SELECT COUNT(*) AS n FROM object_crc32_work");
const flag = (on: boolean) => database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(NATIVE_ZIP_FLAG, on ? 1 : 0, Date.now()).run();

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([database.DB.prepare("DELETE FROM asset_renditions"), database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE '%delivery-test%' OR kind = 'video'"), database.DB.prepare("DELETE FROM object_crc32"), database.DB.prepare("DELETE FROM object_crc32_work"),
    database.DB.prepare("DELETE FROM guest_rate_limits"), database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(NATIVE_ZIP_FLAG)]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); await flag(true); deliveryZipTestHooks.beforeStream = undefined; });
afterEach(async () => { deliveryZipTestHooks.beforeStream = undefined; await wipe(); await clearDeliveryFlags(); });

/** Stores the CRC row for a real object, so the gate finds it ready. */
async function crcReady(key: string) {
  const object = (await database.MEDIA.get(key))!; const data = new Uint8Array(await object.arrayBuffer());
  await database.DB.prepare("INSERT OR REPLACE INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, ?, ?, ?, ?)").bind(key, crc32(data), data.length, object.etag, Date.now()).run();
}
type PhotoInput = { premium?: boolean; unlocked?: boolean; web?: boolean; crc?: boolean; original?: Uint8Array; superseded?: boolean };
let serial = 0;
async function photo(input: PhotoInput = {}) {
  serial += 1;
  const asset = await seedAsset("photo", { deliveryPremium: input.premium, superseded: input.superseded });
  const original = input.original ?? text(`ORIGINAL-FULL-RES-${serial}`);
  await database.MEDIA.put(`projects/${asset.projectId}/delivery-test/${asset.id}`, original, { httpMetadata: { contentType: "image/jpeg" } });
  await database.DB.prepare("UPDATE assets SET original_filename = ?, bytes = ? WHERE id = ?").bind(SECRET_NAME, original.length, asset.id).run();
  const webBytes = text(`WEB-SIZE-JPEG-${serial}`); const webKey = `renditions/${asset.id}/delivery_web`;
  if (input.web !== false) {
    await database.MEDIA.put(webKey, webBytes, { httpMetadata: { contentType: "image/jpeg" } });
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, 'delivery_web', ?, ?, 'image/jpeg', 1, 1, ?, ?)")
      .bind(crypto.randomUUID(), asset.id, webKey, webBytes.length, RENDITION_VARIANT_SPEC.delivery_web, Date.now()).run();
  }
  if (input.crc !== false) { await crcReady(`projects/${asset.projectId}/delivery-test/${asset.id}`); if (input.web !== false) await crcReady(webKey); }
  if (input.unlocked) await seedUnlock(asset.id);
  return { ...asset, original, webBytes, webKey, originalKey: `projects/${asset.projectId}/delivery-test/${asset.id}` };
}
async function page(...assets: Array<{ id: string }>) { await seedPage({ slug: SLUG, assetIds: assets.map((asset) => asset.id) }); }
const unzip = async (response: Response) => { expect(response.status, await response.clone().text()).toBe(200); const archive = new Uint8Array(await response.arrayBuffer()); expect(Number(response.headers.get("content-length"))).toBe(archive.length); return new Map(parseZip(archive).entries.map((entry) => [entry.name, entry.data])); };
const asText = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const get = (url: string, init: { method?: string; headers?: Record<string, string>; ip?: string } = {}) => guestFetch(url, init);
const post = (url: string, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(url, { method: "POST", body: {}, ...init });

/** The zip routes alone, with extra bindings (a rendition queue) the pool's Worker does not carry. */
function localApp(extra: Record<string, unknown> = {}) {
  const app = new Hono<AppEnv>(); mountDeliveryZips(app);
  return (url: string, init: RequestInit = {}) => app.fetch(new Request(`https://portal.test${url}`, init), { ...baseEnv, DB: database.DB, MEDIA: database.MEDIA, ...extra } as never, { waitUntil() {}, passThroughOnException() {} } as never);
}
const jsonPost = (body: unknown = {}) => ({ method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) });

describe("photos.zip bytes", () => {
  it("Web-size streams each current derivative under its public label, with an exact length, hygiene headers and a clean archive name", async () => {
    const a = await photo(); const b = await photo(); await page(a, b);
    const response = await get(zipPath("web"));
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="12-test-street-photos-web-size\.zip"/);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const files = await unzip(response);
    expect([...files.keys()]).toEqual(["Photo 01.jpg", "Photo 02.jpg"]);
    expect(files.get("Photo 01.jpg")).toEqual(a.webBytes); expect(files.get("Photo 02.jpg")).toEqual(b.webBytes);
    expect(await audits()).toBe(1);
  });
  it("Full-res streams the originals, never the derivative", async () => {
    const a = await photo(); const b = await photo(); await page(a, b);
    const response = await get(zipPath("full"));
    expect(response.headers.get("content-disposition")).toContain("12-test-street-photos-full-res.zip");
    const files = await unzip(response);
    expect([...files.keys()]).toEqual(["Photo 01.jpg", "Photo 02.jpg"]);
    expect(files.get("Photo 01.jpg")).toEqual(a.original); expect(files.get("Photo 02.jpg")).toEqual(b.original);
  });
  it("includes a superseded member of the current set and leaves out videos and PDFs", async () => {
    const old = await photo({ superseded: true }); const kept = await photo(); const pdf = await seedAsset("floorplan_pdf"); const copy = await seedAsset("copy_pdf"); const video = await seedVideoVersion();
    await page(old, pdf, kept, copy, { id: video.assetId });
    const files = await unzip(await get(zipPath("full")));
    expect([...files.keys()]).toEqual(["Photo 01.jpg", "Photo 02.jpg"]);
    const manifest = deliveryZipManifestSchema.parse(await (await get(manifestPath("full"))).json());
    expect(manifest.photos).toBe(2);
  });
  it("uses only the page's current set", async () => {
    const oldOnly = await photo(); const kept = await photo();
    await seedPage({ slug: SLUG, assetIds: [kept.id], olderSets: [[oldOnly.id]] });
    expect([...(await unzip(await get(zipPath("web")))).keys()]).toEqual(["Photo 01.jpg"]);
  });
});

describe("locked and premium photos", () => {
  it("leaves a locked photo out, lists it by public label in Left out.txt, and keeps the numbering stable", async () => {
    const a = await photo(); const locked = await photo({ premium: true }); const c = await photo(); await page(a, locked, c);
    const files = await unzip(await get(zipPath("web")));
    expect([...files.keys()]).toEqual(["Photo 01.jpg", "Photo 03.jpg", "Left out.txt"]);
    expect(asText(files.get("Left out.txt"))).toBe("These photos are not in this download.\r\n\r\n- Photo 02: premium photo, not unlocked yet\r\n");
    expect([...files.values()].some((bytes) => asText(bytes).includes(asText(locked.webBytes)))).toBe(false);
  });
  it("includes an unlocked premium photo, with no notice", async () => {
    const a = await photo({ premium: true, unlocked: true }); const b = await photo(); await page(a, b);
    const files = await unzip(await get(zipPath("web")));
    expect([...files.keys()]).toEqual(["Photo 01.jpg", "Photo 02.jpg"]);
  });
  it("answers nothing_to_download when every photo is locked, and the manifest lists them all", async () => {
    const a = await photo({ premium: true }); await page(a);
    const response = await get(zipPath("web")); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "nothing_to_download" });
    const manifest = deliveryZipManifestSchema.parse(await (await get(manifestPath())).json());
    expect(manifest).toMatchObject({ photos: 0, totalBytes: 0, leftOut: [{ label: "Photo 01", reason: "premium_locked" }] });
    expect(await audits()).toBe(0);
  });
});

describe("misses are the stub and touch nothing", () => {
  it("unknown, off, gate shut, a bad size and stray segments answer the byte-identical /d stub on every route", async () => {
    const a = await photo(); await page(a);
    const requests = (slug: string, size: string) => [get(path(size, slug)), get(path(`${size}/photos.zip`, slug)), post(path(`${size}/prepare`, slug))];
    for (const [slug, size] of [["unknown-page-bcdfgh", "web"], [SLUG, "huge"], [SLUG, "web/"], [SLUG, "WEB"]] as const) for (const response of await Promise.all(requests(slug, size))) await expectStub(response);
    await expectStub(await get(`${manifestPath()}/extra`)); await expectStub(await get(`${zipPath()}/x`));
    await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run();
    for (const response of await Promise.all(requests(SLUG, "web"))) await expectStub(response);
    await database.DB.prepare("UPDATE delivery_pages SET enabled = 1").run(); await clearDeliveryFlags();
    for (const response of await Promise.all(requests(SLUG, "web"))) await expectStub(response);
    expect(await audits()).toBe(0); expect(await workRows()).toBe(0); expect(await count("SELECT COUNT(*) AS n FROM guest_rate_limits")).toBe(0);
  });
});

describe("caps are checked from D1 before any R2 call", () => {
  /** Inserts `n` photo assets and a page holding them, without any R2 object: a route that touched R2 would answer 502, not 422. */
  async function bulk(n: number, bytes = 10) {
    const collectionId = (await seedAsset("photo")).collectionId; const projectId = ids.project; const now = Date.now(); const assetIds: string[] = [];
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < n; index += 1) {
      const id = crypto.randomUUID(); assetIds.push(id);
      statements.push(database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'x.jpg', ?, 'upload', 1, 'ready', ?, ?)").bind(id, collectionId, `projects/${projectId}/delivery-test/bulk-${id}`, bytes, now, now));
    }
    for (let at = 0; at < statements.length; at += 50) await database.DB.batch(statements.slice(at, at + 50));
    await seedPage({ slug: SLUG, assetIds });
    return assetIds;
  }
  it("301 photos is 422 zip_too_large on the zip and prepare, and the manifest says tooLarge, with no R2 read, work or audit", async () => {
    await bulk(DELIVERY_ZIP_MAX_PHOTOS + 1);
    const zip = await get(zipPath("full")); expect(zip.status).toBe(422); expect(await zip.json()).toEqual({ error: "zip_too_large", maxPhotos: 300, maxBytes: DELIVERY_ZIP_MAX_BYTES });
    const prepared = await post(preparePath("full")); expect(prepared.status).toBe(422);
    const manifest = deliveryZipManifestSchema.parse(await (await get(manifestPath("full"))).json());
    expect(manifest).toMatchObject({ photos: 301, tooLarge: true, archive: { state: "too_large", pending: 0 } });
    expect(await audits()).toBe(0); expect(await workRows()).toBe(0); expect(await quota("dlcheck")).toBe(0);
  }, 60_000);
  it("exactly 300 photos passes the cap (it then fails on the missing objects, not on size)", async () => {
    await bulk(DELIVERY_ZIP_MAX_PHOTOS);
    const response = await get(zipPath("full")); expect(response.status).toBe(502);
  }, 60_000);
  it("over 8 GiB of originals is 422 and exactly 8 GiB is not", async () => {
    const ids8 = await bulk(2, 1);
    await database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind(DELIVERY_ZIP_MAX_BYTES / 2 + 1, ids8[0]).run();
    await database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind(DELIVERY_ZIP_MAX_BYTES / 2, ids8[1]).run();
    expect((await get(zipPath("full"))).status).toBe(422);
    await database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind(DELIVERY_ZIP_MAX_BYTES / 2, ids8[0]).run();
    expect((await get(zipPath("full"))).status).toBe(502);
  });
});

describe("readiness", () => {
  it("a missing CRC on a small set is 409 download_preparing, queues the work, and spends no start and writes no audit", async () => {
    const a = await photo({ crc: false }); await page(a);
    const response = await get(zipPath("full"));
    expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ error: "download_preparing", pending: 1, retryAfterSeconds: 30 });
    expect(await workRows()).toBe(1); expect(await audits()).toBe(0); expect(await quota("dlzip")).toBe(0);
  });
  it("a missing Web-size derivative is preparing, never the original", async () => {
    const a = await photo({ web: false }); const b = await photo(); await page(a, b);
    const response = await get(zipPath("web"));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "download_preparing", pending: 1, retryAfterSeconds: 30 });
    expect(await audits()).toBe(0);
    // Full-res does not need the derivative.
    expect([...(await unzip(await get(zipPath("full")))).keys()]).toEqual(["Photo 01.jpg", "Photo 02.jpg"]);
  });
  it("a stale-spec derivative counts as missing", async () => {
    const a = await photo(); await page(a);
    await database.DB.prepare("UPDATE asset_renditions SET spec_version = 'old' WHERE asset_id = ?").bind(a.id).run();
    expect((await get(zipPath("web"))).status).toBe(409);
  });
  it("a Web-size R2 object that is gone while its current row survives is preparing, and prepare asks for it again", async () => {
    const a = await photo(); await page(a); await database.MEDIA.delete(a.webKey);
    const response = await get(zipPath("web")); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "download_preparing", pending: 1 });
    expect(deliveryZipManifestSchema.parse(await (await get(manifestPath("web"))).json()).archive).toMatchObject({ state: "preparing", pending: 1 });
    const sent: unknown[] = []; const queue = { send: async (message: unknown) => { sent.push(message); } };
    const prepared = await localApp({ RENDITIONS_ENABLED: true, RENDITION_QUEUE: queue })(preparePath("web"), jsonPost());
    expect(await prepared.json()).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(sent).toEqual([{ type: "generate_renditions", assetId: a.id, variants: ["delivery_web"] }]);
    expect(await audits()).toBe(0);
    // Full-res does not depend on the derivative.
    expect((await get(zipPath("full"))).status).toBe(200);
  });
  it("native_zip off with every Web-size derivative missing is still 502 download_unavailable, on the zip, prepare and manifest", async () => {
    const a = await photo({ web: false }); await page(a); await flag(false);
    const response = await get(zipPath("web")); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "download_unavailable" });
    expect(deliveryZipManifestSchema.parse(await (await get(manifestPath("web"))).json()).archive.state).toBe("unavailable");
    expect(await (await post(preparePath("web"))).json()).toEqual({ state: "unavailable", pending: 0 });
  });
  it("native_zip off is 502 download_unavailable, with no audit", async () => {
    const a = await photo(); await page(a); await flag(false);
    const response = await get(zipPath("web")); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "download_unavailable" });
    expect(await audits()).toBe(0); expect(await workRows()).toBe(0);
    expect(deliveryZipManifestSchema.parse(await (await get(manifestPath())).json()).archive.state).toBe("unavailable");
  });
  it("a missing or resized object is 502 download_unavailable", async () => {
    const a = await photo(); await page(a);
    await database.MEDIA.delete(a.originalKey); expect((await get(zipPath("full"))).status).toBe(502);
    await database.MEDIA.put(a.originalKey, text("changed size!!")); expect((await get(zipPath("full"))).status).toBe(502);
    expect(await audits()).toBe(0);
  });
  it("a failed CRC job is 502, not an endless preparing", async () => {
    const a = await photo({ crc: false }); await page(a);
    await database.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?, 'failed', 3, ?, ?)").bind(a.originalKey, Date.now(), Date.now()).run();
    expect((await get(zipPath("full"))).status).toBe(502);
  });
});

describe("manifest", () => {
  it("is strict, read-only and reports ready, then preparing with a missing CRC", async () => {
    const a = await photo(); const locked = await photo({ premium: true }); await page(a, locked);
    const ready = deliveryZipManifestSchema.parse(await (await get(manifestPath("web"))).json());
    expect(ready).toEqual({ size: "web", setNumber: 1, photos: 1, totalBytes: a.webBytes.length, tooLarge: false, leftOut: [{ label: "Photo 02", reason: "premium_locked" }], archive: { state: "ready", pending: 0 } });
    const full = deliveryZipManifestSchema.parse(await (await get(manifestPath("full"))).json()); expect(full.totalBytes).toBe(a.original.length);
    await database.DB.prepare("DELETE FROM object_crc32").run();
    const preparing = deliveryZipManifestSchema.parse(await (await get(manifestPath("web"))).json());
    expect(preparing.archive).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(await workRows()).toBe(0); expect(await audits()).toBe(0); expect(await quota("dlzip")).toBe(0);
  });
  it("reports preparing for a missing derivative without queueing anything", async () => {
    const a = await photo({ web: false }); await page(a);
    expect(deliveryZipManifestSchema.parse(await (await get(manifestPath("web"))).json()).archive).toMatchObject({ state: "preparing", pending: 1 });
    expect(await workRows()).toBe(0);
  });
});

describe("prepare", () => {
  it("queues the missing CRC-32s even for a small set, and says preparing, then ready once they are there", async () => {
    const a = await photo({ crc: false }); await page(a);
    const response = await post(preparePath("full")); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(await workRows()).toBe(1); expect(await audits()).toBe(0); expect(await quota("dlzip")).toBe(0);
    await crcReady(a.originalKey);
    expect(await (await post(preparePath("full"))).json()).toEqual({ state: "ready", pending: 0 });
  });
  it("re-enqueues a missing Web-size derivative, and only that", async () => {
    const a = await photo({ web: false }); const b = await photo(); await page(a, b);
    const sent: unknown[] = []; const queue = { send: async (message: unknown) => { sent.push(message); } };
    const response = await localApp({ RENDITIONS_ENABLED: true, RENDITION_QUEUE: queue })(preparePath("web"), jsonPost());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(sent).toEqual([{ type: "generate_renditions", assetId: a.id, variants: ["delivery_web"] }]);
  });
  it("takes exactly {}: another body is 400, over 1 KiB is 413, a foreign Origin or a non-JSON type is 403", async () => {
    const a = await photo(); await page(a);
    expect((await post(preparePath(), { body: { name: "x" } })).status).toBe(400);
    expect((await post(preparePath(), { body: "not json" })).status).toBe(400);
    expect((await post(preparePath(), { body: JSON.stringify({ pad: "x".repeat(2000) }) })).status).toBe(413);
    expect((await post(preparePath(), { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(preparePath(), { contentType: "text/plain" })).status).toBe(403);
    expect((await post(preparePath())).status).toBe(200);
  });
  it("answers the stub before it looks at the Origin or the body", async () => {
    await expectStub(await post(preparePath(), { origin: "https://evil.test", body: "garbage" }));
  });
  it("answers nothing_to_download when nothing is left in", async () => {
    const a = await photo({ premium: true }); await page(a);
    const response = await post(preparePath()); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "nothing_to_download" });
  });
});

describe("methods", () => {
  it("HEAD is 405 and any Range is 416 on the zip, after the page is admitted, with no side effects", async () => {
    const a = await photo({ crc: false }); await page(a);
    const head = await get(zipPath("full"), { method: "HEAD" }); expect(head.status).toBe(405);
    const ranged = await get(zipPath("full"), { headers: { range: "bytes=0-" } }); expect(ranged.status).toBe(416);
    expect(await ranged.json()).toEqual({ error: "range_not_satisfiable" });
    expect(await workRows()).toBe(0); expect(await audits()).toBe(0); expect(await count("SELECT COUNT(*) AS n FROM guest_rate_limits")).toBe(0);
    expect(await snapshot(await get(path("full/photos.zip", "unknown-page-bcdfgh"), { method: "HEAD" }))).toEqual(await snapshot(await get("/d", { method: "HEAD" })));
  });
});

describe("quotas", () => {
  it("allows 10 starts per address in 15 minutes and refuses the 11th with 429 and Retry-After; preparing never spends one", async () => {
    const a = await photo(); await page(a); const ip = "203.0.113.9";
    for (let index = 0; index < 10; index += 1) { const ok = await get(zipPath("web"), { ip }); expect(ok.status, `start ${index + 1}`).toBe(200); await ok.arrayBuffer(); }
    const limited = await get(zipPath("web"), { ip }); expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "too_many_attempts" });
    expect(await audits()).toBe(10);
    // A different address still starts (the page bucket holds 60).
    const other = await get(zipPath("web"), { ip: "203.0.113.10" }); expect(other.status).toBe(200); await other.arrayBuffer();
  });
  it("a start refused by the address limit does not charge the page bucket (both or neither)", async () => {
    const a = await photo(); await page(a); const ip = "203.0.113.40";
    for (let index = 0; index < 10; index += 1) await (await get(zipPath("web"), { ip })).arrayBuffer();
    for (let index = 0; index < 5; index += 1) expect((await get(zipPath("web"), { ip })).status).toBe(429);
    const pageBucket = await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(`dlzip:page:${ids.project}`).first<{ count: number }>();
    expect(pageBucket?.count).toBe(10);
  });
  it("a full page bucket does not charge the address bucket", async () => {
    const a = await photo(); await page(a); const ip = "203.0.113.41";
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 60)").bind(`dlzip:page:${ids.project}`, Math.floor(Date.now() / 900_000) * 900_000).run();
    expect((await get(zipPath("web"), { ip })).status).toBe(429);
    expect(await count("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'dlzip:ip:%'")).toBe(0);
  });
  it("a preparing answer and a refusal cost no start", async () => {
    const a = await photo({ crc: false }); await page(a);
    for (let index = 0; index < 3; index += 1) expect((await get(zipPath("full"))).status).toBe(409);
    expect(await quota("dlzip")).toBe(0);
  });
  it("refuses the 61st check from one address and the 301st on one page", async () => {
    const a = await photo(); await page(a); const ip = "203.0.113.20";
    for (let index = 0; index < 60; index += 1) expect((await get(manifestPath(), { ip })).status, `check ${index + 1}`).toBe(200);
    expect((await get(manifestPath(), { ip })).status).toBe(429);
    await database.DB.prepare("DELETE FROM guest_rate_limits").run();
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 300)").bind(`dlcheck:page:${ids.project}`, Math.floor(Date.now() / 900_000) * 900_000).run();
    expect((await get(manifestPath())).status).toBe(429);
  });
  it("charges checks even when every Web-size derivative is missing, so polling a preparing page is still limited", async () => {
    const a = await photo({ web: false }); await page(a); const ip = "203.0.113.21";
    for (let index = 0; index < 60; index += 1) expect((await get(manifestPath("web"), { ip })).status, `check ${index + 1}`).toBe(200);
    expect((await get(manifestPath("web"), { ip })).status).toBe(429);
    await database.DB.prepare("DELETE FROM guest_rate_limits").run();
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 300)").bind(`dlcheck:page:${ids.project}`, Math.floor(Date.now() / 900_000) * 900_000).run();
    expect((await get(zipPath("web"))).status).toBe(429);
  });
  it("refuses the 21st prepare from one address and the 121st on one page", async () => {
    const a = await photo(); await page(a); const ip = "203.0.113.30";
    for (let index = 0; index < 20; index += 1) expect((await post(preparePath(), { ip })).status, `prepare ${index + 1}`).toBe(200);
    expect((await post(preparePath(), { ip })).status).toBe(429);
    await database.DB.prepare("DELETE FROM guest_rate_limits").run();
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 120)").bind(`dlprep:page:${ids.project}`, Math.floor(Date.now() / 900_000) * 900_000).run();
    expect((await post(preparePath())).status).toBe(429);
  });
  it("refuses a start when the page bucket is full (60)", async () => {
    const a = await photo(); await page(a);
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 60)").bind(`dlzip:page:${ids.project}`, Math.floor(Date.now() / 900_000) * 900_000).run();
    expect((await get(zipPath("web"))).status).toBe(429); expect(await audits()).toBe(0);
  });
});

describe("audit", () => {
  it("writes one fenced row per start: actor NULL, the size, the set, the count and the bytes, and no address, id or key", async () => {
    const a = await photo(); const b = await photo({ premium: true }); await page(a, b);
    await unzip(await get(zipPath("web")));
    const rows = (await database.DB.prepare("SELECT actor_id, target_type, target_id, meta_json FROM audit_log WHERE action = 'delivery.download_all'").all<{ actor_id: string | null; target_type: string; target_id: string; meta_json: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: null, target_type: "project", target_id: ids.project });
    expect(JSON.parse(rows[0]!.meta_json)).toEqual({ via: "public_delivery", size: "web", setNumber: 1, count: 1, totalBytes: a.webBytes.length });
  });
  it("is the stub, with no audit, when the page is switched off between the gate and the start", async () => {
    const a = await photo(); await page(a);
    deliveryZipTestHooks.beforeStream = async () => { await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run(); };
    await expectStub(await get(zipPath("web"))); expect(await audits()).toBe(0); expect(await quota("dlzip")).toBe(0);
  });
  it("is the stub when a newer set is published between the gate and the start", async () => {
    const a = await photo(); await page(a);
    deliveryZipTestHooks.beforeStream = async () => {
      await database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, crypto.randomUUID().slice(0, 32), ids.admin, Date.now()).run();
      await database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2").run();
    };
    await expectStub(await get(zipPath("web"))); expect(await audits()).toBe(0);
  });
});

describe("re-authorisation mid-stream", () => {
  /** Two photos, the first large enough that the zip cannot have run ahead to the second entry's check when the first chunk arrives. */
  async function twoEntries() {
    const big = new Uint8Array(6 * 1024 * 1024); big.fill(7);
    const first = await photo({ original: big }); const second = await photo(); await page(first, second);
    return { first, second };
  }
  const readUntilFirstChunk = async (response: Response) => { const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); return reader; };
  const finish = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<"complete" | "aborted"> => { try { for (;;) { const { done } = await reader.read(); if (done) return "complete"; } } catch { return "aborted"; } };
  it("completes when nothing changes", async () => {
    await twoEntries(); const response = await get(zipPath("full")); expect(response.status).toBe(200);
    expect(await finish(await readUntilFirstChunk(response))).toBe("complete");
  });
  for (const [name, change] of [
    ["a photo relocked", (c: { second: { id: string } }) => database.DB.prepare("UPDATE assets SET delivery_premium = 1 WHERE id = ?").bind(c.second.id).run()],
    ["the page switched off", () => database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run()],
    ["the Client Delivery gate shut", () => clearDeliveryFlags()],
    ["a newer set published", async () => {
      await database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, crypto.randomUUID().slice(0, 32), ids.admin, Date.now()).run();
      await database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2").run();
    }],
  ] as const) {
    it(`aborts the stream after ${name} between entries`, async () => {
      const context = await twoEntries(); const response = await get(zipPath("full")); expect(response.status).toBe(200);
      const reader = await readUntilFirstChunk(response);
      await (change as (c: typeof context) => Promise<unknown>)(context);
      expect(await finish(reader)).toBe("aborted");
    });
  }
});

describe("nothing identifying leaves", () => {
  it("the manifest, the headers, the entry names and the notice carry no id, key, handle or stored filename", async () => {
    const a = await photo(); const locked = await photo({ premium: true }); await page(a, locked);
    const handles = (await database.DB.prepare("SELECT handle FROM delivery_set_items").all<{ handle: string }>()).results.map((row) => row.handle);
    const forbidden = [a.id, locked.id, a.originalKey, a.webKey, SECRET_NAME, "SECRET-CLIENT", ids.project, ...handles];
    const responses = [await get(manifestPath("web")), await post(preparePath("web")), await get(zipPath("web"))];
    const seen: string[] = [];
    for (const response of responses) {
      seen.push(JSON.stringify([...response.headers]));
      if (response.headers.get("content-type") === "application/zip") { const files = parseZip(new Uint8Array(await response.arrayBuffer())); seen.push(files.entries.map((entry) => entry.name).join("|")); seen.push(asText(files.entries.find((entry) => entry.name === "Left out.txt")?.data)); }
      else seen.push(await response.text());
    }
    for (const value of forbidden) for (const chunk of seen) expect(chunk, value).not.toContain(value);
    const { errored } = await drain(await get(zipPath("web"))); expect(errored).toBe(false);
  });
});
