import type { Context, Hono } from "hono";
import { guestDecisionInputSchema, guestDecisionResponseSchema, type VideoReviewPart } from "@quincy/shared";
import { newId } from "../lib/ids";
import type { AppEnv } from "../env";
import { archivedResponse, classifyRefusal, guestFence } from "./fence";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, TOO_LARGE, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestSession } from "./link";
import { resolveGrantedVersion } from "./read";

/**
 * Guest client decision (#741 14a): `POST /d/api/links/:linkId/versions/:assetId/decision`. A verified guest approves a Version or asks for changes; the answer is an append-only event
 * (`video_approval_events`), informational only (ADR 0021 section 5). The order is the guest order of the plan (section 1.1): ids, link and gate (the `guest` AND `delivery` parts),
 * Origin, the session, then the capability (unverified 401, `allow_approve` off 403), the Version through a live member and a live grant (a miss is the stub), the archived Project
 * (409), the body, and the write.
 *
 * Every non-success answer goes through `answer`, which runs `classifyRefusal` first (the shared fence of `fence.ts`, with the `delivery` part): a request whose link, session, gate or
 * Project changed under it is the stub, or 409 `project_archived`, and never a 401, 403, 400, 413 or conflict. The INSERT repeats the fence at a fresh time taken after the body was read:
 * the exact session token and identity, a VERIFIED session, `allow_approve`, the live member and grant of this Version, and the revision allocated in the same statement. The audit row
 * follows only an event that landed, in the same batch, and carries no note text.
 */
const PARTS: readonly VideoReviewPart[] = ["guest", "delivery"];
/** The note is at most 2000 characters, which can be 8 KiB of UTF-8; the rest is the JSON around it. */
const DECISION_BODY_MAX = 16 * 1024;

type Handled = Context<AppEnv, "/d/api/links/:linkId/versions/:assetId/decision">;
const plain = (c: Handled) => c as unknown as Context<AppEnv>;

async function decide(c: Handled): Promise<Response> {
  const now = Date.now(); const linkId = c.req.param("linkId"); const assetId = c.req.param("assetId");
  if (!UUID.test(assetId)) return guestNotFound(plain(c));
  const link = await loadActiveLink(plain(c), linkId, now);
  if (!link || !link.parts.includes("delivery")) return guestNotFound(plain(c));
  const rejected = originRejection(plain(c)); if (rejected) return rejected;
  const session = await resolveSession(plain(c), linkId, now);
  if (!session) return guestNotFound(plain(c));
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(plain(c), session, true, PARTS) ?? response;

  // The capability is not a stub on purpose: the session body already tells the page whether it is verified and what the link allows.
  if (session.guestId === null) return answer(c.json({ error: "verification_required" }, 401));
  if (!session.link.allowApprove) return answer(c.json({ error: "approve_disabled" }, 403));
  const version = await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
  if (!version) return guestNotFound(plain(c));
  const archived = await archivedResponse(plain(c), session.link.projectId); if (archived) return archived;

  const raw = await readJson(plain(c), DECISION_BODY_MAX);
  // Refusal first, once the body is in: every answer below is given only to a request whose link, session, gate and Project still stand, and whose Video and grant are still live.
  const early = await classifyRefusal(plain(c), session, true, PARTS); if (early) return early;
  if (!await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, assetId)) return guestNotFound(plain(c));
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  const parsed = raw === INVALID ? null : guestDecisionInputSchema.safeParse(raw);
  if (!parsed?.success) return c.json({ error: "invalid_request" }, 400);

  const eventId = newId(); const committedAt = Date.now();
  const note = parsed.data.note ? parsed.data.note : null;
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at)
        SELECT ?1, l.project_id, g.video_id, g.asset_id, l.id, COALESCE((SELECT MAX(x.revision) FROM video_approval_events x WHERE x.asset_id = g.asset_id), 0) + 1, ?2, ?3, s.guest_id, NULL, ?4
        FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
          JOIN review_link_version_grants g ON g.link_id = l.id AND g.asset_id = ?8 AND g.revoked_at IS NULL
          JOIN review_link_videos rv ON rv.link_id = g.link_id AND rv.video_id = g.video_id AND rv.removed_at IS NULL
          JOIN videos v ON v.id = g.video_id AND v.project_id = l.project_id
          JOIN video_version_meta m ON m.asset_id = g.asset_id AND m.video_id = g.video_id
        WHERE s.id = ?5 AND s.guest_id IS NOT NULL AND s.verified_at IS NOT NULL AND l.allow_approve = 1 AND ${guestFence({ now: "?4", token: "?6", guest: "?7" }, PARTS)}`)
        .bind(eventId, parsed.data.decision, note, committedAt, session.id, session.tokenHash, session.guestId, assetId),
      c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, NULL, 'video_version.decision', 'asset', e.asset_id, json_object('guest', json_object('guestId', e.actor_guest_id, 'sessionId', ?2), 'linkId', e.link_id, 'projectId', e.project_id,
          'videoId', e.video_id, 'decision', e.decision, 'revision', e.revision, 'hasNote', e.note IS NOT NULL), ?3 FROM video_approval_events e WHERE e.id = ?4`)
        .bind(newId(), session.id, committedAt, eventId),
      c.env.DB.prepare("SELECT revision, decision, created_at FROM video_approval_events WHERE id = ?1").bind(eventId),
    ]);
  } catch (error) {
    // The revision is allocated in the INSERT and D1 serialises writes, so this is a defence: a collision is retried by the client, never a partial write.
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) return answer(c.json({ error: "decision_conflict" }, 409));
    throw error;
  }
  const stored = results[2]!.results[0] as { revision: number; decision: "approved" | "changes_requested"; created_at: number } | undefined;
  if (stored) return c.json(guestDecisionResponseSchema.parse({ decision: { value: stored.decision, revision: stored.revision, at: new Date(stored.created_at).toISOString(), self: true } }), 201);
  return refusedBecause(c, session);
}

/** Nothing landed: say why, from a fresh read, in the same order as the entry. The stub or the archive first, then what this session may do, else the Version is no longer reachable. */
async function refusedBecause(c: Handled, session: GuestSession): Promise<Response> {
  const refused = await classifyRefusal(plain(c), session, true, PARTS); if (refused) return refused;
  const row = await c.env.DB.prepare("SELECT s.guest_id, s.verified_at, l.allow_approve FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?1").bind(session.id).first<{ guest_id: string | null; verified_at: number | null; allow_approve: number }>();
  if (!row) return guestNotFound(plain(c));
  if (row.guest_id === null || row.verified_at === null || row.guest_id !== session.guestId) return c.json({ error: "verification_required" }, 401);
  if (row.allow_approve !== 1) return c.json({ error: "approve_disabled" }, 403);
  return guestNotFound(plain(c));
}

export function mountGuestApproval(app: Hono<AppEnv>): void {
  app.post("/d/api/links/:linkId/versions/:assetId/decision", guestRoute("/d/api/links/:linkId/versions/:assetId/decision", decide));
}
