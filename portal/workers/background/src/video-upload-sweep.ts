import { VIDEO_UPLOAD_COMPLETION_LEASE_MS } from "@quincy/shared";
import type { Env } from "./env";
import { isMissingMultipartUploadError } from "./external-upload-sweep";

type SweepRow = { id: string; r2Key: string; uploadId: string | null; status: "pending" | "completing" | "aborting" };

/**
 * Reclaims staff video uploads (#741 PR 4b) that nobody will finish: a `pending` reservation past its expiry, a `completing` claim older than the
 * 15 minute lease (the completion stalled or its Worker died), and an `aborting` row an abort left behind. Each is claimed with a compare-and-set to
 * `aborting` under the same predicate that selected it, then the multipart upload is aborted (an upload R2 no longer knows is as good as aborted),
 * the object is deleted, and only then is the row closed as `expired`. Once a row is `aborting` a completion's batch cannot commit, because every one of
 * its statements is fenced on `status = 'completing'`. It never recovers a stale `completing` upload: that would need a re-probe, and the uploader can
 * start again. A failed R2 call leaves the row `aborting` for the next minute. Uses the R2 binding, never S3 credentials.
 */
export async function sweepVideoUploads(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<{ scanned: number; reclaimed: number }> {
  const staleBefore = now - VIDEO_UPLOAD_COMPLETION_LEASE_MS;
  const rows = await env.DB.prepare(`
    SELECT id, r2_key AS r2Key, upload_id AS uploadId, status FROM video_upload_reservations
    WHERE (status = 'pending' AND expires_at <= ?) OR status = 'aborting' OR (status = 'completing' AND completing_at <= ?)
    ORDER BY id LIMIT 100
  `).bind(now, staleBefore).all<SweepRow>();
  let reclaimed = 0;
  for (const row of rows.results) {
    if (row.status !== "aborting") {
      const claimed = await env.DB.prepare(`
        UPDATE video_upload_reservations SET status = 'aborting', updated_at = ?
        WHERE id = ? AND ((status = 'pending' AND expires_at <= ?) OR (status = 'completing' AND completing_at <= ?))
      `).bind(now, row.id, now, staleBefore).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue;
    }
    try {
      if (row.uploadId) {
        try { await env.MEDIA.resumeMultipartUpload(row.r2Key, row.uploadId).abort(); }
        catch (error) { if (!isMissingMultipartUploadError(error)) throw error; }
      }
      await env.MEDIA.delete(row.r2Key);
      const done = await env.DB.prepare("UPDATE video_upload_reservations SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'aborting'").bind(now, row.id).run();
      if ((done.meta.changes ?? 0) === 1) reclaimed += 1;
    } catch (error) {
      console.error("Video upload sweep failed", { reservationId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  return { scanned: rows.results.length, reclaimed };
}
