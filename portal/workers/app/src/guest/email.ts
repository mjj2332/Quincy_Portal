import type { Context, Hono } from "hono";
import { EMAIL_SEND_ERROR_CODES, GUEST_CODE_RESEND_SECONDS, guestEmailCodeInputSchema, guestEmailVerifyInputSchema } from "@quincy/shared";
import { auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { hashToken, randomToken } from "../lib/opaque-token";
import { hashPasscode, verifyPasscode } from "../lib/review-passcode";
import type { AppEnv } from "../env";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, sessionCookieHeader, TOO_LARGE, tooMany } from "./http";
import { identityOf, loadActiveLink, resolveSession, sessionBody, type GuestSession } from "./link";
import { clientAddress, emailBucket, GUEST_CODE_RESEND_MS, GUEST_DAY_MS, GUEST_LIMITS, ipBucket, reserveAttempts, windowStart } from "./rate-limit";

/**
 * Guest email verification (#741 13a): `POST .../email/code` mails a six-digit code to an address, `POST .../email/verify` swaps the right code for a verified session. The code is
 * 6 digits, lives 10 minutes, allows 5 tries and works once. It is stored as a PBKDF2 hash (`lib/review-passcode.ts`, no secret: a leaked row is a single-use, 10-minute hash bound to a
 * session whose token exists only as a hash). The order on both routes is the guest order of 12a: link id, gate, Origin, credential; then the limits and the body.
 *
 * THE RULE (Sol rounds 1 and 2): whatever the entry checked, the SQL that writes checks again, at a fresh time. `guestEmailFence` is the one fragment for that: the session row with the exact
 * token hash this request authenticated with and the identity it saw (`guest_id`), the link active and at the session's generation, the gate (master flag, all-projects or pilot row,
 * `guest` part) and an unarchived Project. EVERY write on these two routes either carries it (the attempt counter, the code INSERT, the token swap) or runs in the same atomic batch
 * only after a statement that carried it landed (the rest of the verify batch, keyed on the fresh token hash). `classifyRefusal` then runs BEFORE any code-specific answer
 * (`code_expired`, `code_incorrect`, 429): a refused write is the guest stub, or 409 `project_archived` when only the archive landed, and never says anything about the code.
 * Structurally: once the body is read, `classifyRefusal` runs ONCE right away (before the 413/400 answers too), and again before every later non-success answer: each 429 (quota and
 * cooldown), 409 `already_verified`, and each code error. So no limit, validation or code outcome is ever the answer to a request whose link, gate or Project has changed under it.
 */
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
const SEND_BODY_MAX = 1024;
const VERIFY_BODY_MAX = 1024;

/** NFC, trimmed, lower case. No Gmail dot or plus folding: that would merge two people. */
export const normaliseEmail = (email: string): string => email.trim().normalize("NFC").toLowerCase();

/** A uniform six-digit code: values past the largest multiple of a million are redrawn, so no digit is likelier than another. */
function newCode(): string {
  const limit = 4_294_000_000; const buffer = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(buffer); if (buffer[0]! < limit) return String(buffer[0]! % 1_000_000).padStart(6, "0"); }
}

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The code email. Transactional: it carries no Review link (only the hash of the token is stored, ADR 0021 §10) and no unsubscribe link, because no membership exists yet and the last
 * sentence says the only consequence. The label is staff text, so it is escaped for HTML and appears nowhere else.
 */
