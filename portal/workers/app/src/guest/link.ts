import type { Context } from "hono";
import type { GuestSessionResponse } from "@quincy/shared";
import { hashToken } from "../lib/opaque-token";
import { readVideoReviewGate } from "../lib/video-review-gate";
import type { AppEnv } from "../env";
import { readSessionCookie, UUID } from "./http";

/** What the guest surface knows of a Review link: the link row, the gate and the session join. Every failure here is `null`, and the caller answers the one stub. */
export type GuestLink = {
  id: string; projectId: string; label: string | null; expiresAt: number; allowComments: boolean; allowApprove: boolean; allowDownload: boolean;
  tokenHash: string; tokenGeneration: number; hasPasscode: boolean; passcodeHash: string | null;
};
type LinkRow = { id: string; project_id: string; label: string | null; expires_at: number; allow_comments: number; allow_approve: number; allow_download: number; token_hash: string; token_generation: number; passcode_hash: string | null };

const LINK_SELECT = "l.id, l.project_id, l.label, l.expires_at, l.allow_comments, l.allow_approve, l.allow_download, l.token_hash, l.token_generation, l.passcode_hash";
const toLink = (row: LinkRow): GuestLink => ({
  id: row.id, projectId: row.project_id, label: row.label, expiresAt: row.expires_at, allowComments: row.allow_comments === 1, allowApprove: row.allow_approve === 1, allowDownload: row.allow_download === 1,
  tokenHash: row.token_hash, tokenGeneration: row.token_generation, hasPasscode: row.passcode_hash !== null, passcodeHash: row.passcode_hash,
});

/** The full gate for a Project: `video_review` on, the Project piloted or all-projects on, and the `guest` part on. */
export async function guestGateOpen(db: D1Database, projectId: string): Promise<boolean> {
  const state = await readVideoReviewGate(db, projectId);
  return state.open && state.parts.includes("guest");
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
  if (!row || !await guestGateOpen(c.env.DB, row.project_id)) return null;
  return toLink(row);
}

export type GuestSession = { id: string; link: GuestLink; guestId: string | null; expiresAt: number };
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
  const row = await c.env.DB.prepare(`SELECT s.id AS session_id, s.guest_id, s.expires_at AS session_expires_at, s.last_seen_at, ${LINK_SELECT}
      FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
      WHERE s.token_hash = ?1 AND s.link_id = ?2 AND s.expires_at > ?3 AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?3 AND s.link_generation = l.token_generation`)
    .bind(await hashToken(token), linkId, now).first<LinkRow & { session_id: string; guest_id: string | null; session_expires_at: number; last_seen_at: number }>();
  if (!row || !await guestGateOpen(c.env.DB, row.project_id)) return null;
  if (row.last_seen_at < now - SEEN_GRANULARITY_MS) await c.env.DB.prepare("UPDATE guest_sessions SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3").bind(now, row.session_id, now - SEEN_GRANULARITY_MS).run();
  return { id: row.session_id, link: toLink(row), guestId: row.guest_id, expiresAt: row.session_expires_at };
}

/** `verified` and `email` stay false and null until the email step (13) fills them. */
export const sessionBody = (link: GuestLink): GuestSessionResponse => ({
  link: { label: link.label, expiresAt: new Date(link.expiresAt).toISOString(), allow: { comments: link.allowComments, approve: link.allowApprove, download: link.allowDownload } },
  verified: false, email: null,
});
