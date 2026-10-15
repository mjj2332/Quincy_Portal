import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoVersionSummariesResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, guestFetch, linkPath, linkWithSession, openGuestGate } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The phone Versions sheet's reads (#879): staff and guest, per Version, with the open-note rule of the list. */
const OPEN = ["video_review", "video_review_notes", `video_review_pilot:${ids.project}`] as const;
const staffPath = (videoId: string, projectId: string = ids.project) => `/api/projects/${projectId}/videos/${videoId}/version-summaries`;
const guestPath = (linkId: string, videoId: string) => linkPath(linkId, `/videos/${videoId}/version-summaries`);

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoNotes(); await clearGuestRows(); await clearVideoFlags(); await setVideoFlags(...OPEN); await openGuestGate(); await setVideoFlags(...OPEN); });
afterEach(async () => { await clearVideoFlags(); await clearVideoNotes(); await clearGuestRows(); });

async function film() {
  const v1 = await seedVideoVersion({ title: "Hero" });
  const v2 = await seedVideoVersion({ projectId: v1.projectId, videoId: v1.videoId, version: 2 });
  return { v1, v2 };
}
/** v2: one open public, one open internal, one resolved, one empty tombstone, one tombstone with a reply, one reply. v1: one open public. */
async function notes(v1: string, v2: string) {
  await seedVideoNote({ assetId: v2, visibility: "public" });
  await seedVideoNote({ assetId: v2, visibility: "internal" });
  await seedVideoNote({ assetId: v2, visibility: "public", resolvedBy: ids.member });
  await seedVideoNote({ assetId: v2, visibility: "public", deletedAt: Date.now() });
  const kept = await seedVideoNote({ assetId: v2, visibility: "public", deletedAt: Date.now() });
  await seedVideoNote({ assetId: v2, visibility: "public", parentId: kept.id });
  await seedVideoNote({ assetId: v1, visibility: "public" });
}

describe("GET /api/projects/:projectId/videos/:videoId/version-summaries", () => {
  it("lists every live Version newest first with the open root count of both visibilities", async () => {
    const { v1, v2 } = await film(); await notes(v1.assetId, v2.assetId);
    const response = await request(staffPath(v1.videoId), "admin"); expect(response.status).toBe(200);
    const body = videoVersionSummariesResponseSchema.parse(await response.json());
    expect(body.versions.map((v) => [v.assetId, v.version, v.openNoteCount])).toEqual([[v2.assetId, 2, 3], [v1.assetId, 1, 1]]);
    expect(Number.isNaN(Date.parse(body.versions[0]!.createdAt))).toBe(false);
  });
  it("answers a null count while the notes part is off, and 404 when the gate is closed", async () => {
    const { v1 } = await film();
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    const body = videoVersionSummariesResponseSchema.parse(await (await request(staffPath(v1.videoId), "admin")).json());
    expect(body.versions.every((v) => v.openNoteCount === null)).toBe(true);
    await clearVideoFlags();
    expect((await request(staffPath(v1.videoId), "admin")).status).toBe(404);
  });
  it("is 400 for a malformed id, 404 for an unknown Video, and 403 or 404 outside the Project", async () => {
    const { v1 } = await film();
    expect((await request(staffPath("nope"), "admin")).status).toBe(400);
    expect((await request(staffPath(crypto.randomUUID()), "admin")).status).toBe(404);
    expect((await request(staffPath(v1.videoId), "photographer")).status).toBe(403);
  });
});

describe("GET /d/api/links/:linkId/videos/:videoId/version-summaries", () => {
  it("lists granted Versions only, counting public open roots", async () => {
    const { v1, v2 } = await film(); await notes(v1.assetId, v2.assetId);
    const session = await linkWithSession(); await addMember(session.id, v1.videoId, [v1.assetId, v2.assetId]);
    const response = await guestFetch(guestPath(session.id, v1.videoId), { cookie: session.cookie }); expect(response.status).toBe(200);
    const body = videoVersionSummariesResponseSchema.parse(await response.json());
    expect(body.versions.map((v) => [v.version, v.openNoteCount])).toEqual([[2, 2], [1, 1]]);
    const only = await linkWithSession(); await addMember(only.id, v1.videoId, [v1.assetId]);
    const narrow = videoVersionSummariesResponseSchema.parse(await (await guestFetch(guestPath(only.id, v1.videoId), { cookie: only.cookie })).json());
    expect(narrow.versions.map((v) => v.version)).toEqual([1]);
    expect(JSON.stringify(narrow)).not.toContain(v2.assetId);
  });
  it("is the stub without a session and for a Video that is not a member", async () => {
    const { v1 } = await film(); const other = await seedVideoVersion({ title: "Other" });
    const session = await linkWithSession(); await addMember(session.id, v1.videoId, [v1.assetId]);
    expect((await guestFetch(guestPath(session.id, v1.videoId))).status).toBe(404);
    expect((await guestFetch(guestPath(session.id, other.videoId), { cookie: session.cookie })).status).toBe(404);
    expect((await guestFetch(guestPath(session.id, "nope"), { cookie: session.cookie })).status).toBe(404);
    expect(database).toBeDefined();
  });
});
