import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { ObjectCrcMessage } from "@quincy/shared";
import app from "../src/index";
import { releaseVersion } from "../src/lib/video-approval";
import type { Principal } from "../src/lib/video-notes";
import { baseEnv, cookie, database, ids, seedFixture } from "./embedded-media-support";
import { clearVideoFlags, ensureCollection, seedVideoVersion, setVideoFlags } from "./video-review-support";
import { clearDeliveryFlags, openDelivery, seedAsset, wipeDelivery } from "./delivery-support";

/** The object CRC PRODUCERS in the app (#802): the RAW "select for editing" write and a video Version release each queue the CRC job for the object they commit, best effort. */
const staff = { id: ids.member, role: "editor" } as unknown as Principal;
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
function fakeQueue(fail = false) {
  const sent: ObjectCrcMessage[] = [];
  return { sent, sendBatch: vi.fn(async (messages: Array<{ body: ObjectCrcMessage }>) => { if (fail) throw new Error("queue unavailable"); for (const message of messages) sent.push(message.body); }) };
}
const context = () => createExecutionContext();
async function post(path: string, who: "admin" | "member", queue: ReturnType<typeof fakeQueue> | undefined, body?: unknown) {
  const headers = new Headers({ cookie: await cookie(who), origin: baseEnv.APP_ORIGIN }); if (body !== undefined) headers.set("content-type", "application/json");
  return app.fetch(new Request(`https://portal.test${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...baseEnv, OBJECT_CRC_QUEUE: queue as never }, context());
}

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`); });
afterEach(async () => {
  consoleError.mockClear(); await clearVideoFlags();
  await database.DB.batch([database.DB.prepare("DELETE FROM selections"), database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action = 'asset.select'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video' OR r2_key LIKE 'object-crc-producers/%'"), database.DB.prepare("DELETE FROM videos")]);
});

async function rawAsset() {
  const collectionId = await ensureCollection(ids.project, "raw"); const id = crypto.randomUUID(); const key = `object-crc-producers/${id}/IMG_0001.dng`; const now = Date.now();
  await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'IMG_0001.dng', 10, 'upload', ?, ?)").bind(id, collectionId, key, now, now).run();
  return { id, key };
}
const selectionCount = async (assetId: string) => (await database.DB.prepare("SELECT count(*) AS n FROM selections WHERE asset_id = ?").bind(assetId).first<{ n: number }>())!.n;

describe("select for editing", () => {
  it("queues the CRC job for the selected RAW's key, after the selection is written", async () => {
    const asset = await rawAsset(); const queue = fakeQueue();
    expect((await post(`/api/assets/${asset.id}/select`, "member", queue)).status).toBe(200);
    expect(await selectionCount(asset.id)).toBe(1);
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: asset.key }]);
  });

  it("selecting again queues it again (the job skips an object whose CRC is stored)", async () => {
    const asset = await rawAsset(); const queue = fakeQueue();
    await post(`/api/assets/${asset.id}/select`, "member", queue); await post(`/api/assets/${asset.id}/select`, "member", queue);
    expect(queue.sent).toHaveLength(2);
  });

  it("a failing queue, or no binding, never undoes the selection or changes the answer", async () => {
    const failing = await rawAsset(); const failedQueue = fakeQueue(true);
    expect((await post(`/api/assets/${failing.id}/select`, "member", failedQueue)).status).toBe(200);
    expect(failedQueue.sendBatch).toHaveBeenCalledOnce(); expect(await selectionCount(failing.id)).toBe(1);
    const unbound = await rawAsset();
    expect((await post(`/api/assets/${unbound.id}/select`, "member", undefined)).status).toBe(200);
    expect(await selectionCount(unbound.id)).toBe(1);
  });

  it("queues nothing for a selection that is refused", async () => {
    const queue = fakeQueue();
    expect((await post(`/api/assets/${crypto.randomUUID()}/select`, "member", queue)).status).toBe(404);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });
});

async function approved(assetId: string, videoId: string) {
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)")
    .bind(crypto.randomUUID(), ids.project, videoId, assetId, ids.member, Date.now()).run();
}

