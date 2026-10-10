import { SELF as workerSelf, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestSessionResponseSchema } from "@quincy/shared";
import { app } from "../src/index";
import { hashPasscode } from "../src/lib/review-passcode";
import { hashToken } from "../src/lib/opaque-token";
import type { Env } from "../src/env";
import { baseEnv, cookie as staffCookie, database, ids, request as staffRequest, seedFixture } from "./embedded-media-support";
import {
  addMember, clearGuestRows, cookieName, freshIp, GUEST_WINDOW_MS, guestFetch, guestOrigin, HYGIENE, linkPath, linkWithSession, openGuestGate, seedGuestLink, sessionCookie, sha256Hex, startSession,
} from "./guest-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The guest session model (#741 12a, §2): per-link exchange, cookie, passcode attempts, and the one join every request repeats. */
const DAY = 86_400_000;

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await clearVideoFlags(); });

const stubOf = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });
const sessionRows = async (linkId: string) => (await database.DB.prepare("SELECT * FROM guest_sessions WHERE link_id = ?").bind(linkId).all<Record<string, unknown>>()).results;

describe("POST /d/api/links/:linkId/session", () => {
  it("exchanges the link token for a session cookie scoped to this link, and stores only hashes", async () => {
    const link = await seedGuestLink({ label: "Smith family", allow: [1, 0, 1] });
    const before = Date.now();
    const { response, cookie } = await startSession(link);
    expect(response.status).toBe(200);
    const body = guestSessionResponseSchema.parse(await response.json());
    expect(body).toEqual({ link: { label: "Smith family", expiresAt: expect.any(String), allow: { comments: true, approve: false, download: true } }, verified: false, email: null, name: null });

    const setCookie = response.headers.getSetCookie().find((entry) => entry.startsWith(`${cookieName(link.id)}=`))!;
    expect(setCookie, "cookie name carries the __Secure- prefix and the link id").toBeDefined();
    const attributes = setCookie.split("; ").slice(1);
    expect(attributes).toContain(`Path=/d/api/links/${link.id}`);
    expect(attributes).toContain("HttpOnly"); expect(attributes).toContain("Secure"); expect(attributes).toContain("SameSite=Strict");
    const maxAge = Number(attributes.find((attribute) => attribute.startsWith("Max-Age="))!.slice(8));
    expect(maxAge).toBeGreaterThan(7 * 86_400 - 30); expect(maxAge).toBeLessThanOrEqual(7 * 86_400);
    expect(attributes.some((attribute) => attribute.startsWith("Domain="))).toBe(false);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);

    const rawSession = cookie!.split("=")[1]!;
    const [row] = await sessionRows(link.id);
    expect(row).toMatchObject({ link_id: link.id, link_generation: 1, guest_id: null, verified_at: null, token_hash: await hashToken(rawSession) });
    expect(row!.expires_at as number).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
    // Neither raw secret reaches D1.
    const dump = JSON.stringify((await database.DB.prepare("SELECT * FROM guest_sessions UNION ALL SELECT id, token_hash, project_id, 0, NULL, NULL, 0, 0, 0 FROM client_links WHERE id = ?").bind(link.id).all()).results);
    expect(dump).not.toContain(rawSession); expect(dump).not.toContain(link.token);
    const audit = await database.DB.prepare("SELECT actor_id, target_type, target_id, meta_json FROM audit_log WHERE action = 'review_link.session_start' AND target_id = ?").bind(link.id).first<{ actor_id: string | null; target_type: string; target_id: string; meta_json: string }>();
    expect(audit).toMatchObject({ actor_id: null, target_type: "review_link" });
    expect(JSON.parse(audit!.meta_json)).toEqual({ guest: { sessionId: row!.id }, linkId: link.id });
    expect(audit!.meta_json).not.toContain(link.token);
  });

  it("caps the session at the link expiry", async () => {
    const link = await seedGuestLink({ expiresAt: Date.now() + 3_600_000 });
    const { response } = await startSession(link);
    expect(response.status).toBe(200);
    const [row] = await sessionRows(link.id);
    const linkRow = await database.DB.prepare("SELECT expires_at FROM client_links WHERE id = ?").bind(link.id).first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(linkRow!.expires_at);
    const maxAge = Number(response.headers.getSetCookie()[0]!.match(/Max-Age=(\d+)/)![1]);
    expect(maxAge).toBeLessThanOrEqual(3600); expect(maxAge).toBeGreaterThan(3500);
  });

  it("answers the byte-identical stub for an unknown link, a wrong token, another link's token, a malformed token, an expired, revoked or non-video link", async () => {
    const a = await seedGuestLink(); const b = await seedGuestLink();
    const reference = await stubOf(await guestFetch("/d/api/x"));
    expect(reference.status).toBe(404);
    const post = (id: string, token: unknown) => guestFetch(linkPath(id, "/session"), { method: "POST", body: { token } });
    const attempts = [
      await post(crypto.randomUUID(), a.token), await post(a.id, b.token), await post(a.id, "A".repeat(43)), await post(a.id, "short"), await post("not-a-uuid", a.token),
      await post((await seedGuestLink({ expiresAt: Date.now() - 1000 })).id, "x".repeat(43)),
    ];
    const expired = await seedGuestLink({ expiresAt: Date.now() - 1000 }); attempts.push(await post(expired.id, expired.token));
    const revoked = await seedGuestLink({ revoked: true }); attempts.push(await post(revoked.id, revoked.token));
    const delivery = await seedGuestLink({ kind: "delivery" }); attempts.push(await post(delivery.id, delivery.token));
    for (const [index, response] of attempts.entries()) expect(await stubOf(response), `attempt ${index}`).toEqual(reference);
    expect(await sessionRows(a.id)).toHaveLength(0);
  });

  it("answers the stub when the gate is closed for this Project: master off, not piloted, guest part off", async () => {
    const link = await seedGuestLink(); const reference = await stubOf(await guestFetch("/d/api/x"));
    for (const flags of [[], ["video_review_guest"], ["video_review", "video_review_guest"], ["video_review", `video_review_pilot:${ids.project}`]] as string[][]) {
      await clearVideoFlags(); await setVideoFlags(...flags);
      expect(await stubOf((await startSession(link)).response), flags.join(",")).toEqual(reference);
    }
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_guest");
    expect((await startSession(link)).response.status, "all-projects scope opens it").toBe(200);
    // A pilot on another Project does not open this one.
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.otherProject}`, "video_review_guest");
    expect(await stubOf((await startSession(link)).response)).toEqual(reference);
  });

  it("requires the app Origin and a JSON content type (403 invalid_origin), after the gate", async () => {
    const link = await seedGuestLink();
    for (const override of [{ origin: "https://evil.example" }, { origin: null }, { contentType: "text/plain" }, { contentType: null }] as const) {
      const response = await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: { token: link.token }, ...override });
      expect(response.status, JSON.stringify(override)).toBe(403);
      expect(await response.json()).toEqual({ error: "invalid_origin" });
      for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    }
    expect(await sessionRows(link.id)).toHaveLength(0);
    // Behind a closed gate even a bad Origin is the stub, not a 403.
    await clearVideoFlags();
    expect((await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: { token: link.token }, origin: "https://evil.example" })).status).toBe(404);
  });

  it("rejects a malformed body with 400 and a token in the query string is never read", async () => {
    const link = await seedGuestLink();
    expect((await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: { token: link.token, extra: 1 } })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: {} })).status).toBe(400);
    const viaQuery = await guestFetch(`${linkPath(link.id, "/session")}?token=${link.token}`, { method: "POST", body: {} });
    expect(viaQuery.status).toBe(400);
    expect(await sessionRows(link.id)).toHaveLength(0);
  });

  it("omits Secure and the __Secure- prefix only for http://localhost", async () => {
    const link = await seedGuestLink();
    const environment: Env = { ...baseEnv, APP_ORIGIN: "http://localhost:8787" };
    const response = await app.fetch(new Request(`http://localhost:8787${linkPath(link.id, "/session")}`, {
      method: "POST", headers: { origin: "http://localhost:8787", "content-type": "application/json", "cf-connecting-ip": freshIp() }, body: JSON.stringify({ token: link.token }),
    }), environment, createExecutionContext());
    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie()[0]!;
    expect(setCookie.startsWith(`quincy_guest_${link.id}=`)).toBe(true);
    expect(setCookie).not.toContain("Secure"); expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict"); expect(setCookie).toContain(`Path=/d/api/links/${link.id}`);
    // The prefixed name is not accepted on a localhost deployment, and the plain name is not accepted in production.
    const plain = setCookie.split(";")[0]!;
    const production = await guestFetch(linkPath(link.id, "/session"), { cookie: plain });
    expect(production.status).toBe(404);
  });
});

