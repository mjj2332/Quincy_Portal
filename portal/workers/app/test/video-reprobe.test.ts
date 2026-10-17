import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MP4_PROBE_VERSION } from "@quincy/shared";
import { bFrameCtts, buildMp4, videoTrack, type Mp4Spec } from "../../../packages/shared/src/testing/mp4-builder";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, seedFixture, type Who } from "./embedded-media-support";
import { seedVideoVersion } from "./video-review-support";

/** The #900 backfill: stored Versions probed under an older version are re-probed from R2 and raised only when the new count is larger. */
const ROUTE = "/api/admin/video-versions/reprobe";
const buildFile = async (spec: Mp4Spec) => { const source = buildMp4(spec); return source.read(0, source.size); };
// The cfr-25 shape: 25 fps in a 12800 timescale, B-frames, an edit that only absorbs the composition delay.
const CFR25 = () => buildFile({ movieTimescale: 1000, tracks: [videoTrack({ timescale: 12800, stts: [[500, 512]], ctts: bFrameCtts(500, 512), cttsVersion: 1, elst: [{ segmentDuration: 20000, mediaTime: 1024 }] })] });
const HEVC = () => buildFile({ tracks: [videoTrack({ codec: "hvc1" })] });
type Json = Record<string, any>;

async function post(body: unknown, who: Who = "admin", env: Env = baseEnv) {
  const headers = { cookie: await cookie(who), origin: env.APP_ORIGIN, "content-type": "application/json" };
  return app.fetch(new Request(`https://portal.test${ROUTE}`, { method: "POST", headers, body: JSON.stringify(body) }), env, createExecutionContext());
}
const wrapMedia = (override: (target: R2Bucket, property: string | symbol) => unknown): Env => ({ ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
  const custom = override(target, property); if (custom !== undefined) return custom;
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });

