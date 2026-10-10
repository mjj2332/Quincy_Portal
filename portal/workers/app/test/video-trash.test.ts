import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VIDEO_TRASH_RETENTION_DAYS, videoListResponseSchema, videoRemovalImpactSchema, videoRemovalRefusalSchema, videoRemoveResponseSchema, videoRestoreResponseSchema, videoTrashResponseSchema, type VideoRemovalImpact } from "@quincy/shared";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { addMember, clearGuestRows, grant, seedGuestLink } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, currentVersions, seedReservation, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Video Trash, slice C (#776): remove, restore and the Trash list. The order on every route, the impact and its refusals, current-Version recompute, an exact restore, suppressed notifications,
 * and the fence under real interleavings (a `before` hook runs after the handler's reads and just before the committing batch).
 */
type Json = Record<string, any>;
const OPEN = ["video_review", "video_review_trash", "video_review_notes", "video_review_links", "video_review_delivery", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
const p = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}${rest}`;
const DAY = 86_400_000;

type Seeded = Awaited<ReturnType<typeof seedVideoVersion>>;
/** A Video with `count` Versions, the newest current and every older one superseded (as upload completion leaves it). */
async function seedVideo(count: number, input: { projectId?: string; title?: string } = {}): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (let version = 1; version <= count; version += 1) out.push(await seedVideoVersion({ projectId: input.projectId, videoId: out[0]?.videoId, version, title: input.title, poster: true }));
  const now = Date.now();
  for (let i = 0; i < out.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, out[i + 1]!.assetId, out[i]!.assetId).run();
  return out;
}
const rows = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all<Json>()).results;
const first = async (sql: string, ...binds: unknown[]) => (await rows(sql, ...binds))[0] ?? null;
const impactOf = async (assetId: string, who: Who = "admin"): Promise<VideoRemovalImpact> => { const response = await request(p(`/video-versions/${assetId}/removal-impact`), who); expect(response.status).toBe(200); return videoRemovalImpactSchema.parse(await response.json()); };
const expectedOf = (impact: VideoRemovalImpact) => ({ notes: impact.notes, decisions: impact.decisions, release: impact.release, links: impact.links.length });
const remove = (assetId: string, body: unknown, who: Who = "admin") => request(p(`/video-versions/${assetId}/remove`), who, "POST", body);
/** Removes with the impact as it stands, `removeVideo` as the last-Version rule wants. */
async function removeAuto(assetId: string, who: Who = "admin") { const impact = await impactOf(assetId); return remove(assetId, { expected: expectedOf(impact), removeVideo: impact.lastVersion }, who); }
const restoreVersion = (assetId: string, who: Who = "admin") => request(p(`/video-versions/${assetId}/restore`), who, "POST", {});
const restoreVideo = (videoId: string, who: Who = "admin") => request(p(`/videos/${videoId}/restore`), who, "POST", {});
const trashList = async (who: Who = "admin") => { const response = await request(p("/video-trash"), who); expect(response.status).toBe(200); return videoTrashResponseSchema.parse(await response.json()); };
const audits = async (...actions: string[]) => rows(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action IN (${actions.map(() => "?").join(",")}) ORDER BY created_at, rowid`, ...actions);
const AUDIT_ACTIONS = ["video_version.remove", "video_version.restore", "video.remove", "video.restore"] as const;
const metaOf = (row: Json) => JSON.parse(row.meta_json as string) as Json;

async function seedEvent(seed: Seeded, decision: "approved" | "changes_requested" = "approved") {
  const id = crypto.randomUUID();
  const revision = (await first("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM video_approval_events WHERE asset_id = ?", seed.assetId))!.next as number;
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'secret decision note', NULL, ?, ?)")
    .bind(id, seed.projectId, seed.videoId, seed.assetId, revision, decision, ids.admin, Date.now()).run();
  return { id, revision };
}
async function seedRelease(seed: Seeded) {
  const event = await seedEvent(seed); const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, seed.projectId, seed.videoId, seed.assetId, event.id, event.revision, ids.admin, Date.now()).run();
  return { id, event };
}
/** A Review link with the Video as a member and the Versions granted. */
async function seedLink(seed: Seeded, assets: string[], input: { label?: string | null; expiresAt?: number; revoked?: boolean } = {}) {
  const link = await seedGuestLink({ label: input.label === undefined ? "Smith family" : input.label, expiresAt: input.expiresAt, revoked: input.revoked });
  await addMember(link.id, seed.videoId, assets);
  return link;
}

const wipe = async () => {
  await clearGuestRows(); await clearVideoNotes();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM notification_digest_items"), database.DB.prepare("DELETE FROM notification_delivery_ledger"), database.DB.prepare("DELETE FROM notification_outbox"),
    database.DB.prepare("DELETE FROM video_upload_reservations"),
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.%' OR action LIKE 'review_link.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await wipe(); await clearVideoFlags(); });

// ---- the order on every route ------------------------------------------------------------------------------------------------------------------------------

