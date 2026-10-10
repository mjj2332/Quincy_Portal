import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guestSessionResponseSchema, reviewLinkListResponseSchema } from "@quincy/shared";
import { hashToken } from "../src/lib/opaque-token";
import { emailBucket, ipBucket } from "../src/guest/rate-limit";
import { baseEnv, database, ids, request as staffRequest, seedFixture } from "./embedded-media-support";
import {
  addMember, clearGuestRows, freshIp, GUEST_WINDOW_MS, guestFetch, guestOrigin, HYGIENE, linkPath, linkWithSession, mockEmail, openGuestGate, seedGuestLink, sessionCookie, sha256Hex, startSession, type SentEmail,
} from "./guest-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The guest email code API (#741 13a): send a six-digit code, verify it, and the session becomes a verified guest. */
const DAY = 86_400_000; const MINUTE = 60_000;
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;
const EMAIL = "gina@guest-13a.test"; const NAME = "Gina Guest";

let mail: ReturnType<typeof mockEmail>;
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await openGuestGate(); mail = mockEmail(); });
afterEach(async () => {
  mail.restore(); vi.restoreAllMocks();
  await database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.email_%'").run();
  await database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-13a.test' OR email_normalized LIKE '%.invalid'").run();
  await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
  await clearGuestRows(); await clearVideoFlags();
});

