import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoDeleteResponseSchema, videoDeletionImpactSchema, videoRestoreResponseSchema, videoTrashResponseSchema, type VideoDeletionImpact } from "@quincy/shared";
import { app } from "../src/index";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { seedPage, wipeDelivery } from "./delivery-support";
import { OPEN, first, p, racing, rows, seedDelivery, seedEvent, seedLink, seedRelease, seedVideo, states, wipe, type Seeded } from "./video-trash-support";
import { clearVideoFlags, currentVersions, markVersionRemoved, seedReservation, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Delete a Video (#868): a whole-Video removal from the grid. The impact is read over the Video's live Versions, the delete repeats every confirmed count and the exact Version set in its
 * committing batch, and Undo is the existing Video restore. Prior art for the order and the races: `video-trash.test.ts`.
 */
const impactPath = (videoId: string, projectId?: string) => p(`/videos/${videoId}/removal-impact`, projectId);
const removePath = (videoId: string, projectId?: string) => p(`/videos/${videoId}/remove`, projectId);
const impactOf = async (videoId: string, who: Who = "admin"): Promise<VideoDeletionImpact> => { const response = await request(impactPath(videoId), who); expect(response.status).toBe(200); return videoDeletionImpactSchema.parse(await response.json()); };
const expectedOf = (impact: VideoDeletionImpact) => ({ versions: impact.versions, latestVersion: impact.latestVersion, notes: impact.notes, decisions: impact.decisions, releases: impact.releases, links: impact.links.length });
const del = (videoId: string, body: unknown, who: Who = "admin") => request(removePath(videoId), who, "POST", body);
const deleteAuto = async (videoId: string, who: Who = "admin") => del(videoId, { expected: expectedOf(await impactOf(videoId)) }, who);
const restoreVideo = (videoId: string) => request(p(`/videos/${videoId}/restore`), "admin", "POST", {});
const trashList = async () => videoTrashResponseSchema.parse(await (await request(p("/video-trash"), "admin")).json());
const audits = (...actions: string[]) => rows(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action IN (${actions.map(() => "?").join(",")}) ORDER BY created_at, rowid`, ...actions);
const ACTIONS = ["video.remove", "video_version.remove", "video.restore", "video_version.restore"] as const;
const ZERO = { versions: 1, latestVersion: 1, notes: 0, decisions: 0, releases: 0, links: 0 };
const untouched = async (seeds: Seeded[]) => {
  for (const seed of seeds) expect(await first("SELECT removed_at, removed_with_video FROM video_version_meta WHERE asset_id = ?", seed.assetId)).toEqual({ removed_at: null, removed_with_video: 0 });
  expect(await first("SELECT removed_at FROM videos WHERE id = ?", seeds[0]!.videoId)).toEqual({ removed_at: null });
  expect(await audits(...ACTIONS)).toEqual([]);
};

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await wipe(); await wipeDelivery(); await clearVideoFlags(); });

describe("the route order: malformed id, part off, capability, access, archived, row, body", () => {
  const calls = (videoId: string, projectId?: string) => [
    { name: "removal-impact", method: "GET" as const, path: impactPath(videoId, projectId), write: false, body: undefined as unknown },
    { name: "remove", method: "POST" as const, path: removePath(videoId, projectId), write: true, body: { expected: ZERO } },
  ];

  it("answers 400 for a malformed id before anything else, even with the part off", async () => {
    await clearVideoFlags();
    expect((await request(p("/videos/nope/removal-impact"), "photographer")).status).toBe(400);
    expect((await request(p("/videos/nope/remove"), "photographer", "POST", { expected: ZERO })).status).toBe(400);
  });

  it("answers 404 when the part is off, 403 to a Photographer and an External editor", async () => {
    const [v] = await seedVideo(1);
    for (const call of calls(v!.videoId)) for (const who of ["photographer", "external", "externalOutsider"] as const) expect((await request(call.path, who, call.method, call.body)).status, `${call.name} ${who}`).toBe(403);
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    for (const call of calls(v!.videoId)) expect((await request(call.path, "admin", call.method, call.body)).status, call.name).toBe(404);
    expect(await audits(...ACTIONS)).toEqual([]);
  });

  it("answers an archived Project 409 on the write (before the row 404 and the body) and 200 on the read", async () => {
    const [archived] = await seedVideo(1, { projectId: ids.archivedProject });
    expect((await request(impactPath(archived!.videoId, ids.archivedProject), "admin")).status).toBe(200);
    expect((await request(removePath(archived!.videoId, ids.archivedProject), "admin", "POST", { expected: ZERO })).status).toBe(409);
    expect((await request(removePath(crypto.randomUUID(), ids.archivedProject), "admin", "POST", { not: "valid" })).status).toBe(409);
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", archived!.videoId)).toEqual({ removed_at: null });
  });

  it("answers 404 for an unknown, other-Project or trashed Video before the body is read, then 400 for a non-strict body", async () => {
    const [mine] = await seedVideo(1); const [elsewhere] = await seedVideo(1, { projectId: ids.otherProject });
    for (const videoId of [crypto.randomUUID(), elsewhere!.videoId]) for (const call of calls(videoId)) expect((await request(call.path, "admin", call.method, call.method === "POST" ? { garbage: true } : undefined)).status, call.name).toBe(404);
    for (const body of [{}, { expected: { ...ZERO, extra: 1 } }, { expected: { ...ZERO, versions: 0 } }, { expected: ZERO, extra: true }, { expected: { ...ZERO, links: -1 } }]) expect((await del(mine!.videoId, body)).status, JSON.stringify(body)).toBe(400);
    expect((await deleteAuto(mine!.videoId)).status).toBe(200);
    expect((await request(impactPath(mine!.videoId), "admin")).status).toBe(404);
    expect((await del(mine!.videoId, { expected: ZERO })).status).toBe(404);
  });
});

describe("removal impact", () => {
  it("counts the live Versions, notes, decisions, Releases and distinct Review links of the whole Video, and excludes what is already gone", async () => {
    const [v1, v2, v3] = await seedVideo(3);
    await seedVideoNote({ assetId: v1!.assetId, body: "n1" }); await seedVideoNote({ assetId: v2!.assetId, body: "n2" }); await seedVideoNote({ assetId: v3!.assetId, body: "n3" });
    await seedVideoNote({ assetId: v3!.assetId, body: "gone", deletedAt: Date.now() });
    await seedEvent(v1!); await seedEvent(v3!, "changes_requested"); await seedRelease(v2!);
    const shared = await seedLink(v1!, [v1!.assetId, v2!.assetId], { label: "Smith family" });
    await seedLink(v3!, [v3!.assetId], { label: null });
    await seedLink(v1!, [v1!.assetId], { revoked: true });
    const impact = await impactOf(v1!.videoId);
    expect(impact).toMatchObject({ versions: 3, latestVersion: 3, uploading: false, published: false, notes: 3, decisions: 3, releases: 1 });
    expect(impact.links.map((link) => link.id)).toContain(shared.id); expect(impact.links).toHaveLength(2);
    // A Version trashed on its own earlier is not part of the delete.
    await markVersionRemoved(v1!.assetId);
    expect(await impactOf(v1!.videoId)).toMatchObject({ versions: 2, latestVersion: 3, notes: 2, decisions: 2, releases: 1 });
    // The shared link still grants the live v2; only a link that granted nothing but the trashed v1 would drop.
    expect((await impactOf(v1!.videoId)).links).toHaveLength(2);
  });

  it("reports an active upload and a Video in a published Client Delivery set (a trashed Version in the set counts)", async () => {
    const [v1, v2] = await seedVideo(2);
    await seedReservation({ videoId: v1!.videoId, status: "pending" });
    expect((await impactOf(v1!.videoId)).uploading).toBe(true);
    await database.DB.prepare("DELETE FROM video_upload_reservations").run();
    await seedPage({ assetIds: [v2!.assetId], olderSets: [[v1!.assetId]] });
    expect((await impactOf(v1!.videoId)).published).toBe(true);
    await wipeDelivery(); await seedPage({ assetIds: [v1!.assetId] });
    await markVersionRemoved(v1!.assetId);
    expect((await impactOf(v1!.videoId)).published).toBe(true);
  });

  it("is private and not cached", async () => {
    const [v] = await seedVideo(1);
    expect((await request(impactPath(v!.videoId), "admin")).headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("delete", () => {
  it("removes every live Version with the Video in one go: one clock, hidden from list and stream, audited once for the Video and once per Version, Trash shows one Video item", async () => {
    const [v1, v2, v3] = await seedVideo(3, { title: "Whole" });
    await seedVideoNote({ assetId: v2!.assetId, body: "TOP-SECRET-NOTE" }); await seedEvent(v2!);
    await database.DB.prepare("UPDATE collections SET received_count = 1, status = 'received' WHERE id = ?").bind(v1!.collectionId).run();
    const before = Date.now();
    const response = await del(v1!.videoId, { expected: expectedOf(await impactOf(v1!.videoId)) });
    expect(response.status).toBe(200);
    expect(videoDeleteResponseSchema.parse(await response.json())).toEqual({ videoId: v1!.videoId, versionCount: 3 });
    const video = (await first("SELECT removed_at, removed_by, purge_at FROM videos WHERE id = ?", v1!.videoId))!;
    expect(video.removed_by).toBe(ids.admin); expect(video.removed_at as number).toBeGreaterThanOrEqual(before);
    const metas = await rows("SELECT removed_at, removed_by, purge_at, removed_with_video FROM video_version_meta WHERE video_id = ?", v1!.videoId);
    expect(metas).toHaveLength(3);
    for (const meta of metas) expect(meta).toEqual({ removed_at: video.removed_at, removed_by: ids.admin, purge_at: video.purge_at, removed_with_video: 1 });
    expect((await request(p("/videos"), "admin").then((r) => r.json()) as { videos: unknown[] }).videos).toEqual([]);
    for (const seed of [v1, v2, v3]) expect((await request(`/media/video/${seed!.assetId}`, "admin")).status).toBe(404);
    expect(await first("SELECT received_count FROM collections WHERE id = ?", v1!.collectionId)).toEqual({ received_count: 0 });
    const log = await audits(...ACTIONS);
    expect(log.filter((row) => row.action === "video.remove")).toHaveLength(1);
    expect(log.filter((row) => row.action === "video_version.remove").map((row) => row.target_id).sort()).toEqual([v1, v2, v3].map((seed) => seed!.assetId).sort());
    const videoAudit = log.find((row) => row.action === "video.remove")!;
    expect(videoAudit).toMatchObject({ actor_id: ids.admin, target_type: "video", target_id: v1!.videoId });
    expect(JSON.parse(videoAudit.meta_json as string)).toMatchObject({ projectId: ids.project, versionCount: 3, latestVersion: 3, notes: 1, decisions: 1, releases: 0, links: 0, wholeVideo: true });
    expect(log.map((row) => row.meta_json as string).join()).not.toContain("TOP-SECRET");
    const trash = await trashList(); expect(trash.items).toHaveLength(1); expect(trash.items[0]).toMatchObject({ kind: "video", videoId: v1!.videoId, title: "Whole", versionCount: 3 });
  });

  it("Undo (the existing Video restore) brings back the Versions live at Delete with newest current, leaves an earlier lone-trashed Version in Trash, and keeps notes, grants, Releases and decisions", async () => {
    const [v1, v2, v3] = await seedVideo(3);
    await seedVideoNote({ assetId: v3!.assetId, body: "kept" }); await seedRelease(v2!); await seedLink(v3!, [v3!.assetId]);
    await markVersionRemoved(v1!.assetId, 1000);
    const state = async () => JSON.stringify([await rows("SELECT id, body, deleted_at FROM video_notes ORDER BY id"), await rows("SELECT * FROM video_releases ORDER BY id"), await rows("SELECT * FROM video_approval_events ORDER BY id"), await rows("SELECT * FROM review_link_version_grants ORDER BY link_id, asset_id")]);
    const snapshot = await state();
    expect((await deleteAuto(v1!.videoId)).status).toBe(200);
    expect(await first("SELECT removed_at, removed_with_video FROM video_version_meta WHERE asset_id = ?", v1!.assetId)).toEqual({ removed_at: 1000, removed_with_video: 0 });
    const restored = await restoreVideo(v1!.videoId);
    expect(restored.status).toBe(200);
    expect(videoRestoreResponseSchema.parse(await restored.json()).video.versions.map((version) => version.version).sort()).toEqual([2, 3]);
    expect(await currentVersions(v1!.videoId)).toEqual([3]);
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v1!.assetId)).toEqual({ removed_at: 1000 });
    expect(await state()).toBe(snapshot);
  });

  it("records the impersonating Admin in the audit rows", async () => {
    const [v] = await seedVideo(2);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await request("/api/auth/admin/impersonate-user", "admin", "POST", { userId: ids.member }); expect(started.status).toBe(200);
      const cookies = new Map<string, string>();
      for (const value of (started.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const session = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
      const response = await app.fetch(new Request(`https://portal.test${removePath(v!.videoId)}`, { method: "POST", headers: { cookie: session, origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ expected: expectedOf(await impactOf(v!.videoId)) }) }), baseEnv, executionContext);
      expect(response.status).toBe(200);
      const log = await audits("video.remove", "video_version.remove"); expect(log).toHaveLength(3);
      for (const row of log) { expect(row.actor_id).toBe(ids.member); expect(JSON.parse(row.meta_json as string)).toMatchObject({ impersonatedBy: ids.admin }); }
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });

  it("refuses a stale confirmation for each changed field and writes nothing", async () => {
    const [v1, v2] = await seedVideo(2);
    const base = expectedOf(await impactOf(v1!.videoId));
    for (const [field, value] of [["versions", 3], ["latestVersion", 9], ["notes", 1], ["decisions", 1], ["releases", 1], ["links", 1]] as const) {
      const response = await del(v1!.videoId, { expected: { ...base, [field]: value } });
      expect(response.status, field).toBe(409);
      expect(await response.json()).toMatchObject({ code: "impact_changed", impact: { versions: 2 } });
    }
    await untouched([v1!, v2!]);
  });

  it("refuses an active upload, a published Delivery set and an archived Project, writing nothing", async () => {
    const [v1, v2] = await seedVideo(2);
    await seedReservation({ videoId: v1!.videoId, status: "pending" });
    const uploading = await del(v1!.videoId, { expected: expectedOf(await impactOf(v1!.videoId)) });
    expect(uploading.status).toBe(409); expect(await uploading.json()).toMatchObject({ code: "upload_in_progress" });
    await database.DB.prepare("DELETE FROM video_upload_reservations").run();
    await seedPage({ assetIds: [v2!.assetId] });
    const published = await deleteAuto(v1!.videoId);
    expect(published.status).toBe(409); expect(await published.json()).toMatchObject({ code: "delivery_published" });
    await untouched([v1!, v2!]);
  });

  it("deletes a Video of more than 100 Versions (the cohort is matched by subquery, never one bind per Version)", async () => {
    const seeds = await seedVideo(105);
    const response = await deleteAuto(seeds[0]!.videoId);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ versionCount: 105 });
    expect(await first("SELECT COUNT(*) AS n FROM video_version_meta WHERE video_id = ? AND removed_with_video = 1", seeds[0]!.videoId)).toEqual({ n: 105 });
    expect(await first("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'video_version.remove'")).toEqual({ n: 105 });
  });

  it("suppresses outstanding notifications for every Version, a refused delete suppresses none, and Undo never replays them", async () => {
    const [v1, v2] = await seedVideo(2);
    const old = await seedDelivery(v1!, "pending", "pending", "pending", "n1"); const current = await seedDelivery(v2!, "pending", "pending", "pending", "n2");
    const stale = expectedOf(await impactOf(v1!.videoId)); await seedVideoNote({ assetId: v2!.assetId });
    expect((await del(v1!.videoId, { expected: stale })).status).toBe(409);
    for (const d of [old, current]) expect(await states(d)).toEqual({ outbox: "pending", ledger: "pending", digest: "pending" });
    expect((await deleteAuto(v1!.videoId)).status).toBe(200);
    for (const d of [old, current]) expect(await states(d)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: "suppressed" });
    expect((await restoreVideo(v1!.videoId)).status).toBe(200);
    for (const d of [old, current]) expect(await states(d)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: "suppressed" });
  });
});