describe("the route order: malformed id, part off, capability, access, archived, row, body", () => {
  const BODY = { expected: { notes: 0, decisions: 0, release: false, links: 0 }, removeVideo: true };
  const calls = (assetId: string, videoId: string, projectId?: string): Array<{ name: string; method: "GET" | "POST"; path: string; body?: unknown; write: boolean }> => [
    { name: "removal-impact", method: "GET", path: p(`/video-versions/${assetId}/removal-impact`, projectId), write: false },
    { name: "remove", method: "POST", path: p(`/video-versions/${assetId}/remove`, projectId), body: BODY, write: true },
    { name: "restore version", method: "POST", path: p(`/video-versions/${assetId}/restore`, projectId), body: {}, write: true },
    { name: "restore video", method: "POST", path: p(`/videos/${videoId}/restore`, projectId), body: {}, write: true },
    { name: "trash list", method: "GET", path: p("/video-trash", projectId), write: false },
  ];

  it("answers 400 for a malformed id before anything else, even with the part off", async () => {
    await clearVideoFlags();
    for (const [method, path, body] of [
      ["GET", "/api/projects/not-a-uuid/video-trash"], ["GET", p("/video-versions/nope/removal-impact")], ["POST", p("/video-versions/nope/remove"), BODY], ["POST", p("/video-versions/nope/restore"), {}], ["POST", p("/videos/nope/restore"), {}],
    ] as const) expect((await request(path, "photographer", method, body)).status, path).toBe(400);
  });

  it("answers 404 when the part is off, whatever the role, the id or the body, and 404 when only the master or the pilot is off", async () => {
    const [v] = await seedVideo(1);
    for (const flags of [[], ["video_review", `video_review_pilot:${ids.project}`], ["video_review", "video_review_trash"], ["video_review_trash", `video_review_pilot:${ids.project}`]]) {
      await clearVideoFlags(); await setVideoFlags(...flags);
      for (const call of [...calls(v!.assetId, v!.videoId), ...calls(crypto.randomUUID(), crypto.randomUUID())]) {
        for (const who of ["admin", "photographer", "external"] as const) {
          const response = await request(call.path, who, call.method, call.body);
          expect(response.status, `${call.name} ${who} ${flags.join()}`).toBe(404);
        }
      }
    }
  });

  it("answers 403 to a Photographer and to an External editor (assigned or not); an Editor outside the Project still has access, because Admin and Editor both hold viewAllProjects", async () => {
    const [v] = await seedVideo(1);
    for (const call of calls(v!.assetId, v!.videoId)) {
      for (const who of ["photographer", "external", "externalOutsider"] as const) expect((await request(call.path, who, call.method, call.body)).status, `${call.name} ${who}`).toBe(403);
    }
    // The 403 "not assigned" branch is unreachable for the two roles that hold manageVideoTrash: an unassigned Editor sees every Project.
    expect((await request(p(`/video-versions/${v!.assetId}/removal-impact`), "other")).status).toBe(200);
    expect((await request(p("/video-trash"), "other")).status).toBe(200);
    // Nothing happened.
    expect(await audits(...AUDIT_ACTIONS)).toEqual([]);
  });

  it("answers an archived Project 409 on every write (before the row 404 and the body), and lets the two reads through", async () => {
    const [archived] = await seedVideo(1, { projectId: ids.archivedProject });
    for (const call of calls(archived!.assetId, archived!.videoId, ids.archivedProject)) {
      const response = await request(call.path, "admin", call.method, call.body);
      if (call.write) { expect(response.status, call.name).toBe(409); expect(await response.json()).toMatchObject({ code: "project_archived" }); } else expect(response.status, call.name).toBe(200);
    }
    for (const call of calls(crypto.randomUUID(), crypto.randomUUID(), ids.archivedProject).filter((entry) => entry.write)) {
      expect((await request(call.path, "admin", call.method, { not: "valid" })).status, `${call.name} unknown row`).toBe(409);
    }
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", archived!.assetId)).toEqual({ removed_at: null });
  });

  it("answers 404 for an unknown or other-Project row before the body is read", async () => {
    const [mine] = await seedVideo(1); const [elsewhere] = await seedVideo(1, { projectId: ids.otherProject });
    for (const [assetId, videoId] of [[crypto.randomUUID(), crypto.randomUUID()], [elsewhere!.assetId, elsewhere!.videoId]] as const) {
      for (const call of calls(assetId, videoId).filter((entry) => entry.name !== "trash list")) expect((await request(call.path, "admin", call.method, call.method === "POST" ? { garbage: true } : undefined)).status, call.name).toBe(404);
    }
    // A restore of a live Version or a live Video is also a 404: it is not in Trash.
    expect((await restoreVersion(mine!.assetId)).status).toBe(404);
    expect((await restoreVideo(mine!.videoId)).status).toBe(404);
  });

  it("answers 400 for a body that is not exactly the contract", async () => {
    const [v] = await seedVideo(2);
    for (const body of [{}, { removeVideo: false }, { expected: { notes: 0, decisions: 0, release: false, links: 0 } }, { ...BODY, removeVideo: "yes" }, { ...BODY, extra: 1 }, { ...BODY, expected: { ...BODY.expected, extra: 1 } }, { ...BODY, expected: { notes: -1, decisions: 0, release: false, links: 0 } }]) {
      expect((await remove(v!.assetId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(p(`/video-versions/${v!.assetId}/restore`), "admin", "POST", { extra: 1 })).status).toBe(404);
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v!.assetId)).toEqual({ removed_at: null });
  });

  it("lets Admin and an assigned Editor remove and restore", async () => {
    for (const who of ["admin", "member"] as const) {
      const [a, b] = await seedVideo(2);
      expect((await removeAuto(a!.assetId, who)).status, who).toBe(200);
      expect((await restoreVersion(a!.assetId, who)).status, who).toBe(200);
      expect((await request(p(`/video-versions/${b!.assetId}/removal-impact`), who)).status, who).toBe(200);
    }
  });
});

// ---- the impact --------------------------------------------------------------------------------------------------------------------------------------------

describe("removal impact", () => {
  it("counts notes and replies (a tombstone does not count), decisions, a live Release and the live Review links that grant the Version", async () => {
    const [v1, v2] = await seedVideo(2);
    const root = await seedVideoNote({ assetId: v2!.assetId, body: "first" }); await seedVideoNote({ assetId: v2!.assetId, body: "second", startFrame: 20 });
    await seedVideoNote({ assetId: v2!.assetId, parentId: root.id, body: "a reply" }); await seedVideoNote({ assetId: v2!.assetId, body: "gone", startFrame: 30, deletedAt: Date.now() });
    await seedVideoNote({ assetId: v1!.assetId, body: "elsewhere" });
    await seedEvent(v2!); await seedEvent(v2!, "changes_requested"); await seedEvent(v1!);
    await seedRelease(v2!);
    const live = await seedLink(v2!, [v2!.assetId, v1!.assetId], { label: "Beta" }); const unlabelled = await seedLink(v2!, [v2!.assetId], { label: null });
    await seedLink(v2!, [v2!.assetId], { revoked: true }); await seedLink(v2!, [v2!.assetId], { expiresAt: Date.now() - 1000 });
    const noGrant = await seedLink(v2!, [v1!.assetId]); void noGrant;
    const revokedGrant = await seedLink(v2!, [v2!.assetId]);
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.admin, revokedGrant.id).run();
    const removedMember = await seedLink(v2!, [v2!.assetId]);
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.admin, removedMember.id).run();

    const impact = await impactOf(v2!.assetId);
    expect(impact).toMatchObject({ lastVersion: false, uploading: false, notes: 3, decisions: 3, release: true });
    expect(impact.links).toEqual([{ id: live.id, label: "Beta" }, { id: unlabelled.id, label: null }].sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "") || a.id.localeCompare(b.id)));
    expect(await impactOf(v1!.assetId)).toMatchObject({ notes: 1, decisions: 1, release: false });
  });

  it("reports lastVersion for the only live Version, and uploading for an active reservation on the Video", async () => {
    const [a, b] = await seedVideo(2);
    expect((await impactOf(a!.assetId)).lastVersion).toBe(false);
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    expect((await impactOf(b!.assetId)).lastVersion).toBe(true);
    expect((await impactOf(b!.assetId)).uploading).toBe(false);
    const reservation = await seedReservation({ videoId: b!.videoId, status: "pending" });
    expect((await impactOf(b!.assetId)).uploading).toBe(true);
    await database.DB.prepare("UPDATE video_upload_reservations SET status = 'expired' WHERE id = ?").bind(reservation.id).run();
    expect((await impactOf(b!.assetId)).uploading).toBe(false);
  });

  it("is a 404 for a Version already in Trash and writes nothing", async () => {
    const [a] = await seedVideo(2);
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    expect((await request(p(`/video-versions/${a!.assetId}/removal-impact`), "admin")).status).toBe(404);
  });
});

