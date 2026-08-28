import type { Env } from "./env";

type SweepSession = {
  id: string;
  r2Key: string;
  r2UploadId: string;
  bytes: number;
  status: "open" | "completing" | "aborting";
  expiresAt: number;
  completionLeaseExpiresAt: number | null;
};

const isFinalJpeg = (object: R2Object | null, bytes: number) => Boolean(
  object && object.size === bytes && object.httpMetadata?.contentType === "image/jpeg",
);

/**
 * Reclaims only tracked multipart state. It never enumerates R2 and never deletes completed
 * media. A stale completion is reopened after a HEAD-first check so the app can retry its
 * predetermined asset/audit commit; an incomplete upload is aborted and terminalized.
 */
export async function sweepExternalEditedUploads(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<{ scanned: number; reclaimed: number; reopened: number }> {
  const rows = await env.DB.prepare(`
    SELECT id, r2_key AS r2Key, r2_upload_id AS r2UploadId, bytes, status,
      expires_at AS expiresAt, completion_lease_expires_at AS completionLeaseExpiresAt
    FROM external_edited_upload_sessions
    WHERE (status = 'open' AND expires_at <= ?)
       OR status = 'aborting'
       OR (status = 'completing' AND completion_lease_expires_at <= ?)
    ORDER BY id LIMIT 100
  `).bind(now, now).all<SweepSession>();
  let reclaimed = 0;
  let reopened = 0;
  for (const row of rows.results) {
    if (row.status === "completing") {
      const final = await env.MEDIA.head(row.r2Key);
      if (isFinalJpeg(final, row.bytes) && row.expiresAt > now) {
        const reset = await env.DB.prepare(`
          UPDATE external_edited_upload_sessions
          SET status = 'open', completion_lease_token = NULL, completion_lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'completing' AND completion_lease_expires_at <= ?
        `).bind(now, row.id, now).run();
        if ((reset.meta.changes ?? 0) === 1) reopened += 1;
        continue;
      }
      if (final) continue; // A mismatched final object is an operator-visible 409, not an abort target.
      const claimed = await env.DB.prepare(`
        UPDATE external_edited_upload_sessions
        SET status = 'aborting', completion_lease_token = NULL, completion_lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'completing' AND completion_lease_expires_at <= ?
      `).bind(now, row.id, now).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    }
    try {
      await env.MEDIA.resumeMultipartUpload(row.r2Key, row.r2UploadId).abort();
      const terminalStatus = row.expiresAt <= now ? "expired" : "aborted";
      const done = await env.DB.prepare(`
        UPDATE external_edited_upload_sessions
        SET status = ?, terminal_at = ?, updated_at = ?
        WHERE id = ? AND status = 'aborting'
      `).bind(terminalStatus, now, now, row.id).run();
      if ((done.meta.changes ?? 0) === 1) reclaimed += 1;
    } catch (error) {
      console.error("External upload multipart sweep failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  return { scanned: rows.results.length, reclaimed, reopened };
}
