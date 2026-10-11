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


const keysOf = (row: Pick<SweepRow, "originalKey" | "displayKey" | "posterKey">) => [row.originalKey, row.displayKey, row.posterKey].filter((key): key is string => Boolean(key));
const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 160) : "unknown");

/** Upsert shape shared with the app worker's `enqueueEmbeddedMediaCleanup`: a key already queued keeps its row and gains an upload id it lacked. */
/** How long a sweep's claim on a queue entry holds before another sweep may take it over. */
const CLEANUP_LEASE_MS = 10 * 60 * 1000;

export const ENQUEUE_SQL = `
  INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
`;

/**
 * Reclaims embedded media nobody owns (#493): media edited out of a post a week ago or longer (a deleted
 * post's media is detached at 0, so due now), and media uploaded but never posted. An attached row is never
 * touched. At most 100 rows a run.
 *
 * - An expired uploading row may still have a multipart upload that a late completion could finish, so the sweep never
 *   deletes its objects itself. One batch moves its keys and upload id to `embedded_media_cleanup` and deletes the row (under the same
 *   expiry predicate the read used, so a promotion that won the race skips it). Late completions then find no row and clean up or queue what they wrote.
 * - A pending or detached row is claimed first (flipped to detached at 0, which no API attach statement accepts), then its objects go, then the row.
 *   If R2 refuses the delete, the keys are queued before the row is dropped, so the object never loses its owner.
 * - The queue is then drained: abort the upload (a missing upload counts as terminal), delete the object, delete the entry. A failure
 *   keeps the entry and counts an attempt, so the next run retries.
 */
export async function sweepEmbeddedMedia(env: Pick<Env, "DB" | "MEDIA">, now = Date.now()): Promise<{ scanned: number; reclaimed: number; failed: number; drained: number }> {
  const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
  const rows = await env.DB.prepare(`
    SELECT id, state, original_key AS originalKey, display_key AS displayKey, poster_key AS posterKey, upload_id AS uploadId, project_id AS projectId
    FROM embedded_media
    WHERE (state = 'detached' AND detached_at <= ?) OR (state IN ('uploading', 'pending') AND created_at <= ?)
    ORDER BY id LIMIT ?
  `).bind(cutoff, cutoff, SWEEP_LIMIT).all<SweepRow & { projectId: string | null }>();
  let reclaimed = 0; let failed = 0;
  for (const row of rows.results) {
    try {
      if (row.state === "uploading") {
        // Queue and delete in one batch. Both statements carry the expiry predicate, so they act together or not at all.
        const predicate = "id = ? AND state = 'uploading' AND created_at <= ?";
        const statements = [
          env.DB.prepare(`${ENQUEUE_SQL.replace("VALUES (?, ?, ?, ?)", `SELECT original_key, upload_id, project_id, ? FROM embedded_media WHERE ${predicate}`)}`).bind(now, row.id, cutoff),
          ...[row.displayKey, row.posterKey].filter((key): key is string => Boolean(key)).map((key) => env.DB.prepare(ENQUEUE_SQL.replace("VALUES (?, ?, ?, ?)", `SELECT ?, NULL, project_id, ? FROM embedded_media WHERE ${predicate}`)).bind(key, now, row.id, cutoff)),
          env.DB.prepare(`DELETE FROM embedded_media WHERE ${predicate}`).bind(row.id, cutoff),
        ];
        const results = await env.DB.batch(statements);
        if ((results[results.length - 1]!.meta.changes ?? 0) === 1) reclaimed += 1;
        continue;
      }
      // Claim first: flip the row into 'detached' at 0 (due now; an unowned row takes its own id as owner, which the table's CHECK requires and no comment can match), with the same expiry predicate the read used. Every attach
      // predicate in the API needs 'pending' or an owner and a fresh timestamp, so a claimed row can no longer be attached. A lost claim
      // means the row changed under us (attached, or already taken): skip it.
      // RETURNING hands back the keys the row owns at the moment of the claim, not the ones the read saw: a poster written between the two
      // (a video upload's poster PUT) is deleted too, and one written after it finds the row no longer 'pending' and queues its own key.
      const claim = await env.DB.prepare(`
        UPDATE embedded_media SET state = 'detached', detached_at = 0, owner_id = COALESCE(owner_id, id), updated_at = ?
        WHERE id = ? AND ((state = 'detached' AND detached_at <= ?) OR (state = 'pending' AND created_at <= ?))
        RETURNING original_key AS originalKey, display_key AS displayKey, poster_key AS posterKey
      `).bind(now, row.id, cutoff, cutoff).all<Pick<SweepRow, "originalKey" | "displayKey" | "posterKey">>();
      const claimed = claim.results[0];
      if (!claimed) continue;
      const claimedKeys = keysOf(claimed);
      try { await env.MEDIA.delete(claimedKeys); }
      catch (error) {
        console.error("Embedded media object delete failed, queued for cleanup", { mediaId: row.id, error: errorText(error) });
        await env.DB.batch(claimedKeys.map((key) => env.DB.prepare(ENQUEUE_SQL).bind(key, null, row.projectId, now)));
      }
      const deleted = await env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'detached' AND detached_at = 0").bind(row.id).run();
      if ((deleted.meta.changes ?? 0) === 1) reclaimed += 1;
    } catch (error) {
      failed += 1;
      console.error("Embedded media sweep failed", { mediaId: row.id, error: errorText(error) });
    }
  }
  // A link preview nobody saved in a post (#497) goes at the same age. Its image is an ordinary pending row, reclaimed above or on a later run.
  await env.DB.prepare("DELETE FROM link_previews WHERE owner_id IS NULL AND created_at <= ?").bind(cutoff).run();
  // The attempts behind the hourly limit (#497) are only needed for that hour, so a day is a wide margin.
  await env.DB.prepare("DELETE FROM link_preview_attempts WHERE created_at <= ?").bind(now - 24 * 60 * 60 * 1000).run();
  return { scanned: rows.results.length, reclaimed, failed, drained: await drainCleanupQueue(env, now) };
}