// ---- remove ------------------------------------------------------------------------------------------------------------------------------------------------

describe("remove", () => {
  it("removes the current Version: the older one becomes current, the list and the stream drop it, the audit row carries counts and no text", async () => {
    const [v1, v2] = await seedVideo(2);
    await seedVideoNote({ assetId: v2!.assetId, body: "TOP-SECRET-NOTE-TEXT" }); await seedEvent(v2!);
    const impact = await impactOf(v2!.assetId);
    const before = Date.now();
    const response = await remove(v2!.assetId, { expected: expectedOf(impact), removeVideo: false });
    expect(response.status).toBe(200);
    const body = videoRemoveResponseSchema.parse(await response.json());
    expect(body.video?.currentAssetId).toBe(v1!.assetId); expect(body.video?.versions.map((version) => version.version)).toEqual([1]);
    const meta = await first("SELECT removed_at, removed_by, purge_at, removed_with_video FROM video_version_meta WHERE asset_id = ?", v2!.assetId);
    expect(meta).toMatchObject({ removed_by: ids.admin, removed_with_video: 0 });
    expect(meta!.removed_at as number).toBeGreaterThanOrEqual(before); expect(meta!.purge_at).toBe((meta!.removed_at as number) + VIDEO_TRASH_RETENTION_DAYS * DAY);
    expect(await currentVersions(v1!.videoId)).toEqual([1]);
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null });
    expect((await request(`/media/video/${v2!.assetId}`, "admin")).status).toBe(404);
    const list = videoListResponseSchema.parse(await (await request(p("/videos"), "admin")).json()); expect(list.videos[0]!.versions.map((version) => version.version)).toEqual([1]);
    const log = await audits(...AUDIT_ACTIONS);
    expect(log.map((row) => row.action)).toEqual(["video_version.remove"]);
    expect(log[0]).toMatchObject({ actor_id: ids.admin, target_type: "asset", target_id: v2!.assetId });
    expect(metaOf(log[0]!)).toMatchObject({ projectId: ids.project, videoId: v2!.videoId, version: 2, removeVideo: false, notes: 1, decisions: 1, release: false, links: 0 });
    expect(log[0]!.meta_json).not.toContain("TOP-SECRET"); expect(log[0]!.meta_json).not.toContain("secret decision note");
  });

  it("removes an older Version without touching which one is current", async () => {
    const [v1, v2] = await seedVideo(2);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    expect(videoRemoveResponseSchema.parse(await (await removeAuto(v2!.assetId)).json())).toEqual({ video: null });
  });

  it("removes the last Version with removeVideo: the Video goes with it, nothing is current, two audit rows, the collection count drops", async () => {
    const [a] = await seedVideo(1, { title: "Only" }); const [b] = await seedVideo(1, { title: "Other" });
    const collectionId = a!.collectionId;
    await database.DB.prepare("UPDATE collections SET received_count = 2, status = 'received' WHERE id = ?").bind(collectionId).run();
    const impact = await impactOf(a!.assetId); expect(impact.lastVersion).toBe(true);
    const response = await remove(a!.assetId, { expected: expectedOf(impact), removeVideo: true });
    expect(response.status).toBe(200); expect(videoRemoveResponseSchema.parse(await response.json())).toEqual({ video: null });
    const video = await first("SELECT removed_at, removed_by, purge_at FROM videos WHERE id = ?", a!.videoId);
    expect(video).toMatchObject({ removed_by: ids.admin }); expect(video!.purge_at).toBe((video!.removed_at as number) + VIDEO_TRASH_RETENTION_DAYS * DAY);
    expect(await first("SELECT removed_with_video, removed_at FROM video_version_meta WHERE asset_id = ?", a!.assetId)).toMatchObject({ removed_with_video: 1 });
    expect(await currentVersions(a!.videoId)).toEqual([]); expect(await currentVersions(b!.videoId)).toEqual([1]);
    expect(await first("SELECT received_count FROM collections WHERE id = ?", collectionId)).toEqual({ received_count: 1 });
    const log = await audits(...AUDIT_ACTIONS);
    expect(log.map((row) => `${row.action}:${row.target_type}`).sort()).toEqual(["video.remove:video", "video_version.remove:asset"]);
    expect(log.find((row) => row.action === "video.remove")).toMatchObject({ target_id: a!.videoId }); expect(metaOf(log.find((row) => row.action === "video_version.remove")!)).toMatchObject({ removeVideo: true });
    const list = videoListResponseSchema.parse(await (await request(p("/videos"), "admin")).json()); expect(list.videos.map((entry) => entry.id)).toEqual([b!.videoId]);
  });

  it("records the impersonating Admin in the audit row", async () => {
    const [a] = await seedVideo(2);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await request("/api/auth/admin/impersonate-user", "admin", "POST", { userId: ids.member }); expect(started.status).toBe(200);
      const cookies = new Map<string, string>();
      for (const value of (started.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const session = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const impact = await impactOf(a!.assetId);
      const response = await app.fetch(new Request(`https://portal.test${p(`/video-versions/${a!.assetId}/remove`)}`, { method: "POST", headers: { cookie: session, origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ expected: expectedOf(impact), removeVideo: false }) }), baseEnv, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext);
      expect(response.status).toBe(200);
      const [row] = await audits("video_version.remove"); expect(row).toMatchObject({ actor_id: ids.member }); expect(metaOf(row!)).toMatchObject({ impersonatedBy: ids.admin });
      expect(await first("SELECT removed_by FROM video_version_meta WHERE asset_id = ?", a!.assetId)).toEqual({ removed_by: ids.member });
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });

  it("refuses a stale impact 409 impact_changed with the fresh impact, and writes nothing, not even an audit row", async () => {
    const [, v2] = await seedVideo(2);
    const stale = expectedOf(await impactOf(v2!.assetId));
    await seedVideoNote({ assetId: v2!.assetId, body: "landed after the read" });
    const response = await remove(v2!.assetId, { expected: stale, removeVideo: false });
    expect(response.status).toBe(409);
    const refusal = videoRemovalRefusalSchema.parse(await response.json()); expect(refusal.code).toBe("impact_changed"); expect(refusal.impact.notes).toBe(1);
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v2!.assetId)).toEqual({ removed_at: null });
    expect(await audits(...AUDIT_ACTIONS)).toEqual([]);
    expect(await currentVersions(v2!.videoId)).toEqual([2]);
  });

  it("refuses each mismatched count and a mismatched release flag", async () => {
    const [v1, v2] = await seedVideo(2);
    await seedVideoNote({ assetId: v2!.assetId }); await seedEvent(v2!); await seedRelease(v2!); await seedLink(v2!, [v2!.assetId]);
    const good = expectedOf(await impactOf(v2!.assetId));
    expect(good).toMatchObject({ notes: 1, decisions: 2, release: true, links: 1 });
    for (const wrong of [{ notes: 0 }, { decisions: 0 }, { release: false }, { links: 0 }]) {
      const response = await remove(v2!.assetId, { expected: { ...good, ...wrong }, removeVideo: false }); expect(response.status, JSON.stringify(wrong)).toBe(409);
      expect(((await response.json()) as Json).code).toBe("impact_changed");
    }
    expect((await remove(v2!.assetId, { expected: good, removeVideo: false })).status).toBe(200);
    expect(v1).toBeTruthy();
  });

  it("refuses removeVideo that disagrees with the last-Version rule, 409 last_version with the impact", async () => {
    const [a, b] = await seedVideo(2);
    let response = await remove(a!.assetId, { expected: expectedOf(await impactOf(a!.assetId)), removeVideo: true });
    expect(response.status).toBe(409); let refusal = videoRemovalRefusalSchema.parse(await response.json()); expect(refusal.code).toBe("last_version"); expect(refusal.impact.lastVersion).toBe(false);
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    response = await remove(b!.assetId, { expected: expectedOf(await impactOf(b!.assetId)), removeVideo: false });
    expect(response.status).toBe(409); refusal = videoRemovalRefusalSchema.parse(await response.json()); expect(refusal.code).toBe("last_version"); expect(refusal.impact.lastVersion).toBe(true);
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", b!.videoId)).toEqual({ removed_at: null });
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", b!.assetId)).toEqual({ removed_at: null });
  });

  it("refuses removing the Video while an upload is active on it (409 upload_in_progress), and allows removing a Version meanwhile", async () => {
    const [a, b] = await seedVideo(2);
    const reservation = await seedReservation({ videoId: a!.videoId, status: "completing" });
    expect((await removeAuto(a!.assetId)).status, "a Version, mid-upload").toBe(200);
    const impact = await impactOf(b!.assetId); expect(impact).toMatchObject({ lastVersion: true, uploading: true });
    const response = await remove(b!.assetId, { expected: expectedOf(impact), removeVideo: true });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "upload_in_progress" });
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", b!.videoId)).toEqual({ removed_at: null });
    await database.DB.prepare("UPDATE video_upload_reservations SET status = 'completed' WHERE id = ?").bind(reservation.id).run();
    expect((await remove(b!.assetId, { expected: expectedOf(impact), removeVideo: true })).status).toBe(200);
  });

  it("is a 404 the second time: a Version already in Trash cannot be removed again", async () => {
    const [a] = await seedVideo(2);
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    expect((await remove(a!.assetId, { expected: { notes: 0, decisions: 0, release: false, links: 0 }, removeVideo: false })).status).toBe(404);
    expect(await audits("video_version.remove")).toHaveLength(1);
  });
});

