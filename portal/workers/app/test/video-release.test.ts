import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoDecisionsResponseSchema, videoListResponseSchema, videoPremiumResponseSchema, videoReleaseResponseSchema, videoDecisionRecordedResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { addMember, clearGuestRows, linkPath, openGuestGate, seedGuestLink, startSession } from "./guest-support";
import { hashToken } from "../src/lib/opaque-token";
import { guestFetch } from "./guest-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff approval, Release and premium (#741 14a): the order matrix, the Release CAS, withdraw, premium and unlock, and the audit rows. */
type Json = Record<string, any>;
const OPEN = ["video_review", "video_review_delivery", "video_review_guest", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
const json = async (response: Response) => await response.json() as Json;
const p = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}${rest}`;
const decisionsOf = (videoId: string) => p(`/videos/${videoId}/decisions`);
const recordPath = (assetId: string, projectId?: string) => p(`/video-versions/${assetId}/decisions`, projectId);
const releasePath = (assetId: string, projectId?: string) => p(`/video-versions/${assetId}/release`, projectId);
const premiumPath = (videoId: string, projectId?: string) => p(`/videos/${videoId}/premium`, projectId);
const unlockPath = (videoId: string, projectId?: string) => p(`/videos/${videoId}/premium-unlock`, projectId);

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.premium%'"),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-14a.test'"),
    database.DB.prepare("DELETE FROM video_notes"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
let v1: Awaited<ReturnType<typeof seedVideoVersion>>;
let v2: Awaited<ReturnType<typeof seedVideoVersion>>;
let archivedVideo: Awaited<ReturnType<typeof seedVideoVersion>>;
beforeEach(async () => {
  await clearGuestRows(); await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN);
  v1 = await seedVideoVersion({ title: "Hero" });
  v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
  archivedVideo = await seedVideoVersion({ projectId: ids.archivedProject, title: "Frozen" });
});
afterEach(async () => { await clearGuestRows(); await wipe(); await clearVideoFlags(); });

const events = async (assetId: string) => (await database.DB.prepare("SELECT * FROM video_approval_events WHERE asset_id = ? ORDER BY revision").bind(assetId).all<Json>()).results;
const releases = async (assetId: string) => (await database.DB.prepare("SELECT * FROM video_releases WHERE asset_id = ? ORDER BY released_at, rowid").bind(assetId).all<Json>()).results;
const liveReleases = async (assetId: string) => (await releases(assetId)).filter((row) => row.withdrawn_at === null);
const audits = async (...actions: string[]) => (await database.DB.prepare(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action IN (${actions.map(() => "?").join(",")}) ORDER BY created_at, rowid`).bind(...actions).all<Json>()).results;
const unlockRow = (videoId: string) => database.DB.prepare("SELECT * FROM video_premium_unlocks WHERE video_id = ?").bind(videoId).first<Json>();
const premiumOf = async (videoId: string) => (await database.DB.prepare("SELECT premium FROM videos WHERE id = ?").bind(videoId).first<{ premium: number }>())!.premium;

/** A client decision straight into the table: by a guest on a link, or by staff (no link). */
async function seedEvent(input: { assetId: string; videoId: string; decision: "approved" | "changes_requested"; revision?: number; guest?: { id: string; linkId: string } | null; note?: string | null }) {
  const id = crypto.randomUUID();
  const revision = input.revision ?? ((await database.DB.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM video_approval_events WHERE asset_id = ?").bind(input.assetId).first<{ next: number }>())!.next);
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ids.project, input.videoId, input.assetId, input.guest?.linkId ?? null, revision, input.decision, input.note ?? null, input.guest?.id ?? null, input.guest ? null : ids.admin, Date.now()).run();
  return { id, revision };
}
async function seedGuest(name = "Gina Guest", email = `${crypto.randomUUID()}@guest-14a.test`) {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, ?, ?)").bind(id, email, name, Date.now()).run();
  return { id, email, name };
}
const record = (assetId: string, body: unknown, who: Who = "admin") => request(recordPath(assetId), who, "POST", body);
const release = (assetId: string, approvalRevision: unknown, who: Who = "admin") => request(releasePath(assetId), who, "POST", { approvalRevision });
const withdraw = (assetId: string, who: Who = "admin") => request(releasePath(assetId), who, "DELETE");

