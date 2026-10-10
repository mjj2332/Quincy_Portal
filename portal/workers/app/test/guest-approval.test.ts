import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestDecisionResponseSchema, guestVideoListResponseSchema } from "@quincy/shared";
import { GUEST_LIMITS, GUEST_WINDOW_MS } from "../src/guest/rate-limit";
import { hashToken } from "../src/lib/opaque-token";
import { database, ids, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, freshIp, guestFetch, guestOrigin, HYGIENE, linkPath, openGuestGate, seedGuestLink, startSession, type LinkInput } from "./guest-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The guest decision POST (#741 14a): approve or request changes on one Version, recorded as an append-only event. Rules from docs/plans/741-13-15.md section 3 and the guest-write rules. */
type Json = Record<string, any>;
const decisionPath = (linkId: string, assetId: string) => linkPath(linkId, `/versions/${assetId}/decision`);

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.%'"),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-14a.test'"),
    database.DB.prepare("DELETE FROM video_notes"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project),
  ]);
};
beforeEach(async () => { await clearGuestRows(); await wipe(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await wipe(); await clearVideoFlags(); });

/** A link with a session verified straight in the database (the email flow has its own suite), one Video on it with its first Version granted. */
async function verifiedLink(input: LinkInput = {}, name = "Gina Guest") {
  const link = await seedGuestLink(input); const { cookie } = await startSession(link);
  if (!cookie) throw new Error("no session");
  const guestId = await verifyCookie(cookie, `${crypto.randomUUID()}@guest-14a.test`, name);
  return { ...link, cookie, guestId };
}
async function verifyCookie(cookie: string, email: string, name: string): Promise<string> {
  const guestId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, ?, ?)").bind(guestId, email, name, Date.now()).run();
  await database.DB.prepare("UPDATE guest_sessions SET guest_id = ?, verified_at = ? WHERE token_hash = ?").bind(guestId, Date.now(), await hashToken(cookie.split("=")[1]!)).run();
  return guestId;
}
async function setup(input: LinkInput = {}) {
  const link = await verifiedLink(input); const version = await seedVideoVersion({ title: "Hero" });
  await addMember(link.id, version.videoId, [version.assetId]);
  return { link, version };
}
const decide = (link: { id: string }, cookie: string | null, assetId: string, body: unknown = { decision: "approved" }, init: Parameters<typeof guestFetch>[1] = {}) =>
  guestFetch(decisionPath(link.id, assetId), { method: "POST", cookie, body, ...init });
const events = async (assetId: string) => (await database.DB.prepare("SELECT * FROM video_approval_events WHERE asset_id = ? ORDER BY revision").bind(assetId).all<Json>()).results;
const audits = async (action = "video_version.decision") => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = ?").bind(action).all<Json>()).results;
const videos = async (link: { id: string }, cookie: string) => { const response = await guestFetch(linkPath(link.id, "/videos"), { cookie }); expect(response.status).toBe(200); return guestVideoListResponseSchema.parse(await response.json()); };