// ---- restore -----------------------------------------------------------------------------------------------------------------------------------------------

describe("restore", () => {
  it("restoring an older Version leaves it non-current; restoring a newer one makes it current again", async () => {
    const [v1, v2, v3] = await seedVideo(3);
    expect((await removeAuto(v3!.assetId)).status).toBe(200); expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    let response = await restoreVersion(v1!.assetId); expect(response.status).toBe(200);
    let body = videoRestoreResponseSchema.parse(await response.json()); expect(body.video.currentAssetId).toBe(v2!.assetId); expect(body.video.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    response = await restoreVersion(v3!.assetId); expect(response.status).toBe(200);
    body = videoRestoreResponseSchema.parse(await response.json()); expect(body.video.currentAssetId).toBe(v3!.assetId);
    expect(await currentVersions(v1!.videoId)).toEqual([3]);
    expect(await first("SELECT removed_at, removed_by, purge_at, removed_with_video FROM video_version_meta WHERE asset_id = ?", v3!.assetId)).toEqual({ removed_at: null, removed_by: null, purge_at: null, removed_with_video: 0 });
    const log = await audits("video_version.restore"); expect(log.map((row) => row.target_id)).toEqual([v1!.assetId, v3!.assetId]);
    expect(metaOf(log[1]!)).toMatchObject({ projectId: ids.project, videoId: v3!.videoId, version: 3 });
  });

  it("is a 404 for a live Version, an unknown one and a purged one; 409 video_in_trash when its Video is in Trash", async () => {
    const [a, b] = await seedVideo(2);
    expect((await restoreVersion(a!.assetId)).status).toBe(404);
    expect((await restoreVersion(crypto.randomUUID())).status).toBe(404);
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    expect((await removeAuto(b!.assetId)).status).toBe(200);
    const response = await restoreVersion(a!.assetId); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "video_in_trash" });
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", a!.assetId)).not.toEqual({ removed_at: null });
    // Purged: the rows are gone.
    await database.DB.prepare("DELETE FROM assets WHERE id = ?").bind(a!.assetId).run();
    expect((await restoreVersion(a!.assetId)).status).toBe(404);
    await database.DB.batch([database.DB.prepare("DELETE FROM video_version_meta WHERE video_id = ?").bind(b!.videoId), database.DB.prepare("DELETE FROM assets WHERE version_group_id = ?").bind(b!.videoId), database.DB.prepare("DELETE FROM videos WHERE id = ?").bind(b!.videoId)]);
    expect((await restoreVideo(b!.videoId)).status).toBe(404);
  });

  it("restoring the Video brings back only the Versions removed with it; one removed on its own stays in Trash and restores afterwards, non-current", async () => {
    const [v1, v2, v3] = await seedVideo(3);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect((await removeAuto(v3!.assetId)).status).toBe(200);
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect(await first("SELECT removed_with_video FROM video_version_meta WHERE asset_id = ?", v2!.assetId)).toEqual({ removed_with_video: 1 });
    expect(await first("SELECT removed_with_video FROM video_version_meta WHERE asset_id = ?", v1!.assetId)).toEqual({ removed_with_video: 0 });
    const response = await restoreVideo(v1!.videoId); expect(response.status).toBe(200);
    const body = videoRestoreResponseSchema.parse(await response.json());
    expect(body.video.versions.map((version) => version.version)).toEqual([2]); expect(body.video.currentAssetId).toBe(v2!.assetId);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    expect(await first("SELECT removed_at, purge_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null, purge_at: null });
    expect((await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v1!.assetId))!.removed_at).not.toBeNull();
    expect((await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v3!.assetId))!.removed_at).not.toBeNull();
    expect((await restoreVersion(v1!.assetId)).status).toBe(200);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    expect((await restoreVideo(v1!.videoId)).status, "the Video is live now").toBe(404);
    const log = await audits("video.restore", "video_version.restore");
    expect(log.map((row) => `${row.action}:${row.target_id}`).sort()).toEqual([`video.restore:${v1!.videoId}`, `video_version.restore:${v1!.assetId}`, `video_version.restore:${v2!.assetId}`].sort());
  });

  it("restores a removed Video to the collection count", async () => {
    const [a] = await seedVideo(1);
    await database.DB.prepare("UPDATE collections SET received_count = 1, status = 'received' WHERE id = ?").bind(a!.collectionId).run();
    expect((await removeAuto(a!.assetId)).status).toBe(200);
    expect(await first("SELECT received_count, status FROM collections WHERE id = ?", a!.collectionId)).toEqual({ received_count: 0, status: "empty" });
    expect((await restoreVideo(a!.videoId)).status).toBe(200);
    expect(await first("SELECT received_count, status FROM collections WHERE id = ?", a!.collectionId)).toEqual({ received_count: 1, status: "received" });
  });

  it("brings back grants, memberships, a live Release, decisions, notes and markup byte for byte, and touches none of them while in Trash", async () => {
    const [v1, v2] = await seedVideo(2);
    const note = await seedVideoNote({ assetId: v2!.assetId, body: "keep me", markup: true }); await seedVideoNote({ assetId: v2!.assetId, parentId: note.id, body: "and my reply" });
    await seedEvent(v2!); await seedRelease(v2!); const link = await seedLink(v2!, [v1!.assetId, v2!.assetId]);
    const snapshot = async () => JSON.stringify(await Promise.all(["review_link_version_grants", "review_link_videos", "video_releases", "video_approval_events", "video_notes", "video_note_markup", "client_links"].map((table) => rows(`SELECT * FROM ${table} ORDER BY rowid`))));
    const before = await snapshot();
    expect(link.id).toBeTruthy();
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect(await snapshot(), "while in Trash").toBe(before);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect(await snapshot(), "Video in Trash").toBe(before);
    expect((await restoreVideo(v1!.videoId)).status).toBe(200); expect((await restoreVersion(v2!.assetId)).status).toBe(200);
    expect(await snapshot(), "after restore").toBe(before);
    expect(await impactOf(v2!.assetId)).toMatchObject({ notes: 2, decisions: 2, release: true });
    expect((await impactOf(v2!.assetId)).links).toHaveLength(1);
  });
});

