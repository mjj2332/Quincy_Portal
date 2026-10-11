import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { crc32 } from "node:zlib";
import app from "../src/index";
import { NATIVE_ZIP_FLAG, ZIP_LEGACY_MAX_BYTES } from "../src/lib/object-crc";
import { baseEnv, cookie, database, ids, seedFixture } from "./embedded-media-support";
import { ensureCollection } from "./video-review-support";
import { parseZip } from "./zip-parse-support";

/** The staff zip routes behind the `native_zip` flag (#802): selected RAW, and the download-selection ticket. Every hybrid branch, and what each one writes. */
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
const BIG = ZIP_LEGACY_MAX_BYTES + 1;
const enc = new TextEncoder();
type Queue = { sent: unknown[]; sendBatch: (messages: Array<{ body: unknown }>) => Promise<void> };
const fakeQueue = (): Queue => { const sent: unknown[] = []; return { sent, sendBatch: async (messages) => { for (const message of messages) sent.push(message.body); } }; };

/** R2 with HEAD answers overridden for the keys in `heads`, so a "300 MiB" object needs no 300 MiB of bytes. */
function media(heads: Record<string, { etag: string; size: number }> = {}) {
  return new Proxy(database.MEDIA, { get(target, prop) { return (...args: unknown[]) => (prop === "head" && String(args[0]) in heads ? Promise.resolve(heads[String(args[0])]) : (target as any)[prop](...args)); } });
}
async function call(path: string, who: "member" | "admin", options: { method?: "GET" | "POST"; body?: unknown; heads?: Record<string, { etag: string; size: number }>; queue?: Queue } = {}) {
  const method = options.method ?? "GET"; const headers = new Headers({ cookie: await cookie(who) });
  if (method === "POST") { headers.set("origin", baseEnv.APP_ORIGIN); headers.set("content-type", "application/json"); }
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }),
    { ...baseEnv, MEDIA: media(options.heads), ...(options.queue ? { OBJECT_CRC_QUEUE: options.queue } : {}) } as never, context);
  return { response, settle: () => waitOnExecutionContext(context) };
}

beforeAll(async () => { await seedFixture(); });
afterEach(async () => {
  consoleError.mockClear();
  await database.DB.batch([database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(NATIVE_ZIP_FLAG), database.DB.prepare("DELETE FROM object_crc32"), database.DB.prepare("DELETE FROM object_crc32_work"),
    database.DB.prepare("DELETE FROM selections"), database.DB.prepare("DELETE FROM download_selection_tickets"), database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE 'zip-routes/%'"),
    database.DB.prepare("DELETE FROM audit_log WHERE action IN ('project.download_selected', 'project.download_selection')")]);
});
const flag = (on: boolean) => database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(NATIVE_ZIP_FLAG, on ? 1 : 0, Date.now()).run();
const audits = async (action: string) => (await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = ?").bind(action).all()).results;
const tickets = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM download_selection_tickets").first<{ n: number }>())!.n;

/** A RAW asset in the Project; `object` false stores nothing in R2, `bytes` overrides what D1 records, `selected` selects it for editing. */
async function raw(name: string, options: { body?: string; bytes?: number; object?: boolean; selected?: boolean } = {}) {
  const collectionId = await ensureCollection(ids.project, "raw"); const id = crypto.randomUUID(); const key = `zip-routes/${id}/${name}`; const body = options.body ?? `payload of ${name}`; const now = Date.now();
  if (options.object !== false) await database.MEDIA.put(key, body);
  await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)").bind(id, collectionId, key, name, options.bytes ?? body.length, now, now).run();
  if (options.selected !== false) await database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?)").bind(crypto.randomUUID(), id, ids.member, now).run();
  return { id, key, body };
}
/** A stored CRC row that matches the object R2 holds now. */
async function ready(asset: { key: string; body: string }) {
  const head = (await database.MEDIA.head(asset.key))!;
  await database.DB.prepare("INSERT OR REPLACE INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, ?, ?, ?, ?)").bind(asset.key, crc32(enc.encode(asset.body)), asset.body.length, head.etag, Date.now()).run();
}
const big = (asset: { key: string }) => ({ [asset.key]: { etag: "big-etag", size: BIG } });

