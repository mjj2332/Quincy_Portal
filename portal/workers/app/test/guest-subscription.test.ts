import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestSubscriptionResponseSchema } from "@quincy/shared";
import { GUEST_LIMITS } from "../src/guest/rate-limit";
import { hashToken, randomToken } from "../src/lib/opaque-token";
import { database, ids, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, freshIp, guestFetch, HYGIENE, linkPath, openGuestGate, seedGuestLink, slowRequest, startSession, type LinkInput } from "./guest-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The client digest subscription API (#741 15b): the tokened unsubscribe POST (no gate, per decision 11) and the verified guest's own PUT. */
type Json = Record<string, any>;
const UNSUBSCRIBE = "/d/api/unsubscribe";
const subscriptionPath = (linkId: string) => linkPath(linkId, "/subscription");

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM guest_unsubscribe_tokens"), database.DB.prepare("DELETE FROM guest_link_members"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.%subscribe'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-15b.test'"),
    database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project),
  ]);
};
beforeEach(async () => { await clearGuestRows(); await wipe(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await wipe(); await clearVideoFlags(); });

/** A link with a verified guest (membership included), straight into the tables, and a Video on it. */
async function verifiedLink(input: LinkInput = {}, guest: { guestId?: string; email?: string } = {}) {
  const link = await seedGuestLink(input); const { cookie } = await startSession(link);
  if (!cookie) throw new Error("no session");
  const guestId = guest.guestId ?? crypto.randomUUID(); const now = Date.now();
  if (!guest.guestId) await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Gina Guest', ?)").bind(guestId, guest.email ?? `${guestId}@guest-15b.test`, now).run();
  const memberId = crypto.randomUUID();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO guest_link_members (id, link_id, guest_id, first_verified_at, last_verified_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").bind(memberId, link.id, guestId, now, now, now),
    database.DB.prepare("UPDATE guest_sessions SET guest_id = ?, verified_at = ? WHERE token_hash = ?").bind(guestId, now, await hashToken(cookie.split("=")[1]!)),
  ]);
  const version = await seedVideoVersion({ title: "Hero" }); await addMember(link.id, version.videoId, [version.assetId]);
  return { ...link, cookie, guestId, memberId, version };
}
type Linked = Awaited<ReturnType<typeof verifiedLink>>;
/** An unsubscribe token for a membership: only its hash is stored, as the digest does. */
async function mintToken(memberId: string, createdAt = Date.now()) {
  const token = randomToken();
  await database.DB.prepare("INSERT INTO guest_unsubscribe_tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)").bind(await hashToken(token), memberId, createdAt).run();
  return token;
}
const unsubscribe = (body: unknown, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(UNSUBSCRIBE, { method: "POST", body, ...init });
const memberRow = (memberId: string) => database.DB.prepare("SELECT unsubscribed_at FROM guest_link_members WHERE id = ?").bind(memberId).first<{ unsubscribed_at: number | null }>();
const audits = async () => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action LIKE 'review_link.%subscribe' ORDER BY created_at, rowid").all<Json>()).results;
const pendingRows = async (guestId: string) => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_notification_digest WHERE guest_id = ? AND sent_at IS NULL").bind(guestId).first<{ n: number }>())!.n;
async function seedPending(link: Linked, count = 2) {
  for (let index = 0; index < count; index += 1)
    await database.DB.prepare("INSERT INTO guest_notification_digest (id, guest_id, link_id, event_type, video_id, asset_id, note_id, created_at) VALUES (?, ?, ?, 'version_granted', ?, ?, NULL, ?)")
      .bind(crypto.randomUUID(), link.guestId, link.id, link.version.videoId, link.version.assetId, Date.now()).run();
}
const probe = async (response: Response) => ({ status: response.status, body: await response.text() });
const stubBody = async () => probe(await guestFetch("/d"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the token contract with the background Worker", () => {
  it("hashes a token as plain SHA-256 hex, which is what the digest flush stores (the Workers cannot share code)", async () => {
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("POST /d/api/unsubscribe", () => {
  it("unsubscribes the membership the token names, answers the state, audits once with no actor, and drops the pending digest rows", async () => {
    const link = await verifiedLink(); await seedPending(link); const token = await mintToken(link.memberId);
    const response = await unsubscribe({ token });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(guestSubscriptionResponseSchema.parse(await response.json())).toEqual({ subscribed: false });
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect((await memberRow(link.memberId))!.unsubscribed_at).not.toBeNull();
    expect(await pendingRows(link.guestId)).toBe(0);
    const [entry, ...rest] = await audits(); expect(rest).toEqual([]);
    expect(entry).toMatchObject({ actor_id: null, action: "review_link.unsubscribe", target_type: "review_link", target_id: link.id });
    expect(JSON.parse(entry!.meta_json)).toMatchObject({ memberId: link.memberId, linkId: link.id, guest: { guestId: link.guestId } });
  });

  it("is idempotent: a second unsubscribe is 200 with no second audit row and keeps the first timestamp", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId);
    await unsubscribe({ token }); const first = (await memberRow(link.memberId))!.unsubscribed_at;
    await sleep(5); expect((await unsubscribe({ token, subscribed: false })).status).toBe(200);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBe(first);
    expect(await audits()).toHaveLength(1);
  });

  it("resubscribes with subscribed: true, audits review_link.resubscribe, and keeps no stale pending rows", async () => {
    const link = await verifiedLink(); await seedPending(link); const token = await mintToken(link.memberId);
    await unsubscribe({ token });
    const response = await unsubscribe({ token, subscribed: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ subscribed: true });
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
    expect(await pendingRows(link.guestId)).toBe(0);
    expect((await audits()).map((row) => row.action)).toEqual(["review_link.unsubscribe", "review_link.resubscribe"]);
    expect((await unsubscribe({ token, subscribed: true })).status).toBe(200);
    expect(await audits()).toHaveLength(2);
  });

  it("stops ONE link only: the same guest's membership on another link stays subscribed", async () => {
    const one = await verifiedLink(); const two = await verifiedLink({}, { guestId: one.guestId });
    await seedPending(two); const token = await mintToken(one.memberId);
    await unsubscribe({ token });
    expect((await memberRow(one.memberId))!.unsubscribed_at).not.toBeNull();
    expect((await memberRow(two.memberId))!.unsubscribed_at).toBeNull();
    expect(await pendingRows(two.guestId)).toBe(2);
  });

  it("every token minted for a membership stays valid: the tokens of two emails each work, and one use does not burn the other", async () => {
    const link = await verifiedLink(); const first = await mintToken(link.memberId); const second = await mintToken(link.memberId);
    expect((await unsubscribe({ token: first })).status).toBe(200);
    expect((await unsubscribe({ token: second, subscribed: true })).status).toBe(200);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
    expect((await unsubscribe({ token: second })).status).toBe(200);
    expect((await memberRow(link.memberId))!.unsubscribed_at).not.toBeNull();
  });

  it("carries NO gate: every video review flag off, a revoked link, an expired link and an archived Project all still unsubscribe", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId);
    await clearVideoFlags();
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, link.id).run();
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    const response = await unsubscribe({ token });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ subscribed: false });
    expect((await memberRow(link.memberId))!.unsubscribed_at).not.toBeNull();
    const again = await unsubscribe({ token, subscribed: true });
    expect(again.status).toBe(200); expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
  });

  it("needs no cookie, and a session cookie does not matter", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId);
    expect((await unsubscribe({ token }, { cookie: null })).status).toBe(200);
    expect((await memberRow(link.memberId))!.unsubscribed_at).not.toBeNull();
  });

  it("answers the byte-identical stub for an unknown, malformed or hash-as-token, and writes nothing", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId); const reference = await stubBody();
    for (const candidate of [randomToken(), "x", token.slice(0, -1), `${token} `, await hashToken(token)])
      expect(await probe(await unsubscribe({ token: candidate })), candidate).toEqual(reference);
    expect(await probe(await guestFetch(`${UNSUBSCRIBE}?token=${token}`))).toEqual(reference);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull(); expect(await audits()).toHaveLength(0);
  });

  it("never accepts the token anywhere but the JSON body (a query string is ignored)", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId);
    const response = await guestFetch(`${UNSUBSCRIBE}?token=${token}`, { method: "POST", body: {} });
    expect(response.status).toBe(400);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
  });

  it("validates the body (400 for an extra key, a wrong type or bad JSON; 413 over the cap) and the Origin (403)", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId);
    for (const body of [{}, { token, extra: 1 }, { token: 5 }, { token, subscribed: "yes" }, "{not json", { token: "" }]) expect((await unsubscribe(body)).status, JSON.stringify(body)).toBe(400);
    expect((await unsubscribe(JSON.stringify({ token: "a".repeat(5000) }))).status).toBe(413);
    expect((await unsubscribe({ token }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await unsubscribe({ token }, { origin: null })).status).toBe(403);
    expect((await unsubscribe({ token }, { contentType: "text/plain" })).status).toBe(403);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull(); expect(await audits()).toHaveLength(0);
  });

  it("is limited to 30 per address in 15 minutes: the 31st is 429 with Retry-After, unknown tokens count, and another address is unaffected", async () => {
    const link = await verifiedLink(); const token = await mintToken(link.memberId); const ip = freshIp();
    for (let attempt = 0; attempt < GUEST_LIMITS.unsubscribeIp; attempt += 1) expect((await unsubscribe({ token: attempt % 2 ? token : randomToken(), subscribed: true }, { ip })).status, String(attempt)).not.toBe(429);
    const limited = await unsubscribe({ token }, { ip });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
    expect((await unsubscribe({ token }, { ip: freshIp() })).status).toBe(200);
  });
});

