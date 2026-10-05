import { EMBEDDED_DISPLAY_MAX_ATTEMPTS } from "@quincy/db";
import { enqueueEmbeddedDisplaySafely, renditionsEnabled } from "@quincy/shared";
import type { Env } from "./env";

/** A message can legitimately wait behind an asset backlog (the queue runs one at a time), so a row is only called lost after this long. */
export const EMBEDDED_DISPLAY_RECOVERY_AFTER_MS = 10 * 60 * 1000;
const RECOVERY_LIMIT = 10;

type StaleRow = { id: string; attempts: number; requestedAt: number };

/**
 * Re-sends the conversion of a HEIC image whose queue message was lost (#495; queue sends fail as a group, see docs/lessons.md). Minute cron.
 * Picks at most ten `pending` rows requested more than ten minutes ago whose lease is free or expired, in the order they were requested.
 * Each is claimed with a compare-and-set on `rendition_requested_at` (two overlapping runs send once), then sent. A row past the attempt
 * cap is failed instead. Does nothing while renditions are off: the consumer would throw on every message.
 */
export async function recoverEmbeddedRenditions(env: Pick<Env, "DB" | "RENDITIONS_ENABLED" | "RENDITION_QUEUE">, now = Date.now()): Promise<{ resent: number; failed: number }> {
  if (!renditionsEnabled(env)) return { resent: 0, failed: 0 };
  const stale = (await env.DB.prepare(`
    SELECT id, rendition_attempts AS attempts, rendition_requested_at AS requestedAt FROM embedded_media
    WHERE rendition_status = 'pending' AND state IN ('pending', 'attached') AND rendition_requested_at < ? AND (rendition_lease_until IS NULL OR rendition_lease_until < ?)
    ORDER BY rendition_requested_at LIMIT ?
  `).bind(now - EMBEDDED_DISPLAY_RECOVERY_AFTER_MS, now, RECOVERY_LIMIT).all<StaleRow>()).results;
  let resent = 0; let failed = 0;
  for (const row of stale) {
    if (row.attempts > EMBEDDED_DISPLAY_MAX_ATTEMPTS) {
      const result = await env.DB.prepare("UPDATE embedded_media SET rendition_status = 'failed', rendition_error = 'attempts', rendition_lease_until = NULL, updated_at = ? WHERE id = ? AND rendition_status = 'pending' AND rendition_attempts = ?").bind(now, row.id, row.attempts).run();
      if ((result.meta.changes ?? 0) === 1) failed += 1;
      continue;
    }
    const claimed = await env.DB.prepare("UPDATE embedded_media SET rendition_requested_at = ? WHERE id = ? AND rendition_status = 'pending' AND rendition_requested_at = ?").bind(now, row.id, row.requestedAt).run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    if (await enqueueEmbeddedDisplaySafely(env, row.id, "recovery", now)) resent += 1;
  }
  return { resent, failed };
}