describe("GET /api/projects/:id/selected-raw.zip", () => {
  const path = `/api/projects/${ids.project}/selected-raw.zip`;

  it("flag missing, 256 MiB or less: the legacy writer, audited, with no Content-Length", async () => {
    await raw("a.dng");
    const { response } = await call(path, "member"); expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(await audits("project.download_selected")).toHaveLength(1);
  });

  it("flag missing, over 256 MiB: 413 download_too_large, no audit, R2 untouched", async () => {
    await raw("big.dng", { bytes: BIG, object: false });
    const { response } = await call(path, "member"); expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "download_too_large", maxBytes: ZIP_LEGACY_MAX_BYTES });
    expect(await audits("project.download_selected")).toHaveLength(0);
  });

  it("flag on, every CRC ready: the native writer with an exact Content-Length, and a valid archive", async () => {
    await flag(true); const a = await raw("a.dng", { body: "first" }); const b = await raw("b.dng", { body: "second" }); await ready(a); await ready(b);
    const { response, settle } = await call(path, "member"); expect(response.status).toBe(200);
    const archive = new Uint8Array(await response.arrayBuffer()); await settle();
    expect(Number(response.headers.get("content-length"))).toBe(archive.length);
    expect(parseZip(archive).entries.map((entry) => [entry.name, new TextDecoder().decode(entry.data)])).toEqual([["a.dng", "first"], ["b.dng", "second"]]);
    expect(await audits("project.download_selected")).toHaveLength(1);
  });

  it("flag on, a RAW key reused for new bytes: the stale row reads as pending, so the small archive is legacy and the job is queued when asked", async () => {
    await flag(true); const a = await raw("a.dng", { body: "first" }); await ready(a); await database.MEDIA.put(a.key, "second revision");
    await database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind("second revision".length, a.id).run();
    const { response } = await call(path, "member"); expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBeNull();
    expect(new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()))).toContain("second revision");
  });

  it("flag on, a stale row over 256 MiB: 409 download_preparing, one message queued, no audit", async () => {
    await flag(true); const a = await raw("big.dng", { bytes: BIG, object: false }); const queue = fakeQueue();
    await database.DB.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, ?, 'old-etag', ?)").bind(a.key, BIG, Date.now()).run();
    const { response } = await call(path, "member", { heads: big(a), queue });
    expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toMatchObject({ code: "download_preparing", pending: 1, retryAfterSeconds: 30 });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: a.key }]); expect(await audits("project.download_selected")).toHaveLength(0);
  });

  it("flag on, a missing object or a size R2 disagrees with D1 about: 502 download_unavailable, no audit", async () => {
    await flag(true); const gone = await raw("gone.dng", { object: false });
    let { response } = await call(path, "member"); expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ code: "download_unavailable" });
    await database.DB.prepare("DELETE FROM assets WHERE id = ?").bind(gone.id).run();
    const resized = await raw("resized.dng", { bytes: 3 }); await ready({ key: resized.key, body: resized.body });
    ({ response } = await call(path, "member")); expect(response.status).toBe(502); await response.body?.cancel();
    expect(await audits("project.download_selected")).toHaveLength(0);
  });

  it("flag on, a CRC job that failed: 502, not an endless preparing", async () => {
    await flag(true); const a = await raw("big.dng", { bytes: BIG, object: false });
    await database.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?, 'failed', 3, ?, ?)").bind(a.key, Date.now(), Date.now()).run();
    const { response } = await call(path, "member", { heads: big(a), queue: fakeQueue() }); expect(response.status).toBe(502);
  });
});

describe("POST /api/projects/:id/download-selection and its archive", () => {
  const post = (assetIds: string[], options: Parameters<typeof call>[2] = {}) => call(`/api/projects/${ids.project}/download-selection`, "member", { ...options, method: "POST", body: { assetIds } });

  it("flag missing, over 256 MiB: 413 with the stable code, no ticket", async () => {
    const a = await raw("big.dng", { bytes: BIG, object: false, selected: false });
    const { response } = await post([a.id]); expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "Selected assets exceed the 256 MiB download limit", code: "download_too_large" }); expect(await tickets()).toBe(0);
  });

  it("flag on, over 256 MiB and not ready: 409 download_preparing, no ticket, the job queued", async () => {
    await flag(true); const a = await raw("big.dng", { bytes: BIG, object: false, selected: false }); const queue = fakeQueue();
    const { response } = await post([a.id], { heads: big(a), queue });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "download_preparing", pending: 1 });
    expect(await tickets()).toBe(0); expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: a.key }]);
  });

  it("flag on, ready: the ticket is created, and its archive is native with an exact Content-Length", async () => {
    await flag(true); const a = await raw("a.dng", { body: "alpha", selected: false }); const b = await raw("b.dng", { body: "beta", selected: false }); await ready(a); await ready(b);
    const created = await post([a.id, b.id]); expect(created.response.status).toBe(201);
    const { downloadUrl } = await created.response.json() as { downloadUrl: string };
    const { response, settle } = await call(downloadUrl, "member"); expect(response.status).toBe(200);
    const archive = new Uint8Array(await response.arrayBuffer()); await settle();
    expect(Number(response.headers.get("content-length"))).toBe(archive.length); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(parseZip(archive).entries.map((entry) => entry.name)).toEqual(["a.dng", "b.dng"]);
    expect(await audits("project.download_selection")).toHaveLength(1);
  });

  it("flag on, an archive requested for a ticket whose object has since changed under a stale row: 409 and no audit", async () => {
    await flag(true); const a = await raw("big.dng", { bytes: BIG, object: false, selected: false });
    await database.DB.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, ?, 'big-etag', ?)").bind(a.key, BIG, Date.now()).run();
    const created = await post([a.id], { heads: big(a) }); expect(created.response.status).toBe(201);
    const { downloadUrl } = await created.response.json() as { downloadUrl: string };
    await database.DB.prepare("UPDATE object_crc32 SET etag = 'older' WHERE r2_key = ?").bind(a.key).run();
    const { response } = await call(downloadUrl, "member", { heads: big(a), queue: fakeQueue() }); expect(response.status).toBe(409);
    expect(await audits("project.download_selection")).toHaveLength(0);
  });
});
