import type { Context } from "hono";
import type { GuestSessionResponse, VideoReviewPart } from "@quincy/shared";
import { hashToken } from "../lib/opaque-token";
import { readVideoReviewGate } from "../lib/video-review-gate";
import type { AppEnv } from "../env";
import { readSessionCookie, UUID } from "./http";

/** What the guest surface knows of a Review link: the link row, the gate and the session join. Every failure here is `null`, and the caller answers the one stub. */
export type GuestLink = {
  id: string; projectId: string; label: string | null; expiresAt: number; allowComments: boolean; allowApprove: boolean; allowDownload: boolean;
  tokenHash: string; tokenGeneration: number; hasPasscode: boolean; passcodeHash: string | null;
  /** The Worker parts on for this Project when the row was read (`guest` is always among them). The `allow` flags a guest is shown depend on two of them. */
  parts: VideoReviewPart[];
};
type LinkRow = { id: string; project_id: string; label: string | null; expires_at: number; allow_comments: number; allow_approve: number; allow_download: number; token_hash: string; token_generation: number; passcode_hash: string | null };

const LINK_SELECT = "l.id, l.project_id, l.label, l.expires_at, l.allow_comments, l.allow_approve, l.allow_download, l.token_hash, l.token_generation, l.passcode_hash";
const toLink = (row: LinkRow, parts: VideoReviewPart[]): GuestLink => ({
  id: row.id, projectId: row.project_id, label: row.label, expiresAt: row.expires_at, allowComments: row.allow_comments === 1, allowApprove: row.allow_approve === 1, allowDownload: row.allow_download === 1,
  tokenHash: row.token_hash, tokenGeneration: row.token_generation, hasPasscode: row.passcode_hash !== null, passcodeHash: row.passcode_hash, parts,
});

/** The full gate for a Project: `video_review` on, the Project piloted or all-projects on, and the `guest` part on. Answers the parts that are on, or `null` when the gate is shut. */
export async function guestGateParts(db: D1Database, projectId: string): Promise<VideoReviewPart[] | null> {
  const state = await readVideoReviewGate(db, projectId);
  return state.open && state.parts.includes("guest") ? state.parts : null;
}

/** `video_review` and `video_review_guest` both on: one flag read, before any link is looked up. Per-Project scope is checked after the link is known. */
export async function guestGloballyOpen(db: D1Database): Promise<boolean> {
  const rows = (await db.prepare("SELECT key FROM feature_flags WHERE enabled = 1 AND key IN ('video_review', 'video_review_guest')").all<{ key: string }>()).results;
  return rows.length === 2;
}

/** An active Review link (kind `video_review`, not revoked, not expired) whose Project passes the gate. */
export async function loadActiveLink(c: Context<AppEnv>, linkId: string, now: number): Promise<GuestLink | null> {
  if (!UUID.test(linkId)) return null;
  const row = await c.env.DB.prepare(`SELECT ${LINK_SELECT} FROM client_links l WHERE l.id = ?1 AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?2`).bind(linkId, now).first<LinkRow>();
  const parts = row ? await guestGateParts(c.env.DB, row.project_id) : null;
  return row && parts ? toLink(row, parts) : null;
}

/** `guestId`, `email` and `name` are null until the session is verified (13a); `email` is the normalised address. */
export type GuestSession = { id: string; link: GuestLink; guestId: string | null; email: string | null; name: string | null; expiresAt: number };
const SEEN_GRANULARITY_MS = 5 * 60_000;

/**
 * The session behind the cookie of THIS link, in one statement: not expired, the link a video review link that is not revoked or expired, and the session minted under the link's
 * current generation (so replacing the link or revoking it ends the session on the very next request, whether or not its row was deleted yet). Then the gate. `last_seen_at` is
 * written only when older than five minutes, so a range request is not a write.
 */
export async function resolveSession(c: Context<AppEnv>, linkId: string, now: number): Promise<GuestSession | null> {
  if (!UUID.test(linkId)) return null;
  const token = readSessionCookie(c, linkId);
  if (!token) return null;
  const row = await c.env.DB.prepare(`SELECT s.id AS session_id, s.guest_id, g.email_normalized AS guest_email, g.display_name AS guest_name, s.expires_at AS session_expires_at, s.last_seen_at, ${LINK_SELECT}
      FROM guest_sessions s JOIN client_links l ON l.id = s.link_id LEFT JOIN guest_reviewers g ON g.id = s.guest_id
      WHERE s.token_hash = ?1 AND s.link_id = ?2 AND s.expires_at > ?3 AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?3 AND s.link_generation = l.token_generation`)
    .bind(await hashToken(token), linkId, now).first<LinkRow & { session_id: string; guest_id: string | null; guest_email: string | null; guest_name: string | null; session_expires_at: number; last_seen_at: number }>();
  const parts = row ? await guestGateParts(c.env.DB, row.project_id) : null;
  if (!row || !parts) return null;
  if (row.last_seen_at < now - SEEN_GRANULARITY_MS) {
    // A verified guest's membership is touched on the same beat, so the staff list's `lastSeenAt` follows the guest and not only their first verification.
    const touch = [c.env.DB.prepare("UPDATE guest_sessions SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3").bind(now, row.session_id, now - SEEN_GRANULARITY_MS)];
    if (row.guest_id !== null) touch.push(c.env.DB.prepare("UPDATE guest_link_members SET last_seen_at = ?1 WHERE link_id = ?2 AND guest_id = ?3 AND last_seen_at < ?1").bind(now, row.id, row.guest_id));
    await c.env.DB.batch(touch);
  }
  return { id: row.session_id, link: toLink(row, parts), guestId: row.guest_id, email: row.guest_email, name: row.guest_name, expiresAt: row.session_expires_at };
}

/**
 * What the page is told. Each `allow` flag is the link's flag AND its Worker part (`guest_comments` for comments, `delivery` for approve and download), from the gate state already
 * read for this request. `verified`, `email` and `name` are false, null and null until the session is verified.
 */
export const sessionBody = (link: GuestLink, identity: { email: string; name: string | null } | null = null): GuestSessionResponse => ({
  link: {
    label: link.label, expiresAt: new Date(link.expiresAt).toISOString(),
    allow: { comments: link.allowComments && link.parts.includes("guest_comments"), approve: link.allowApprove && link.parts.includes("delivery"), download: link.allowDownload && link.parts.includes("delivery") },
  },
  verified: identity !== null, email: identity?.email ?? null, name: identity?.name ?? null,
});
/** The identity of a session for `sessionBody`, or null while it is unverified. */
export const identityOf = (session: Pick<GuestSession, "email" | "name">): { email: string; name: string | null } | null => (session.email === null ? null : { email: session.email, name: session.name });
