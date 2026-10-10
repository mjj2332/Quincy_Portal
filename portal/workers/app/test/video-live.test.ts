import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestVideoListResponseSchema, reviewLinkListResponseSchema, videoDecisionsResponseSchema, videoListResponseSchema, videoNoteListResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, guestFetch, linkPath, linkWithSession, verifySession } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, currentVersions, markVersionRemoved, markVideoRemoved, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Video Trash, slice B (#776): every read returns no removed row and every committing write is fenced on a live Version of a live Video. Nothing can remove a row yet
 * (the routes are slice C), so the fixture marks rows removed straight in SQL. The world: Video A has v1 (historical, live), v2 (in Trash) and v3 (current); Video B is in Trash whole;
 * Video C is untouched and proves the filter takes nothing else.
 */
const OPEN = ["video_review", "video_review_notes", "video_review_export", "video_review_links", "video_review_delivery", "video_review_guest", "video_review_guest_comments", `video_review_pilot:${ids.project}`] as const;
type Json = Record<string, any>;
const p = (rest: string) => `/api/projects/${ids.project}${rest}`;

type Seeded = Awaited<ReturnType<typeof seedVideoVersion>>;
type World = { a1: Seeded; a2: Seeded; a3: Seeded; b1: Seeded; c1: Seeded; notes: { a1: string; a2: string; a3: string; b1: string }; removedIds: string[] };

async function world(): Promise<World> {
  const a1 = await seedVideoVersion({ title: "Kitchen cut", poster: true });
  const a2 = await seedVideoVersion({ projectId: a1.projectId, videoId: a1.videoId, version: 2, poster: true });
  const a3 = await seedVideoVersion({ projectId: a1.projectId, videoId: a1.videoId, version: 3, poster: true });
  const b1 = await seedVideoVersion({ title: "Garden cut (trashed)", poster: true });
  const c1 = await seedVideoVersion({ title: "Control cut", poster: true });
  const notes = {
    a1: (await seedVideoNote({ assetId: a1.assetId, body: "note on history" })).id, a2: (await seedVideoNote({ assetId: a2.assetId, body: "note on trashed version" })).id,
    a3: (await seedVideoNote({ assetId: a3.assetId, body: "note on current" })).id, b1: (await seedVideoNote({ assetId: b1.assetId, body: "note on trashed video" })).id,
  };
  // History as upload completion leaves it: v1 and v2 superseded, v3 current.
  const now = Date.now();
  await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, a2.assetId, a1.assetId).run();
  await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, a3.assetId, a2.assetId).run();
  await markVersionRemoved(a2.assetId);
  await markVideoRemoved(b1.videoId);
  return { a1, a2, a3, b1, c1, notes, removedIds: [a2.assetId, b1.assetId, b1.videoId] };
}

const wipe = async () => {
  await clearGuestRows(); await clearVideoNotes();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.premium%' OR action LIKE 'review_link.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await wipe(); await clearVideoFlags(); });

const leaks = (text: string, w: World) => [...w.removedIds, "Garden cut (trashed)", "note on trashed version", "note on trashed video"].filter((needle) => text.includes(needle));
const rows = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all<Json>()).results;