type Session = { id: string; token: string; cookie: string };
const sessionOf = async (link: { id: string; token: string }): Promise<Session> => {
  const { cookie } = await startSession(link); if (!cookie) throw new Error("no session");
  const row = await database.DB.prepare("SELECT id FROM guest_sessions WHERE token_hash = ?").bind(await hashToken(cookie.split("=")[1]!)).first<{ id: string }>();
  return { id: row!.id, token: cookie.split("=")[1]!, cookie };
};
const sendCode = (link: { id: string }, cookie: string | null, email: unknown = EMAIL, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(linkPath(link.id, "/email/code"), { method: "POST", cookie, body: { email }, ...init });
const verify = (link: { id: string }, cookie: string | null, code: string, name: unknown = NAME, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(linkPath(link.id, "/email/verify"), { method: "POST", cookie, body: { code, name }, ...init });
const codeOf = (message: SentEmail) => /Your review code: (\d{6})$/.exec(message.subject)![1]!;
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");
const codeRows = async (sessionId: string) => (await database.DB.prepare("SELECT * FROM guest_email_codes WHERE session_id = ? ORDER BY created_at, rowid").bind(sessionId).all<Json>()).results;
const sessionRow = async (sessionId: string) => database.DB.prepare("SELECT * FROM guest_sessions WHERE id = ?").bind(sessionId).first<Json>();
const audits = async (action: string, linkId?: string) => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = ?1 AND (?2 IS NULL OR target_id = ?2)").bind(action, linkId ?? null).all<Json>()).results;
/** Lets a second code be requested: the 60-second wait and its counter are what stand between two sends of one session. */
async function pastResendWait(sessionId: string) {
  await database.DB.batch([database.DB.prepare("UPDATE guest_email_codes SET created_at = created_at - 61000, expires_at = expires_at - 61000 WHERE session_id = ?").bind(sessionId), database.DB.prepare("DELETE FROM guest_rate_limits WHERE bucket LIKE 'codesend:session:%'")]);
}
async function seedBucket(bucket: string, count: number, windowMs = GUEST_WINDOW_MS) {
  await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?1, ?2, ?3)").bind(bucket, Math.floor(Date.now() / windowMs) * windowMs, count).run();
}
/** A link, a session, a sent code, and the code itself. */
async function sent(input: { email?: string; link?: Awaited<ReturnType<typeof seedGuestLink>> } = {}) {
  const link = input.link ?? await seedGuestLink(); const session = await sessionOf(link);
  const response = await sendCode(link, session.cookie, input.email ?? EMAIL);
  expect(response.status, await response.clone().text()).toBe(202);
  return { link, session, code: codeOf(mail.sent.at(-1)!) };
}
/** Takes a session all the way to verified; the cookie is the rotated one. */
async function verifiedGuest(input: { email?: string; name?: string; link?: Awaited<ReturnType<typeof seedGuestLink>> } = {}) {
  const { link, session, code } = await sent(input);
  const response = await verify(link, session.cookie, code, input.name ?? NAME);
  expect(response.status, await response.clone().text()).toBe(200);
  return { link, session, oldCookie: session.cookie, cookie: sessionCookie(response, link.id)!, response };
}

describe("POST .../email/code", () => {
  it("answers 202 with the same bytes for a new address, a known one and an unroutable one, and sends one email each", async () => {
    const link = await seedGuestLink();
    const first = await sessionOf(link); const known = await sessionOf(link); const odd = await sessionOf(link);
    await verifiedGuest({ link, email: "known@guest-13a.test" });
    const responses = [
      await sendCode(link, first.cookie, "brand-new@guest-13a.test"),
      await sendCode(link, known.cookie, "known@guest-13a.test"),
      await sendCode(link, odd.cookie, "someone@no-such-domain.invalid"),
    ];
    const bodies = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.text(), type: response.headers.get("content-type") })));
    expect(bodies[0]).toEqual({ status: 202, body: JSON.stringify({ sent: true, resendAfterSeconds: 60 }), type: expect.stringContaining("application/json") });
    expect(bodies[1]).toEqual(bodies[0]); expect(bodies[2]).toEqual(bodies[0]);
    expect(mail.sent.map((message) => message.to).slice(-3)).toEqual(["brand-new@guest-13a.test", "known@guest-13a.test", "someone@no-such-domain.invalid"]);
    for (const response of responses) for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
  });

  it("sends the code through the email sender: subject, text and escaped HTML, no Review link, no unsubscribe link", async () => {
    const link = await seedGuestLink({ label: `Smith <b>&</b> family` });
    const { code } = await sent({ link, email: "  Gina@Guest-13A.test " });
    const message = mail.sent.at(-1)!;
    expect(message.from).toBe("studio@example.test"); expect(message.to).toBe("gina@guest-13a.test");
    expect(message.subject).toBe(`Your review code: ${code}`);
    expect(message.text).toBe(`Use ${code.slice(0, 3)} ${code.slice(3)} to verify your email for Smith <b>&</b> family. It expires in 10 minutes. If you didn't ask for it, ignore this email: nothing happens unless the code is entered. You won't get other email from this review unless you verify.`);
    expect(message.html).toContain("Smith &lt;b&gt;&amp;&lt;/b&gt; family"); expect(message.html).not.toContain("<b>");
    for (const body of [message.text, message.html]) {
      expect(body).not.toMatch(/unsubscribe/i); expect(body).not.toContain(link.token); expect(body).not.toContain(link.id); expect(body).not.toMatch(/https?:\/\//);
    }
  });

  it("names a link with no label 'your video review'", async () => {
    await sent({ link: await seedGuestLink({ label: null }) });
    expect(mail.sent.at(-1)!.text).toContain("to verify your email for your video review.");
  });

  it("stores the code only as a PBKDF2 hash, valid for 10 minutes, with no tries used", async () => {
    const before = Date.now(); const { session, code } = await sent(); const [row] = await codeRows(session.id);
    expect(code).toMatch(/^\d{6}$/);
    expect(row).toMatchObject({ email_normalized: EMAIL, attempts: 0, consumed_at: null });
    expect(row!.code_hash).toMatch(/^pbkdf2-sha256\$/); expect(JSON.stringify(row)).not.toContain(code);
    expect(row!.expires_at - row!.created_at).toBe(10 * MINUTE); expect(row!.created_at).toBeGreaterThanOrEqual(before);
  });

  it("refuses a second send within 60 seconds with 429 and Retry-After, and sends nothing", async () => {
    const { link, session } = await sent();
    const again = await sendCode(link, session.cookie);
    expect(again.status).toBe(429); expect(again.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await again.json()).toEqual({ error: "too_many_attempts", retryAfterSeconds: Number(again.headers.get("retry-after")) });
    expect(Number(again.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(mail.sent).toHaveLength(1);
    await pastResendWait(session.id);
    expect((await sendCode(link, session.cookie)).status).toBe(202); expect(mail.sent).toHaveLength(2);
  });

  it("caps one address at 5 sends in 15 minutes, across sessions", async () => {
    const link = await seedGuestLink();
    for (let index = 0; index < 5; index += 1) expect((await sendCode(link, (await sessionOf(link)).cookie)).status, `send ${index + 1}`).toBe(202);
    const sixth = await sendCode(link, (await sessionOf(link)).cookie);
    expect(sixth.status).toBe(429); expect(await sixth.json()).toMatchObject({ error: "too_many_attempts" });
    expect(mail.sent).toHaveLength(5);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "someone-else@guest-13a.test")).status).toBe(202);
  });

  it("caps one address at 20 sends a day", async () => {
    const link = await seedGuestLink(); const start = Math.floor(Date.now() / DAY) * DAY;
    await seedBucket(await emailBucket("codesend24h", EMAIL, start), 19, DAY);
    expect((await sendCode(link, (await sessionOf(link)).cookie)).status).toBe(202);
    const over = await sendCode(link, (await sessionOf(link)).cookie);
    expect(over.status).toBe(429); expect(mail.sent).toHaveLength(1);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(60);
  });

  it("caps one link at 30 sends in 15 minutes", async () => {
    const link = await seedGuestLink(); await seedBucket(`codesend:link:${link.id}`, 29);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "a@guest-13a.test")).status).toBe(202);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "b@guest-13a.test")).status).toBe(429);
    const other = await seedGuestLink(); expect((await sendCode(other, (await sessionOf(other)).cookie, "c@guest-13a.test")).status).toBe(202);
  });

  it("caps one address (IP) at 10 sends in 15 minutes", async () => {
    const link = await seedGuestLink(); const ip = freshIp(); await seedBucket(await ipBucket("codesend", ip, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS), 9);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "a@guest-13a.test", { ip })).status).toBe(202);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "b@guest-13a.test", { ip })).status).toBe(429);
    expect((await sendCode(link, (await sessionOf(link)).cookie, "b@guest-13a.test", { ip: freshIp() })).status).toBe(202);
  });

  it("admits one of two concurrent sends at limit minus one", async () => {
    const link = await seedGuestLink(); await seedBucket(await emailBucket("codesend", EMAIL, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS), 4);
    const [a, b] = [await sessionOf(link), await sessionOf(link)];
    const statuses = (await Promise.all([sendCode(link, a.cookie), sendCode(link, b.cookie)])).map((response) => response.status).sort();
    expect(statuses).toEqual([202, 429]); expect(mail.sent).toHaveLength(1);
  });

  it("admits one of two concurrent sends from one session", async () => {
    const { link, session } = await (async () => { const link = await seedGuestLink(); return { link, session: await sessionOf(link) }; })();
    const statuses = (await Promise.all([sendCode(link, session.cookie), sendCode(link, session.cookie)])).map((response) => response.status).sort();
    expect(statuses).toEqual([202, 429]); expect(await codeRows(session.id)).toHaveLength(1);
  });

  it("answers 202 and audits delivered:false when the email cannot be sent, with the same body", async () => {
    mail.restore(); mail = mockEmail({ fail: Object.assign(new Error("secret detail user@elsewhere.test"), { code: "E_DOMAIN_NOT_VERIFIED" }) });
    const link = await seedGuestLink(); const session = await sessionOf(link);
    const response = await sendCode(link, session.cookie);
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ sent: true, resendAfterSeconds: 60 });
    const [row] = await audits("review_link.email_code_send", link.id);
    expect(JSON.parse(row!.meta_json)).toEqual({ guest: { sessionId: session.id }, linkId: link.id, delivered: false, errorCode: "E_DOMAIN_NOT_VERIFIED" });
    expect(JSON.stringify(row)).not.toContain("secret detail");
  });

  it("answers 202 with an unknown error as a generic code, and with no email binding at all", async () => {
    mail.restore(); mail = mockEmail({ fail: new Error("boom") });
    const link = await seedGuestLink();
    expect((await sendCode(link, (await sessionOf(link)).cookie)).status).toBe(202);
    mail.restore(); mail = mockEmail({ configured: false });
    expect((await sendCode(link, (await sessionOf(link)).cookie, "x@guest-13a.test")).status).toBe(202);
    const metas = (await audits("review_link.email_code_send", link.id)).map((row) => JSON.parse(row.meta_json));
    expect(metas.map((meta) => [meta.delivered, meta.errorCode])).toEqual([[false, "send_failed"], [false, "email_configuration_missing"]]);
  });

  it("audits a send with the guest session and link, never the address or the code", async () => {
    const { link, session, code } = await sent();
    const rows = await audits("review_link.email_code_send", link.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: null, target_type: "review_link", target_id: link.id });
    expect(JSON.parse(rows[0]!.meta_json)).toEqual({ guest: { sessionId: session.id }, linkId: link.id, delivered: true });
    expect(JSON.stringify(rows[0])).not.toContain(code); expect(JSON.stringify(rows[0])).not.toContain("guest-13a");
  });

  it("validates the body: 400 for a bad address, an extra key or bad JSON, 413 over the cap, 403 off-origin", async () => {
    const link = await seedGuestLink(); const { cookie } = await sessionOf(link);
    for (const email of ["", "not-an-email", "a@b@c.test", `${"x".repeat(250)}@guest-13a.test`, 5, null]) expect((await sendCode(link, cookie, email, { ip: freshIp() })).status, String(email)).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/code"), { method: "POST", cookie, body: { email: EMAIL, extra: 1 } })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/code"), { method: "POST", cookie, body: "{nope" })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/code"), { method: "POST", cookie, body: JSON.stringify({ email: EMAIL, pad: "x".repeat(4000) }) })).status).toBe(413);
    expect((await sendCode(link, cookie, EMAIL, { origin: "https://evil.test" })).status).toBe(403);
    expect((await sendCode(link, cookie, EMAIL, { origin: null })).status).toBe(403);
    expect((await sendCode(link, cookie, EMAIL, { contentType: "text/plain" })).status).toBe(403);
    expect(mail.sent).toHaveLength(0);
  });

  it("is the stub, and writes nothing, for no cookie, another link's cookie, a staff cookie, a revoked, expired or replaced link and a closed part", async () => {
    const link = await seedGuestLink(); const other = await seedGuestLink(); const mine = await sessionOf(link); const theirs = await sessionOf(other);
    const stub = await guestFetch("/d");
    const reference = { status: stub.status, body: await stub.text() };
    const probe = async (response: Response) => ({ status: response.status, body: await response.text() });
    expect(await probe(await sendCode(link, null))).toEqual(reference);
    expect(await probe(await sendCode(link, theirs.cookie))).toEqual(reference);
    expect(await probe(await sendCode(link, mine.cookie.replace("=", "=x")))).toEqual(reference);
    const staff = await guestFetch(linkPath(link.id, "/email/code"), { method: "POST", body: { email: EMAIL }, headers: { cookie: "better-auth.session_token=anything" } });
    expect(await probe(staff)).toEqual(reference);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), link.id).run();
    expect(await probe(await sendCode(link, mine.cookie))).toEqual(reference);
    const expired = await seedGuestLink(); const expiredSession = await sessionOf(expired);
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect(await probe(await sendCode(expired, expiredSession.cookie))).toEqual(reference);
    const replaced = await seedGuestLink(); const replacedSession = await sessionOf(replaced);
    await database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(replaced.id).run();
    expect(await probe(await sendCode(replaced, replacedSession.cookie))).toEqual(reference);
    const closed = await seedGuestLink(); const closedSession = await sessionOf(closed);
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    expect(await probe(await sendCode(closed, closedSession.cookie))).toEqual(reference);
    expect(mail.sent).toHaveLength(0);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_email_codes").first<{ n: number }>())!.n).toBe(0);
    expect(await audits("review_link.email_code_send")).toHaveLength(0);
  });

  it("refuses an address other than the one a verified session already holds with 409 already_verified, and lets the same address through", async () => {
    const { link, cookie, session } = await verifiedGuest();
    const other = await sendCode(link, cookie, "someone-else@guest-13a.test");
    expect(other.status).toBe(409); expect(await other.json()).toEqual({ error: "already_verified" });
    await pastResendWait(session.id);
    const same = await sendCode(link, cookie, EMAIL.toUpperCase());
    expect(same.status).toBe(202);
  });
});

