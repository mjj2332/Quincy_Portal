import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { videoListResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** #741 5b-counts: `latestNoteCount` on the Videos list. Open root notes on the current Version, under the panel's tombstone rule. */
const OPEN = ["video_review", "video_review_notes", `video_review_pilot:${ids.project}`] as const;
const listed = async (who: "admin" | "member" | "external" = "member") => {
  const response = await request(`/api/projects/${ids.project}/videos`, who); expect(response.status).toBe(200);
  return videoListResponseSchema.parse(await response.json()).videos;
};
const countOf = async (videoId: string, who: "admin" | "member" | "external" = "member") => (await listed(who)).find((video) => video.id === videoId)!.latestNoteCount;

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await clearVideoNotes(); });
afterEach(async () => { vi.restoreAllMocks(); await clearVideoFlags(); });

describe("latestNoteCount", () => {
  it("is null and runs no notes query when the notes part is off", async () => {
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    const version = await seedVideoVersion(); await seedVideoNote({ assetId: version.assetId });
    const prepared: string[] = [];
    const real = database.DB.prepare.bind(database.DB);
    vi.spyOn(database.DB, "prepare").mockImplementation((sql: string) => { prepared.push(sql); return real(sql); });
    expect(await countOf(version.videoId)).toBeNull();
    expect(prepared.some((sql) => sql.includes("video_notes"))).toBe(false);
  });

  it("is 0 with the part on and no notes, and counts open roots of both visibilities for staff and an assigned External", async () => {
    const version = await seedVideoVersion();
    expect(await countOf(version.videoId)).toBe(0);
    await seedVideoNote({ assetId: version.assetId, visibility: "public" });
    await seedVideoNote({ assetId: version.assetId, visibility: "internal" });
    for (const who of ["admin", "member", "external"] as const) expect(await countOf(version.videoId, who), who).toBe(2);
  });

  it("does not count replies, resolved roots or empty tombstones, but counts a tombstone that kept replies", async () => {
    const version = await seedVideoVersion();
    const open = await seedVideoNote({ assetId: version.assetId });
    await seedVideoNote({ assetId: version.assetId, parentId: open.id });
    await seedVideoNote({ assetId: version.assetId, resolvedBy: ids.member });
    await seedVideoNote({ assetId: version.assetId, deletedAt: Date.now() });
    const kept = await seedVideoNote({ assetId: version.assetId, deletedAt: Date.now() });
    await seedVideoNote({ assetId: version.assetId, parentId: kept.id });
    expect(await countOf(version.videoId)).toBe(2);
  });

  it("counts only the current Version, per Video, and not a reservation", async () => {
    const v1 = await seedVideoVersion(); const other = await seedVideoVersion();
    await seedVideoNote({ assetId: v1.assetId }); await seedVideoNote({ assetId: other.assetId }); await seedVideoNote({ assetId: other.assetId });
    const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), v1.assetId).run();
    expect(await countOf(v1.videoId)).toBe(0);
    await seedVideoNote({ assetId: v2.assetId });
    expect(await countOf(v1.videoId)).toBe(1);
    expect(await countOf(other.videoId)).toBe(2);
  });

  it("keeps the gate order: closed 404, then capability 403", async () => {
    await clearVideoFlags();
    expect((await request(`/api/projects/${ids.project}/videos`, "member")).status).toBe(404);
    await setVideoFlags(...OPEN);
    expect((await request(`/api/projects/${ids.project}/videos`, "photographer")).status).toBe(403);
  });
});