// ---- the Trash list ----------------------------------------------------------------------------------------------------------------------------------------

describe("the Trash list", () => {
  it("is empty with the retention, then lists a Version and a Video, newest removal first, with who and when and the frozen purge time", async () => {
    expect(await trashList()).toEqual({ retentionDays: VIDEO_TRASH_RETENTION_DAYS, items: [] });
    const [a1, a2] = await seedVideo(2, { title: "Kitchen" }); const [b1, b2] = await seedVideo(2, { title: "Garden" }); const [c1] = await seedVideo(1, { title: "Hall" });
    await database.DB.prepare("UPDATE video_version_meta SET uploaded_by = uploaded_by").run();
    expect((await removeAuto(a1!.assetId, "member")).status).toBe(200);
    expect((await removeAuto(b1!.assetId)).status).toBe(200); expect((await removeAuto(b2!.assetId)).status).toBe(200);
    expect((await removeAuto(c1!.assetId)).status).toBe(200);
    const list = await trashList("member");
    expect(list.items.map((item) => `${item.kind}:${item.title}`)).toEqual(["video:Hall", "video:Garden", "version:Garden", "version:Kitchen"]);
    const garden = list.items.find((item) => item.title === "Garden")!; expect(garden).toMatchObject({ videoId: b1!.videoId, versionCount: 1, removedBy: { id: ids.admin } }); expect(garden.assetId).toBeUndefined();
    const kitchen = list.items.find((item) => item.title === "Kitchen")!; expect(kitchen).toMatchObject({ assetId: a1!.assetId, version: 1, removedBy: { id: ids.member } }); expect(kitchen.versionCount).toBeUndefined();
    for (const item of list.items) expect(Date.parse(item.purgeAt) - Date.parse(item.removedAt)).toBe(VIDEO_TRASH_RETENTION_DAYS * DAY);
    expect(a2).toBeTruthy();
    // A Version removed on its own stays listed when its Video is removed too, on its own clock, and says why it cannot be restored yet.
    const [d1, d2] = await seedVideo(2, { title: "Drive" });
    expect((await removeAuto(d1!.assetId)).status).toBe(200);
    const alone = (await trashList()).items.find((item) => item.assetId === d1!.assetId)!; expect(alone).toMatchObject({ kind: "version", canRestore: true }); expect(alone.restoreBlockedReason).toBeUndefined();
    expect((await removeAuto(d2!.assetId)).status).toBe(200);
    const both = (await trashList()).items.filter((item) => item.videoId === d1!.videoId);
    expect(both.map((item) => `${item.kind}:${item.version ?? ""}`).sort()).toEqual(["version:1", "video:"]);
    const version = both.find((item) => item.kind === "version")!; const video = both.find((item) => item.kind === "video")!;
    expect(video.versionCount).toBe(1); expect(video.canRestore).toBeUndefined();
    expect(version).toMatchObject({ assetId: d1!.assetId, canRestore: false, restoreBlockedReason: "video_in_trash" });
    expect(version.removedAt).toBe(alone.removedAt); expect(version.purgeAt).toBe(alone.purgeAt);
    expect(Date.parse(video.removedAt)).toBeGreaterThanOrEqual(Date.parse(version.removedAt));
    // The Video's purge takes the whole group, so a Version under a removed Video reports the earlier purge time, never a day that will not come.
    expect(Date.parse(version.purgeAt)).toBe(Math.min(Date.parse(alone.purgeAt), Date.parse(video.purgeAt)));
    const earlier = Date.now() + 2 * DAY;
    await database.DB.prepare("UPDATE videos SET purge_at = ? WHERE id = ?").bind(earlier, d1!.videoId).run();
    const capped = (await trashList()).items.filter((item) => item.videoId === d1!.videoId);
    expect(Date.parse(capped.find((item) => item.kind === "version")!.purgeAt)).toBe(earlier);
    expect(Date.parse(capped.find((item) => item.kind === "video")!.purgeAt)).toBe(earlier);
    expect((await restoreVersion(d1!.assetId)).status).toBe(409);
    expect((await restoreVideo(d1!.videoId)).status).toBe(200);
    const after = (await trashList()).items.filter((item) => item.videoId === d1!.videoId); expect(after.map((item) => `${item.kind}:${item.version}`)).toEqual(["version:1"]);
    expect(after[0]).toMatchObject({ canRestore: true });
  });

  it("keeps the purge time fixed at removal, and lists an archived Project", async () => {
    const [a] = await seedVideo(2, { projectId: ids.archivedProject, title: "Frozen" });
    const removedAt = Date.now() - 5 * DAY;
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ?, removed_by = ?, purge_at = ? WHERE asset_id = ?").bind(removedAt, ids.admin, removedAt + 7 * DAY, a!.assetId).run();
    const response = await request(p("/video-trash", ids.archivedProject), "admin"); expect(response.status).toBe(200);
    const list = videoTrashResponseSchema.parse(await response.json()); expect(Date.parse(list.items[0]!.purgeAt)).toBe(removedAt + 7 * DAY);
  });

  it("lists nothing from another Project", async () => {
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    const [a] = await seedVideo(2, { projectId: ids.otherProject }); expect((await request(p("/video-trash", ids.otherProject), "admin")).status).toBe(200);
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ?, removed_by = ?, purge_at = ? WHERE asset_id = ?").bind(Date.now(), ids.admin, Date.now() + DAY, a!.assetId).run();
    expect((await trashList()).items).toEqual([]);
  });
});