describe("passcode", () => {
  it("answers 401 passcode_required, then 401 passcode_incorrect, then 200, without a session row before acceptance", async () => {
    const link = await seedGuestLink({ passcodeHash: await hashPasscode("opensesame") });
    const missing = await startSession(link);
    expect(missing.response.status).toBe(401); expect(await missing.response.json()).toEqual({ error: "passcode_required" });
    const wrong = await startSession(link, "wrong-guess");
    expect(wrong.response.status).toBe(401); expect(await wrong.response.json()).toEqual({ error: "passcode_incorrect" });
    expect(wrong.cookie).toBeNull(); expect(missing.cookie).toBeNull();
    expect(await sessionRows(link.id)).toHaveLength(0);
    for (const [name, value] of Object.entries(HYGIENE)) expect(wrong.response.headers.get(name), name).toBe(value);
    const right = await startSession(link, "opensesame");
    expect(right.response.status).toBe(200); expect(right.cookie).not.toBeNull();
    expect(await sessionRows(link.id)).toHaveLength(1);
  });

  it("limits one address to 10 passcode attempts per 15 minutes, with Retry-After, and counts the IP only as a hash", async () => {
    const link = await seedGuestLink({ passcodeHash: await hashPasscode("opensesame") }); const ip = "192.0.2.77";
    for (let attempt = 1; attempt <= 10; attempt += 1) expect((await startSession(link, `wrong-${attempt}`, ip)).response.status, `attempt ${attempt}`).toBe(401);
    const limited = await startSession(link, "opensesame", ip);
    expect(limited.response.status).toBe(429);
    const body = await limited.response.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("too_many_attempts"); expect(body.retryAfterSeconds).toBeGreaterThan(0); expect(body.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(limited.response.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
    // The right passcode did not get through while limited, and another address is unaffected.
    expect(limited.cookie).toBeNull();
    expect((await startSession(link, "opensesame", "192.0.2.78")).response.status).toBe(200);
    const buckets = (await database.DB.prepare("SELECT bucket FROM guest_rate_limits").all<{ bucket: string }>()).results.map((row) => row.bucket);
    expect(buckets.join("|")).not.toContain(ip);
    const window = Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    // The bucket name is the digest of `ip|window`, so a test can rebuild it; recompute for the previous window too in case the clock rolled.
    const candidates = await Promise.all([window, window - GUEST_WINDOW_MS].map(async (start) => `passcode:ip:${await sha256Hex(`${ip}|${start}`)}`));
    expect(buckets.some((bucket) => candidates.includes(bucket))).toBe(true);
  });

  it("limits one link to 20 attempts per 15 minutes across addresses", async () => {
    const link = await seedGuestLink({ passcodeHash: await hashPasscode("opensesame") });
    for (let attempt = 1; attempt <= 20; attempt += 1) expect((await startSession(link, `wrong-${attempt}`)).response.status, `attempt ${attempt}`).toBe(401);
    expect((await startSession(link, "opensesame")).response.status).toBe(429);
  });

  it("admits exactly one of two concurrent attempts when one slot is left (the reservation is one statement)", async () => {
    const link = await seedGuestLink({ passcodeHash: await hashPasscode("opensesame") });
    const window = Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 19)").bind(`passcode:link:${link.id}`, window).run();
    const results = await Promise.all([startSession(link, "wrong-a"), startSession(link, "wrong-b")]);
    expect(results.map((result) => result.response.status).sort()).toEqual([401, 429]);
    const row = await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(`passcode:link:${link.id}`).first<{ count: number }>();
    expect(row!.count).toBe(20);
  });

  it("limits tokenless guessing per address (exchange:ip, 60 per window) and answers 429 once past it", async () => {
    const link = await seedGuestLink(); const ip = "192.0.2.99";
    const window = Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 60)").bind(`exchange:ip:${await sha256Hex(`${ip}|${window}`)}`, window).run();
    const response = await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: { token: "A".repeat(43) }, ip });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "too_many_attempts" });
  });
});