describe("video Version release", () => {
  it("queues the CRC job for the released Version's original", async () => {
    const version = await seedVideoVersion({ title: "Final" }); await approved(version.assetId, version.videoId); const queue = fakeQueue();
    const outcome = await releaseVersion(database.DB, { projectId: ids.project, assetId: version.assetId, principal: staff, approvalRevision: 1, now: Date.now() }, { OBJECT_CRC_QUEUE: queue });
    expect("release" in outcome).toBe(true);
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: version.key }]);
  });

  it("queues nothing when the Release is refused", async () => {
    const version = await seedVideoVersion({ title: "Final" }); await approved(version.assetId, version.videoId); const queue = fakeQueue();
    const outcome = await releaseVersion(database.DB, { projectId: ids.project, assetId: version.assetId, principal: staff, approvalRevision: 9, now: Date.now() }, { OBJECT_CRC_QUEUE: queue });
    expect("release" in outcome).toBe(false); expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it("a failing queue never undoes the Release", async () => {
    const version = await seedVideoVersion({ title: "Final" }); await approved(version.assetId, version.videoId); const queue = fakeQueue(true);
    const outcome = await releaseVersion(database.DB, { projectId: ids.project, assetId: version.assetId, principal: staff, approvalRevision: 1, now: Date.now() }, { OBJECT_CRC_QUEUE: queue });
    expect("release" in outcome).toBe(true);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_releases WHERE asset_id = ? AND withdrawn_at IS NULL").bind(version.assetId).first<{ n: number }>())!.n).toBe(1);
  });

  it("the release route passes its queue binding through", async () => {
    await setVideoFlags("video_review_delivery");
    const version = await seedVideoVersion({ title: "Final" }); await approved(version.assetId, version.videoId); const queue = fakeQueue();
    const response = await post(`/api/projects/${ids.project}/video-versions/${version.assetId}/release`, "admin", queue, { approvalRevision: 1 });
    expect(response.status).toBe(201);
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: version.key }]);
  });
});

describe("Client Delivery Publish (#787 slice 7)", () => {
  beforeEach(async () => { await openDelivery(ids.project); await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); });
  afterEach(async () => { await wipeDelivery(); await clearDeliveryFlags(); await database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE '%delivery-test%'").run(); });
  async function publish(assetIds: string[], queue: ReturnType<typeof fakeQueue> | undefined) {
    const ctx = context(); const headers = new Headers({ cookie: await cookie("admin"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" });
    const response = await app.fetch(new Request(`https://portal.test/api/projects/${ids.project}/delivery/publish`, { method: "POST", headers, body: JSON.stringify({ assetIds, expectedLatestSet: null, operationId: crypto.randomUUID() }) }), { ...baseEnv, OBJECT_CRC_QUEUE: queue as never }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  const keyOf = async (id: string) => (await database.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(id).first<{ r2_key: string }>())!.r2_key;

  it("queues the CRC job for the originals of the published photos, locked ones included, and nothing for a PDF", async () => {
    const a = await seedAsset("photo"); const locked = await seedAsset("photo", { deliveryPremium: true }); const pdf = await seedAsset("floorplan_pdf"); const queue = fakeQueue();
    expect((await publish([a.id, locked.id, pdf.id], queue)).status).toBe(201);
    expect(queue.sent.map((message) => message.r2Key).sort()).toEqual([await keyOf(a.id), await keyOf(locked.id)].sort());
  });
  it("a failing queue, or no binding, never fails Publish", async () => {
    const a = await seedAsset("photo"); const failing = fakeQueue(true);
    expect((await publish([a.id], failing)).status).toBe(201); expect(failing.sendBatch).toHaveBeenCalled();
    await wipeDelivery(); const b = await seedAsset("photo");
    expect((await publish([b.id], undefined)).status).toBe(201);
  });
  it("queues nothing for a refused Publish", async () => {
    const queue = fakeQueue(); expect((await publish([crypto.randomUUID()], queue)).status).toBe(400); expect(queue.sendBatch).not.toHaveBeenCalled();
  });
});