export function composeCodeEmail(code: string, label: string | null): { subject: string; text: string; html: string } {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`; const what = label ?? "your video review";
  const sentence = (shown: string) => `Use ${shown} to verify your email for ${what}. It expires in 10 minutes. If you didn't ask for it, ignore this email: nothing happens unless the code is entered. You won't get other email from this review unless you verify.`;
  return {
    subject: `Your review code: ${code}`,
    text: sentence(spaced),
    html: `<!doctype html><html><body><p>${escapeHtml(sentence(spaced))}</p></body></html>`,
  };
}

const SAFE_SEND_ERRORS = new Set<string>(EMAIL_SEND_ERROR_CODES);
/** The stored reason a send failed: a known Email Service code, else a generic one. The message is never kept, because it can carry the address. */
function sendFailureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  return SAFE_SEND_ERRORS.has(code) ? code : "send_failed";
}

/** The session and link are still the ones a request resolved: the fence every write here repeats, so a revoke, replace or expiry landing mid-request writes nothing. */
const LIVE_SESSION_SQL = `s.expires_at > ?NOW AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?NOW AND s.link_generation = l.token_generation`;
const live = (now: string) => LIVE_SESSION_SQL.replaceAll("?NOW", now);
/** The feature gate as rows, for the link alias `l`: `video_review` on, `video_review_all_projects` or this Project's pilot row on, and the `guest` part on. Mirrors `readVideoReviewGate`. */
const GATE_SQL = `EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key = 'video_review')
  AND EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key IN ('video_review_all_projects', 'video_review_pilot:' || l.project_id))
  AND EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key = 'video_review_guest')`;
const UNARCHIVED_SQL = "EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id AND p.archived_at IS NULL)";
/** Everything a committing statement re-checks, for aliases `s` and `l`: live session and link at `now`, the gate, and an unarchived Project. */
const committable = (now: string) => `${live(now)} AND ${GATE_SQL} AND ${UNARCHIVED_SQL}`;

/** The fence for aliases `s` (guest_sessions) and `l` (client_links), as SQL over the placeholders `now` (a time), `token` (hash) and `guest` (the guest id the request saw, or NULL). */
const guestEmailFence = (bind: { now: string; token: string; guest: string }): string => `s.token_hash = ${bind.token} AND s.guest_id IS ${bind.guest} AND ${committable(bind.now)}`;

/**
 * Whether a request was refused by the fence, and how. Runs at its own fresh time and BEFORE every non-success outcome of verify (no code row, `already_verified`, `code_expired`,
 * `code_incorrect`): the stub when the session, link or gate is gone (a revoke or replace deletes the session and its codes), `project_archived` (409) when only the Project is archived,
 * else null. One more case is not a refusal: the session row is still live but its token was rotated, which only a competing verify on this same session does. `rotatedIsRefusal` false
 * lets the caller go on (its code is spent, so it answers 401 `code_expired` and the client refetches the now-verified session); true answers the stub.
 */
async function classifyRefusal(c: Context<AppEnv>, session: GuestSession, rotatedIsRefusal = true): Promise<Response | null> {
  const row = await c.env.DB.prepare(`SELECT s.token_hash, p.archived_at FROM guest_sessions s JOIN client_links l ON l.id = s.link_id JOIN projects p ON p.id = l.project_id
    WHERE s.id = ?1 AND ${live("?2")} AND ${GATE_SQL}`).bind(session.id, Date.now()).first<{ token_hash: string; archived_at: number | null }>();
  if (!row) return guestNotFound(c);
  if (row.archived_at !== null) return c.json({ error: "project_archived" }, 409);
  return row.token_hash !== session.tokenHash && rotatedIsRefusal ? guestNotFound(c) : null;
}
/** An archived Project takes no writes: 409 before any limit is spent or body read. */
async function archivedResponse(c: Context<AppEnv>, projectId: string): Promise<Response | null> {
  const row = await c.env.DB.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>();
  return row?.archived_at != null ? c.json({ error: "project_archived" }, 409) : null;
}

type Handled<P extends string> = Context<AppEnv, P>;

/** Link, gate, Origin and session, in the guest order, or the response that ends the request. */
async function authenticate<P extends string>(c: Handled<P>, now: number): Promise<{ session: GuestSession } | { response: Response }> {
  const linkId = c.req.param("linkId" as never) as string;
  if (!await loadActiveLink(c as unknown as Context<AppEnv>, linkId, now)) return { response: await guestNotFound(c as unknown as Context<AppEnv>) };
  const rejected = originRejection(c as unknown as Context<AppEnv>); if (rejected) return { response: rejected };
  const session = await resolveSession(c as unknown as Context<AppEnv>, linkId, now);
  return session ? { session } : { response: await guestNotFound(c as unknown as Context<AppEnv>) };
}

async function sendCode(c: Handled<"/d/api/links/:linkId/email/code">): Promise<Response> {
  const now = Date.now(); const auth = await authenticate(c, now);
  if ("response" in auth) return auth.response;
  const { session } = auth; const link = session.link;
  const archived = await archivedResponse(c as unknown as Context<AppEnv>, link.projectId); if (archived) return archived;
  // The body comes before the limits: the address buckets are keyed by it, so they cannot be reserved without it.
  const raw = await readJson(c, SEND_BODY_MAX);
  // Refusal first, once the body is in: every answer below (413, 400, 409, 429) is given only to a request whose link, gate and Project still stand.
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(c as unknown as Context<AppEnv>, session) ?? response;
  const early = await classifyRefusal(c as unknown as Context<AppEnv>, session); if (early) return early;
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  const parsed = raw === INVALID ? null : guestEmailCodeInputSchema.safeParse(raw);
  if (!parsed?.success) return c.json({ error: "invalid_request" }, 400);
  const email = normaliseEmail(parsed.data.email);
  if (session.email !== null && session.email !== email) return answer(c.json({ error: "already_verified" }, 409));

  // One time for every limit decision, taken now that the body is in: a body held across a window boundary is charged to the window it completes in, and the minute is judged at completion.
  const decidedAt = Date.now();
  // One send a minute per session, exactly: the counter below guards a race, this read is what makes the minute a minute and not a fixed window that may reset a second later.
  const recent = await c.env.DB.prepare("SELECT created_at FROM guest_email_codes WHERE session_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(session.id).first<{ created_at: number }>();
  if (recent && decidedAt - recent.created_at < GUEST_CODE_RESEND_MS) return answer(tooMany(Math.max(1, Math.ceil((recent.created_at + GUEST_CODE_RESEND_MS - decidedAt) / 1000))));
  const start = windowStart(decidedAt);
  const attempt = await reserveAttempts(c.env.DB, [
    { bucket: `codesend:session:${session.id}`, limit: GUEST_LIMITS.codeSendSession, windowMs: GUEST_CODE_RESEND_MS },
    { bucket: await emailBucket("codesend", email, start), limit: GUEST_LIMITS.codeSendEmail },
    { bucket: await emailBucket("codesend24h", email, windowStart(decidedAt, GUEST_DAY_MS)), limit: GUEST_LIMITS.codeSendEmailDay, windowMs: GUEST_DAY_MS },
    { bucket: `codesend:link:${link.id}`, limit: GUEST_LIMITS.codeSendLink },
    { bucket: await ipBucket("codesend", clientAddress(c.req.raw), start), limit: GUEST_LIMITS.codeSendIp },
  ], decidedAt);
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));

  const code = newCode(); const codeId = newId(); const codeHash = await hashPasscode(code);
  // The time is taken again here, after the body was read and the code hashed: a slow body must not stretch the session, link or minute it is checked against.
  const issuedAt = Date.now();
  // The code and its audit row land together or not at all, under the fence; the row says the send is unconfirmed until the outcome below replaces it. So provenance survives
  // anything that happens during the send (a revoke deletes the code, not the audit row).
  const auditId = newId();
  const [inserted] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO guest_email_codes (id, link_id, session_id, email_normalized, code_hash, attempts, expires_at, consumed_at, created_at)
      SELECT ?1, s.link_id, s.id, ?2, ?3, 0, ?4, NULL, ?5 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
      WHERE s.id = ?6 AND ${guestEmailFence({ now: "?5", token: "?8", guest: "?9" })} AND NOT EXISTS (SELECT 1 FROM guest_email_codes c WHERE c.session_id = s.id AND c.created_at > ?7)`)
      .bind(codeId, email, codeHash, issuedAt + CODE_TTL_MS, issuedAt, session.id, issuedAt - GUEST_CODE_RESEND_MS, session.tokenHash, session.guestId),
    c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'review_link.email_code_send', 'review_link', ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM guest_email_codes WHERE id = ?5)`)
      .bind(auditId, link.id, auditMeta(null, { guest: { sessionId: session.id }, linkId: link.id, delivered: false, errorCode: "send_unconfirmed" }), issuedAt, codeId),
  ]);
  if (inserted!.meta.changes === 0) {
    const refused = await classifyRefusal(c as unknown as Context<AppEnv>, session); if (refused) return refused;
    const newest = await c.env.DB.prepare("SELECT created_at FROM guest_email_codes WHERE session_id = ?1 AND created_at > ?2 ORDER BY created_at DESC LIMIT 1").bind(session.id, issuedAt - GUEST_CODE_RESEND_MS).first<{ created_at: number }>();
    return newest ? tooMany(Math.max(1, Math.ceil((newest.created_at + GUEST_CODE_RESEND_MS - issuedAt) / 1000))) : guestNotFound(c as unknown as Context<AppEnv>);
  }

  let errorCode: string | null = null;
  const sender = c.env.NOTIFICATIONS_FROM_ADDRESS;
  if (!c.env.EMAIL || !sender) errorCode = "email_configuration_missing";
  else {
    const message = composeCodeEmail(code, link.label);
    try { await c.env.EMAIL.send({ from: sender, to: email, subject: message.subject, text: message.text, html: message.html }); } catch (error) { errorCode = sendFailureCode(error); }
  }
  // The safe outcome, recorded against the audit row by its id and unconditionally: it never carries the address or the code, and it needs no live session because the row already exists.
  await c.env.DB.prepare("UPDATE audit_log SET meta_json = ?1 WHERE id = ?2 AND action = 'review_link.email_code_send'")
    .bind(auditMeta(null, { guest: { sessionId: session.id }, linkId: link.id, delivered: errorCode === null, ...(errorCode === null ? {} : { errorCode }) }), auditId).run();
  // The same answer for every address: it says nothing of whether the address is known, deliverable or limited by anything but this session.
  return c.json({ sent: true, resendAfterSeconds: GUEST_CODE_RESEND_SECONDS }, 202);
}

async function verifyCode(c: Handled<"/d/api/links/:linkId/email/verify">): Promise<Response> {
  const now = Date.now(); const auth = await authenticate(c, now);
  if ("response" in auth) return auth.response;
  const { session } = auth; const link = session.link;
  const archived = await archivedResponse(c as unknown as Context<AppEnv>, link.projectId); if (archived) return archived;
  const raw = await readJson(c, VERIFY_BODY_MAX);
  // Refusal first, once the body is in (a rotated token is not a refusal here: the code decides, see classifyRefusal). Every answer below is given only to a request that still stands.
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(c as unknown as Context<AppEnv>, session, false) ?? response;
  const refused = await classifyRefusal(c as unknown as Context<AppEnv>, session, false); if (refused) return refused;
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  const parsed = raw === INVALID ? null : guestEmailVerifyInputSchema.safeParse(raw);
  if (!parsed?.success) return c.json({ error: "invalid_request" }, 400);
  // Reserved after the body is read, at a fresh time: the attempt is charged to the window it is made in, however slowly the body arrived.
  const decidedAt = Date.now(); const start = windowStart(decidedAt);
  const attempt = await reserveAttempts(c.env.DB, [
    { bucket: `codeverify:link:${link.id}`, limit: GUEST_LIMITS.codeVerifyLink },
    { bucket: await ipBucket("codeverify", clientAddress(c.req.raw), start), limit: GUEST_LIMITS.codeVerifyIp },
  ], decidedAt);
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));

  // Only the newest code of this session counts, so asking for a new one kills the old.
  const newest = await c.env.DB.prepare("SELECT id, email_normalized FROM guest_email_codes WHERE session_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(session.id).first<{ id: string; email_normalized: string }>();
  if (session.email !== null && (!newest || newest.email_normalized !== session.email)) return answer(c.json({ error: "already_verified" }, 409));
  if (!newest) return answer(c.json({ error: "code_expired" }, 401));
  // One statement counts the try and says whether the code can still be tried: expired, consumed, burned (5 tries) or superseded all return no row, so the sixth try finds nothing even with the right code.
  const tried = await c.env.DB.prepare(`UPDATE guest_email_codes SET attempts = attempts + 1
    WHERE id = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND attempts < ?3 AND NOT EXISTS (SELECT 1 FROM guest_email_codes n WHERE n.session_id = guest_email_codes.session_id AND n.created_at > guest_email_codes.created_at)
      AND EXISTS (SELECT 1 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = guest_email_codes.session_id AND ${guestEmailFence({ now: "?2", token: "?4", guest: "?5" })})
    RETURNING attempts, code_hash`).bind(newest.id, Date.now(), CODE_TRIES, session.tokenHash, session.guestId).first<{ attempts: number; code_hash: string }>();
  // Refusal first: a code answer must never come from a request the fence would have refused.
  if (!tried) return await classifyRefusal(c as unknown as Context<AppEnv>, session, false) ?? c.json({ error: "code_expired" }, 401);
  const correct = await verifyPasscode(tried.code_hash, parsed.data.code);
  if (!correct) return await classifyRefusal(c as unknown as Context<AppEnv>, session) ?? c.json({ error: "code_incorrect", attemptsLeft: CODE_TRIES - tried.attempts }, 401);

  // The right code. The first statement swaps the session token under every fence; each later one runs only if that swap landed (the token hash is a fresh value that only this request
  // holds), so a revoke, a replace, an expiry, a newer code or the other half of a double-click writes nothing. The audit row is last and carries the guest id the batch actually stored.
  const token = randomToken(); const tokenHash = await hashToken(token);
  // A fresh time for the commit, after the body was read and the code hashed: every expiry below is judged at the moment of writing, not of arrival.
  const committedAt = Date.now();
  const sessionLanded = "EXISTS (SELECT 1 FROM guest_sessions WHERE id = ?{S} AND token_hash = ?{H})";
  const landed = (s: number, h: number) => sessionLanded.replace("?{S}", `?${s}`).replace("?{H}", `?${h}`);
  const email = newest.email_normalized; const db = c.env.DB;
  const results = await db.batch([
    db.prepare(`UPDATE guest_sessions SET token_hash = ?1 WHERE id = ?2
      AND EXISTS (SELECT 1 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?2 AND ${guestEmailFence({ now: "?3", token: "?5", guest: "?6" })})
      AND EXISTS (SELECT 1 FROM guest_email_codes c WHERE c.id = ?4 AND c.session_id = guest_sessions.id AND c.consumed_at IS NULL AND c.expires_at > ?3
        AND NOT EXISTS (SELECT 1 FROM guest_email_codes n WHERE n.session_id = c.session_id AND n.created_at > c.created_at)
        AND (guest_sessions.guest_id IS NULL OR guest_sessions.guest_id = (SELECT id FROM guest_reviewers WHERE email_normalized = c.email_normalized)))`).bind(tokenHash, session.id, committedAt, newest.id, session.tokenHash, session.guestId),
    db.prepare(`UPDATE guest_email_codes SET consumed_at = ?1 WHERE id = ?2 AND ${landed(3, 4)}`).bind(committedAt, newest.id, session.id, tokenHash),
    // The name is that person's current one: the last verification writes it, on this link or another.
    db.prepare(`INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) SELECT ?1, ?2, ?3, ?4 WHERE ${landed(5, 6)}
      ON CONFLICT (email_normalized) DO UPDATE SET display_name = excluded.display_name`).bind(newId(), email, parsed.data.name, committedAt, session.id, tokenHash),
    // `unsubscribed_at`, `first_verified_at` and `last_digest_sent_at` are left alone: verifying again never resubscribes anyone.
    db.prepare(`INSERT INTO guest_link_members (id, link_id, guest_id, first_verified_at, last_verified_at, last_seen_at) SELECT ?1, ?2, g.id, ?3, ?3, ?3 FROM guest_reviewers g
      WHERE g.email_normalized = ?4 AND ${landed(5, 6)}
      ON CONFLICT (link_id, guest_id) DO UPDATE SET last_verified_at = excluded.last_verified_at, last_seen_at = excluded.last_seen_at`).bind(newId(), link.id, committedAt, email, session.id, tokenHash),
    db.prepare(`UPDATE guest_sessions SET guest_id = (SELECT id FROM guest_reviewers WHERE email_normalized = ?1), verified_at = ?2 WHERE id = ?3 AND token_hash = ?4`).bind(email, committedAt, session.id, tokenHash),
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'review_link.email_verify', 'review_link', s.link_id, json_object('guest', json_object('guestId', s.guest_id, 'sessionId', s.id), 'linkId', s.link_id), ?2
      FROM guest_sessions s WHERE s.id = ?3 AND s.token_hash = ?4 AND s.guest_id IS NOT NULL`).bind(newId(), committedAt, session.id, tokenHash),
    db.prepare(`SELECT s.expires_at, g.email_normalized, g.display_name FROM guest_sessions s JOIN guest_reviewers g ON g.id = s.guest_id WHERE s.id = ?1 AND s.token_hash = ?2`).bind(session.id, tokenHash),
  ]);
  const stored = results[results.length - 1]!.results[0] as { expires_at: number; email_normalized: string; display_name: string | null } | undefined;
  if (!stored) {
    // Nothing landed. A gone session, link or gate is the stub and an archived Project is 409; a session that is still live lost the race to a double-click, a newer code or an expiry: the code is spent.
    return await classifyRefusal(c as unknown as Context<AppEnv>, session, false) ?? c.json({ error: "code_expired" }, 401);
  }
  const response = c.json(sessionBody(link, identityOf({ email: stored.email_normalized, name: stored.display_name })));
  response.headers.append("set-cookie", sessionCookieHeader(c.env, link.id, token, (stored.expires_at - committedAt) / 1000));
  return response;
}

export function mountGuestEmail(app: Hono<AppEnv>): void {
  app.post("/d/api/links/:linkId/email/code", guestRoute("/d/api/links/:linkId/email/code", sendCode));
  app.post("/d/api/links/:linkId/email/verify", guestRoute("/d/api/links/:linkId/email/verify", verifyCode));
}