describe("POST .../email/verify", () => {
  it("verifies: fills the session, creates the reviewer and the membership, rotates the cookie and answers the verified session body", async () => {
    const link = await seedGuestLink({ label: "Smith family" }); const { session, code } = await sent({ link });
    const before = Date.now(); const response = await verify(link, session.cookie, code, "  Gina   Guest ");
    expect(response.status).toBe(200);
    const body = guestSessionResponseSchema.parse(await response.json());
    expect(body).toEqual({ link: { label: "Smith family", expiresAt: expect.any(String), allow: { comments: true, approve: true, download: true } }, verified: true, email: EMAIL, name: "Gina   Guest" });
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const rotated = sessionCookie(response, link.id)!;
    expect(rotated).not.toBe(session.cookie);
    const setCookie = response.headers.getSetCookie().find((entry) => entry.startsWith("__Secure-quincy_guest_"))!;
    expect(setCookie).toContain(`Path=/d/api/links/${link.id}`); expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("Secure"); expect(setCookie).toContain("SameSite=Strict");
    const row = await sessionRow(session.id);
    expect(row).toMatchObject({ id: session.id, token_hash: await hashToken(rotated.split("=")[1]!), link_generation: 1 });
    expect(row!.verified_at).toBeGreaterThanOrEqual(before); expect(row!.guest_id).toEqual(expect.any(String));
    const reviewer = await database.DB.prepare("SELECT * FROM guest_reviewers WHERE email_normalized = ?").bind(EMAIL).first<Json>();
    expect(reviewer).toMatchObject({ id: row!.guest_id, display_name: "Gina   Guest" });
    const members = (await database.DB.prepare("SELECT * FROM guest_link_members WHERE link_id = ?").bind(link.id).all<Json>()).results;
    expect(members).toHaveLength(1); expect(members[0]).toMatchObject({ guest_id: reviewer!.id, unsubscribed_at: null, last_digest_sent_at: null });
    expect((await codeRows(session.id))[0]!.consumed_at).toBeGreaterThanOrEqual(before);
  });

  it("kills the old cookie and keeps the new one working", async () => {
    const { link, oldCookie, cookie } = await verifiedGuest();
    expect((await guestFetch(linkPath(link.id, "/session"), { cookie: oldCookie })).status).toBe(404);
    expect((await guestFetch(linkPath(link.id, "/videos"), { cookie: oldCookie })).status).toBe(404);
    const live = await guestFetch(linkPath(link.id, "/session"), { cookie });
    expect(live.status).toBe(200); expect(guestSessionResponseSchema.parse(await live.json())).toMatchObject({ verified: true, email: EMAIL, name: NAME });
  });

  it("answers GET session as unverified, then verified", async () => {
    const link = await seedGuestLink(); const session = await sessionOf(link);
    expect(await json(await guestFetch(linkPath(link.id, "/session"), { cookie: session.cookie }))).toMatchObject({ verified: false, email: null, name: null });
  });

  it("counts wrong tries down, and the sixth try fails with code_expired even with the right code", async () => {
    const { link, session, code } = await sent(); const wrong = wrongCode(code);
    for (const left of [4, 3, 2, 1, 0]) {
      const response = await verify(link, session.cookie, wrong);
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "code_incorrect", attemptsLeft: left });
    }
    const sixth = await verify(link, session.cookie, code);
    expect(sixth.status).toBe(401); expect(await sixth.json()).toEqual({ error: "code_expired" });
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null, verified_at: null });
    expect((await codeRows(session.id))[0]!.attempts).toBe(5);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_reviewers WHERE email_normalized = ?").bind(EMAIL).first<{ n: number }>())!.n).toBe(0);
  });

  it("accepts the right code on the fifth try", async () => {
    const { link, session, code } = await sent();
    for (let index = 0; index < 4; index += 1) expect((await verify(link, session.cookie, wrongCode(code))).status).toBe(401);
    expect((await verify(link, session.cookie, code)).status).toBe(200);
  });

  it("refuses a code after ten minutes with code_expired", async () => {
    const { link, session, code } = await sent();
    await database.DB.prepare("UPDATE guest_email_codes SET expires_at = ? WHERE session_id = ?").bind(Date.now() - 1, session.id).run();
    const response = await verify(link, session.cookie, code);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "code_expired" });
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null });
  });

  it("answers code_expired when no code was ever sent", async () => {
    const link = await seedGuestLink(); const session = await sessionOf(link);
    const response = await verify(link, session.cookie, "123456");
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "code_expired" });
  });

  it("refuses to reuse a consumed code", async () => {
    const { link, session, code, } = await sent();
    const first = await verify(link, session.cookie, code); expect(first.status).toBe(200);
    const rotated = sessionCookie(first, link.id)!;
    const again = await verify(link, rotated, code);
    expect(again.status).toBe(401); expect(await again.json()).toEqual({ error: "code_expired" });
  });

  it("admits one of two concurrent verifies of the right code", async () => {
    const { link, session, code } = await sent();
    const responses = await Promise.all([verify(link, session.cookie, code), verify(link, session.cookie, code)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses[0]).toBe(200); expect([401, 404]).toContain(statuses[1]);
    expect(await audits("review_link.email_verify", link.id)).toHaveLength(1);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_link_members WHERE link_id = ?").bind(link.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("answers an older code as incorrect once a newer one was sent", async () => {
    const { link, session, code: first } = await sent();
    await pastResendWait(session.id);
    expect((await sendCode(link, session.cookie)).status).toBe(202);
    const second = codeOf(mail.sent.at(-1)!);
    if (first !== second) {
      const old = await verify(link, session.cookie, first);
      expect(old.status).toBe(401); expect(await old.json()).toMatchObject({ error: "code_incorrect" });
    }
    expect((await verify(link, session.cookie, second)).status).toBe(200);
  });

  it("keeps the address of the newest code, and writes the new name over the old one", async () => {
    const link = await seedGuestLink();
    const first = await verifiedGuest({ link, name: "First Name" });
    const second = await sent({ link }); // another browser, same address
    expect((await verify(link, second.session.cookie, second.code, "Second Name")).status).toBe(200);
    expect((await database.DB.prepare("SELECT display_name FROM guest_reviewers WHERE email_normalized = ?").bind(EMAIL).first<Json>())!.display_name).toBe("Second Name");
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_link_members WHERE link_id = ?").bind(link.id).first<{ n: number }>())!.n).toBe(1);
    expect(first.cookie).toBeTruthy();
  });

  it("re-verifying never resubscribes and keeps the first verified time", async () => {
    const link = await seedGuestLink(); await verifiedGuest({ link });
    const stamp = Date.now() - 5 * DAY;
    await database.DB.prepare("UPDATE guest_link_members SET unsubscribed_at = ?1, first_verified_at = ?2, last_digest_sent_at = ?2 WHERE link_id = ?3").bind(stamp, stamp, link.id).run();
    const again = await sent({ link }); expect((await verify(link, again.session.cookie, again.code)).status).toBe(200);
    const [member] = (await database.DB.prepare("SELECT * FROM guest_link_members WHERE link_id = ?").bind(link.id).all<Json>()).results;
    expect(member).toMatchObject({ unsubscribed_at: stamp, first_verified_at: stamp, last_digest_sent_at: stamp });
    expect(member!.last_verified_at).toBeGreaterThan(stamp);
  });

  it("answers 409 already_verified when a verified session holds a code for a different address", async () => {
    const { link, session, cookie } = await verifiedGuest();
    await database.DB.prepare("INSERT INTO guest_email_codes (id, link_id, session_id, email_normalized, code_hash, attempts, expires_at, consumed_at, created_at) VALUES (?, ?, ?, 'other@guest-13a.test', 'pbkdf2-sha256$1$AA==$AA==', 0, ?, NULL, ?)")
      .bind(crypto.randomUUID(), link.id, session.id, Date.now() + MINUTE, Date.now() + 1).run();
    const response = await verify(link, cookie, "123456");
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "already_verified" });
  });

  it("covers every Video on the link with one verification", async () => {
    const link = await seedGuestLink(); const a = await seedVideoVersion({ title: "A" }); const b = await seedVideoVersion({ title: "B" });
    await addMember(link.id, a.videoId, [a.assetId]); await addMember(link.id, b.videoId, [b.assetId]);
    const { cookie } = await verifiedGuest({ link });
    const videos = await json(await guestFetch(linkPath(link.id, "/videos"), { cookie }));
    expect(videos.videos).toHaveLength(2);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_link_members WHERE link_id = ?").bind(link.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("is killed by a revoke, a replace or an expiry between send and verify: the stub, and nothing written", async () => {
    for (const kill of [
      (id: string) => database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), id).run(),
      (id: string) => database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(id).run(),
      (id: string) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run(),
      (id: string) => database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(id).run(),
    ]) {
      const { link, session, code } = await sent({ link: await seedGuestLink() });
      await kill(link.id);
      const stub = await guestFetch("/d"); const response = await verify(link, session.cookie, code);
      expect({ status: response.status, body: await response.text() }).toEqual({ status: stub.status, body: await stub.text() });
      expect(await audits("review_link.email_verify", link.id)).toHaveLength(0);
      expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_link_members WHERE link_id = ?").bind(link.id).first<{ n: number }>())!.n).toBe(0);
      expect(await database.DB.prepare("SELECT 1 FROM guest_reviewers WHERE email_normalized = ?").bind(EMAIL).first()).toBeNull();
    }
  });

  it("leaves the code unspent and the session unverified when the link is revoked but the session row survives (a revoke that has not deleted it yet)", async () => {
    const { link, session, code } = await sent();
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), link.id).run();
    const response = await verify(link, session.cookie, code);
    expect(response.status).toBe(404);
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null, verified_at: null });
    expect((await codeRows(session.id))[0]!.consumed_at).toBeNull();
  });

  it("limits verify attempts per link (100 in 15 minutes) and per address (30)", async () => {
    const { link, session, code } = await sent();
    await seedBucket(`codeverify:link:${link.id}`, 99);
    expect((await verify(link, session.cookie, wrongCode(code))).status).toBe(401);
    const limited = await verify(link, session.cookie, code);
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: "too_many_attempts" });
    expect((await codeRows(session.id))[0]!.attempts).toBe(1);
    const ipLink = await sent(); const ip = freshIp();
    await seedBucket(await ipBucket("codeverify", ip, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS), 29);
    expect((await verify(ipLink.link, ipLink.session.cookie, wrongCode(ipLink.code), NAME, { ip })).status).toBe(401);
    expect((await verify(ipLink.link, ipLink.session.cookie, ipLink.code, NAME, { ip })).status).toBe(429);
    expect((await verify(ipLink.link, ipLink.session.cookie, ipLink.code, NAME, { ip: freshIp() })).status).toBe(200);
  });

  it("validates the body: a code of six digits and a name of 1 to 80 characters", async () => {
    const { link, session, code } = await sent();
    for (const [badCode, name] of [["12345", NAME], ["1234567", NAME], ["12345a", NAME], [123456, NAME], [code, ""], [code, "   "], [code, "x".repeat(81)], [code, 7], [code, "two\nlines"]] as const)
      expect((await verify(link, session.cookie, badCode as string, name as string, { ip: freshIp() })).status, `${String(badCode)} / ${String(name)}`).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/verify"), { method: "POST", cookie: session.cookie, body: { code, name: NAME, email: "x@y.test" } })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/verify"), { method: "POST", cookie: session.cookie, body: { code } })).status).toBe(400);
    expect((await guestFetch(linkPath(link.id, "/email/verify"), { method: "POST", cookie: session.cookie, body: JSON.stringify({ code, name: "y".repeat(4000) }) })).status).toBe(413);
    expect((await codeRows(session.id))[0]!.attempts).toBe(0);
    expect((await verify(link, session.cookie, code, "x".repeat(80))).status).toBe(200);
  });

  it("is the stub for no cookie and 403 for a wrong Origin, and the wrong Origin burns no try", async () => {
    const { link, session, code } = await sent();
    const stub = await guestFetch("/d");
    expect((await verify(link, null, code)).status).toBe(stub.status);
    expect((await verify(link, session.cookie, code, NAME, { origin: "https://evil.test" })).status).toBe(403);
    expect((await verify(link, session.cookie, code, NAME, { contentType: "text/plain" })).status).toBe(403);
    expect((await codeRows(session.id))[0]!.attempts).toBe(0);
  });

  it("audits a verification with the guest and the link, and never the code or the address", async () => {
    const { link, session, code } = await sent(); const response = await verify(link, session.cookie, code);
    const guestId = (await sessionRow(session.id))!.guest_id as string;
    const rows = await audits("review_link.email_verify", link.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: null, target_type: "review_link", target_id: link.id });
    expect(JSON.parse(rows[0]!.meta_json)).toEqual({ guest: { guestId, sessionId: session.id }, linkId: link.id });
    expect(response.status).toBe(200);
  });
});