describe("staff reads return no removed row", () => {
  it("the Video list drops a trashed Video and a trashed Version, keeps the historical live Version, and leaks neither id nor title", async () => {
    const w = await world();
    for (const who of ["admin", "member"] as const) {
      const response = await request(p("/videos"), who); expect(response.status, who).toBe(200);
      const text = await response.text(); expect(leaks(text, w), who).toEqual([]);
      const body = videoListResponseSchema.parse(JSON.parse(text));
      expect(body.videos.map((video) => video.id).sort()).toEqual([w.a1.videoId, w.c1.videoId].sort());
      const a = body.videos.find((video) => video.id === w.a1.videoId)!;
      expect(a.versions.map((version) => version.version)).toEqual([3, 1]);
      expect(a.currentAssetId).toBe(w.a3.assetId);
      expect(a.versions.find((version) => version.version === 1)).toMatchObject({ assetId: w.a1.assetId, current: false });
    }
  });

  it("counts open notes on the current Version only, and never a trashed Version's notes", async () => {
    const w = await world();
    const body = videoListResponseSchema.parse(await (await request(p("/videos"), "admin")).json());
    expect(body.videos.find((video) => video.id === w.a1.videoId)!.latestNoteCount).toBe(1);
  });

  it("streams and posters: a trashed Version and a trashed Video are 404, a historical live Version still plays", async () => {
    const w = await world();
    for (const asset of [w.a2.assetId, w.b1.assetId]) {
      expect((await request(`/media/video/${asset}`, "admin")).status, `stream ${asset}`).toBe(404);
      expect((await request(`/media/video/${asset}/poster`, "admin")).status, `poster ${asset}`).toBe(404);
    }
    for (const asset of [w.a1.assetId, w.a3.assetId, w.c1.assetId]) {
      expect((await request(`/media/video/${asset}`, "admin")).status, `stream ${asset}`).toBe(200);
      expect((await request(`/media/video/${asset}/poster`, "admin")).status, `poster ${asset}`).toBe(200);
    }
  });

  it("notes: list, create, and every by-id read and write on a trashed Version or Video are 404; the historical Version's notes still read", async () => {
    const w = await world();
    expect((await request(p(`/video-versions/${w.a1.assetId}/notes`), "admin")).status).toBe(200);
    const history = videoNoteListResponseSchema.parse(await (await request(p(`/video-versions/${w.a1.assetId}/notes`), "admin")).json());
    expect(history.notes.map((note) => note.id)).toEqual([w.notes.a1]);
    for (const asset of [w.a2.assetId, w.b1.assetId]) {
      expect((await request(p(`/video-versions/${asset}/notes`), "admin")).status, `list ${asset}`).toBe(404);
      expect((await request(p(`/video-versions/${asset}/notes`), "admin", "POST", { startFrame: 10, visibility: "public", body: "late" })).status, `create ${asset}`).toBe(404);
    }
    for (const noteId of [w.notes.a2, w.notes.b1]) {
      expect((await request(p(`/video-notes/${noteId}/replies`), "admin", "POST", { body: "x" })).status, `reply ${noteId}`).toBe(404);
      expect((await request(p(`/video-notes/${noteId}`), "admin", "PATCH", { expectedRevision: 1, body: "y" })).status, `edit ${noteId}`).toBe(404);
      expect((await request(p(`/video-notes/${noteId}`), "admin", "DELETE", { expectedRevision: 1 })).status, `delete ${noteId}`).toBe(404);
      expect((await request(p(`/video-notes/${noteId}/resolution`), "admin", "PUT", { resolved: true })).status, `resolve ${noteId}`).toBe(404);
      expect((await request(p(`/video-notes/${noteId}/markup`), "admin")).status, `markup ${noteId}`).toBe(404);
    }
    // Nothing landed on the trashed rows.
    expect(await rows("SELECT id FROM video_notes WHERE asset_id IN (?, ?) AND (body <> 'note on trashed version' AND body <> 'note on trashed video' OR deleted_at IS NOT NULL OR resolved_at IS NOT NULL OR parent_id IS NOT NULL)", w.a2.assetId, w.b1.assetId)).toEqual([]);
    // The live Version of the same Video is unaffected.
    expect((await request(p(`/video-notes/${w.notes.a3}/replies`), "admin", "POST", { body: "still fine" })).status).toBe(201);
  });

  it("paste: a trashed Version is neither a source nor a target, in preview and commit", async () => {
    const w = await world();
    const noteBody = { sourceAssetId: w.a2.assetId, noteIds: [w.notes.a2] };
    expect((await request(p(`/video-versions/${w.a3.assetId}/note-paste/preview`), "admin", "POST", noteBody)).status, "source in Trash").toBe(404);
    expect((await request(p(`/video-versions/${w.a2.assetId}/note-paste/preview`), "admin", "POST", { sourceAssetId: w.a1.assetId, noteIds: [w.notes.a1] })).status, "target in Trash").toBe(404);
    expect((await request(p(`/video-versions/${w.a3.assetId}/note-paste`), "admin", "POST", { sourceAssetId: w.a2.assetId, notes: [{ noteId: w.notes.a2, revision: 1 }] })).status, "commit, source in Trash").toBe(404);
    expect((await request(p(`/video-versions/${w.a2.assetId}/note-paste`), "admin", "POST", { sourceAssetId: w.a1.assetId, notes: [{ noteId: w.notes.a1, revision: 1 }] })).status, "commit, target in Trash").toBe(404);
    expect((await request(p(`/video-versions/${w.a3.assetId}/note-paste/preview`), "admin", "POST", { sourceAssetId: w.a1.assetId, noteIds: [w.notes.a1] })).status, "live pair").toBe(200);
    expect(await rows("SELECT id FROM video_notes WHERE copied_from_note_id IS NOT NULL")).toEqual([]);
  });

  it("marker export: 404 for a trashed Version or Video, 200 for the historical Version", async () => {
    const w = await world();
    for (const asset of [w.a2.assetId, w.b1.assetId]) expect((await request(p(`/video-versions/${asset}/marker-export?format=edl`), "admin")).status, asset).toBe(404);
    expect((await request(p(`/video-versions/${w.a1.assetId}/marker-export?format=edl`), "admin")).status).toBe(200);
    expect(await rows("SELECT id FROM audit_log WHERE action = 'video_note.export' AND target_id IN (?, ?)", w.a2.assetId, w.b1.assetId)).toEqual([]);
  });

  it("decisions, Releases and premium: reads are 404 for trashed rows, every write is refused and writes nothing; the historical Version still takes a decision", async () => {
    const w = await world();
    expect((await request(p(`/videos/${w.b1.videoId}/decisions`), "admin")).status).toBe(404);
    const decisions = videoDecisionsResponseSchema.parse(await (await request(p(`/videos/${w.a1.videoId}/decisions`), "admin")).json());
    expect(decisions.versions.map((version) => version.version)).toEqual([3, 1]);
    for (const asset of [w.a2.assetId, w.b1.assetId]) {
      expect((await request(p(`/video-versions/${asset}/decisions`), "admin", "POST", { decision: "approved" })).status, `decide ${asset}`).toBe(404);
      expect((await request(p(`/video-versions/${asset}/release`), "admin", "POST", { approvalRevision: 1 })).status, `release ${asset}`).toBe(404);
      expect((await request(p(`/video-versions/${asset}/release`), "admin", "DELETE")).status, `withdraw ${asset}`).toBe(404);
    }
    expect((await request(p(`/videos/${w.b1.videoId}/premium`), "admin", "PUT", { premium: true })).status).toBe(404);
    expect((await request(p(`/videos/${w.b1.videoId}/premium-unlock`), "admin", "PUT", { unlocked: true, paymentRef: "ref" })).status).toBe(404);
    expect(await rows("SELECT id FROM video_approval_events WHERE asset_id IN (?, ?)", w.a2.assetId, w.b1.assetId)).toEqual([]);
    expect(await rows("SELECT premium FROM videos WHERE id = ?", w.b1.videoId)).toEqual([{ premium: 0 }]);
    expect((await request(p(`/video-versions/${w.a1.assetId}/decisions`), "admin", "POST", { decision: "approved" })).status).toBe(201);
  });

  it("the committing statements repeat the fence: a removal that lands after the route's read still writes nothing", async () => {
    const w = await world();
    const { recordStaffDecision, releaseVersion } = await import("../src/lib/video-approval");
    const principal = { id: ids.admin };
    expect(await recordStaffDecision(database.DB, { projectId: ids.project, assetId: w.a2.assetId, principal, decision: "approved", note: null, now: Date.now() })).toBeNull();
    expect(await recordStaffDecision(database.DB, { projectId: ids.project, assetId: w.b1.assetId, principal, decision: "approved", note: null, now: Date.now() })).toBeNull();
    // A live approval exists, then its Version goes to Trash before the Release commits.
    const event = await recordStaffDecision(database.DB, { projectId: ids.project, assetId: w.a3.assetId, principal, decision: "approved", note: null, now: Date.now() });
    expect(event).not.toBeNull();
    await markVersionRemoved(w.a3.assetId);
    const released = await releaseVersion(database.DB, { projectId: ids.project, assetId: w.a3.assetId, principal, approvalRevision: event!.revision, now: Date.now() });
    expect("release" in released).toBe(false);
    expect(await rows("SELECT id FROM video_releases WHERE asset_id = ?", w.a3.assetId)).toEqual([]);
  });
});

