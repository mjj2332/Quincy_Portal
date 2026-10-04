import { EMBEDDED_MEDIA_RETENTION_MS } from "@quincy/shared";
import type { Env } from "./env";

type SweepRow = {
  id: string; state: "uploading" | "pending" | "detached"; originalKey: string; displayKey: string | null; posterKey: string | null; uploadId: string | null;
};

const SWEEP_LIMIT = 100;

function isMissingUpload(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown } | null;
  if (!value || typeof value !== "object") return false;
  const text = [value.code, value.name, value.message].filter((item): item is string => typeof item === "string").join(" ");
  return value.status === 404 || /NoSuchUpload|no such upload|upload (?:does not exist|was not found)|multipart upload (?:does not exist|not found)|already aborted/i.test(text);
}

/**
 * Reclaims embedded media nobody owns (#493): media edited out of a post a week ago or longer (a deleted
 * post's media is detached at 0, so due now), and media uploaded but never posted. An attached row is never
 * touched. Objects go first and the row is then deleted only if it is still in the state read, so a failed
 * R2 delete keeps the row for the next run and a row that changed state in between is left alone. The attach
 * and re-attach statements in the API carry the same seven-day boundary, so a row the sweep takes can no
 * longer be attached. At most 100 rows a run.
 */
export async function sweepEmbeddedMedia(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<{ scanned: number; reclaimed: number; failed: number }> {
  const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
  const rows = await env.DB.prepare(`
    SELECT id, state, original_key AS originalKey, display_key AS displayKey, poster_key AS posterKey, upload_id AS uploadId
    FROM embedded_media
    WHERE (state = 'detached' AND detached_at <= ?) OR (state IN ('uploading', 'pending') AND created_at <= ?)
    ORDER BY id LIMIT ?
  `).bind(cutoff, cutoff, SWEEP_LIMIT).all<SweepRow>();
  let reclaimed = 0; let failed = 0;
  for (const row of rows.results) {
    try {
      if (row.state === "uploading" && row.uploadId) {
        // Best effort: R2 aborts a stale multipart upload by itself after seven days.
        try { await env.MEDIA.resumeMultipartUpload(row.originalKey, row.uploadId).abort(); }
        catch (error) { if (!isMissingUpload(error)) console.error("Embedded media multipart abort failed", { mediaId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }); }
      }
      await env.MEDIA.delete([row.originalKey, row.displayKey, row.posterKey].filter((key): key is string => Boolean(key)));
      const deleted = await env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = ?").bind(row.id, row.state).run();
      if ((deleted.meta.changes ?? 0) === 1) reclaimed += 1;
    } catch (error) {
      failed += 1;
      console.error("Embedded media sweep failed", { mediaId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  return { scanned: rows.results.length, reclaimed, failed };
}