describe("the delivery gate and the route order", () => {
  const calls = (assetId: string, videoId: string, projectId?: string): Array<[string, string, Json?]> => [
    ["GET", p(`/videos/${videoId}/decisions`, projectId)], ["POST", recordPath(assetId, projectId), { decision: "approved" }], ["POST", releasePath(assetId, projectId), { approvalRevision: 1 }],
    ["DELETE", releasePath(assetId, projectId)], ["PUT", premiumPath(videoId, projectId), { premium: true }], ["PUT", unlockPath(videoId, projectId), { unlocked: true }],
  ];
  it("answers one 404 for a real and an unknown id on every route when the master, the delivery part or the Project's pilot is off", async () => {
    const closings: Array<[string, () => Promise<void>]> = [
      ["master off", async () => { await clearVideoFlags(); await setVideoFlags("video_review_delivery", `video_review_pilot:${ids.project}`); }],
      ["delivery off", async () => { await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`, "video_review_guest", "video_review_links"); }],
      ["another Project's pilot", async () => { await clearVideoFlags(); await setVideoFlags("video_review", "video_review_delivery", `video_review_pilot:${ids.otherProject}`); }],
    ];
    for (const [label, close] of closings) {
      await close();
      for (const who of ["admin", "member", "photographer", "external"] as const) {
        const real = calls(v1.assetId, v1.videoId); const unknown = calls(crypto.randomUUID(), crypto.randomUUID());
        for (let index = 0; index < real.length; index += 1) {
          const [method, path, body] = real[index]!; const [, unknownPath] = unknown[index]!;
          const a = await request(path, who, method as "GET", body); const b = await request(unknownPath, who, method as "GET", body);
          expect([a.status, b.status], `${label} ${who} ${method} ${path}`).toEqual([404, 404]);
          expect(await json(a), label).toEqual(await json(b));
        }
      }
    }
    expect(await events(v1.assetId)).toHaveLength(0); expect(await unlockRow(v1.videoId)).toBeNull();
  });

  it("answers 400 for a malformed id before the gate", async () => {
    await clearVideoFlags();
    for (const [method, path, body] of [["GET", p("/videos/nope/decisions")], ["POST", p("/video-versions/nope/decisions"), { decision: "approved" }], ["POST", p("/video-versions/nope/release"), { approvalRevision: 1 }],
      ["DELETE", p("/video-versions/nope/release")], ["PUT", p("/videos/nope/premium"), { premium: true }], ["PUT", p("/videos/nope/premium-unlock"), { unlocked: true }],
      ["GET", `/api/projects/nope/videos/${v1.videoId}/decisions`]] as Array<[string, string, Json?]>) {
      expect((await request(path, "admin", method as "GET", body)).status, `${method} ${path}`).toBe(400);
    }
  });

  it("checks the capability after the gate: shareVideo reads, releaseVideo records and releases, manageVideoPremium (Admin only) sets premium", async () => {
    const cases: Array<[string, string, Json | undefined, Who[], Who[]]> = [
      ["GET", decisionsOf(v1.videoId), undefined, ["admin", "member"], ["photographer", "external", "externalOutsider"]],
      ["POST", recordPath(v1.assetId), { decision: "approved" }, ["admin", "member"], ["photographer", "external", "externalOutsider"]],
      ["PUT", premiumPath(v1.videoId), { premium: true }, ["admin"], ["member", "photographer", "external", "externalOutsider"]],
      ["PUT", unlockPath(v1.videoId), { unlocked: true }, ["admin"], ["member", "photographer", "external", "externalOutsider"]],
    ];
    for (const [method, path, body, allowed, denied] of cases) {
      for (const who of allowed) expect([200, 201], `${who} ${method} ${path}`).toContain((await request(path, who, method as "GET", body)).status);
      for (const who of denied) expect((await request(path, who, method as "GET", body)).status, `${who} ${method} ${path}`).toBe(403);
    }
    expect((await release(v1.assetId, 99, "member")).status).toBe(409);
    for (const who of ["photographer", "external"] as const) { expect((await release(v1.assetId, 1, who)).status).toBe(403); expect((await withdraw(v1.assetId, who)).status).toBe(403); }
  });

  it("answers 409 project_archived for every write on an archived Project, before the row lookup, and still reads", async () => {
    const unknown = crypto.randomUUID();
    for (const [method, path, body] of [["POST", recordPath(unknown, ids.archivedProject), { decision: "approved" }], ["POST", releasePath(unknown, ids.archivedProject), { approvalRevision: 1 }], ["DELETE", releasePath(unknown, ids.archivedProject)],
      ["PUT", premiumPath(unknown, ids.archivedProject), { premium: true }], ["PUT", unlockPath(unknown, ids.archivedProject), { unlocked: true }]] as Array<[string, string, Json?]>) {
      const response = await request(path, "admin", method as "POST", body);
      expect(response.status, `${method} ${path}`).toBe(409); expect(await json(response)).toMatchObject({ code: "project_archived" });
    }
    expect((await request(p(`/videos/${archivedVideo.videoId}/decisions`, ids.archivedProject), "admin")).status).toBe(200);
  });

  it("answers 404 for a Version or Video of another Project, and 400 for a bad body only after the row exists", async () => {
    const other = await seedVideoVersion({ projectId: ids.otherProject, title: "Elsewhere" }); await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    for (const response of [await request(recordPath(other.assetId), "admin", "POST", { decision: "approved" }), await request(releasePath(other.assetId), "admin", "POST", { approvalRevision: 1 }), await request(releasePath(other.assetId), "admin", "DELETE"),
      await request(decisionsOf(other.videoId), "admin"), await request(premiumPath(other.videoId), "admin", "PUT", { premium: true }), await request(unlockPath(other.videoId), "admin", "PUT", { unlocked: true })]) expect(response.status).toBe(404);
    expect((await request(recordPath(crypto.randomUUID()), "admin", "POST", { nope: 1 })).status).toBe(404);
    expect((await request(recordPath(v1.assetId), "admin", "POST", { nope: 1 })).status).toBe(400);
    expect((await request(releasePath(v1.assetId), "admin", "POST", { approvalRevision: "x" })).status).toBe(400);
    expect((await request(premiumPath(v1.videoId), "admin", "PUT", { premium: "yes" })).status).toBe(400);
    expect((await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: true, paymentRef: "x".repeat(201) })).status).toBe(400);
  });
});

describe("recording and reading decisions", () => {
  it("records a staff decision with no link, the user as actor, the next revision and an audit row", async () => {
    const response = await record(v1.assetId, { decision: "approved", note: "Client said yes by phone" });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = videoDecisionRecordedResponseSchema.parse(await response.json());
    expect(body.decision).toMatchObject({ revision: 1, decision: "approved", note: "Client said yes by phone", link: null, actor: { kind: "user", person: { id: ids.admin } } });
    expect((await events(v1.assetId))[0]).toMatchObject({ link_id: null, actor_guest_id: null, actor_user_id: ids.admin, revision: 1 });
    expect((await record(v1.assetId, { decision: "changes_requested" }, "member")).status).toBe(201);
    expect((await events(v1.assetId)).map((row) => row.revision)).toEqual([1, 2]);
    const rows = await audits("video_version.decision");
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ actor_id: ids.admin, target_type: "asset", target_id: v1.assetId });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ staffRecorded: true, decision: "approved", revision: 1, videoId: v1.videoId });
    expect(rows[0]!.meta_json).not.toContain("Client said yes");
  });

  it("lists every Version newest first with events oldest first: staff by person, guests by name and email, the link label, and the live Release", async () => {
    const link = await seedGuestLink({ label: "Smith family" }); const guest = await seedGuest("Gina Guest", "gina@guest-14a.test");
    await addMember(link.id, v1.videoId, [v1.assetId]);
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved", guest: { id: guest.id, linkId: link.id }, note: "Love it" });
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "changes_requested" });
    const response = await request(decisionsOf(v1.videoId), "member"); expect(response.status).toBe(200);
    const { versions } = videoDecisionsResponseSchema.parse(await response.json());
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[0]!.events).toEqual([]); expect(versions[0]!.release).toBeNull();
    expect(versions[1]!.events.map((event) => [event.revision, event.decision])).toEqual([[1, "approved"], [2, "changes_requested"]]);
    expect(versions[1]!.events[0]).toMatchObject({ note: "Love it", link: { id: link.id, label: "Smith family" }, actor: { kind: "guest", name: "Gina Guest", email: "gina@guest-14a.test" } });
    expect(versions[1]!.events[1]).toMatchObject({ link: null, actor: { kind: "user", person: { id: ids.admin } } });
    const released = await release(v1.assetId, 99); expect(released.status).toBe(409);
    await seedEvent({ assetId: v2.assetId, videoId: v1.videoId, decision: "approved" });
    expect((await release(v2.assetId, 1)).status).toBe(201);
    const again = videoDecisionsResponseSchema.parse(await (await request(decisionsOf(v1.videoId), "admin")).json());
    expect(again.versions[0]!.release).toMatchObject({ approvalRevision: 1, releasedBy: { id: ids.admin } }); expect(again.versions[1]!.release).toBeNull();
  });

  it("shows guests a staff-recorded decision never, and a guest decision only on its own link", async () => {
    const link = await seedGuestLink(); await startSession(link);
    await addMember(link.id, v1.videoId, [v1.assetId]);
    expect((await record(v1.assetId, { decision: "approved", note: "STAFF-ONLY" })).status).toBe(201);
    const { cookie } = await startSession(link);
    const guestId = (await seedGuest()).id;
    await database.DB.prepare("UPDATE guest_sessions SET guest_id = ?, verified_at = ? WHERE token_hash = ?").bind(guestId, Date.now(), await hashToken(cookie!.split("=")[1]!)).run();
    const dump = await (await guestFetch(linkPath(link.id, "/videos"), { cookie })).text();
    expect(dump).not.toContain("STAFF-ONLY"); expect(JSON.parse(dump).videos[0].versions[0].decision).toBeNull();
  });
});

describe("Release", () => {
  it("releases the approved revision: 201, a live row on that event, one audit row", async () => {
    const approval = await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const response = await release(v1.assetId, 1);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(videoReleaseResponseSchema.parse(await response.json()).release).toMatchObject({ approvalRevision: 1, releasedBy: { id: ids.admin } });
    const [row, ...rest] = await releases(v1.assetId); expect(rest).toEqual([]);
    expect(row).toMatchObject({ project_id: ids.project, video_id: v1.videoId, approval_event_id: approval.id, approval_revision: 1, released_by: ids.admin, withdrawn_at: null });
    const [entry, ...more] = await audits("video_version.release"); expect(more).toEqual([]);
    expect(entry).toMatchObject({ actor_id: ids.admin, target_type: "asset", target_id: v1.assetId });
    expect(JSON.parse(entry!.meta_json)).toMatchObject({ approvalRevision: 1, videoId: v1.videoId, releaseId: row!.id });
  });

  it("does not let an approval of v1 release v2, and answers a stale revision 409 release_stale with the current one", async () => {
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const wrongVersion = await release(v2.assetId, 1);
    expect(wrongVersion.status).toBe(409); expect(await json(wrongVersion)).toMatchObject({ code: "release_stale", current: null });
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const stale = await release(v1.assetId, 1);
    expect(stale.status).toBe(409); expect(await json(stale)).toMatchObject({ code: "release_stale", current: 2 });
    expect(await releases(v1.assetId)).toHaveLength(0); expect(await releases(v2.assetId)).toHaveLength(0); expect(await audits("video_version.release")).toHaveLength(0);
  });

  it("is blocked by a later changes_requested, from any link or from staff", async () => {
    const link = await seedGuestLink(); const guest = await seedGuest(); await addMember(link.id, v1.videoId, [v1.assetId]);
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "changes_requested", guest: { id: guest.id, linkId: link.id } });
    const blocked = await release(v1.assetId, 1);
    expect(blocked.status).toBe(409); expect(await json(blocked)).toMatchObject({ code: "release_stale", current: 2 });
    const notApproval = await release(v1.assetId, 2);
    expect(notApproval.status).toBe(422); expect(await json(notApproval)).toMatchObject({ code: "not_approved" });
    expect((await record(v1.assetId, { decision: "approved" })).status).toBe(201);
    expect((await release(v1.assetId, 3)).status).toBe(201);
    await record(v1.assetId, { decision: "changes_requested" });
    expect(await liveReleases(v1.assetId)).toHaveLength(1);
  });

  it("answers 409 already_released for a second Release, and writes one row", async () => {
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    expect((await release(v1.assetId, 1)).status).toBe(201);
    const again = await release(v1.assetId, 1);
    expect(again.status).toBe(409); expect(await json(again)).toMatchObject({ code: "already_released" });
    expect(await releases(v1.assetId)).toHaveLength(1); expect(await audits("video_version.release")).toHaveLength(1);
  });

  it("admits one of several concurrent Releases: one 201, the rest 409, one live row, one audit row", async () => {
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const responses = await Promise.all([release(v1.assetId, 1), release(v1.assetId, 1, "member"), release(v1.assetId, 1)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    for (const response of responses) if (response.status === 409) expect(["already_released", "release_stale"]).toContain((await json(response)).code);
    expect(await liveReleases(v1.assetId)).toHaveLength(1); expect(await audits("video_version.release")).toHaveLength(1);
  });

  it("loses to a decision that lands first: a Release racing a changes_requested is 409 or wins before it, never both", async () => {
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const [released, requested] = await Promise.all([release(v1.assetId, 1), record(v1.assetId, { decision: "changes_requested" })]);
    expect(requested.status).toBe(201); expect([201, 409]).toContain(released.status);
    expect((await liveReleases(v1.assetId)).length).toBe(released.status === 201 ? 1 : 0);
    const late = await release(v1.assetId, 1); expect(late.status).toBe(409);
  });

  it("withdraws: 200, the row stays with who and when, a second withdraw is 404, and the Version can be released again", async () => {
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    await release(v1.assetId, 1);
    const response = await withdraw(v1.assetId, "member");
    expect(response.status).toBe(200); expect(await json(response)).toEqual({ released: false });
    const [row] = await releases(v1.assetId); expect(row).toMatchObject({ withdrawn_by: ids.member }); expect(row!.withdrawn_at).toBeGreaterThan(0);
    const [entry] = await audits("video_version.release_withdraw");
    expect(entry).toMatchObject({ actor_id: ids.member, target_type: "asset", target_id: v1.assetId }); expect(JSON.parse(entry!.meta_json)).toMatchObject({ releaseId: row!.id });
    const second = await withdraw(v1.assetId); expect(second.status).toBe(404);
    expect(await audits("video_version.release_withdraw")).toHaveLength(1);
    expect((await release(v1.assetId, 1)).status).toBe(201);
    expect(await releases(v1.assetId)).toHaveLength(2); expect(await liveReleases(v1.assetId)).toHaveLength(1);
  });

  it("ends the guest's released flag on withdraw", async () => {
    const link = await seedGuestLink(); const { cookie } = await startSession(link); await addMember(link.id, v1.videoId, [v1.assetId]);
    await seedEvent({ assetId: v1.assetId, videoId: v1.videoId, decision: "approved" });
    const flag = async () => (await (await guestFetch(linkPath(link.id, "/videos"), { cookie })).json() as Json).videos[0].versions[0].released;
    expect(await flag()).toBe(false);
    await release(v1.assetId, 1); expect(await flag()).toBe(true);
    await withdraw(v1.assetId); expect(await flag()).toBe(false);
  });
});

describe("premium and unlock", () => {
  const listed = async (videoId: string) => { const response = await request(p("/videos"), "admin"); expect(response.status).toBe(200); return videoListResponseSchema.parse(await response.json()).videos.find((video) => video.id === videoId)!; };

  it("sets premium: Admin only, 200 with the state, idempotent (no audit when nothing changes), audited as a video", async () => {
    const response = await request(premiumPath(v1.videoId), "admin", "PUT", { premium: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(videoPremiumResponseSchema.parse(await response.json())).toEqual({ premium: true, premiumUnlocked: false });
    expect(await premiumOf(v1.videoId)).toBe(1);
    expect((await request(premiumPath(v1.videoId), "admin", "PUT", { premium: true })).status).toBe(200);
    expect(await audits("video.premium_set")).toHaveLength(1);
    expect((await request(premiumPath(v1.videoId), "member", "PUT", { premium: false })).status).toBe(403);
    expect(await premiumOf(v1.videoId)).toBe(1);
    expect((await request(premiumPath(v1.videoId), "admin", "PUT", { premium: false })).status).toBe(200);
    const rows = await audits("video.premium_set");
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ actor_id: ids.admin, target_type: "video", target_id: v1.videoId });
    expect(rows.map((row) => JSON.parse(row.meta_json).premium)).toEqual([true, false]);
  });

  it("unlocks idempotently: one row, premiumUnlocked on the Video DTO and the guest DTO, a payment reference change audited, a relock deleting the row", async () => {
    await request(premiumPath(v1.videoId), "admin", "PUT", { premium: true });
    expect((await listed(v1.videoId))).toMatchObject({ premium: true, premiumUnlocked: false });
    const unlocked = await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: true, paymentRef: "INV-1001" });
    expect(unlocked.status, await unlocked.clone().text()).toBe(200);
    expect(videoPremiumResponseSchema.parse(await unlocked.json())).toEqual({ premium: true, premiumUnlocked: true });
    expect(await unlockRow(v1.videoId)).toMatchObject({ project_id: ids.project, unlocked_by: ids.admin, payment_ref: "INV-1001" });
    expect((await listed(v1.videoId))).toMatchObject({ premium: true, premiumUnlocked: true });

    expect((await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: true, paymentRef: "INV-1001" })).status).toBe(200);
    expect(await audits("video.premium_unlock")).toHaveLength(1);

    expect((await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: true, paymentRef: "INV-2002" })).status).toBe(200);
    expect((await unlockRow(v1.videoId))!.payment_ref).toBe("INV-2002");
    const rows = await audits("video.premium_unlock"); expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, target_type: "video", target_id: v1.videoId });
    expect(rows.map((row) => row.meta_json).join("")).not.toContain("INV-");

    const link = await seedGuestLink(); const { cookie } = await startSession(link); await addMember(link.id, v1.videoId, [v1.assetId]);
    const guestVideo = async () => (await (await guestFetch(linkPath(link.id, "/videos"), { cookie })).json() as Json).videos[0];
    expect(await guestVideo()).toMatchObject({ premium: true, unlocked: true });

    const relocked = await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: false });
    expect(relocked.status).toBe(200); expect(await relocked.json()).toEqual({ premium: true, premiumUnlocked: false });
    expect(await unlockRow(v1.videoId)).toBeNull();
    expect(await guestVideo()).toMatchObject({ premium: true, unlocked: false });
    expect((await audits("video.premium_relock"))).toHaveLength(1);
    expect((await request(unlockPath(v1.videoId), "admin", "PUT", { unlocked: false })).status).toBe(200);
    expect((await audits("video.premium_relock"))).toHaveLength(1);
  });

  it("refuses Editors and writes nothing", async () => {
    for (const who of ["member", "photographer", "external"] as const) {
      expect((await request(unlockPath(v1.videoId), who, "PUT", { unlocked: true })).status).toBe(403);
      expect((await request(premiumPath(v1.videoId), who, "PUT", { premium: true })).status).toBe(403);
    }
    expect(await unlockRow(v1.videoId)).toBeNull(); expect(await audits("video.premium_set", "video.premium_unlock")).toHaveLength(0);
  });

  it("shows premiumUnlocked false on every Video of the staff list until an unlock row exists", async () => {
    expect((await listed(v1.videoId))).toMatchObject({ premium: false, premiumUnlocked: false });
  });
});