describe("Review links", () => {
  async function linked(w: World) {
    const link = await linkWithSession();
    await addMember(link.id, w.a1.videoId, [w.a1.assetId, w.a2.assetId, w.a3.assetId]);
    await addMember(link.id, w.b1.videoId, [w.b1.assetId]);
    await addMember(link.id, w.c1.videoId, [w.c1.assetId]);
    return link;
  }
  const grantsOf = async (linkId: string, videoId: string) => (await rows("SELECT asset_id FROM review_link_version_grants WHERE link_id = ? AND video_id = ? AND revoked_at IS NULL ORDER BY asset_id", linkId, videoId)).map((row) => row.asset_id).sort();

  it("the staff DTO hides a trashed Video and a trashed Version's grant, and leaks neither", async () => {
    const w = await world(); const link = await linked(w);
    const response = await request(p("/review-links"), "admin"); expect(response.status).toBe(200);
    const text = await response.text(); expect(leaks(text, w)).toEqual([]);
    const dto = reviewLinkListResponseSchema.parse(JSON.parse(text)).links.find((entry) => entry.id === link.id)!;
    expect(dto.videos.map((video) => video.videoId).sort()).toEqual([w.a1.videoId, w.c1.videoId].sort());
    expect(dto.videos.find((video) => video.videoId === w.a1.videoId)!.grants.map((grant) => grant.version)).toEqual([1, 3]);
  });

  it("create and add-Video refuse a trashed Video (422) and a grant on a trashed Version (422), writing nothing", async () => {
    const w = await world(); const link = await linked(w);
    const before = (await rows("SELECT count(*) AS n FROM client_links"))[0]!.n;
    expect((await request(p("/review-links"), "admin", "POST", { videoIds: [w.b1.videoId] })).status).toBe(422);
    expect((await request(p("/review-links"), "admin", "POST", { videoIds: [w.a1.videoId], grants: { [w.a1.videoId]: [w.a2.assetId] } })).status).toBe(422);
    expect((await request(p(`/review-links/${link.id}/videos`), "admin", "POST", { videoId: w.b1.videoId, assetIds: [w.b1.assetId] })).status).toBe(422);
    expect((await rows("SELECT count(*) AS n FROM client_links"))[0]!.n).toBe(before);
  });

  it("a grant PUT revokes only omitted LIVE grants and keeps the grant on a trashed Version; a trashed Video is 404", async () => {
    const w = await world(); const link = await linked(w);
    const response = await request(p(`/review-links/${link.id}/videos/${w.a1.videoId}/grants`), "admin", "PUT", { assetIds: [w.a3.assetId] });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await grantsOf(link.id, w.a1.videoId)).toEqual([w.a2.assetId, w.a3.assetId].sort());
    expect(await rows("SELECT revoked_at FROM review_link_version_grants WHERE link_id = ? AND asset_id = ?", link.id, w.a1.assetId)).toEqual([{ revoked_at: expect.any(Number) }]);
    expect((await request(p(`/review-links/${link.id}/videos/${w.b1.videoId}/grants`), "admin", "PUT", { assetIds: [w.b1.assetId] })).status).toBe(404);
    expect(await grantsOf(link.id, w.b1.videoId)).toEqual([w.b1.assetId]);
  });

  it("the committing statement repeats the live-grant rule: a Version trashed between the read and the commit keeps its grant", async () => {
    const w = await world(); const link = await linked(w);
    const { setLinkGrants } = await import("../src/lib/review-links");
    await markVersionRemoved(w.a1.assetId);
    const landed = await setLinkGrants(database.DB, { projectId: ids.project, linkId: link.id, principal: { id: ids.admin }, videoId: w.a1.videoId, assetIds: [w.a3.assetId], now: Date.now() });
    expect(landed).toBe(true);
    expect(await grantsOf(link.id, w.a1.videoId)).toEqual([w.a1.assetId, w.a2.assetId, w.a3.assetId].sort());
  });
});