/** A stored Version whose meta was written by probe 1 for `file` (498 / 19920 for the cfr-25 shape). */
async function stored(options: { file?: Uint8Array; assetId?: string; frames?: number; durationMs?: number; contentType?: string; object?: boolean; bytes?: number } = {}) {
  const file = options.file ?? await CFR25();
  const seeded = await seedVideoVersion({ object: false, ...(options.assetId ? { assetId: options.assetId } : {}) });
  if (options.object !== false) await database.MEDIA.put(seeded.key, file, { httpMetadata: { contentType: options.contentType ?? "video/mp4" } });
  await database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind(options.bytes ?? file.byteLength, seeded.assetId).run();
  await database.DB.prepare("UPDATE video_version_meta SET fps_num = 25, fps_den = 1, media_timescale = 12800, frame_delta = 512, frame_count = ?, duration_ms = ?, codec_string = 'avc1.64001F', tc_nominal_fps = 25, tc_drop_frame = 0, start_tc_frames = NULL, probe_version = 1 WHERE asset_id = ?")
    .bind(options.frames ?? 498, options.durationMs ?? 19920, seeded.assetId).run();
  return seeded;
}
const meta = (assetId: string) => database.DB.prepare("SELECT frame_count AS frameCount, duration_ms AS durationMs, probe_version AS probeVersion FROM video_version_meta WHERE asset_id = ?").bind(assetId).first<Json>();
const auditCount = async (action: string) => (await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").bind(action).first<{ n: number }>())!.n;
const run = async (body: Json = {}, who: Who = "admin", env?: Env) => { const response = await post(body, who, env); expect(response.status, await response.clone().text()).toBe(200); return await response.json() as Json; };

beforeAll(seedFixture);
const wipe = () => database.DB.batch([
  database.DB.prepare("DELETE FROM audit_log WHERE action IN ('video.version.reprobe', 'admin.video_probe_backfill')"),
  database.DB.prepare("DELETE FROM object_crc32"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos"),
]);
beforeEach(wipe);
afterEach(wipe);

describe("POST /api/admin/video-versions/reprobe", () => {
  it("a dry run (the default) reports what would change and writes nothing, audit included", async () => {
    const v = await stored();
    const body = await run({});
    expect(body).toMatchObject({ dryRun: true, scanned: 1, nextCursor: null });
    expect(body.items).toEqual([{ assetId: v.assetId, videoId: v.videoId, version: 1, status: "changed", old: { frameCount: 498, durationMs: 19920 }, new: { frameCount: 500, durationMs: 20000 } }]);
    expect(await meta(v.assetId)).toEqual({ frameCount: 498, durationMs: 19920, probeVersion: 1 });
    expect(await auditCount("video.version.reprobe")).toBe(0); expect(await auditCount("admin.video_probe_backfill")).toBe(0);
  });

  it("a real run raises the count and duration, stamps the probe version and audits the row and the run", async () => {
    const v = await stored();
    expect(await run({ dryRun: false })).toMatchObject({ dryRun: false, scanned: 1, items: [{ status: "changed" }] });
    expect(await meta(v.assetId)).toEqual({ frameCount: 500, durationMs: 20000, probeVersion: MP4_PROBE_VERSION });
    const row = await database.DB.prepare("SELECT id, actor_id AS actorId, target_type AS targetType, target_id AS targetId, meta_json AS meta FROM audit_log WHERE action = 'video.version.reprobe'").first<Json>();
    expect(row).toMatchObject({ id: `reprobe-v${MP4_PROBE_VERSION}-${v.assetId}`, targetType: "asset", targetId: v.assetId });
    expect(JSON.parse(row!.meta)).toMatchObject({ projectId: v.projectId, videoId: v.videoId, version: 1, old: { frameCount: 498, durationMs: 19920 }, new: { frameCount: 500, durationMs: 20000 } });
    expect(await auditCount("admin.video_probe_backfill")).toBe(1);
  });

  it("a second run is a no-op, and a trashed Version is scanned like a live one", async () => {
    const v = await stored();
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), v.assetId).run();
    await run({ dryRun: false });
    expect((await meta(v.assetId))!.frameCount).toBe(500);
    expect(await run({ dryRun: false })).toMatchObject({ scanned: 0, items: [], nextCursor: null });
    expect(await auditCount("video.version.reprobe")).toBe(1);
  });

  it("never writes a lower count (would_lower) and leaves an equal one at version 1 (unchanged)", async () => {
    const lower = await stored({ frames: 600, durationMs: 24000, assetId: "00000000-0000-4000-8000-000000000001" });
    const equal = await stored({ frames: 500, durationMs: 20000, assetId: "00000000-0000-4000-8000-000000000002" });
    const body = await run({ dryRun: false });
    expect(body.items.map((i: Json) => i.status)).toEqual(["would_lower", "unchanged"]);
    expect(await meta(lower.assetId)).toEqual({ frameCount: 600, durationMs: 24000, probeVersion: 1 });
    expect(await meta(equal.assetId)).toEqual({ frameCount: 500, durationMs: 20000, probeVersion: 1 });
    expect(await auditCount("video.version.reprobe")).toBe(0);
  });

  it("skips a missing object, a size or content-type mismatch and a stale crc32 etag (object_changed)", async () => {
    const missing = await stored({ object: false });
    const size = await stored({ bytes: 1 });
    const type = await stored({ contentType: "application/octet-stream" });
    const crc = await stored();
    await database.DB.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, ?, 'stale-etag', ?)").bind(crc.key, 1, Date.now()).run();
    const body = await run({ dryRun: false, limit: 10 });
    const status = (assetId: string) => body.items.find((i: Json) => i.assetId === assetId).status;
    expect([status(missing.assetId), status(size.assetId), status(type.assetId), status(crc.assetId)]).toEqual(["missing", "object_changed", "object_changed", "object_changed"]);
    for (const v of [missing, size, type, crc]) expect(await meta(v.assetId)).toEqual({ frameCount: 498, durationMs: 19920, probeVersion: 1 });
  });

  it("a crc32 row whose etag matches the object does not block the row", async () => {
    const v = await stored(); const head = (await database.MEDIA.head(v.key))!;
    await database.DB.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, ?, ?, ?)").bind(v.key, head.size, head.etag, Date.now()).run();
    expect((await run({})).items[0].status).toBe("changed");
  });

  it("skips a row whose probed facts differ from the stored ones (facts_changed)", async () => {
    const v = await stored();
    await database.DB.prepare("UPDATE video_version_meta SET width = 1280 WHERE asset_id = ?").bind(v.assetId).run();
    expect((await run({ dryRun: false })).items[0].status).toBe("facts_changed");
    expect((await meta(v.assetId))!.probeVersion).toBe(1);
  });

  it("reports a file the probe rejects and writes nothing", async () => {
    const v = await stored({ file: await HEVC() });
    expect((await run({ dryRun: false })).items[0]).toMatchObject({ status: "rejected:hevc", old: { frameCount: 498 } });
    expect(await meta(v.assetId)).toEqual({ frameCount: 498, durationMs: 19920, probeVersion: 1 });
  });

  it("an ETag swap mid-probe is unavailable, never a verdict on the new bytes", async () => {
    const v = await stored(); let swapped = false;
    const env = wrapMedia((target, property) => property === "get" ? async (key: string, options?: R2GetOptions) => {
      if (!swapped) { swapped = true; await target.put(key, new Uint8Array(64).fill(9), { httpMetadata: { contentType: "video/mp4" } }); }
      return target.get(key, options);
    } : undefined);
    expect((await run({ dryRun: false }, "admin", env)).items[0].status).toBe("unavailable");
    expect(await meta(v.assetId)).toEqual({ frameCount: 498, durationMs: 19920, probeVersion: 1 });
  });

  it("loses a compare-and-swap to a concurrent change: the row keeps the other writer's value and no row audit is written", async () => {
    const v = await stored();
    const env = wrapMedia((target, property) => property === "head" ? async (key: string) => {
      const head = await target.head(key);
      await database.DB.prepare("UPDATE video_version_meta SET frame_count = 499 WHERE asset_id = ?").bind(v.assetId).run();
      return head;
    } : undefined);
    expect((await run({ dryRun: false }, "admin", env)).items[0].status).toBe("conflict");
    expect(await meta(v.assetId)).toEqual({ frameCount: 499, durationMs: 19920, probeVersion: 1 });
    expect(await auditCount("video.version.reprobe")).toBe(0);
  });

  it("pages by asset id and ends with a null nextCursor", async () => {
    const ids3 = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"];
    for (const assetId of ids3) await stored({ assetId });
    const first = await run({ limit: 2 });
    expect(first.items.map((i: Json) => i.assetId)).toEqual(ids3.slice(0, 2)); expect(first.nextCursor).toBe(ids3[1]);
    const second = await run({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i: Json) => i.assetId)).toEqual([ids3[2]]); expect(second.nextCursor).toBeNull();
  });

  it("is Admin only (403 before any read) and refuses a bad body", async () => {
    await stored();
    for (const who of ["member", "photographer", "external"] as const) expect((await post({}, who)).status, who).toBe(403);
    expect((await post({ limit: 11 })).status).toBe(400);
    expect((await post({ extra: 1 })).status).toBe(400);
    expect(await auditCount("admin.video_probe_backfill")).toBe(0);
  });
});