describe("the session body's allow flags", () => {
  const allowOf = async (link: { id: string }, cookie: string) => (await json(await guestFetch(linkPath(link.id, "/session"), { cookie }))).link.allow;

  it("is the link flag AND its part: comments need guest_comments, approve and download need delivery", async () => {
    const link = await seedGuestLink({ allow: [1, 1, 1] }); const { cookie } = await sessionOf(link);
    expect(await allowOf(link, cookie)).toEqual({ comments: true, approve: true, download: true });
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`, "video_review_guest", "video_review_delivery");
    expect(await allowOf(link, cookie)).toEqual({ comments: false, approve: true, download: true });
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`, "video_review_guest", "video_review_guest_comments");
    expect(await allowOf(link, cookie)).toEqual({ comments: true, approve: false, download: false });
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`, "video_review_guest");
    expect(await allowOf(link, cookie)).toEqual({ comments: false, approve: false, download: false });
  });

  it("stays false when the link flag is off even though the part is on, in the exchange response too", async () => {
    const link = await seedGuestLink({ allow: [0, 1, 0] }); const { response, cookie } = await startSession(link);
    expect((await json(response)).link.allow).toEqual({ comments: false, approve: true, download: false });
    expect(await allowOf(link, cookie!)).toEqual({ comments: false, approve: true, download: false });
    const verified = await verifiedGuest({ link: await seedGuestLink({ allow: [0, 0, 1] }) });
    expect(await allowOf(verified.link, verified.cookie)).toEqual({ comments: false, approve: false, download: true });
  });
});

describe("staff view and last-seen", () => {
  it("lists verified guests in the staff link DTO with name, email, last seen and subscription", async () => {
    await setVideoFlags("video_review_links");
    const link = await seedGuestLink(); await verifiedGuest({ link, name: "Gina Guest" });
    const other = await sent({ link, email: "bob@guest-13a.test" }); await verify(link, other.session.cookie, other.code, "Bob");
    await database.DB.prepare("UPDATE guest_link_members SET unsubscribed_at = ?1 WHERE guest_id = (SELECT id FROM guest_reviewers WHERE email_normalized = 'bob@guest-13a.test')").bind(Date.now()).run();
    const response = await staffRequest(`/api/projects/${ids.project}/review-links`, "admin");
    expect(response.status, await response.clone().text()).toBe(200);
    const dto = reviewLinkListResponseSchema.parse(await response.json()).links.find((entry) => entry.id === link.id)!;
    const guests = [...dto.activity.verifiedGuests].sort((a, b) => a.email.localeCompare(b.email));
    expect(guests).toEqual([
      { email: "bob@guest-13a.test", name: "Bob", lastSeenAt: expect.any(String), unsubscribed: true },
      { email: EMAIL, name: "Gina Guest", lastSeenAt: expect.any(String), unsubscribed: false },
    ]);
  });

  it("refreshes the membership's last seen when a verified session is touched", async () => {
    const { link, cookie, session } = await verifiedGuest(); const old = Date.now() - DAY;
    await database.DB.batch([database.DB.prepare("UPDATE guest_sessions SET last_seen_at = ? WHERE id = ?").bind(old, session.id), database.DB.prepare("UPDATE guest_link_members SET last_seen_at = ? WHERE link_id = ?").bind(old, link.id)]);
    expect((await guestFetch(linkPath(link.id, "/session"), { cookie })).status).toBe(200);
    const member = await database.DB.prepare("SELECT last_seen_at FROM guest_link_members WHERE link_id = ?").bind(link.id).first<{ last_seen_at: number }>();
    expect(member!.last_seen_at).toBeGreaterThan(old);
  });
});

describe("leak sweep", () => {
  it("puts neither the code nor the address in any response, header, log line or audit row", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const link = await seedGuestLink(); const session = await sessionOf(link);
    const secrets: Array<{ label: string; text: string }> = [];
    const keep = async (label: string, response: Response) => { secrets.push({ label, text: `${response.status} ${JSON.stringify([...response.headers].filter(([name]) => name !== "set-cookie"))} ${await response.text()}` }); };
    await keep("send", await sendCode(link, session.cookie));
    const code = codeOf(mail.sent.at(-1)!); const wrong = wrongCode(code);
    await keep("send again", await sendCode(link, session.cookie));
    await keep("wrong", await verify(link, session.cookie, wrong));
    await keep("bad body", await verify(link, session.cookie, "nope"));
    const ok = await verify(link, session.cookie, code); expect(ok.status).toBe(200);
    secrets.push({ label: "verify headers", text: JSON.stringify([...ok.headers].filter(([name]) => name !== "set-cookie")) });
    await keep("reuse", await verify(link, sessionCookie(ok, link.id)!, code));
    for (const { label, text } of secrets) { expect(text, label).not.toContain(code); expect(text, label).not.toContain("guest-13a"); }
    const auditDump = JSON.stringify((await database.DB.prepare("SELECT * FROM audit_log WHERE action LIKE 'review_link.%'").all()).results);
    expect(auditDump).not.toContain(code); expect(auditDump).not.toContain("guest-13a"); expect(auditDump).not.toContain(wrong === code ? "no-match" : `"${wrong}"`);
    expect(logs.join("\n")).not.toContain(code); expect(logs.join("\n")).not.toContain("guest-13a");
    const rawCookie = session.token;
    expect(auditDump).not.toContain(rawCookie);
    expect(await sha256Hex(code)).not.toContain(code);
    expect(guestOrigin).toBeTruthy();
  });
});

/** A POST whose body arrives `delayMs` after the headers, so the Worker has already passed its entry checks when the state changes under it. */
function slowPost(path: string, cookie: string, body: unknown, delayMs: number): { response: Promise<Response>; } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({ async start(controller) { await new Promise((resolve) => setTimeout(resolve, delayMs)); controller.enqueue(bytes); controller.close(); } });
  const headers = new Headers({ "cf-connecting-ip": freshIp(), cookie, origin: guestOrigin, "content-type": "application/json" });
  return { response: workerSelf.fetch(`https://portal.test${path}`, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit) };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stubBody = async () => { const stub = await guestFetch("/d"); return { status: stub.status, body: await stub.text() }; };
const plain = async (response: Response) => ({ status: response.status, body: await response.text() });
const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
const codeCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_email_codes").first<{ n: number }>())!.n;
const memberCount = async (linkId: string) => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_link_members WHERE link_id = ?").bind(linkId).first<{ n: number }>())!.n;

describe("the committing SQL repeats what the entry checked (Sol round 1)", () => {
  it("gate: a gate that closes mid-request issues no code and verifies nothing, and answers the stub", async () => {
    const link = await seedGuestLink();
    let round = 0;
    for (const close of [() => clearVideoFlags(), () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run(), () => database.DB.prepare("DELETE FROM feature_flags WHERE key LIKE 'video_review_pilot:%'").run()]) {
      await openGuestGate(); const address = `round${round += 1}@guest-13a.test`;
      const session = await sessionOf(link); const before = mail.sent.length;
      const pending = slowPost(linkPath(link.id, "/email/code"), session.cookie, { email: address }, 250);
      await sleep(80); await close();
      expect(await plain(await pending.response)).toEqual(await stubBody());
      expect(mail.sent.length).toBe(before); expect(await codeRows(session.id)).toHaveLength(0);
      await openGuestGate();
      const ready = await sent({ link, email: address }); const verifying = slowPost(linkPath(link.id, "/email/verify"), ready.session.cookie, { code: ready.code, name: NAME }, 250);
      await sleep(80); await close();
      expect(await plain(await verifying.response)).toEqual(await stubBody());
      expect(await sessionRow(ready.session.id)).toMatchObject({ guest_id: null, verified_at: null }); expect((await codeRows(ready.session.id))[0]!.consumed_at).toBeNull();
      expect(await memberCount(link.id)).toBe(0);
      await database.DB.prepare("DELETE FROM guest_email_codes").run();
    }
  });

  it("clock: a code that expires while the body is on its way is refused", async () => {
    const { link, session, code } = await sent();
    await database.DB.prepare("UPDATE guest_email_codes SET expires_at = ? WHERE session_id = ?").bind(Date.now() + 300, session.id).run();
    const pending = slowPost(linkPath(link.id, "/email/verify"), session.cookie, { code, name: NAME }, 600);
    const response = await pending.response;
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "code_expired" });
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null }); expect(await memberCount(link.id)).toBe(0);
  });

  it("clock: a link (and so its session) that expires while the body is on its way is the stub and upgrades nothing", async () => {
    const { link, session, code } = await sent();
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() + 300, link.id).run();
    await database.DB.prepare("UPDATE guest_sessions SET expires_at = ? WHERE id = ?").bind(Date.now() + 300, session.id).run();
    const response = await (slowPost(linkPath(link.id, "/email/verify"), session.cookie, { code, name: NAME }, 600)).response;
    expect(await plain(response)).toEqual(await stubBody());
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null }); expect(await memberCount(link.id)).toBe(0);
  });

  it("clock: a link that expires while a send is on its way issues no code", async () => {
    const link = await seedGuestLink(); const session = await sessionOf(link);
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() + 300, link.id).run();
    const response = await (slowPost(linkPath(link.id, "/email/code"), session.cookie, { email: EMAIL }, 600)).response;
    expect(await plain(response)).toEqual(await stubBody());
    expect(await codeRows(session.id)).toHaveLength(0); expect(mail.sent).toHaveLength(0);
  });

  it("archived: verify after the Project is archived is 409 project_archived and creates no membership; send is 409 too and mails nothing", async () => {
    const { link, session, code } = await sent();
    await archive();
    const verifying = await verify(link, session.cookie, code);
    expect(verifying.status).toBe(409); expect(await verifying.json()).toEqual({ error: "project_archived" });
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null }); expect(await memberCount(link.id)).toBe(0);
    expect((await codeRows(session.id))[0]).toMatchObject({ attempts: 0, consumed_at: null });
    await pastResendWait(session.id); const mailed = mail.sent.length;
    const resend = await sendCode(link, session.cookie);
    expect(resend.status).toBe(409); expect(await resend.json()).toEqual({ error: "project_archived" });
    expect(mail.sent.length).toBe(mailed); expect(await codeRows(session.id)).toHaveLength(1);
  });

  it("archived: an archive that lands mid-request is 409 project_archived (not the stub) and writes nothing", async () => {
    const { link, session, code } = await sent();
    const pending = slowPost(linkPath(link.id, "/email/verify"), session.cookie, { code, name: NAME }, 300);
    await sleep(80); await archive();
    const response = await pending.response;
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "project_archived" });
    expect(await sessionRow(session.id)).toMatchObject({ guest_id: null }); expect(await memberCount(link.id)).toBe(0);
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
    await pastResendWait(session.id); const codes = await codeCount();
    const sending = slowPost(linkPath(link.id, "/email/code"), session.cookie, { email: EMAIL }, 300);
    await sleep(80); await archive();
    const sendResponse = await sending.response;
    expect(sendResponse.status).toBe(409); expect(await codeCount()).toBe(codes);
  });
});