const probe = async (response: Response) => ({ status: response.status, body: await response.text() });
const stubBody = async () => probe(await guestFetch("/d"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
/** A POST whose body arrives `delayMs` after the headers, so the Worker has already passed its entry checks when the state changes under it. */
function slowPost(path: string, cookie: string, body: unknown, delayMs: number): { response: Promise<Response> } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({ async start(controller) { await new Promise((resolve) => setTimeout(resolve, delayMs)); controller.enqueue(bytes); controller.close(); } });
  const headers = new Headers({ "cf-connecting-ip": freshIp(), cookie, origin: guestOrigin, "content-type": "application/json" });
  return { response: workerSelf.fetch(`https://portal.test${path}`, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit) };
}

describe("POST .../versions/:assetId/decision", () => {
  it("records an approval: 201 with the event, the guest as actor, no staff id, one audit row", async () => {
    const { link, version } = await setup();
    const response = await decide(link, link.cookie, version.assetId, { decision: "approved", note: "Looks great" });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = guestDecisionResponseSchema.parse(await response.json());
    expect(body.decision).toMatchObject({ value: "approved", revision: 1, self: true });
    expect(Date.parse(body.decision.at)).not.toBeNaN();
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const [row] = await events(version.assetId);
    expect(row).toMatchObject({ project_id: ids.project, video_id: version.videoId, asset_id: version.assetId, link_id: link.id, revision: 1, decision: "approved", note: "Looks great", actor_guest_id: link.guestId, actor_user_id: null });
    const [entry, ...rest] = await audits(); expect(rest).toEqual([]);
    expect(entry).toMatchObject({ actor_id: null, target_type: "asset", target_id: version.assetId });
    expect(JSON.parse(entry!.meta_json)).toMatchObject({ guest: { guestId: link.guestId }, linkId: link.id, decision: "approved", revision: 1 });
  });

  it("keeps the note out of the audit row and stores no note as NULL", async () => {
    const { link, version } = await setup();
    await decide(link, link.cookie, version.assetId, { decision: "changes_requested", note: "SENTINEL-NOTE-TEXT" });
    await decide(link, link.cookie, version.assetId, { decision: "approved", note: "   " });
    expect(JSON.stringify(await audits())).not.toContain("SENTINEL-NOTE-TEXT");
    expect((await events(version.assetId)).map((row) => row.note)).toEqual(["SENTINEL-NOTE-TEXT", null]);
  });

  it("appends: every decision is a new revision, a later one never edits an earlier event", async () => {
    const { link, version } = await setup();
    for (const decision of ["approved", "changes_requested", "approved"]) expect((await decide(link, link.cookie, version.assetId, { decision })).status).toBe(201);
    const rows = await events(version.assetId);
    expect(rows.map((row) => [row.revision, row.decision])).toEqual([[1, "approved"], [2, "changes_requested"], [3, "approved"]]);
    expect(await audits()).toHaveLength(3);
  });

  it("gives concurrent duplicates distinct revisions and one audit row each", async () => {
    const { link, version } = await setup();
    const responses = await Promise.all([1, 2, 3].map(() => decide(link, link.cookie, version.assetId)));
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect((await Promise.all(responses.map(async (response) => (await response.json() as Json).decision.revision))).sort()).toEqual([1, 2, 3]);
    expect((await events(version.assetId)).map((row) => row.revision)).toEqual([1, 2, 3]);
    expect(await audits()).toHaveLength(3);
  });

  it("numbers revisions per Version: a decision on Video A does not touch Video B", async () => {
    const { link, version } = await setup(); const other = await seedVideoVersion({ title: "Other" }); await addMember(link.id, other.videoId, [other.assetId]);
    await decide(link, link.cookie, version.assetId); await decide(link, link.cookie, version.assetId);
    const response = await decide(link, link.cookie, other.assetId, { decision: "changes_requested" });
    expect((await response.json() as Json).decision.revision).toBe(1);
    expect(await events(other.assetId)).toHaveLength(1); expect(await events(version.assetId)).toHaveLength(2);
  });

  it("validates the body: 400 for a bad decision, an extra key, a long note or bad JSON; 413 over the cap; a 2000 character note is fine", async () => {
    const { link, version } = await setup();
    for (const body of [{ decision: "maybe" }, {}, { decision: "approved", extra: 1 }, { decision: "approved", note: "x".repeat(2001) }, { decision: "approved", note: 5 }, "not json", "[]"]) {
      const response = await decide(link, link.cookie, version.assetId, body); expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await decide(link, link.cookie, version.assetId, { decision: "approved", note: "x".repeat(20_000) })).status).toBe(413);
    expect(await events(version.assetId)).toHaveLength(0);
    expect((await decide(link, link.cookie, version.assetId, { decision: "approved", note: "é".repeat(2000) })).status).toBe(201);
  });

  it("is 401 verification_required for an unverified session, and 403 approve_disabled when the link does not allow approving", async () => {
    const link = await seedGuestLink(); const { cookie } = await startSession(link); const version = await seedVideoVersion({ title: "Hero" });
    await addMember(link.id, version.videoId, [version.assetId]);
    const unverified = await decide(link, cookie, version.assetId);
    expect(unverified.status).toBe(401); expect(await unverified.json()).toEqual({ error: "verification_required" });
    const off = await verifiedLink({ allow: [1, 0, 1] }); await addMember(off.id, version.videoId, [version.assetId]);
    const disabled = await decide(off, off.cookie, version.assetId);
    expect(disabled.status).toBe(403); expect(await disabled.json()).toEqual({ error: "approve_disabled" });
    expect(await events(version.assetId)).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });

  it("is 403 invalid_origin for a wrong Origin or content type, and writes nothing", async () => {
    const { link, version } = await setup();
    expect((await decide(link, link.cookie, version.assetId, undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await decide(link, link.cookie, version.assetId, undefined, { origin: null })).status).toBe(403);
    expect((await decide(link, link.cookie, version.assetId, undefined, { contentType: "text/plain" })).status).toBe(403);
    expect(await events(version.assetId)).toHaveLength(0);
  });

  it("is the byte-identical stub for no cookie, another link's cookie, a staff cookie, a bad id, a revoked, expired or replaced link, and a closed part", async () => {
    const { link, version } = await setup(); const other = await verifiedLink();
    const reference = await stubBody();
    expect(await probe(await decide(link, null, version.assetId))).toEqual(reference);
    expect(await probe(await decide(link, other.cookie, version.assetId))).toEqual(reference);
    expect(await probe(await decide(link, link.cookie.replace("=", "=x"), version.assetId))).toEqual(reference);
    expect(await probe(await guestFetch(decisionPath(link.id, version.assetId), { method: "POST", body: { decision: "approved" }, headers: { cookie: "better-auth.session_token=anything" } }))).toEqual(reference);
    expect(await probe(await decide(link, link.cookie, "not-a-uuid"))).toEqual(reference);
    expect(await probe(await decide({ id: "not-a-uuid" }, link.cookie, version.assetId))).toEqual(reference);
    for (const part of ["video_review_delivery", "video_review_guest"]) {
      await openGuestGate(); await database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(part).run();
      expect(await probe(await decide(link, link.cookie, version.assetId)), part).toEqual(reference);
    }
    await openGuestGate(); await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`, "video_review_guest");
    expect(await probe(await decide(link, link.cookie, version.assetId))).toEqual(reference);
    await openGuestGate();
    const expired = await verifiedLink(); await addMember(expired.id, version.videoId, [version.assetId]);
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect(await probe(await decide(expired, expired.cookie, version.assetId))).toEqual(reference);
    const replaced = await verifiedLink(); await addMember(replaced.id, version.videoId, [version.assetId]);
    await database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(replaced.id).run();
    expect(await probe(await decide(replaced, replaced.cookie, version.assetId))).toEqual(reference);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await decide(link, link.cookie, version.assetId))).toEqual(reference);
    expect(await events(version.assetId)).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });

  it("is the stub for a Version the link does not reach: not granted, grant revoked, Video removed, another Project's, a delivery link", async () => {
    const { link, version } = await setup(); const reference = await stubBody();
    const v2 = await seedVideoVersion({ videoId: version.videoId, version: 2 });
    expect(await probe(await decide(link, link.cookie, v2.assetId))).toEqual(reference);
    const elsewhere = await seedVideoVersion({ title: "Not on the link" });
    expect(await probe(await decide(link, link.cookie, elsewhere.assetId))).toEqual(reference);
    expect(await probe(await decide(link, link.cookie, crypto.randomUUID()))).toEqual(reference);
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await decide(link, link.cookie, version.assetId))).toEqual(reference);
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = NULL, revoked_by = NULL WHERE link_id = ?").bind(link.id).run();
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await decide(link, link.cookie, version.assetId))).toEqual(reference);
    expect((await events(version.assetId)).length + (await events(v2.assetId)).length + (await events(elsewhere.assetId)).length).toBe(0);
  });

  it("is 409 project_archived once the Project is archived, before the limit is charged or the body judged, and writes nothing", async () => {
    const { link, version } = await setup(); await archive();
    const response = await decide(link, link.cookie, version.assetId);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "project_archived" });
    expect(await events(version.assetId)).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });

  it("does not withdraw a Release: a decision recorded after a Release leaves it live", async () => {
    const { link, version } = await setup();
    await decide(link, link.cookie, version.assetId);
    const [approval] = await events(version.assetId);
    await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(crypto.randomUUID(), ids.project, version.videoId, version.assetId, approval!.id, ids.admin, Date.now()).run();
    expect((await decide(link, link.cookie, version.assetId, { decision: "changes_requested" })).status).toBe(201);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM video_releases WHERE withdrawn_at IS NULL").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("the committing SQL repeats what the entry checked", () => {
  const transitions: Array<[string, (linkId: string) => Promise<unknown>, "stub" | "archived"]> = [
    ["revoke", (id) => database.DB.batch([database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, id), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(id)]), "stub"],
    ["revoke with the session row surviving", (id) => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, id).run(), "stub"],
    ["replace", (id) => database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(id).run(), "stub"],
    ["expiry", (id) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run(), "stub"],
    ["gate close", () => clearVideoFlags(), "stub"],
    ["delivery part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_delivery'").run(), "stub"],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run(), "stub"],
    ["Video removed", (id) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, id).run(), "stub"],
    ["grant revoked", (id) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, id).run(), "stub"],
    ["archive", () => archive(), "archived"],
  ];
  it("a transition landing while the body is on its way writes no event and no audit row, and answers the refusal", async () => {
    for (const [label, change, kind] of transitions) {
      await openGuestGate(); await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      const { link, version } = await setup();
      const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 250);
      await sleep(80); await change(link.id);
      const response = await pending.response;
      if (kind === "stub") expect(await probe(response), label).toEqual(await stubBody());
      else { expect(response.status, label).toBe(409); expect(await response.json(), label).toEqual({ error: "project_archived" }); }
      expect(await events(version.assetId), label).toHaveLength(0); expect(await audits(), label).toHaveLength(0);
    }
  });

  it("a malformed body held across a transition is the refusal, not 400", async () => {
    for (const [label, change, kind] of transitions) {
      await openGuestGate(); await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      const { link, version } = await setup();
      const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { nonsense: true }, 250);
      await sleep(80); await change(link.id);
      const response = await pending.response;
      if (kind === "stub") expect(await probe(response), label).toEqual(await stubBody());
      else expect(response.status, label).toBe(409);
    }
  });

  it("allow_approve turned off while the body is on its way writes nothing and answers 403 approve_disabled", async () => {
    const { link, version } = await setup();
    const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 250);
    await sleep(80); await database.DB.prepare("UPDATE client_links SET allow_approve = 0 WHERE id = ?").bind(link.id).run();
    const response = await pending.response;
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "approve_disabled" });
    expect(await events(version.assetId)).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });

  it("a session whose token is rotated while the body is on its way writes nothing and answers the stub (the session is resolved after the body, as in the note routes)", async () => {
    const { link, version } = await setup(); const stub = await stubBody();
    const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 250);
    await sleep(80); await database.DB.prepare("UPDATE guest_sessions SET token_hash = 'rotated' WHERE link_id = ?").bind(link.id).run();
    expect(await probe(await pending.response)).toEqual(stub);
    expect(await events(version.assetId)).toHaveLength(0); expect(await audits()).toHaveLength(0);
  });

  it("an unverified session whose link is revoked is the stub, not 401", async () => {
    const link = await seedGuestLink(); const { cookie } = await startSession(link); const version = await seedVideoVersion({ title: "Hero" });
    await addMember(link.id, version.videoId, [version.assetId]);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await decide(link, cookie, version.assetId))).toEqual(await stubBody());
  });
});

describe("the guest Version DTO: decision, released, downloadUrl", () => {
  it("starts as no decision, not released, no download URL", async () => {
    const { link, version } = await setup();
    const [video] = (await videos(link, link.cookie)).videos;
    expect(video!.versions[0]).toMatchObject({ assetId: version.assetId, decision: null, released: false, downloadUrl: null });
  });

  it("shows the latest decision on THIS link, with self true only for the deciding guest", async () => {
    const { link, version } = await setup();
    await decide(link, link.cookie, version.assetId, { decision: "approved" }); await decide(link, link.cookie, version.assetId, { decision: "changes_requested" });
    const mine = (await videos(link, link.cookie)).videos[0]!.versions[0]!.decision;
    expect(mine).toMatchObject({ value: "changes_requested", revision: 2, self: true }); expect(Date.parse(mine!.at)).not.toBeNaN();
    const { cookie } = await startSession(link); await verifyCookie(cookie!, `${crypto.randomUUID()}@guest-14a.test`, "Second Guest");
    expect((await videos(link, cookie!)).videos[0]!.versions[0]!.decision).toMatchObject({ value: "changes_requested", revision: 2, self: false });
  });

  it("never shows a decision from another link or a staff-recorded one", async () => {
    const { link, version } = await setup(); const other = await verifiedLink(); await addMember(other.id, version.videoId, [version.assetId]);
    await decide(other, other.cookie, version.assetId, { decision: "approved" });
    await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 2, 'changes_requested', 'staff note', NULL, ?, ?)")
      .bind(crypto.randomUUID(), ids.project, version.videoId, version.assetId, ids.admin, Date.now()).run();
    const dump = JSON.stringify(await videos(link, link.cookie));
    expect(dump).toContain('"decision":null'); expect(dump).not.toContain("staff note");
    await decide(link, link.cookie, version.assetId, { decision: "approved" });
    expect((await videos(link, link.cookie)).videos[0]!.versions[0]!.decision).toMatchObject({ value: "approved", revision: 3, self: true });
  });

  it("is released while a Release is live and not once it is withdrawn; the download URL follows the Release (14b)", async () => {
    const { link, version } = await setup();
    await decide(link, link.cookie, version.assetId);
    const [approval] = await events(version.assetId); const releaseId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(releaseId, ids.project, version.videoId, version.assetId, approval!.id, ids.admin, Date.now()).run();
    expect((await videos(link, link.cookie)).videos[0]!.versions[0]).toMatchObject({ released: true, downloadUrl: `/d/api/links/${link.id}/versions/${version.assetId}/download` });
    await database.DB.prepare("UPDATE video_releases SET withdrawn_at = ?, withdrawn_by = ? WHERE id = ?").bind(Date.now(), ids.admin, releaseId).run();
    expect((await videos(link, link.cookie)).videos[0]!.versions[0]).toMatchObject({ released: false, downloadUrl: null });
  });

  it("does not leak staff ids, emails or the note text of any decision", async () => {
    const { link, version } = await setup();
    await decide(link, link.cookie, version.assetId, { decision: "approved", note: "private reasoning" });
    const dump = JSON.stringify(await videos(link, link.cookie));
    for (const secret of ["private reasoning", ids.admin, ids.member, "guest-14a.test", link.guestId]) expect(dump).not.toContain(secret);
  });
});

describe("rate limits and write order", () => {
  const seedBucket = (bucket: string, count: number) => database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?1, ?2, ?3)").bind(bucket, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS, count).run();
  const bucketCount = async (bucket: string) => (await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(bucket).first<{ count: number }>())?.count ?? null;
  const wipeBuckets = () => database.DB.prepare("DELETE FROM guest_rate_limits WHERE bucket LIKE 'decision:%'").run();
  beforeEach(wipeBuckets); afterEach(wipeBuckets);

  it("caps a guest at 20 decisions in 15 minutes: the 21st is 429 with Retry-After and writes nothing", async () => {
    expect(GUEST_LIMITS.decisionGuest).toBe(20);
    const { link, version } = await setup();
    for (let n = 0; n < 20; n++) expect((await decide(link, link.cookie, version.assetId)).status, `decision ${n + 1}`).toBe(201);
    const limited = await decide(link, link.cookie, version.assetId);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "too_many_attempts", retryAfterSeconds: Number(limited.headers.get("retry-after")) });
    expect(await events(version.assetId)).toHaveLength(20); expect(await audits()).toHaveLength(20);
  });

  it("caps a link at 100 decisions in 15 minutes, across guests, and charges both buckets", async () => {
    expect(GUEST_LIMITS.decisionLink).toBe(100);
    const { link, version } = await setup(); await seedBucket(`decision:link:${link.id}`, 99);
    expect((await decide(link, link.cookie, version.assetId)).status).toBe(201);
    expect(await bucketCount(`decision:link:${link.id}`)).toBe(100); expect(await bucketCount(`decision:guest:${link.guestId}`)).toBe(1);
    const limited = await decide(link, link.cookie, version.assetId);
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await events(version.assetId)).toHaveLength(1);
  });

  it("charges an invalid body: a 400 and a 413 each spend an attempt, and an exhausted guest gets 429, not 400", async () => {
    const { link, version } = await setup();
    expect((await decide(link, link.cookie, version.assetId, { decision: "maybe" })).status).toBe(400);
    expect((await decide(link, link.cookie, version.assetId, { decision: "approved", note: "x".repeat(20_000) })).status).toBe(413);
    expect(await bucketCount(`decision:guest:${link.guestId}`)).toBe(2); expect(await bucketCount(`decision:link:${link.id}`)).toBe(2);
    await database.DB.prepare("UPDATE guest_rate_limits SET count = 20 WHERE bucket = ?").bind(`decision:guest:${link.guestId}`).run();
    for (const body of [{ decision: "maybe" }, "not json", { decision: "approved", note: "x".repeat(20_000) }]) {
      const response = await decide(link, link.cookie, version.assetId, body); expect(response.status, JSON.stringify(body).slice(0, 30)).toBe(429);
    }
    expect(await events(version.assetId)).toHaveLength(0);
  });

  it("does not charge a request refused before the limit: stub, Origin, 401, 403, unreachable Version and archived", async () => {
    const { link, version } = await setup(); const other = await seedVideoVersion({ title: "Not granted" });
    await decide(link, link.cookie, version.assetId, undefined, { origin: "https://evil.example" });
    await decide(link, link.cookie, other.assetId);
    await decide(link, null, version.assetId);
    await archive(); await decide(link, link.cookie, version.assetId);
    const off = await verifiedLink({ allow: [1, 0, 1] }); await addMember(off.id, version.videoId, [version.assetId]); await decide(off, off.cookie, version.assetId);
    const unverified = await seedGuestLink(); const { cookie } = await startSession(unverified); await addMember(unverified.id, version.videoId, [version.assetId]); await decide(unverified, cookie, version.assetId);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'decision:%'").first<{ n: number }>())!.n).toBe(0);
  });

  it("answers an archived Project only after capability and visibility: unverified is 401, approve off 403, an unreachable Version the stub", async () => {
    const { link, version } = await setup(); const other = await seedVideoVersion({ title: "Not granted" }); const reference = await stubBody();
    const unverified = await seedGuestLink(); const { cookie } = await startSession(unverified); await addMember(unverified.id, version.videoId, [version.assetId]);
    const off = await verifiedLink({ allow: [1, 0, 1] }); await addMember(off.id, version.videoId, [version.assetId]);
    await archive();
    const a = await decide(unverified, cookie, version.assetId); expect(a.status).toBe(401);
    const b = await decide(off, off.cookie, version.assetId); expect(b.status).toBe(403);
    expect(await probe(await decide(link, link.cookie, other.assetId))).toEqual(reference);
    expect((await decide(link, link.cookie, version.assetId)).status).toBe(409);
  });

  it("a 429 held across a revoke is the stub, and across an archive is 409 project_archived (and is a plain 429 when nothing changes)", async () => {
    {
      const { link, version } = await setup(); await seedBucket(`decision:guest:${link.guestId}`, 20);
      expect((await slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 150).response).status).toBe(429);
    }
    for (const [change, kind] of [
      [(linkId: string) => database.DB.batch([database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), linkId), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(linkId)]), "stub"],
      [() => archive(), "archived"],
    ] as const) {
      await wipe(); await clearGuestRows(); await openGuestGate(); await wipeBuckets();
      const { link, version } = await setup(); const reference = await stubBody();
      await seedBucket(`decision:guest:${link.guestId}`, 20);
      const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 300);
      await sleep(80); await change(link.id);
      const response = await pending.response;
      if (kind === "stub") expect(await probe(response)).toEqual(reference);
      else { expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "project_archived" }); }
      expect(await events(version.assetId)).toHaveLength(0);
    }
  });

  it("charges a decision whose body is held across a window boundary to the window it completes in", async () => {
    const { link, version } = await setup();
    const pending = slowPost(decisionPath(link.id, version.assetId), link.cookie, { decision: "approved" }, 300);
    await sleep(80);
    const rows = async () => (await database.DB.prepare("SELECT window_start FROM guest_rate_limits WHERE bucket = ?").bind(`decision:guest:${link.guestId}`).all<{ window_start: number }>()).results;
    expect(await rows()).toEqual([]);
    expect((await pending.response).status).toBe(201);
    const [row] = await rows(); expect(row!.window_start).toBe(Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS);
  });
});