/**
 * Works through up to 100 queued keys under a lease (#494). An entry is claimed by setting `claimed_until` to now plus the lease and
 * adding 1 to `attempts`, and is NEVER deleted before its cleanup succeeded: a failure at any step leaves it in the table, so ownership
 * of the object is durable. The claim is conditional on the entry being unleased or its lease past, so concurrent sweeps cannot both take
 * it. The claim's identity is the (attempts, queued_at) it returns, and every later statement of this sweep (the dequeue and the release)
 * is fenced on both: a later claim moves `attempts` and a re-queue moves `queued_at`, so a stalled sweep can never remove or alter an
 * entry that is no longer its own, even if two sweeps share a scheduled `now`.
 * A claim permanently invalidates poster adoption of the key: release sets `claimed_until` to 0 (claimed before, lease over), never back
 * to NULL, so it stays reclaimable (0 is below any now) while the adoption, which needs NULL, can never win after any claim. Only a
 * re-queue (for an object the route has given up on) resets it to NULL.
 */
async function drainCleanupQueue(env: Pick<Env, "DB" | "MEDIA">, now: number): Promise<number> {
  const queue = await env.DB.prepare("SELECT storage_key AS storageKey FROM embedded_media_cleanup WHERE claimed_until IS NULL OR claimed_until < ? ORDER BY queued_at, storage_key LIMIT ?").bind(now, SWEEP_LIMIT).all<{ storageKey: string }>();
  let drained = 0;
  for (const { storageKey } of queue.results) {
    try {
      const claim = await env.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ?, attempts = attempts + 1 WHERE storage_key = ? AND (claimed_until IS NULL OR claimed_until < ?) RETURNING upload_id AS uploadId, attempts, queued_at AS queuedAt")
        .bind(now + CLEANUP_LEASE_MS, storageKey, now).all<{ uploadId: string | null; attempts: number; queuedAt: number }>();
      const claimed = claim.results[0];
      if (!claimed) continue;
      // #776: a key a live Video Version still holds is never deleted. A purge enqueues a key only in the batch that deletes its row, so this is the
      // second fence behind it: a stale or mis-queued entry for restored media is dropped here, with its object kept. Fenced like every other dequeue.
      if (await holdsLiveVideoKey(env.DB, storageKey)) {
        await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND attempts = ? AND queued_at = ?").bind(storageKey, claimed.attempts, claimed.queuedAt).run();
        continue;
      }
      const release = async (error: unknown, step: string) => {
        console.error(`Embedded media cleanup ${step} failed`, { key: storageKey, error: errorText(error) });
        try { await env.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = 0 WHERE storage_key = ? AND attempts = ? AND queued_at = ?").bind(storageKey, claimed.attempts, claimed.queuedAt).run(); }
        catch (releaseError) { console.error("Embedded media cleanup lease release failed, it expires on its own", { key: storageKey, error: errorText(releaseError) }); }
      };
      if (claimed.uploadId) {
        try { await env.MEDIA.resumeMultipartUpload(storageKey, claimed.uploadId).abort(); }
        catch (error) { if (!isMissingUpload(error)) { await release(error, "abort"); continue; } }
      }
      try { await env.MEDIA.delete(storageKey); }
      catch (error) { await release(error, "delete"); continue; }
      const dequeued = await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND attempts = ? AND queued_at = ?").bind(storageKey, claimed.attempts, claimed.queuedAt).run();
      if ((dequeued.meta.changes ?? 0) === 1) drained += 1;
    } catch (error) { console.error("Embedded media cleanup failed", { key: storageKey, error: errorText(error) }); }
  }
  return drained;
}

/** True when a Version that is neither in Trash nor under a Video in Trash holds this object key as its original or its poster. */
async function holdsLiveVideoKey(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS held FROM video_version_meta m
    JOIN assets a ON a.id = m.asset_id
    JOIN videos v ON v.id = m.video_id
    WHERE m.removed_at IS NULL AND v.removed_at IS NULL AND (a.r2_key = ?1 OR m.poster_key = ?1)
    LIMIT 1
  `).bind(key).first();
  return row !== null;
}