describe("guest reads and writes", () => {
  async function guestWorld() {
    const w = await world();
    const link = await linkWithSession();
    await addMember(link.id, w.a1.videoId, [w.a1.assetId, w.a2.assetId, w.a3.assetId]);
    await addMember(link.id, w.b1.videoId, [w.b1.assetId]);
    await addMember(link.id, w.c1.videoId, [w.c1.assetId]);
    await verifySession(link);
    return { w, link };
  }
  const get = (link: { id: string; cookie: string }, rest: string) => guestFetch(linkPath(link.id, rest), { cookie: link.cookie });

  it("the guest Video list shows no trashed row and leaks none; the historical live Version is listed", async () => {
    const { w, link } = await guestWorld();
    const response = await get(link, "/videos"); expect(response.status).toBe(200);
    const text = await response.text(); expect(leaks(text, w)).toEqual([]);
    const body = guestVideoListResponseSchema.parse(JSON.parse(text));
    expect(body.videos.map((video) => video.id).sort()).toEqual([w.a1.videoId, w.c1.videoId].sort());
    expect(body.videos.find((video) => video.id === w.a1.videoId)!.versions.map((version) => version.version)).toEqual([3, 1]);
  });

  it("stream, poster, notes and markup of a trashed Version or Video are the stub; the historical Version still answers", async () => {
    const { w, link } = await guestWorld();
    const stub = await (await get(link, `/versions/${crypto.randomUUID()}/stream`)).text();
    for (const asset of [w.a2.assetId, w.b1.assetId]) {
      for (const rest of ["stream", "poster", "notes"]) {
        const response = await get(link, `/versions/${asset}/${rest}`);
        expect(response.status, `${rest} ${asset}`).toBe(404);
        expect(await response.text(), `${rest} ${asset}`).toBe(stub);
      }
    }
    for (const noteId of [w.notes.a2, w.notes.b1]) expect((await get(link, `/notes/${noteId}/markup`)).status, `markup ${noteId}`).toBe(404);
    for (const rest of ["stream", "poster", "notes"]) expect((await get(link, `/versions/${w.a1.assetId}/${rest}`)).status, `history ${rest}`).toBe(200);
  });

  it("guest writes on a trashed Version or Video are refused and write nothing", async () => {
    const { w, link } = await guestWorld();
    for (const asset of [w.a2.assetId, w.b1.assetId]) {
      expect((await guestFetch(linkPath(link.id, `/versions/${asset}/notes`), { method: "POST", cookie: link.cookie, body: { startFrame: 10, body: "hi" } })).status, `note ${asset}`).toBe(404);
      expect((await guestFetch(linkPath(link.id, `/versions/${asset}/decision`), { method: "POST", cookie: link.cookie, body: { decision: "approved" } })).status, `decision ${asset}`).toBe(404);
    }
    for (const noteId of [w.notes.a2, w.notes.b1]) expect((await guestFetch(linkPath(link.id, `/notes/${noteId}/replies`), { method: "POST", cookie: link.cookie, body: { body: "hi" } })).status, `reply ${noteId}`).toBe(404);
    expect(await rows("SELECT id FROM video_approval_events WHERE asset_id IN (?, ?)", w.a2.assetId, w.b1.assetId)).toEqual([]);
    expect(await rows("SELECT id FROM video_notes WHERE author_guest_id IS NOT NULL AND asset_id IN (?, ?) AND body <> 'x'", w.a2.assetId, w.b1.assetId)).toEqual([]);
    expect((await guestFetch(linkPath(link.id, `/versions/${w.a1.assetId}/decision`), { method: "POST", cookie: link.cookie, body: { decision: "approved" } })).status).toBe(201);
  });

  it("downloads: a Release on a trashed Version or Video is not downloadable and not in the manifest", async () => {
    const { w, link } = await guestWorld();
    const now = Date.now();
    for (const [videoId, assetId] of [[w.a1.videoId, w.a2.assetId], [w.b1.videoId, w.b1.assetId], [w.c1.videoId, w.c1.assetId]] as const) {
      const event = crypto.randomUUID();
      await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)").bind(event, ids.project, videoId, assetId, ids.admin, now).run();
      await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(crypto.randomUUID(), ids.project, videoId, assetId, event, ids.admin, now).run();
    }
    for (const asset of [w.a2.assetId, w.b1.assetId]) expect((await get(link, `/versions/${asset}/download`)).status, asset).toBe(404);
    expect((await get(link, `/versions/${w.c1.assetId}/download`)).status).toBe(200);
    const manifest = await get(link, "/downloads"); const text = await manifest.text();
    expect(manifest.status).toBe(200);
    expect(leaks(text, w)).toEqual([]);
    expect(text).toContain("Control cut");
  });
});