describe("GET and DELETE /d/api/links/:linkId/session", () => {
  it("returns the link summary on reload and the stub without the cookie, with another link's cookie, or with a forged one", async () => {
    const a = await linkWithSession(); const b = await linkWithSession();
    const ok = await guestFetch(linkPath(a.id, "/session"), { cookie: a.cookie });
    expect(ok.status).toBe(200);
    expect(guestSessionResponseSchema.parse(await ok.json()).link.label).toBe("Smith family");
    for (const [name, value] of Object.entries(HYGIENE)) expect(ok.headers.get(name), name).toBe(value);
    const reference = await stubOf(await guestFetch("/d/api/x"));
    expect(await stubOf(await guestFetch(linkPath(a.id, "/session")))).toEqual(reference);
    // b's cookie carries b's name, so it is not even looked at on a's path, and a forged value under a's name fails the hash join.
    expect(await stubOf(await guestFetch(linkPath(a.id, "/session"), { cookie: b.cookie }))).toEqual(reference);
    expect(await stubOf(await guestFetch(linkPath(a.id, "/session"), { cookie: `${cookieName(a.id)}=${b.cookie.split("=")[1]}` }))).toEqual(reference);
    expect(await stubOf(await guestFetch(linkPath(a.id, "/session"), { cookie: `${cookieName(a.id)}=forged` }))).toEqual(reference);
  });

  it("kills a live session at once on revoke, replace, a shortened expiry, an expired session and a closed gate", async () => {
    const reference = await stubOf(await guestFetch("/d/api/x"));
    const read = (session: { id: string; cookie: string }) => guestFetch(linkPath(session.id, "/session"), { cookie: session.cookie });
    const revoked = await linkWithSession(); expect((await read(revoked)).status).toBe(200);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, revoked.id).run();
    expect(await stubOf(await read(revoked))).toEqual(reference);

    const replaced = await linkWithSession(); expect((await read(replaced)).status).toBe(200);
    await database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(replaced.id).run();
    expect(await stubOf(await read(replaced)), "the generation join, with the session row still present").toEqual(reference);

    const shortened = await linkWithSession(); expect((await read(shortened)).status).toBe(200);
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, shortened.id).run();
    expect(await stubOf(await read(shortened))).toEqual(reference);

    const lapsed = await linkWithSession(); expect((await read(lapsed)).status).toBe(200);
    await database.DB.prepare("UPDATE guest_sessions SET expires_at = ?, created_at = ? WHERE link_id = ?").bind(Date.now() - 1, Date.now() - 1000, lapsed.id).run();
    expect(await stubOf(await read(lapsed))).toEqual(reference);

    const closed = await linkWithSession(); expect((await read(closed)).status).toBe(200);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'video_review_guest'").run();
    expect(await stubOf(await read(closed))).toEqual(reference);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'video_review_guest'").run();
    expect((await read(closed)).status, "turning the part back on restores it").toBe(200);
  });

  it("writes last_seen_at only when it is older than five minutes", async () => {
    const link = await linkWithSession();
    const seen = async () => (await database.DB.prepare("SELECT last_seen_at FROM guest_sessions WHERE link_id = ?").bind(link.id).first<{ last_seen_at: number }>())!.last_seen_at;
    const first = await seen();
    await guestFetch(linkPath(link.id, "/session"), { cookie: link.cookie });
    expect(await seen()).toBe(first);
    const stale = Date.now() - 6 * 60_000;
    await database.DB.prepare("UPDATE guest_sessions SET last_seen_at = ? WHERE link_id = ?").bind(stale, link.id).run();
    await guestFetch(linkPath(link.id, "/session"), { cookie: link.cookie });
    expect(await seen()).toBeGreaterThan(stale + 5 * 60_000);
  });

  it("leaves: deletes the row, clears the cookie with the same name and path, and the next read is the stub", async () => {
    const link = await linkWithSession();
    const response = await guestFetch(linkPath(link.id, "/session"), { method: "DELETE", cookie: link.cookie });
    expect(response.status).toBe(204);
    const cleared = response.headers.getSetCookie().find((entry) => entry.startsWith(`${cookieName(link.id)}=`))!;
    expect(cleared).toContain("Max-Age=0"); expect(cleared).toContain(`Path=/d/api/links/${link.id}`);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect(await sessionRows(link.id)).toHaveLength(0);
    expect((await guestFetch(linkPath(link.id, "/session"), { cookie: link.cookie })).status).toBe(404);
    // Leaving needs the Origin like every unsafe request.
    const again = await linkWithSession();
    expect((await guestFetch(linkPath(again.id, "/session"), { method: "DELETE", cookie: again.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(await sessionRows(again.id)).toHaveLength(1);
  });

  it("keeps two links in one browser side by side", async () => {
    const a = await linkWithSession(); const b = await linkWithSession({ label: "Jones family" });
    const both = `${a.cookie}; ${b.cookie}`;
    const labelOf = async (id: string) => guestSessionResponseSchema.parse(await (await guestFetch(linkPath(id, "/session"), { cookie: both })).json()).link.label;
    expect(await labelOf(a.id)).toBe("Smith family"); expect(await labelOf(b.id)).toBe("Jones family");
  });
});

describe("GET /d/review", () => {
  it("serves the SPA shell only for a link that passes the full gate, with the hygiene headers and frame-ancestors", async () => {
    const link = await seedGuestLink();
    const response = await guestFetch(`/d/review?link=${link.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toContain("<div id=\"root\"");
  });

  it("serves byte-identical shells (body and every header) for a live, unknown, expired, revoked, non-video and non-pilot link", async () => {
    const live = await seedGuestLink();
    const expired = await seedGuestLink({ expiresAt: Date.now() - 1000 }); const revoked = await seedGuestLink({ revoked: true }); const delivery = await seedGuestLink({ kind: "delivery" });
    const shellOf = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });
    const reference = await shellOf(await guestFetch(`/d/review?link=${live.id}`));
    expect(reference.status).toBe(200);
    expect(reference.body).toContain("<div id=\"root\"");
    for (const id of [crypto.randomUUID(), expired.id, revoked.id, delivery.id]) {
      const other = await shellOf(await guestFetch(`/d/review?link=${id}`));
      expect(other, id).toEqual(reference);
    }
    // The Project's pilot is off (the pilot flag names another Project only): the link is live in D1, the shell is the same.
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_pilot:another-project", "video_review_guest");
    expect(await shellOf(await guestFetch(`/d/review?link=${live.id}`)), "pilot off").toEqual(reference);
    // "Guest part off, master on" is not a shell case: `guestGloballyOpen` reads that pair, so it is the stub (next test).
    const headers = Object.fromEntries(reference.headers);
    for (const [name, value] of Object.entries(HYGIENE)) expect(headers[name], name).toBe(value);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("answers the shared stub, not the shell, for a closed global gate (master off, guest part off), a missing, malformed or extra query", async () => {
    const link = await seedGuestLink(); const reference = await stubOf(await guestFetch("/d/api/x"));
    expect(reference.status).toBe(404);
    const probe = async (path: string, label: string) => expect(await stubOf(await guestFetch(path)), label).toEqual(reference);
    await probe("/d/review", "missing ?link=");
    await probe("/d/review?link=not-a-uuid", "malformed ?link=");
    await probe(`/d/review?link=${link.id}&x=1`, "extra query param");
    await clearVideoFlags(); await setVideoFlags(`video_review_pilot:${ids.project}`, "video_review_guest");
    await probe(`/d/review?link=${link.id}`, "master flag off");
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    await probe(`/d/review?link=${link.id}`, "master on, guest part off");
  });

  it("answers the stub for a missing, repeated, extra or malformed query, a wrong path, and a closed gate", async () => {
    const link = await seedGuestLink(); const reference = await stubOf(await guestFetch("/d/api/x"));
    const paths = [
      "/d/review", `/d/review?link=${link.id}&link=${link.id}`, `/d/review?link=${link.id}&t=${link.token}`, `/d/review?link=${link.id}&x=1`, `/d/review?t=${link.token}`, "/d/review?link=not-a-uuid", `/d/review/extra?link=${link.id}`,
    ];
    for (const path of paths) expect(await stubOf(await guestFetch(path)), path).toEqual(reference);
    await clearVideoFlags(); await setVideoFlags("video_review");
    expect(await stubOf(await guestFetch(`/d/review?link=${link.id}`)), "guest flag off").toEqual(reference);
  });
});

describe("staff and guest stay apart", () => {
  it("a staff cookie on a guest route is the stub, and a guest cookie on a staff route is 401", async () => {
    const link = await linkWithSession(); const reference = await stubOf(await guestFetch("/d/api/x"));
    expect(await stubOf(await guestFetch(linkPath(link.id, "/videos"), { cookie: await staffCookie("admin") }))).toEqual(reference);
    const video = await seedVideoVersion({});
    await addMember(link.id, video.videoId, [video.assetId]);
    const staff = await workerSelf.fetch(`https://portal.test/api/projects/${ids.project}/videos`, { headers: { cookie: link.cookie } });
    expect(staff.status).toBe(401);
    const media = await workerSelf.fetch(`https://portal.test/media/video/${video.assetId}`, { headers: { cookie: link.cookie } });
    expect(media.status).toBe(401);
    // And a guest path never accepts the link token as a credential.
    expect((await guestFetch(linkPath(link.id, "/videos"), { headers: { authorization: `Bearer ${link.token}` } })).status).toBe(404);
    expect(guestOrigin).toBeTruthy();
    expect(sessionCookie(await guestFetch(linkPath(link.id, "/session"), { cookie: link.cookie }), link.id)).toBeNull();
  });
});

describe("staff create and guest exchange together (11a + 12a)", () => {
  it("a link created through the staff route with a passcode exchanges on the guest route, and a wrong passcode does not", async () => {
    await setVideoFlags("video_review_links");
    const video = await seedVideoVersion({});
    const created = await staffRequest(`/api/projects/${ids.project}/review-links`, "admin", "POST", { videoIds: [video.videoId], passcode: "studio-pass-1" });
    expect(created.status, await created.clone().text()).toBe(201);
    const { link, url } = await created.json() as { link: { id: string }; url: string };
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/d/review"); expect(parsed.searchParams.get("link")).toBe(link.id);
    const token = parsed.hash.slice(3);
    const stored = (await database.DB.prepare("SELECT passcode_hash FROM client_links WHERE id = ?").bind(link.id).first<{ passcode_hash: string }>())!.passcode_hash;
    expect(stored).toMatch(/^pbkdf2-sha256\$100000\$/);
    const wrong = await startSession({ id: link.id, token }, "nope-nope-1");
    expect(wrong.response.status).toBe(401);
    const right = await startSession({ id: link.id, token }, "studio-pass-1");
    expect(right.response.status).toBe(200); expect(right.cookie).not.toBeNull();
    const videos = await guestFetch(linkPath(link.id, "/videos"), { cookie: right.cookie });
    expect(videos.status).toBe(200);
    expect(JSON.stringify(await videos.json())).toContain(video.videoId);
  });
});

describe("Sol round 1 fixes", () => {
  /** An env whose DB runs `before` ahead of the Nth multi-statement batch (the rate-limit reservation or the session INSERT), standing in for staff acting mid-exchange. */
  async function exchangeWithRace(link: { id: string; token: string }, passcode: string | undefined, nth: number, before: () => Promise<void>) {
    let seen = 0;
    const db = new Proxy(baseEnv.DB, { get: (target, property) => {
      const value = Reflect.get(target, property);
      if (property !== "batch") return typeof value === "function" ? value.bind(target) : value;
      return async (statements: unknown[]) => { if (statements.length >= 2 && (seen += 1) === nth) await before(); return target.batch(statements as D1PreparedStatement[]); };
    } });
    const environment: Env = { ...baseEnv, DB: db as D1Database };
    return app.fetch(new Request(`https://portal.test${linkPath(link.id, "/session")}`, {
      method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() }, body: JSON.stringify({ token: link.token, ...(passcode === undefined ? {} : { passcode }) }),
    }), environment, createExecutionContext());
  }

  it("mints no session when staff add a passcode between the check and the insert", async () => {
    const link = await seedGuestLink();
    const response = await exchangeWithRace(link, undefined, 1, async () => { await database.DB.prepare("UPDATE client_links SET passcode_hash = ? WHERE id = ?").bind(await hashPasscode("brand-new-pass"), link.id).run(); });
    expect(response.status).toBe(404); expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows(link.id)).toHaveLength(0);
  });

  it("mints no session when staff change the passcode between the verify and the insert", async () => {
    const link = await seedGuestLink({ passcodeHash: await hashPasscode("old-passcode") });
    const response = await exchangeWithRace(link, "old-passcode", 2, async () => { await database.DB.prepare("UPDATE client_links SET passcode_hash = ? WHERE id = ?").bind(await hashPasscode("changed-pass"), link.id).run(); });
    expect(response.status).toBe(404);
    expect(await sessionRows(link.id)).toHaveLength(0);
  });

  it("spends the address quota before it looks a link up: random UUIDs with an empty body hit 429 after 60", async () => {
    const ip = "192.0.2.123";
    let last = 0;
    for (let attempt = 1; attempt <= 61; attempt += 1) last = (await guestFetch(linkPath(crypto.randomUUID(), "/session"), { method: "POST", body: {}, ip })).status;
    expect(last).toBe(429);
    const window = Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    const used = await database.DB.prepare("SELECT SUM(count) AS n FROM guest_rate_limits WHERE bucket = ?").bind(`exchange:ip:${await sha256Hex(`${ip}|${window}`)}`).first<{ n: number | null }>();
    expect(used!.n === null || used!.n >= 60).toBe(true);
  });

  it("leave resolves the session first: a missing, forged, expired or old-generation credential is the stub and clears nothing", async () => {
    const reference = await stubOf(await guestFetch("/d/api/x"));
    const leave = (id: string, cookie: string | null) => guestFetch(linkPath(id, "/session"), { method: "DELETE", cookie });
    const live = await linkWithSession();
    expect(await stubOf(await leave(live.id, null))).toEqual(reference);
    expect(await stubOf(await leave(live.id, `${cookieName(live.id)}=forged`))).toEqual(reference);
    expect(await sessionRows(live.id)).toHaveLength(1);
    const lapsed = await linkWithSession();
    await database.DB.prepare("UPDATE guest_sessions SET expires_at = ?, created_at = ? WHERE link_id = ?").bind(Date.now() - 1, Date.now() - 1000, lapsed.id).run();
    expect(await stubOf(await leave(lapsed.id, lapsed.cookie))).toEqual(reference);
    const replaced = await linkWithSession();
    await database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(replaced.id).run();
    expect(await stubOf(await leave(replaced.id, replaced.cookie))).toEqual(reference);
    expect((await leave(live.id, live.cookie)).status).toBe(204);
  });

  it("rejects an oversize declared Content-Length without reading the body", async () => {
    const link = await seedGuestLink();
    const response = await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: JSON.stringify({ token: link.token, pad: "x".repeat(5000) }) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("cuts a streamed body with no length off at the limit and cancels the reader", async () => {
    const link = await seedGuestLink(); let pulled = 0; let cancelled = false;
    const chunk = new Uint8Array(1024).fill(120);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (pulled >= 64 * 1024) { controller.close(); return; } pulled += chunk.length; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    const request = new Request(`https://portal.test${linkPath(link.id, "/session")}`, { method: "POST", body, duplex: "half", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() } } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const response = await app.fetch(request, baseEnv, createExecutionContext());
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(8 * 1024); expect(cancelled).toBe(true);
    expect(await sessionRows(link.id)).toHaveLength(0);
  });

  it("builds the cookie and the response from the stored session when staff shorten the expiry mid-exchange", async () => {
    const link = await seedGuestLink(); const shortened = Date.now() + 3_600_000;
    const response = await exchangeWithRace(link, undefined, 1, async () => { await database.DB.prepare("UPDATE client_links SET expires_at = ?, label = 'Renamed' WHERE id = ?").bind(shortened, link.id).run(); });
    expect(response.status).toBe(200);
    const maxAge = Number(response.headers.getSetCookie()[0]!.match(/Max-Age=(\d+)/)![1]);
    expect(maxAge).toBeLessThanOrEqual(3600);
    const body = guestSessionResponseSchema.parse(await response.json());
    expect(body.link.expiresAt).toBe(new Date(shortened).toISOString()); expect(body.link.label).toBe("Renamed");
    const [row] = await sessionRows(link.id);
    expect(row!.expires_at).toBe(shortened);
  });
});
