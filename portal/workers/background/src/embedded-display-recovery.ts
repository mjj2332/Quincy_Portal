import { EMBEDDED_DISPLAY_MAX_ATTEMPTS } from "@quincy/db";
import { enqueueEmbeddedDisplaySafely, renditionsEnabled } from "@quincy/shared";
import type { Env } from "./env";

/** A message can legitimately wait behind an asset backlog (the queue runs one at a time), so a row is only called lost after this long. */
export const EMBEDDED_DISPLAY_RECOVERY_AFTER_MS = 10 * 60 * 1000;
const RECOVERY_LIMIT = 10;

type StaleRow = { id: string; attempts: number; requestedAt: number; resentAt: number | null };

/**
 * Re-sends the conversion of a HEIC image whose queue message was lost (#495; queue sends fail as a group, see docs/lessons.md). Minute cron.
 * Picks at most ten `pending` rows whose last send (the request, or a later resend) is more than ten minutes old and whose lease is free or expired,
 * oldest request first. The row's generation, `rendition_requested_at`, is never written here: only complete and a Retry start a new run, so a resend
 * can never invalidate the message already in flight behind a slow queue. Resend timing lives in `rendition_resent_at`.
 * Each row is stamped by one conditional UPDATE that rechecks status, generation, the previous resend stamp and a free lease (two overlapping runs send
 * once, and a worker that claims between the SELECT and the UPDATE is left alone); only a row that UPDATE changed is re-sent, with that same generation.
 * A row past the attempt cap is failed instead. Does nothing while renditions are off: the consumer would throw on every message.
 */
export async function recoverEmbeddedRenditions(env: Pick<Env, "DB" | "RENDITIONS_ENABLED" | "RENDITION_QUEUE">, now = Date.now()): Promise<{ resent: number; failed: number }> {
  if (!renditionsEnabled(env)) return { resent: 0, failed: 0 };
  const stale = (await env.DB.prepare(`
    SELECT id, rendition_attempts AS attempts, rendition_requested_at AS requestedAt, rendition_resent_at AS resentAt FROM embedded_media
    WHERE rendition_status = 'pending' AND state IN ('pending', 'attached') AND max(rendition_requested_at, COALESCE(rendition_resent_at, 0)) < ? AND (rendition_lease_until IS NULL OR rendition_lease_until < ?)
    ORDER BY rendition_requested_at LIMIT ?
  `).bind(now - EMBEDDED_DISPLAY_RECOVERY_AFTER_MS, now, RECOVERY_LIMIT).all<StaleRow>()).results;
  let resent = 0; let failed = 0;
  for (const row of stale) {
    if (row.attempts > EMBEDDED_DISPLAY_MAX_ATTEMPTS) {
      const result = await env.DB.prepare("UPDATE embedded_media SET rendition_status = 'failed', rendition_error = 'attempts', rendition_lease_until = NULL, updated_at = ? WHERE id = ? AND rendition_status = 'pending' AND rendition_attempts = ?").bind(now, row.id, row.attempts).run();
      if ((result.meta.changes ?? 0) === 1) failed += 1;
      continue;
    }
    const stamped = await env.DB.prepare(`
      UPDATE embedded_media SET rendition_resent_at = ?
      WHERE id = ? AND rendition_status = 'pending' AND state IN ('pending', 'attached') AND rendition_requested_at = ? AND rendition_resent_at IS ?
        AND (rendition_lease_until IS NULL OR rendition_lease_until < ?)
    `).bind(now, row.id, row.requestedAt, row.resentAt, now).run();
    if ((stamped.meta.changes ?? 0) !== 1) continue;
    if (await enqueueEmbeddedDisplaySafely(env, row.id, "recovery", row.requestedAt)) resent += 1;
  }
  return { resent, failed };
}