describe("the current-Version invariant", () => {
  it("RECOMPUTE_CURRENT_SQL leaves exactly one current Version per live Video, the newest live one, and none for a removed Video", async () => {
    const { RECOMPUTE_CURRENT_SQL } = await import("../src/lib/video-live-sql");
    const w = await world();
    // Corrupt the state the ways a race could: v1 and v3 both current, the removed v2 current, and the trashed Video's Version current.
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id IN (?, ?, ?, ?)").bind(w.a1.assetId, w.a2.assetId, w.a3.assetId, w.b1.assetId).run();
    for (const videoId of [w.a1.videoId, w.b1.videoId, w.c1.videoId]) for (const sql of RECOMPUTE_CURRENT_SQL) await database.DB.prepare(sql).bind(videoId, Date.now()).run();
    expect(await currentVersions(w.a1.videoId)).toEqual([3]);
    expect(await currentVersions(w.b1.videoId)).toEqual([]);
    expect(await currentVersions(w.c1.videoId)).toEqual([1]);
    // The newest live Version is promoted when the one above it is trashed.
    await markVersionRemoved(w.a3.assetId);
    for (const sql of RECOMPUTE_CURRENT_SQL) await database.DB.prepare(sql).bind(w.a1.videoId, Date.now()).run();
    expect(await currentVersions(w.a1.videoId)).toEqual([1]);
    // Idempotent, and a row already superseded keeps its timestamp.
    const before = await rows("SELECT id, superseded_at FROM assets WHERE version_group_id = ? ORDER BY version", w.a1.videoId);
    for (const sql of RECOMPUTE_CURRENT_SQL) await database.DB.prepare(sql).bind(w.a1.videoId, Date.now() + 5000).run();
    expect(await rows("SELECT id, superseded_at FROM assets WHERE version_group_id = ? ORDER BY version", w.a1.videoId)).toEqual(before);
  });
});

