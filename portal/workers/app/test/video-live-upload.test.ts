import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoUploadReserveResponseSchema } from "@quincy/shared";
import { buildMp4, videoTrack } from "../../../packages/shared/src/testing/mp4-builder";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, jpegBytes, seedFixture, tokens, type Who } from "./embedded-media-support";
import { clearVideoFlags, currentVersions, ensureCollection, markVersionRemoved, markVideoRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Video Trash, slice B (#776): upload completion keeps the current-Version invariant with `RECOMPUTE_CURRENT_SQL`, a Version number is never handed out twice
 * (`videos.version_high_water`), and a Version can only be reserved for and completed on a live Video. Dev-direct uploads, so no S3 stub is needed.
 */
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
async function call(path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, raw?: BodyInit) {
  const context = await createAuth(DEV_ENV).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie, origin: DEV_ENV.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), DEV_ENV, createExecutionContext());
}
const base = `/api/projects/${ids.project}`;
const file = async () => { const source = buildMp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }); return source.read(0, source.size); };

/** Reserves a Version of `videoId` and stores its bytes, as the browser's direct PUT would. */
async function reserveFor(videoId: string) {
  const bytes = await file();
  const response = await call(`${base}/video-uploads`, "member", "POST", { videoId, filename: "cut.mp4", bytes: bytes.byteLength, contentType: "video/mp4" });
  if (response.status !== 201) return { response, reserved: null as null };
  const reserved = videoUploadReserveResponseSchema.parse(await response.json());
  const row = (await database.DB.prepare("SELECT r2_key AS key, asset_id AS assetId FROM video_upload_reservations WHERE id = ?").bind(reserved.reservationId).first<{ key: string; assetId: string }>())!;
  await database.MEDIA.put(row.key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  return { response, reserved: { ...reserved, ...row } };
}
const complete = (reservationId: string) => call(`${base}/video-uploads/${reservationId}/complete`, "member", "POST", {});
const versionsOf = async (videoId: string) => (await database.DB.prepare("SELECT version FROM assets WHERE kind = 'video' AND version_group_id = ? ORDER BY version").bind(videoId).all<{ version: number }>()).results.map((row) => row.version);
const highWater = async (videoId: string) => (await database.DB.prepare("SELECT version_high_water AS n FROM videos WHERE id = ?").bind(videoId).first<{ n: number }>())?.n;
const status = async (id: string) => (await database.DB.prepare("SELECT status FROM video_upload_reservations WHERE id = ?").bind(id).first<{ status: string }>())?.status;

const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("UPDATE video_upload_reservations SET status = 'failed' WHERE status IN ('pending', 'completing', 'aborting')"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeAll(async () => { await seedFixture(); await ensureCollection(ids.project, "video"); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_upload"); });
afterEach(async () => { await wipe(); await clearVideoFlags(); });

/** A Video with Versions 1 to `count`, the last current. */
async function video(count: number) {
  const first = await seedVideoVersion({ title: "Hero cut" }); const all = [first];
  for (let version = 2; version <= count; version += 1) all.push(await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version }));
  const now = Date.now();
  for (const seeded of all.slice(0, -1)) await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(now, seeded.assetId).run();
  return { videoId: first.videoId, versions: all };
}

describe("upload completion keeps one current Version", () => {
  it("a removal that lands mid-upload (and promotes an older Version) still ends with exactly one current Version, and the new number is used once", async () => {
    const { videoId, versions } = await video(3);
    const { reserved } = await reserveFor(videoId);
    expect(reserved!.version).toBe(4);
    // The reserved upload would have superseded v3. v3 goes to Trash instead, and the newest live Version (v2) becomes current, as slice C will do.
    await markVersionRemoved(versions[2]!.assetId);
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id = ?").bind(versions[1]!.assetId).run();
    expect(await currentVersions(videoId)).toEqual([2]);
    const done = await complete(reserved!.reservationId);
    expect(done.status, await done.clone().text()).toBe(201);
    expect(await currentVersions(videoId)).toEqual([4]);
    expect(await versionsOf(videoId)).toEqual([1, 2, 3, 4]);
    expect(await highWater(videoId)).toBe(4);
    expect(await database.DB.prepare("SELECT replaced_by_asset_id AS r FROM assets WHERE id = ?").bind(versions[1]!.assetId).first()).toEqual({ r: reserved!.assetId });
  });

  it("with the current Version in Trash and nothing promoted, the new Version is the only current one", async () => {
    const { videoId, versions } = await video(1);
    const { reserved } = await reserveFor(videoId);
    await markVersionRemoved(versions[0]!.assetId);
    expect((await complete(reserved!.reservationId)).status).toBe(201);
    expect(await currentVersions(videoId)).toEqual([2]);
  });

  it("a plain upload still supersedes the previous Version and links it to the new one", async () => {
    const { videoId, versions } = await video(2);
    const { reserved } = await reserveFor(videoId);
    expect((await complete(reserved!.reservationId)).status).toBe(201);
    expect(await currentVersions(videoId)).toEqual([3]);
    expect(await database.DB.prepare("SELECT replaced_by_asset_id AS r, superseded_at IS NOT NULL AS s FROM assets WHERE id = ?").bind(versions[1]!.assetId).first()).toEqual({ r: reserved!.assetId, s: 1 });
  });
});

describe("Version numbers are never reused", () => {
  it("reserve numbers the Version MAX(highest Asset, high-water mark) + 1, so a purged number stays spent", async () => {
    const { videoId, versions } = await video(2);
    expect(await highWater(videoId)).toBe(2);
    // The purge of v2 (slice D): its rows are gone, the mark stays.
    await database.DB.batch([database.DB.prepare("DELETE FROM video_version_meta WHERE asset_id = ?").bind(versions[1]!.assetId), database.DB.prepare("DELETE FROM assets WHERE id = ?").bind(versions[1]!.assetId)]);
    const { reserved } = await reserveFor(videoId);
    expect(reserved!.version).toBe(3);
    expect((await complete(reserved!.reservationId)).status).toBe(201);
    expect(await versionsOf(videoId)).toEqual([1, 3]);
    expect(await highWater(videoId)).toBe(3);
  });

  it("raises the mark to at least the completed number, and never lowers it", async () => {
    const { videoId } = await video(1);
    await database.DB.prepare("UPDATE videos SET version_high_water = 9 WHERE id = ?").bind(videoId).run();
    const { reserved } = await reserveFor(videoId);
    expect(reserved!.version).toBe(10);
    expect((await complete(reserved!.reservationId)).status).toBe(201);
    expect(await highWater(videoId)).toBe(10);
  });

  it("a new Video's first Version sets the mark to 1", async () => {
    const bytes = await file();
    const response = await call(`${base}/video-uploads`, "member", "POST", { title: "Fresh", filename: "cut.mp4", bytes: bytes.byteLength, contentType: "video/mp4" });
    const reserved = videoUploadReserveResponseSchema.parse(await response.json());
    const row = (await database.DB.prepare("SELECT r2_key AS key FROM video_upload_reservations WHERE id = ?").bind(reserved.reservationId).first<{ key: string }>())!;
    await database.MEDIA.put(row.key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    expect((await complete(reserved.reservationId)).status).toBe(201);
    expect(await highWater(reserved.videoId)).toBe(1);
    expect(await currentVersions(reserved.videoId)).toEqual([1]);
  });
});

describe("a Version can only go onto a live Video", () => {
  it("reserving against a Video in Trash is a 404 and reserves nothing", async () => {
    const { videoId } = await video(1);
    await markVideoRemoved(videoId);
    const { response } = await reserveFor(videoId);
    expect(response.status).toBe(404);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_upload_reservations WHERE video_id = ? AND status IN ('pending', 'completing', 'aborting')").bind(videoId).first<{ n: number }>())!.n).toBe(0);
  });

  it("completing after the Video went to Trash is a 404: no Asset, no meta, the claim handed back", async () => {
    const { videoId } = await video(1);
    const { reserved } = await reserveFor(videoId);
    await markVideoRemoved(videoId);
    const done = await complete(reserved!.reservationId);
    expect(done.status, await done.clone().text()).toBe(404);
    expect(await versionsOf(videoId)).toEqual([1]);
    expect(await currentVersions(videoId)).toEqual([]);
    expect(await status(reserved!.reservationId)).toBe("pending");
    expect(await highWater(videoId)).toBe(1);
  });

  it("the poster PUT is refused for a Version in Trash and for a Version of a Video in Trash", async () => {
    const trashedVersion = await seedVideoVersion({ title: "Trashed version" });
    const trashedVideo = await seedVideoVersion({ title: "Trashed video" });
    const live = await seedVideoVersion({ title: "Live" });
    await markVersionRemoved(trashedVersion.assetId); await markVideoRemoved(trashedVideo.videoId);
    for (const seeded of [trashedVersion, trashedVideo]) expect((await call(`${base}/video-versions/${seeded.assetId}/poster`, "member", "PUT", undefined, jpegBytes(64))).status, seeded.assetId).toBe(404);
    expect((await database.DB.prepare("SELECT poster_key FROM video_version_meta WHERE asset_id IN (?, ?)").bind(trashedVersion.assetId, trashedVideo.assetId).all()).results).toEqual([{ poster_key: null }, { poster_key: null }]);
    expect((await call(`${base}/video-versions/${live.assetId}/poster`, "member", "PUT", undefined, jpegBytes(64))).status).toBe(204);
  });
});