describe("one fence for every write on the email routes (Sol round 2)", () => {
  it("a wrong code delayed past a gate close, a link expiry or an archive spends no try and answers the refusal, not code_incorrect", async () => {
    const cases: Array<[string, (linkId: string) => Promise<unknown>, (response: Response) => Promise<void>]> = [
      ["gate closes", () => clearVideoFlags(), async (r) => expect(await plain(r)).toEqual(await stubBody())],
      ["link expires", (id) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run(), async (r) => expect(await plain(r)).toEqual(await stubBody())],
      ["project archived", () => archive(), async (r) => { expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: "project_archived" }); }],
    ];
    for (const [label, change, expectRefusal] of cases) {
      await openGuestGate(); await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      const { link, session, code } = await sent({ link: await seedGuestLink(), email: `${label.replaceAll(" ", "")}@guest-13a.test` });
      const pending = slowPost(linkPath(link.id, "/email/verify"), session.cookie, { code: wrongCode(code), name: NAME }, 250);
      await sleep(80); await change(link.id);
      await expectRefusal(await pending.response);
      expect((await codeRows(session.id))[0]!.attempts, label).toBe(0);
    }
  });

  it("a send to address B that was in flight when the session verified as address A issues nothing", async () => {
    const { link, session, code } = await sent();
    await pastResendWait(session.id); const mailed = mail.sent.length;
    const pending = slowPost(linkPath(link.id, "/email/code"), session.cookie, { email: "address-b@guest-13a.test" }, 300);
    await sleep(80);
    expect((await verify(link, session.cookie, code)).status).toBe(200);
    expect(await plain(await pending.response)).toEqual(await stubBody());
    expect(mail.sent.length).toBe(mailed);
    expect((await codeRows(session.id)).map((row) => row.email_normalized)).toEqual([EMAIL]);
  });

  it("the send audit row is written with the code and survives a revoke and a gate close during the send", async () => {
    const link = await seedGuestLink(); const session = await sessionOf(link);
    const mutable = baseEnv as unknown as Record<string, unknown>;
    mutable.EMAIL = { send: async () => {
      await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), link.id).run();
      await database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(link.id).run();
      await clearVideoFlags();
      return { messageId: "m" };
    } };
    const response = await sendCode(link, session.cookie);
    expect(response.status).toBe(202);
    const rows = await audits("review_link.email_code_send", link.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta_json)).toEqual({ guest: { sessionId: session.id }, linkId: link.id, delivered: true });
  });

  it("a failed send is recorded against the same audit row, after the code is already stored", async () => {
    mail.restore(); mail = mockEmail({ fail: Object.assign(new Error("x"), { code: "E_DELIVERY_FAILED" }) });
    const link = await seedGuestLink(); const session = await sessionOf(link);
    expect((await sendCode(link, session.cookie)).status).toBe(202);
    const rows = await audits("review_link.email_code_send", link.id);
    expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ delivered: false, errorCode: "E_DELIVERY_FAILED" });
  });
});