describe("concurrency: the fence repeats in the committing batch", () => {
  const exact = (seeds: Seeded[]) => ({ expected: { ...ZERO, versions: seeds.length, latestVersion: seeds.length } });

  it("a Version that completes after the read: impact_changed with the fresh impact, nothing written", async () => {
    const [v1] = await seedVideo(1);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!]), async () => { await seedVideoVersion({ videoId: v1!.videoId, version: 2 }); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "impact_changed", impact: { versions: 2, latestVersion: 2 } });
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null });
    expect(await audits(...ACTIONS)).toEqual([]);
  });

  it("an equal-size replacement of the Version set (one trashed, one added) is still impact_changed", async () => {
    const [v1] = await seedVideo(1);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!]), async () => { await markVersionRemoved(v1!.assetId); await seedVideoVersion({ videoId: v1!.videoId, version: 2 }); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "impact_changed" });
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null });
    expect(await audits(...ACTIONS)).toEqual([]);
  });

  it("a note, a decision, a Release or a link added after the read is impact_changed", async () => {
    const [a, b, c, d] = [await seedVideo(1), await seedVideo(1), await seedVideo(1), await seedVideo(1)].map((s) => s[0]!);
    const note = await racing("POST", removePath(a.videoId), exact([a]), async () => { await seedVideoNote({ assetId: a.assetId }); });
    const decision = await racing("POST", removePath(b.videoId), exact([b]), async () => { await seedEvent(b); });
    const release = await racing("POST", removePath(c.videoId), exact([c]), async () => { await seedRelease(c); });
    const link = await racing("POST", removePath(d.videoId), exact([d]), async () => { await seedLink(d, [d.assetId]); });
    for (const response of [note, decision, release, link]) { expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "impact_changed" }); }
    for (const seed of [a, b, c, d]) expect(await first("SELECT removed_at FROM videos WHERE id = ?", seed.videoId)).toEqual({ removed_at: null });
    expect(await audits(...ACTIONS)).toEqual([]);
  });

  it("an upload reservation started after the read is upload_in_progress", async () => {
    const [v1] = await seedVideo(1);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!]), async () => { await seedReservation({ videoId: v1!.videoId, status: "pending" }); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "upload_in_progress" });
    await untouched([v1!]);
  });

  it("a Publish after the read is delivery_published", async () => {
    const [v1] = await seedVideo(1);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!]), async () => { await seedPage({ assetIds: [v1!.assetId] }); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "delivery_published" });
    await untouched([v1!]);
  });

  it("archiving the Project after the read is project_archived", async () => {
    const [v1] = await seedVideo(1);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!]), async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); });
    try { expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "project_archived" }); await untouched([v1!]); }
    finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });

  it("two simultaneous deletes leave one 200, one 404 and one set of audit rows", async () => {
    const [v1, v2] = await seedVideo(2);
    const response = await racing("POST", removePath(v1!.videoId), exact([v1!, v2!]), async () => { expect((await deleteAuto(v1!.videoId)).status).toBe(200); });
    expect(response.status).toBe(404);
    expect((await audits("video.remove"))).toHaveLength(1); expect((await audits("video_version.remove"))).toHaveLength(2);
  });
});
