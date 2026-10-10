import type { Context, Hono } from "hono";
import { guestDecisionInputSchema, guestDecisionResponseSchema, guestOutboxActor, type VideoReviewPart } from "@quincy/shared";
import { newId } from "../lib/ids";
import { LIVE_VERSION, LIVE_VIDEO } from "../lib/video-live-sql";
import { publishOutboxDetached } from "../lib/server-timing";
import { videoReviewOutboxStatements } from "../lib/video-review-notifications";
import type { AppEnv } from "../env";
import { committableSql } from "../lib/guest-fence-sql";
import { classifyRefusal } from "./fence";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, TOO_LARGE, tooMany, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestLink, type GuestSession } from "./link";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";
import { resolveGrantedVersion } from "./read";

/**
 * Guest client decision (#741 14a): `POST /d/api/links/:linkId/versions/:assetId/decision`. A verified guest approves a Version or asks for changes; the answer is an append-only event
 * (`video_approval_events`), informational only (ADR 0021 section 5). It follows the order of `notes-write.ts` (docs/plans/741-13-15.md section 1.1):
 *
 *  1. path ids are UUIDs, else the stub;
 *  2. the link is active, the gate is open and the `guest` and `delivery` parts are on, else the stub. Then the bounded body is READ (never judged), a fresh time is taken and the link is
 *     read again at it;
 *  3. Origin and content type, else 403;  4. the session cookie, else the stub;
 *  5. capability: unverified is 401, `allow_approve` off is 403;  6. visibility: the Version is reachable through a live member and a live grant, else the stub;  7. an archived Project is 409;
 *  8. the rate-limit attempts are reserved (429), so an invalid body is charged;  9. the body is judged (400, 413);  10. the write.
 *
 * Every non-success answer after the credential goes through `classifyRefusal` (./fence.ts, with the `delivery` part), so lost access is the byte-identical stub and nothing else is ever
 * the answer to a request whose link, gate, part or Version changed under it. The INSERT repeats the fence at a fresh time taken after the body was read: the exact session token and
 * identity, a VERIFIED session, `allow_approve`, the live member and grant of this Version, and the revision allocated in the same statement. The audit row follows only an event that
 * landed, in the same batch, and carries no note text.
 */
const PARTS: readonly VideoReviewPart[] = ["guest", "delivery"];
/** The note is at most 2000 characters, which can be 8 KiB of UTF-8; the rest is the JSON around it. */
const DECISION_BODY_MAX = 16 * 1024;

type Handled = Context<AppEnv, "/d/api/links/:linkId/versions/:assetId/decision">;
const plain = (c: Handled) => c as unknown as Context<AppEnv>;
const open = (link: GuestLink | null): link is GuestLink => link !== null && PARTS.every((part) => link.parts.includes(part));

