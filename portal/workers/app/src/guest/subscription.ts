import type { Context, Hono } from "hono";
import { guestSubscriptionInputSchema, guestSubscriptionResponseSchema, guestUnsubscribeInputSchema, type VideoReviewPart } from "@quincy/shared";
import { hashToken } from "../lib/opaque-token";
import { newId } from "../lib/ids";
import { committableSql } from "../lib/guest-fence-sql";
import type { AppEnv } from "../env";
import { classifyRefusal } from "./fence";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, TOO_LARGE, tooMany } from "./http";
import { loadActiveLink, resolveSession } from "./link";
import { clientAddress, GUEST_LIMITS, ipBucket, reserveAttempts, windowStart } from "./rate-limit";

/**
 * The client digest subscription (#741 15b), two writes that only ever flip `guest_link_members.unsubscribed_at` of ONE membership:
 *
 *  - `POST /d/api/unsubscribe {token, subscribed?}`: the tokened link in a digest email (`${APP_ORIGIN}/d/unsubscribe#t=<token>`, the token only in the fragment, so the page POSTs it here).
 *    Settled decision 11: it carries NO gate (no master flag, no part, no session), so unsubscribing keeps working after a flag is turned off, a link is revoked or a Project is archived.
 *    It only ever REDUCES email (and resubscribing is its undo). The order is Origin, the per-address quota (30 in 15 minutes, charged for unknown tokens too), the bounded body, then the
 *    token's hash: an unknown token is the same stub as every other miss on `/d`.
 *  - `PUT /d/api/links/:linkId/subscription {subscribed}`: a verified guest's own switch, part `guest`, in the order and with the fence of `approval.ts` (stub, Origin, session, 401 when unverified,
 *    `classifyRefusal`, archived 409, the quota, the body, then a write that repeats the fence in SQL).
 *
 * Unsubscribing also drops the membership's pending digest rows (so a later resubscribe never mails stale news). The audit row (`review_link.unsubscribe|resubscribe`, actor NULL, meta
 * `{memberId, linkId, guest:{guestId}}`) is written only when the state changed, in the same batch.
 */
const PARTS: readonly VideoReviewPart[] = ["guest"];

type Handled<P extends string> = Context<AppEnv, P>;
const plain = <P extends string>(c: Handled<P>) => c as unknown as Context<AppEnv>;

const answer = (subscribed: boolean) => guestSubscriptionResponseSchema.parse({ subscribed });

/**
 * One batch: flip the membership (only when it differs), audit the flip, and on an unsubscribe drop its pending rows. `fenced` is extra SQL on the UPDATE's WHERE (the PUT's session fence);
 * the audit follows `changes()` of that UPDATE and the deletion follows the audit row, so a refused or no-op write leaves neither.
 */
