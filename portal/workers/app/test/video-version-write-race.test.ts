import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { videoRenameResponseSchema, videoReviewStatusResponseSchema, type VideoDto } from "@quincy/shared";
import { RECOMPUTE_CURRENT_SQL } from "../src/lib/video-live-sql";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { wipeDelivery } from "./delivery-support";
import { clearVideoFlags, markVersionRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * #874: the Version writes answer the fresh Video the write named. A Version trashed between the write
 * and the fresh-Video read still answers 200 with that Video (the write committed); it is not a 404.
 * The domain function is wrapped to trash the Version right after it commits, which is the only way to
 * land in that window deterministically.
 */
const trash = vi.hoisted(() => ({ assetId: null as string | null, remove: null as ((assetId: string) => Promise<void>) | null }));
vi.mock("../src/lib/video-rename", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/video-rename")>();
  return { ...original, renameVersion: async (...args: Parameters<typeof original.renameVersion>) => {
    const outcome = await original.renameVersion(...args);
    if (trash.assetId && trash.remove) await trash.remove(trash.assetId);
    return outcome;
  } };
});
vi.mock("../src/lib/video-review-status", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/video-review-status")>();
  return { ...original, setVersionReviewStatus: async (...args: Parameters<typeof original.setVersionReviewStatus>) => {
    const outcome = await original.setVersionReviewStatus(...args);
    if (trash.assetId && trash.remove) await trash.remove(trash.assetId);
    return outcome;
  } };
});

/** What Trash leaves once the written Version is no longer current: removed, with the Video's current set recomputed over the live ones. */
async function removeAndRecompute(assetId: string) {
  await markVersionRemoved(assetId);
  const row = (await database.DB.prepare("SELECT video_id AS v FROM video_version_meta WHERE asset_id = ?").bind(assetId).first<{ v: string }>())!;
  await database.DB.batch(RECOMPUTE_CURRENT_SQL.map((sql) => database.DB.prepare(sql).bind(row.v, Date.now())));
}

const OPEN = ["video_review", `video_review_pilot:${ids.project}`] as const;
const base = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}`;
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
async function seedTwo() {
  const v1 = await seedVideoVersion({ version: 1, filename: "cut-1.mp4", title: "cut-2" });
  const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2, filename: "cut-2.mp4", title: "cut-2" });
  await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), v2.assetId, v1.assetId).run();
  return { v1, v2 };
}

/** The answer is the Video as it stands after the trash: only v1 remains, it is current, and the title follows it. */
function expectFresh(video: VideoDto, v1: { videoId: string; assetId: string }) {
  expect(video.id).toBe(v1.videoId);
  expect(video.currentAssetId).toBe(v1.assetId);
  expect(video.versions.map((version) => version.assetId)).toEqual([v1.assetId]);
  expect(video.title).toBe("cut-1");
}

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); trash.remove = removeAndRecompute; });
afterEach(async () => { trash.assetId = null; trash.remove = null; await wipe(); await clearVideoFlags(); });

describe("a Version trashed between the write and the fresh-Video read", () => {
  it("Rename answers 200 with the fresh Video", async () => {
    const { v1, v2 } = await seedTwo();
    trash.assetId = v2.assetId;
    const response = await request(`${base(v2.assetId)}/file-name`, "admin", "PUT", { filename: "Renamed.mp4" });
    expect(response.status, await response.clone().text()).toBe(200);
    expectFresh(videoRenameResponseSchema.parse(await response.json()).video, v1);
  });

  it("Review status answers 200 with the fresh Video", async () => {
    const { v1, v2 } = await seedTwo();
    trash.assetId = v2.assetId;
    const current = (await database.DB.prepare("SELECT review_status AS s FROM video_version_meta WHERE asset_id = ?").bind(v2.assetId).first<{ s: string }>())!.s;
    const response = await request(`${base(v2.assetId)}/review-status`, "admin", "PUT", { reviewStatus: "approved_internal", expectedStatus: current });
    expect(response.status, await response.clone().text()).toBe(200);
    expectFresh(videoReviewStatusResponseSchema.parse(await response.json()).video, v1);
  });
});