describe("PUT /d/api/links/:linkId/subscription", () => {
  const put = (link: { id: string }, cookie: string | null, body: unknown = { subscribed: false }, init: Parameters<typeof guestFetch>[1] = {}) =>
    guestFetch(subscriptionPath(link.id), { method: "PUT", cookie, body, ...init });

  it("lets a verified guest switch off and on, answers the state, audits each change once, and clears pending rows on unsubscribe", async () => {
    const link = await verifiedLink(); await seedPending(link);
    const off = await put(link, link.cookie);
    expect(off.status, await off.clone().text()).toBe(200); expect(guestSubscriptionResponseSchema.parse(await off.json())).toEqual({ subscribed: false });
    for (const [name, value] of Object.entries(HYGIENE)) expect(off.headers.get(name), name).toBe(value);
    expect((await memberRow(link.memberId))!.unsubscribed_at).not.toBeNull(); expect(await pendingRows(link.guestId)).toBe(0);
    expect((await put(link, link.cookie, { subscribed: false })).status).toBe(200);
    const on = await put(link, link.cookie, { subscribed: true });
    expect(await on.json()).toEqual({ subscribed: true }); expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
    const rows = await audits();
    expect(rows.map((row) => row.action)).toEqual(["review_link.unsubscribe", "review_link.resubscribe"]);
    for (const row of rows) { expect(row).toMatchObject({ actor_id: null, target_type: "review_link", target_id: link.id }); expect(JSON.parse(row.meta_json)).toMatchObject({ memberId: link.memberId, linkId: link.id, guest: { guestId: link.guestId } }); }
  });

  it("changes only this link's membership of this guest", async () => {
    const one = await verifiedLink(); const two = await verifiedLink({}, { guestId: one.guestId });
    await put(one, one.cookie);
    expect((await memberRow(one.memberId))!.unsubscribed_at).not.toBeNull(); expect((await memberRow(two.memberId))!.unsubscribed_at).toBeNull();
  });

  it("is 401 verification_required for an unverified session and writes nothing", async () => {
    const link = await seedGuestLink(); const { cookie } = await startSession(link);
    const response = await put(link, cookie);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "verification_required" });
    expect(await audits()).toHaveLength(0);
  });

  it("validates the body (400, 413) and the Origin and content type (403)", async () => {
    const link = await verifiedLink();
    for (const body of [{}, { subscribed: "no" }, { subscribed: true, extra: 1 }, "{nope"]) expect((await put(link, link.cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect((await put(link, link.cookie, JSON.stringify({ subscribed: false, pad: "a".repeat(5000) }))).status).toBe(413);
    expect((await put(link, link.cookie, undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await put(link, link.cookie, undefined, { origin: null })).status).toBe(403);
    expect((await put(link, link.cookie, undefined, { contentType: "text/plain" })).status).toBe(403);
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull();
  });

  it("is the byte-identical stub for no cookie, another link's cookie, a staff cookie, a bad id, a revoked, expired or replaced link, and a closed part; nothing is written", async () => {
    const link = await verifiedLink(); const other = await verifiedLink(); const reference = await stubBody();
    expect(await probe(await put(link, null))).toEqual(reference);
    expect(await probe(await put(link, other.cookie))).toEqual(reference);
    expect(await probe(await guestFetch(subscriptionPath(link.id), { method: "PUT", body: { subscribed: false }, headers: { cookie: "better-auth.session_token=anything" } }))).toEqual(reference);
    expect(await probe(await put({ id: "not-a-uuid" }, link.cookie))).toEqual(reference);
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run();
    expect(await probe(await put(link, link.cookie))).toEqual(reference);
    await openGuestGate(); await clearVideoFlags();
    expect(await probe(await put(link, link.cookie))).toEqual(reference);
    await openGuestGate();
    const expired = await verifiedLink(); await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect(await probe(await put(expired, expired.cookie))).toEqual(reference);
    const replaced = await verifiedLink(); await database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(replaced.id).run();
    expect(await probe(await put(replaced, replaced.cookie))).toEqual(reference);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await put(link, link.cookie))).toEqual(reference);
    for (const row of [link, other, expired, replaced]) expect((await memberRow(row.memberId))!.unsubscribed_at).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it("is 409 project_archived once the Project is archived, and writes nothing", async () => {
    const link = await verifiedLink(); await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    const response = await put(link, link.cookie);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "project_archived" });
    expect((await memberRow(link.memberId))!.unsubscribed_at).toBeNull(); expect(await audits()).toHaveLength(0);
  });

  it("a transition landing while the body is on its way writes nothing and answers the refusal", async () => {
    const transitions: Array<[string, (linkId: string) => Promise<unknown>, "stub" | "archived"]> = [
      ["revoke", (id) => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, id).run(), "stub"],
      ["replace", (id) => database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(id).run(), "stub"],
      ["expiry", (id) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run(), "stub"],
      ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run(), "stub"],
      ["gate close", () => clearVideoFlags(), "stub"],
      ["archive", () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(), "archived"],
    ];
    for (const [label, change, kind] of transitions) {
      await openGuestGate(); await wipe(); const link = await verifiedLink();
      const pending = slowRequest("PUT", subscriptionPath(link.id), link.cookie, { subscribed: false }, 250);
      await sleep(80); await change(link.id);
      const response = await pending;
      if (kind === "stub") expect(await probe(response), label).toEqual(await stubBody()); else expect(response.status, label).toBe(409);
      expect((await memberRow(link.memberId))!.unsubscribed_at, label).toBeNull(); expect(await audits(), label).toHaveLength(0);
    }
  });

  it("limits a guest to 30 switches in 15 minutes", async () => {
    const link = await verifiedLink();
    for (let attempt = 0; attempt < GUEST_LIMITS.subscriptionGuest; attempt += 1) expect((await put(link, link.cookie, { subscribed: attempt % 2 === 1 })).status, String(attempt)).toBe(200);
    const limited = await put(link, link.cookie); expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("works with the notify_client part off: the switch is not part-gated beyond guest", async () => {
    await setVideoFlags(); const link = await verifiedLink();
    expect((await put(link, link.cookie)).status).toBe(200);
  });
});
