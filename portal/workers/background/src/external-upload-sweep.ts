import type { Env } from "./env";

type SweepSession = {
  id: string;
  projectId: string;
  collectionId: string;
  assetId: string;
  originalFilename: string;
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

function isMissingMultipartUploadError(error: unknown): boolean {
  for (let current: unknown = error; current; current = current instanceof Error ? current.cause : undefined) {
    if (!current || typeof current !== "object") continue;
    const value = current as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
    if (value.status === 404 || value.code === "NoSuchUpload" || value.name === "NoSuchUpload") return true;
    const text = [value.code, value.name, value.message].filter((item): item is string => typeof item === "string").join(" ");
    if (/no such upload|multipart upload (?:was )?not found|upload (?:does not exist|has already been aborted)|already aborted/i.test(text)) return true;
  }
  return false;
}

/**
 * Reclaims only tracked multipart state. It never enumerates R2 and never deletes completed
 * media. A stale completion is terminalized after a HEAD-first check: a valid final object is
 * recovered as a completed upload, while an incomplete or invalid multipart is aborted.
 */
export async function sweepExternalEditedUploads(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<{ scanned: number; reclaimed: number; reopened: number }> {
  const rows = await env.DB.prepare(`
    SELECT id, project_id AS projectId, collection_id AS collectionId, asset_id AS assetId,
      original_filename AS originalFilename, r2_key AS r2Key, r2_upload_id AS r2UploadId, bytes, status,
      expires_at AS expiresAt, completion_lease_expires_at AS completionLeaseExpiresAt
    FROM external_edited_upload_sessions
    WHERE (status = 'open' AND expires_at <= ?)
       OR status = 'aborting'
       OR (status = 'completing' AND (completion_lease_expires_at <= ? OR expires_at <= ?))
    ORDER BY id LIMIT 100
  `).bind(now, now, now).all<SweepSession>();
  let reclaimed = 0;
  let reopened = 0;
  for (const row of rows.results) {
    if (row.status === "open") {
      const claimed = await env.DB.prepare(`
        UPDATE external_edited_upload_sessions
        SET status = 'aborting', updated_at = ?
        WHERE id = ? AND status = 'open' AND expires_at <= ?
      `).bind(now, row.id, now).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    } else if (row.status === "completing") {
      const final = await env.MEDIA.head(row.r2Key);
      if (isFinalJpeg(final, row.bytes)) {
        // R2 completion can win just before a worker crash, including after the session's
        // nominal expiry. Recover the immutable object and close the D1 state; never reopen a
        // lease that could race a second completion attempt.
        const recoveredAuditId = crypto.randomUUID();
        const recovered = await env.DB.batch([
          env.DB.prepare(`
            INSERT INTO assets (
              id, collection_id, r2_key, original_filename, bytes, content_hash, source,
              source_raw_asset_id, section, publish_status, rating_from_metadata, created_at, updated_at
            )
            SELECT s.asset_id, s.collection_id, s.r2_key, s.original_filename, s.bytes, NULL, 'upload',
              NULL, 'Manual', 'pending', NULL, ?, ?
            FROM external_edited_upload_sessions s
            INNER JOIN collections c ON c.id = s.collection_id AND c.project_id = s.project_id AND c.kind = 'edited'
            INNER JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
            INNER JOIN user u ON u.id = s.created_by AND u.active = 1 AND u.role = 'external_editor'
              AND u.authorization_epoch = s.authorization_epoch
            INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
              AND pm.project_id = s.project_id AND pm.user_id = s.created_by AND pm.role_on_project = 'editor'
            WHERE s.id = ? AND s.status = 'completing'
              AND (s.completion_lease_expires_at <= ? OR s.expires_at <= ?)
            ON CONFLICT(id) DO NOTHING
          `).bind(now, now, row.id, now, now),
          env.DB.prepare(`
            INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
            SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND collection_id = ? AND r2_key = ? AND bytes = ?)
              AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'asset.ingested' AND target_type = 'asset' AND target_id = ?)
          `).bind(
            recoveredAuditId, row.assetId,
            JSON.stringify({ projectId: row.projectId, key: row.r2Key, manifestId: null, ratingFromMetadata: null, recoveredBy: "external-upload-sweep" }), now,
            row.assetId, row.collectionId, row.r2Key, row.bytes, row.assetId,
          ),
          env.DB.prepare(`
            UPDATE external_edited_upload_sessions
            SET status = 'completed', completion_lease_token = NULL, completion_lease_expires_at = NULL,
                completed_at = ?, terminal_at = ?, updated_at = ?
            WHERE id = ? AND status = 'completing'
              AND (completion_lease_expires_at <= ? OR expires_at <= ?)
              AND EXISTS (
                SELECT 1 FROM assets a
                WHERE a.id = external_edited_upload_sessions.asset_id
                  AND a.collection_id = external_edited_upload_sessions.collection_id
                  AND a.r2_key = external_edited_upload_sessions.r2_key
                  AND a.bytes = external_edited_upload_sessions.bytes
              )
          `).bind(now, now, now, row.id, now, now),
        ]);
        if ((recovered[2]?.meta.changes ?? 0) === 1) {
          reclaimed += 1;
          reopened += 1; // Retained as the legacy metric name for recovered final objects.
        } else {
          console.error("External upload recovery left session completing after authorization check", { sessionId: row.id });
        }
        continue;
      }
      const claimed = await env.DB.prepare(`
        UPDATE external_edited_upload_sessions
        SET status = 'aborting', completion_lease_token = NULL, completion_lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'completing'
          AND (completion_lease_expires_at <= ? OR expires_at <= ?)
      `).bind(now, row.id, now, now).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    }
    try {
      try {
        await env.MEDIA.resumeMultipartUpload(row.r2Key, row.r2UploadId).abort();
      } catch (error) {
        if (!isMissingMultipartUploadError(error)) throw error;
      }
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