function flipStatements(db: D1Database, input: { memberId: string; subscribed: boolean; now: number; fenced?: { sql: string; binds: unknown[] } }): D1PreparedStatement[] {
  const auditId = newId(); const action = input.subscribed ? "review_link.resubscribe" : "review_link.unsubscribe";
  const flip = input.subscribed ? "unsubscribed_at = NULL" : "unsubscribed_at = ?2";
  const differs = input.subscribed ? "unsubscribed_at IS NOT NULL" : "unsubscribed_at IS NULL";
  // `?2` (the time) is bound only where the statement mentions it: an unsubscribe stores it, and the session fence reads it. A bare resubscribe has neither.
  const binds = input.subscribed && !input.fenced ? [input.memberId] : [input.memberId, input.now, ...(input.fenced?.binds ?? [])];
  const statements = [
    db.prepare(`UPDATE guest_link_members SET ${flip} WHERE id = ?1 AND ${differs}${input.fenced ? ` AND ${input.fenced.sql}` : ""}`).bind(...binds),
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, ?2, 'review_link', m.link_id, json_object('memberId', m.id, 'linkId', m.link_id, 'guest', json_object('guestId', m.guest_id)), ?3 FROM guest_link_members m WHERE m.id = ?4 AND changes() > 0`)
      .bind(auditId, action, input.now, input.memberId),
  ];
  if (!input.subscribed) statements.push(db.prepare("DELETE FROM guest_notification_digest WHERE sent_at IS NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?1) AND (guest_id, link_id) = (SELECT guest_id, link_id FROM guest_link_members WHERE id = ?2)").bind(auditId, input.memberId));
  return statements;
}

async function unsubscribeByToken(c: Handled<"/d/api/unsubscribe">): Promise<Response> {
  const rejected = originRejection(plain(c)); if (rejected) return rejected;
  const now = Date.now();
  // The quota first and for every caller: this route has no session, so the address is the only thing to count. A flood of random tokens costs one counter write each.
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: await ipBucket("unsubscribe", clientAddress(c.req.raw), windowStart(now)), limit: GUEST_LIMITS.unsubscribeIp }], now);
  if (attempt.limited) return tooMany(attempt.retryAfterSeconds);
  const raw = await readJson(plain(c));
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  const parsed = raw === INVALID ? null : guestUnsubscribeInputSchema.safeParse(raw);
  if (!parsed?.success) return c.json({ error: "invalid_request" }, 400);
  const tokenHash = await hashToken(parsed.data.token);
  const found = await c.env.DB.prepare("SELECT t.member_id FROM guest_unsubscribe_tokens t JOIN guest_link_members m ON m.id = t.member_id WHERE t.token_hash = ?1").bind(tokenHash).first<{ member_id: string }>();
  if (!found) return guestNotFound(plain(c));
  const subscribed = parsed.data.subscribed === true;
  await c.env.DB.batch(flipStatements(c.env.DB, { memberId: found.member_id, subscribed, now: Date.now() }));
  const state = await c.env.DB.prepare("SELECT unsubscribed_at FROM guest_link_members WHERE id = ?1").bind(found.member_id).first<{ unsubscribed_at: number | null }>();
  // The membership can vanish between the lookup and here (its reviewer deleted): that is the same stub as an unknown token.
  return state ? c.json(answer(state.unsubscribed_at === null)) : guestNotFound(plain(c));
}

type Put = Handled<"/d/api/links/:linkId/subscription">;
async function setSubscription(c: Put): Promise<Response> {
  const linkId = c.req.param("linkId"); const stub = () => guestNotFound(plain(c));
  const open = async (at: number) => { const link = await loadActiveLink(plain(c), linkId, at); return link !== null && PARTS.every((part) => link.parts.includes(part)); };
  if (!await open(Date.now())) return stub();
  const raw = await readJson(plain(c));
  // A fresh time for everything below, and the link read again at it: the body may have been held across a revoke, a gate change or a part going off.
  const now = Date.now();
  if (!await open(now)) return stub();
  const rejected = originRejection(plain(c)); if (rejected) return rejected;
  const session = await resolveSession(plain(c), linkId, now); if (!session) return stub();
  const refusal = (extra: Parameters<typeof classifyRefusal>[3] = {}) => classifyRefusal(plain(c), session, true, { parts: PARTS, ...extra });
  const early = async (response: Response) => await refusal({ archived: false }) ?? response;
  if (session.guestId === null) return early(c.json({ error: "verification_required" }, 401));
  const guestId = session.guestId;
  const refused = await refusal(); if (refused) return refused;
  const done = async (response: Response) => await refusal() ?? response;

  const limit = await reserveAttempts(c.env.DB, [{ bucket: `subscription:guest:${guestId}`, limit: GUEST_LIMITS.subscriptionGuest }], Date.now());
  if (limit.limited) return done(tooMany(limit.retryAfterSeconds));
  if (raw === TOO_LARGE) return done(c.json({ error: "payload_too_large" }, 413));
  const parsed = raw === INVALID ? null : guestSubscriptionInputSchema.safeParse(raw);
  if (!parsed?.success) return done(c.json({ error: "invalid_request" }, 400));

  const member = await c.env.DB.prepare("SELECT id FROM guest_link_members WHERE link_id = ?1 AND guest_id = ?2").bind(session.link.id, guestId).first<{ id: string }>();
  // A verified session always has its membership (the verify batch writes both); a miss is a state the guest cannot reach, so it is the stub.
  if (!member) return done(await stub());
  const committedAt = Date.now();
  await c.env.DB.batch(flipStatements(c.env.DB, {
    memberId: member.id, subscribed: parsed.data.subscribed, now: committedAt,
    // The fence of every guest write, repeated in the UPDATE itself at a fresh time: this exact session and token, the verified guest, a live link at its generation, the gate and an unarchived Project.
    fenced: { sql: `EXISTS (SELECT 1 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?3 AND s.token_hash = ?4 AND s.guest_id = ?5 AND s.verified_at IS NOT NULL AND l.id = guest_link_members.link_id AND ${committableSql("?2", PARTS)})`, binds: [session.id, session.tokenHash, guestId] },
  }));
  // Nothing landed is either a no-op (already in that state) or a refusal; the classifier says which, and a refusal always wins over a state read.
  const lost = await refusal(); if (lost) return lost;
  const state = await c.env.DB.prepare("SELECT unsubscribed_at FROM guest_link_members WHERE id = ?1").bind(member.id).first<{ unsubscribed_at: number | null }>();
  return state ? c.json(answer(state.unsubscribed_at === null)) : stub();
}

export function mountGuestSubscription(app: Hono<AppEnv>): void {
  app.post("/d/api/unsubscribe", guestRoute("/d/api/unsubscribe", unsubscribeByToken));
  app.put("/d/api/links/:linkId/subscription", guestRoute("/d/api/links/:linkId/subscription", setSubscription));
}