// ---- notifications -----------------------------------------------------------------------------------------------------------------------------------------

describe("outstanding notifications", () => {
  type Target = { assetId: string; videoId: string };
  async function seedDelivery(target: Target, status: "pending" | "queued" | "processing" | "completed", ledger: "pending" | "deferred" | "processing" | "sent", digest: "pending" | "sent" | null, tag: string) {
    const outboxId = crypto.randomUUID(); const now = Date.now(); const sourceKey = `video_note:${tag}`;
    const payload = JSON.stringify({ schemaVersion: 1, video: { kind: "video_note", projectId: ids.project, videoId: target.videoId, assetId: target.assetId, sourceId: tag } });
    const lease = status === "processing";
    await database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, lease_token, lease_expires_at, created_at, updated_at) VALUES (?, 1, 'project.video_review.notification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(outboxId, sourceKey, ids.project, ids.admin, ids.member, payload, status, now, lease ? "lease" : null, lease ? now + 60_000 : null, now, now).run();
    const ledgerId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, 'project.video_review.notification', ?, ?, 'email', ?, ?, ?)").bind(ledgerId, outboxId, sourceKey, ids.member, ledger, now, now).run();
    let digestId: string | null = null;
    if (digest) { digestId = crypto.randomUUID(); await database.DB.prepare("INSERT INTO notification_digest_items (id, recipient_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'project_video_review', ?, ?, ?)").bind(digestId, ids.member, ledgerId, ids.project, digest, now, now).run(); }
    return { outboxId, ledgerId, digestId };
  }
  const states = async (d: { outboxId: string; ledgerId: string; digestId: string | null }) => ({
    outbox: (await first("SELECT status FROM notification_outbox WHERE id = ?", d.outboxId))!.status,
    ledger: (await first("SELECT status FROM notification_delivery_ledger WHERE id = ?", d.ledgerId))!.status,
    digest: d.digestId ? (await first("SELECT state FROM notification_digest_items WHERE id = ?", d.digestId))!.state : null,
  });

  it("terminally suppresses outstanding deliveries and digest items for the removed Version only, and a restore never brings them back", async () => {
    const [v1, v2] = await seedVideo(2);
    const pending = await seedDelivery(v2!, "pending", "pending", null, "n1"); const queued = await seedDelivery(v2!, "queued", "pending", null, "n2");
    const deferred = await seedDelivery(v2!, "completed", "deferred", "pending", "n3"); const delivered = await seedDelivery(v2!, "completed", "sent", "sent", "n4");
    const processing = await seedDelivery(v2!, "processing", "pending", null, "n5"); const other = await seedDelivery(v1!, "pending", "pending", "pending", "n6");
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect(await states(pending)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: null });
    expect(await states(queued)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: null });
    expect(await states(deferred)).toEqual({ outbox: "completed", ledger: "suppressed", digest: "suppressed" });
    expect(await states(delivered)).toEqual({ outbox: "completed", ledger: "sent", digest: "sent" });
    expect(await states(processing)).toEqual({ outbox: "processing", ledger: "suppressed", digest: null });
    expect(await states(other)).toEqual({ outbox: "pending", ledger: "pending", digest: "pending" });
    expect((await restoreVersion(v2!.assetId)).status).toBe(200);
    expect(await states(pending)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: null });
    expect(await states(deferred)).toEqual({ outbox: "completed", ledger: "suppressed", digest: "suppressed" });
    expect(await states(other)).toEqual({ outbox: "pending", ledger: "pending", digest: "pending" });
  });

  it("a claimed outbox row (processing) does not let a stale email out: remove then Undo while the worker holds the lease, and the ledger and digest are suppressed, the lease untouched", async () => {
    const [, v2] = await seedVideo(2);
    const claimed = await seedDelivery(v2!, "processing", "pending", "pending", "n9");
    const deferredClaimed = await seedDelivery(v2!, "processing", "deferred", "pending", "n10");
    const inFlight = await seedDelivery(v2!, "processing", "processing", null, "n11");
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect((await restoreVersion(v2!.assetId)).status).toBe(200);
    // The worker resumes: its send claim needs a `pending` email ledger row, and there is none.
    expect(await states(claimed)).toEqual({ outbox: "processing", ledger: "suppressed", digest: "suppressed" });
    expect(await states(deferredClaimed)).toEqual({ outbox: "processing", ledger: "suppressed", digest: "suppressed" });
    expect(await first("SELECT lease_token, lease_expires_at FROM notification_outbox WHERE id = ?", claimed.outboxId)).toMatchObject({ lease_token: "lease" });
    // A send attempt already in flight is kept.
    expect(await states(inFlight)).toEqual({ outbox: "processing", ledger: "processing", digest: null });
  });

  it("removing the Video suppresses the notifications of every Version of it, and a refused removal suppresses nothing", async () => {
    const [v1, v2] = await seedVideo(2);
    const old = await seedDelivery(v1!, "pending", "pending", "pending", "n7"); const current = await seedDelivery(v2!, "pending", "pending", "pending", "n8");
    const stale = expectedOf(await impactOf(v2!.assetId)); await seedVideoNote({ assetId: v2!.assetId });
    expect((await remove(v2!.assetId, { expected: stale, removeVideo: false })).status).toBe(409);
    expect(await states(current)).toEqual({ outbox: "pending", ledger: "pending", digest: "pending" });
    expect((await removeAuto(v2!.assetId)).status).toBe(200); expect((await removeAuto(v1!.assetId)).status).toBe(200);
    for (const d of [old, current]) expect(await states(d)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: "suppressed" });
    expect((await restoreVideo(v1!.videoId)).status).toBe(200);
    for (const d of [old, current]) expect(await states(d)).toEqual({ outbox: "suppressed", ledger: "suppressed", digest: "suppressed" });
  });
});