async function decide(c: Handled): Promise<Response> {
  const linkId = c.req.param("linkId"); const assetId = c.req.param("assetId");
  const stub = () => guestNotFound(plain(c));
  if (!UUID.test(assetId)) return stub();
  if (!open(await loadActiveLink(plain(c), linkId, Date.now()))) return stub();
  const raw = await readJson(plain(c), DECISION_BODY_MAX);
  // A fresh time for everything below, and the link read again at it: the body may have been held across a revoke, a gate change or a part going off.
  const now = Date.now();
  if (!open(await loadActiveLink(plain(c), linkId, now))) return stub();
  const rejected = originRejection(plain(c)); if (rejected) return rejected;
  const session = await resolveSession(plain(c), linkId, now); if (!session) return stub();
  const early = (response: Response) => classifyRefusal(plain(c), session, true, { parts: PARTS, archived: false }).then((refused) => refused ?? response);
  // The capability is not a stub on purpose: the session body already tells the page whether it is verified and what the link allows.
  if (session.guestId === null) return early(c.json({ error: "verification_required" }, 401));
  if (!session.link.allowApprove) return early(c.json({ error: "approve_disabled" }, 403));
  const guestId = session.guestId;
  const scope = { parts: PARTS, approve: true, assetId };
  const granted = await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
  if (!granted) return await classifyRefusal(plain(c), session, true, { ...scope, archived: false }) ?? stub();
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(plain(c), session, true, scope) ?? response;
  const refused = await classifyRefusal(plain(c), session, true, scope); if (refused) return refused;

  const limited = await reserve(c, session.link.id, guestId); if (limited) return answer(limited);
  if (raw === TOO_LARGE) return answer(c.json({ error: "payload_too_large" }, 413));
  const parsed = raw === INVALID ? null : guestDecisionInputSchema.safeParse(raw);
  if (!parsed?.success) return answer(c.json({ error: "invalid_request" }, 400));

  const eventId = newId(); const committedAt = Date.now(); const auditId = newId();
  const note = parsed.data.note ? parsed.data.note : null;
  // 15a: staff are told of the decision, with no note text; appended to this batch and fenced on its audit row.
  const notify = await videoReviewOutboxStatements(c.env.DB, { kind: "video_decision", projectId: session.link.projectId, videoId: granted.videoId, assetId, sourceId: eventId, actorId: guestOutboxActor(guestId), excludeUserId: null, auditId, occurredAt: committedAt });
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at)
        SELECT ?1, l.project_id, g.video_id, g.asset_id, l.id, COALESCE((SELECT MAX(x.revision) FROM video_approval_events x WHERE x.asset_id = g.asset_id), 0) + 1, ?2, ?3, s.guest_id, NULL, ?4
        FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
          JOIN review_link_version_grants g ON g.link_id = l.id AND g.asset_id = ?8 AND g.revoked_at IS NULL
          JOIN review_link_videos rv ON rv.link_id = g.link_id AND rv.video_id = g.video_id AND rv.removed_at IS NULL
          JOIN videos v ON v.id = g.video_id AND v.project_id = l.project_id AND ${LIVE_VIDEO("v")}
          JOIN video_version_meta m ON m.asset_id = g.asset_id AND m.video_id = g.video_id AND ${LIVE_VERSION("m")}
        WHERE s.id = ?5 AND s.guest_id IS NOT NULL AND s.verified_at IS NOT NULL AND l.allow_approve = 1 AND s.token_hash = ?6 AND s.guest_id IS ?7 AND ${committableSql("?4", PARTS)}`)
        .bind(eventId, parsed.data.decision, note, committedAt, session.id, session.tokenHash, guestId, assetId),
      c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, NULL, 'video_version.decision', 'asset', e.asset_id, json_object('guest', json_object('guestId', e.actor_guest_id, 'sessionId', ?2), 'linkId', e.link_id, 'projectId', e.project_id,
          'videoId', e.video_id, 'decision', e.decision, 'revision', e.revision, 'hasNote', e.note IS NOT NULL), ?3 FROM video_approval_events e WHERE e.id = ?4`)
        .bind(auditId, session.id, committedAt, eventId),
      c.env.DB.prepare("SELECT revision, decision, created_at FROM video_approval_events WHERE id = ?1").bind(eventId),
      ...notify.statements,
    ]);
  } catch (error) {
    // The revision is allocated in the INSERT and D1 serialises writes, so this is a defence: a collision is retried by the client, never a partial write.
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) return answer(c.json({ error: "decision_conflict" }, 409));
    throw error;
  }
  const stored = results[2]!.results[0] as { revision: number; decision: "approved" | "changes_requested"; created_at: number } | undefined;
  if (stored && notify.outboxIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, notify.outboxIds));
  if (stored) return c.json(guestDecisionResponseSchema.parse({ decision: { value: stored.decision, revision: stored.revision, at: new Date(stored.created_at).toISOString(), self: true } }), 201);
  return refusedBecause(c, session, assetId);
}

/** One attempt in each bucket, charged to the window the request completes in. */
async function reserve(c: Handled, linkId: string, guestId: string): Promise<Response | null> {
  const decidedAt = Date.now();
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: `decision:guest:${guestId}`, limit: GUEST_LIMITS.decisionGuest }, { bucket: `decision:link:${linkId}`, limit: GUEST_LIMITS.decisionLink }], decidedAt);
  return attempt.limited ? tooMany(attempt.retryAfterSeconds) : null;
}

/** Nothing landed: say why, from a fresh read, in the same order as the entry. The stub or the archive first, then what this session may do, else the Version is no longer reachable. */
async function refusedBecause(c: Handled, session: GuestSession, assetId: string): Promise<Response> {
  const refused = await classifyRefusal(plain(c), session, true, { parts: PARTS, approve: true, assetId }); if (refused) return refused;
  const row = await c.env.DB.prepare("SELECT s.guest_id, s.verified_at, l.allow_approve FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?1").bind(session.id).first<{ guest_id: string | null; verified_at: number | null; allow_approve: number }>();
  if (!row) return guestNotFound(plain(c));
  if (row.guest_id === null || row.verified_at === null || row.guest_id !== session.guestId) return c.json({ error: "verification_required" }, 401);
  if (row.allow_approve !== 1) return c.json({ error: "approve_disabled" }, 403);
  return guestNotFound(plain(c));
}

export function mountGuestApproval(app: Hono<AppEnv>): void {
  app.post("/d/api/links/:linkId/versions/:assetId/decision", guestRoute("/d/api/links/:linkId/versions/:assetId/decision", decide));
}