// ---- real interleavings ------------------------------------------------------------------------------------------------------------------------------------

/** The real app against a D1 whose first batch of at least `min` statements runs `before` just ahead of itself: the handler's reads are done, its committing batch is not. */
async function racing(method: string, path: string, body: unknown, before: () => Promise<unknown>, options: { who?: Who; min?: number } = {}) {
  let ran = false;
  const db = new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!ran && statements.length >= (options.min ?? 5)) { ran = true; await before(); } return target.batch(statements); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const headers = new Headers({ cookie: await cookie(options.who ?? "admin"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" });
  const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, body: JSON.stringify(body) }), { ...baseEnv, DB: db } as Env, executionContext);
  expect(ran, "the committing batch ran through the proxy").toBe(true);
  return response;
}

describe("concurrency: the fence repeats in the committing batch", () => {
  const ZERO = { notes: 0, decisions: 0, release: false, links: 0 };

  it("two removals of the last two Versions without removeVideo: one wins, the other is told last_version, and one Version stays current", async () => {
    const [v1, v2] = await seedVideo(2);
    const response = await racing("POST", p(`/video-versions/${v1!.assetId}/remove`), { expected: ZERO, removeVideo: false }, async () => { expect((await remove(v2!.assetId, { expected: ZERO, removeVideo: false })).status).toBe(200); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "last_version", impact: { lastVersion: true } });
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v1!.assetId)).toEqual({ removed_at: null });
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null });
    expect(await currentVersions(v1!.videoId)).toEqual([1]);
    expect(await audits("video_version.remove")).toHaveLength(1);
  });

  it("two simultaneous removals of the last two Versions: exactly one 200 and one last_version", async () => {
    const [v1, v2] = await seedVideo(2);
    const results = await Promise.all([v1, v2].map((v) => remove(v!.assetId, { expected: ZERO, removeVideo: false })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = results.find((r) => r.status === 409)!; expect(await refused.json()).toMatchObject({ code: "last_version" });
    expect(await rows("SELECT asset_id FROM video_version_meta WHERE video_id = ? AND removed_at IS NULL", v1!.videoId)).toHaveLength(1);
    expect(await currentVersions(v1!.videoId)).toHaveLength(1);
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", v1!.videoId)).toEqual({ removed_at: null });
  });

  it("a decision that lands after the impact read makes the removal 409 impact_changed and removes nothing", async () => {
    const [, v2] = await seedVideo(2);
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/remove`), { expected: ZERO, removeVideo: false }, async () => { await seedEvent(v2!); });
    expect(response.status).toBe(409); const refusal = videoRemovalRefusalSchema.parse(await response.json()); expect(refusal).toMatchObject({ code: "impact_changed", impact: { decisions: 1 } });
    expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v2!.assetId)).toEqual({ removed_at: null });
    expect(await audits(...AUDIT_ACTIONS)).toEqual([]);
    expect(await currentVersions(v2!.videoId)).toEqual([2]);
  });

  it("Release then removal: a Release that landed after the impact read makes the removal stale; with the right expectation the removal wins and the Release is kept, hidden", async () => {
    const [, v2] = await seedVideo(2);
    const stale = await racing("POST", p(`/video-versions/${v2!.assetId}/remove`), { expected: ZERO, removeVideo: false }, async () => { await seedRelease(v2!); });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "impact_changed", impact: { release: true } });
    const impact = await impactOf(v2!.assetId);
    expect((await remove(v2!.assetId, { expected: expectedOf(impact), removeVideo: false })).status).toBe(200);
    expect(await rows("SELECT id FROM video_releases WHERE asset_id = ? AND withdrawn_at IS NULL", v2!.assetId)).toHaveLength(1);
  });

  it("removal then Release: a Release racing a removal is refused 404 and writes no Release row", async () => {
    const [, v2] = await seedVideo(2); const event = await seedEvent(v2!);
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/release`), { approvalRevision: event.revision }, async () => { expect((await removeAuto(v2!.assetId)).status).toBe(200); }, { min: 2 });
    expect(response.status).toBe(404);
    expect(await rows("SELECT id FROM video_releases WHERE asset_id = ?", v2!.assetId)).toEqual([]);
    expect(await audits("video_version.release")).toEqual([]);
  });

  it("a grant edit that lands after the impact read changes the links, so the removal is stale; a grant PUT while the Version is in Trash keeps its grant", async () => {
    const [v1, v2] = await seedVideo(2);
    const link = await seedLink(v2!, [v1!.assetId, v2!.assetId]);
    const grantsPath = p(`/review-links/${link.id}/videos/${v2!.videoId}/grants`);
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/remove`), { expected: { ...ZERO, links: 1 }, removeVideo: false }, async () => { expect((await request(grantsPath, "admin", "PUT", { assetIds: [v1!.assetId] })).status).toBe(200); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "impact_changed", impact: { links: [] } });
    expect((await request(grantsPath, "admin", "PUT", { assetIds: [v1!.assetId, v2!.assetId] })).status).toBe(200);
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect((await request(grantsPath, "admin", "PUT", { assetIds: [v1!.assetId] })).status).toBe(200);
    expect(await rows("SELECT asset_id FROM review_link_version_grants WHERE link_id = ? AND revoked_at IS NULL ORDER BY asset_id", link.id)).toHaveLength(2);
    expect((await restoreVersion(v2!.assetId)).status).toBe(200);
    expect((await impactOf(v2!.assetId)).links.map((entry) => entry.id)).toEqual([link.id]);
  });

  it("a Review link granted after the read is counted: the stale removal is refused", async () => {
    const [, v2] = await seedVideo(2);
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/remove`), { expected: ZERO, removeVideo: false }, async () => { const link = await seedLink(v2!, []); await grant(link.id, v2!.videoId, v2!.assetId); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "impact_changed" });
  });

  it("an upload that starts after the read blocks removing the Video", async () => {
    const [a] = await seedVideo(1);
    const response = await racing("POST", p(`/video-versions/${a!.assetId}/remove`), { expected: ZERO, removeVideo: true }, async () => { await seedReservation({ videoId: a!.videoId, status: "pending" }); });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "upload_in_progress" });
    expect(await first("SELECT removed_at FROM videos WHERE id = ?", a!.videoId)).toEqual({ removed_at: null });
    expect(await audits(...AUDIT_ACTIONS)).toEqual([]);
  });

  /** The collection's `updated_at`, which the count statement moves, for the Video. */
  const collectionStamp = async (videoId: string) => (await first("SELECT c.updated_at FROM collections c JOIN videos v ON v.collection_id = c.id WHERE v.id = ?", videoId))!.updated_at as number;
  const assetStamps = async (videoId: string) => rows("SELECT id, superseded_at, updated_at FROM assets WHERE version_group_id = ? ORDER BY id", videoId);
  const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
  const unarchive = () => database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();

  it("a Project archived after the read refuses the removal 409 project_archived and writes nothing", async () => {
    const [, v2] = await seedVideo(2);
    const stamp = await collectionStamp(v2!.videoId); const assets = await assetStamps(v2!.videoId); await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/remove`), { expected: ZERO, removeVideo: false }, async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); });
    try {
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "project_archived" });
      expect(await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v2!.assetId)).toEqual({ removed_at: null });
      expect(await audits(...AUDIT_ACTIONS)).toEqual([]);
      expect(await collectionStamp(v2!.videoId), "collections.updated_at").toBe(stamp);
      expect(await assetStamps(v2!.videoId), "assets").toEqual(assets);
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });

  it("a Project archived after the read refuses a Version restore and leaves the collection and the assets untouched, with no audit row", async () => {
    const [v1, v2] = await seedVideo(2); expect((await removeAuto(v2!.assetId)).status).toBe(200);
    const stamp = await collectionStamp(v1!.videoId); const assets = await assetStamps(v1!.videoId); await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await racing("POST", p(`/video-versions/${v2!.assetId}/restore`), {}, archive, { min: 3 });
    try {
      expect(response.status).toBe(409);
      expect((await first("SELECT removed_at FROM video_version_meta WHERE asset_id = ?", v2!.assetId))!.removed_at).not.toBeNull();
      expect(await audits("video_version.restore")).toEqual([]);
      expect(await collectionStamp(v1!.videoId), "collections.updated_at").toBe(stamp);
      expect(await assetStamps(v1!.videoId), "assets").toEqual(assets);
    } finally { await unarchive(); }
  });

  it("a restore racing a second removal of the same Version, and two simultaneous restores, leave one audit row each", async () => {
    const [v1, v2] = await seedVideo(2);
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    const results = await Promise.all([restoreVersion(v2!.assetId), restoreVersion(v2!.assetId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await audits("video_version.restore")).toHaveLength(1);
    expect(await currentVersions(v1!.videoId)).toEqual([2]);
    const again = await Promise.all([removeAuto(v2!.assetId), removeAuto(v2!.assetId)]);
    expect(again.map((r) => r.status).sort()).toContain(200);
    expect((await audits("video_version.remove")).length).toBeLessThanOrEqual(3);
    expect(await currentVersions(v1!.videoId)).toHaveLength(1);
  });

  it("a restore of a Video whose Project is archived after the read is refused and restores nothing", async () => {
    const [a] = await seedVideo(1); expect((await removeAuto(a!.assetId)).status).toBe(200);
    const stamp = await collectionStamp(a!.videoId); const assets = await assetStamps(a!.videoId); await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await racing("POST", p(`/videos/${a!.videoId}/restore`), {}, async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); }, { min: 3 });
    try {
      expect(response.status).toBe(409);
      expect((await first("SELECT removed_at FROM videos WHERE id = ?", a!.videoId))!.removed_at).not.toBeNull();
      expect(await audits("video.restore")).toEqual([]);
      expect(await collectionStamp(a!.videoId), "collections.updated_at").toBe(stamp);
      expect(await assetStamps(a!.videoId), "assets").toEqual(assets);
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });
});
