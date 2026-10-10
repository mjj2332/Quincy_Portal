import type { Env } from "./env";
import { ENQUEUE_SQL } from "./embedded-media-sweep";

/** Items a run purges at most (#776 D): the oldest due first, so a backlog drains over several hours. */
export const VIDEO_TRASH_PURGE_LIMIT = 25;

type DueItem = { kind: "version" | "video"; id: string; videoId: string; projectId: string };

/** A terminal reservation can be dropped with its Version; a live one (pending, completing, aborting) still owns an object the upload sweep reclaims. */
const TERMINAL = "('completed', 'rejected', 'expired', 'failed')";

/** The object key `${key}` is held by a Version that is neither in Trash nor under a Video in Trash. Such a key is never queued for deletion. */
const notLiveKey = (key: string) => `NOT EXISTS (
  SELECT 1 FROM assets la JOIN video_version_meta lm ON lm.asset_id = la.id JOIN videos lv ON lv.id = lm.video_id
  WHERE lm.removed_at IS NULL AND lv.removed_at IS NULL AND (la.r2_key = ${key} OR lm.poster_key = ${key}))`;

/** `INSERT ... SELECT` form of the shared cleanup upsert: a key already queued keeps its row, as the embedded-media paths do. */
const enqueue = (select: string) => ENQUEUE_SQL.replace("VALUES (?, ?, ?, ?)", select);

const auditMeta = (item: DueItem, extra: Record<string, unknown> = {}) => JSON.stringify({ projectId: item.projectId, videoId: item.videoId, system: "video_trash_purge", ...extra });

/**
 * Purges what has sat in Video Trash past its frozen `purge_at` (#776 D), from the hourly cron. It ignores feature flags and archive state: retention is retention.
 *
 * Each item is ONE D1 batch, so a restore racing the purge is decided atomically by the fence every statement repeats (`removed_at IS NOT NULL AND purge_at <= now`):
 *   1. queue the original and the poster in `embedded_media_cleanup` (the R2 delete queue the embedded-media sweep drains), gated on no live Version holding the key;
 *   2. delete the Asset row(s), which cascades meta, notes, markup, grants, approval events, Releases and guest digest rows;
 *   3. write the audit row with a NULL actor, immediately after the delete so `changes()` is that delete's;
 *   4. clear the no-FK columns (self-references on surviving Assets, terminal upload reservations).
 * A Video does the same over every Asset of its `version_group_id` (Assets have no FK to Videos), then deletes the `videos` row. If the restore wins, the first statement queues
 * nothing and the delete matches nothing, so the rows and the keys survive. No R2 call happens here: the daily drain deletes the objects, re-checking that no live Version holds the key.
 *
 * Collection counts are not recomputed: a removed Version is superseded and a removed Video has no current Version (the invariant slice B keeps), so a purge never changes
 * the `superseded_at IS NULL` count `COLLECTION_RECEIVED_COUNT_SQL` reads.
 */
export async function purgeVideoTrash(env: Pick<Env, "DB">, now = Date.now()): Promise<{ scanned: number; purged: number; failed: number }> {
  const due = await env.DB.prepare(`
    SELECT kind, id, videoId, projectId FROM (
      SELECT 'version' AS kind, m.asset_id AS id, m.video_id AS videoId, v.project_id AS projectId, m.purge_at AS purgeAt
        FROM video_version_meta m JOIN videos v ON v.id = m.video_id
        WHERE m.removed_at IS NOT NULL AND m.purge_at <= ?1
      UNION ALL
      SELECT 'video', v.id, v.id, v.project_id, v.purge_at
        FROM videos v WHERE v.removed_at IS NOT NULL AND v.purge_at <= ?1
    ) ORDER BY purgeAt, id LIMIT ?2
  `).bind(now, VIDEO_TRASH_PURGE_LIMIT).all<DueItem>();
  let purged = 0; let failed = 0;
  for (const item of due.results) {
    try {
      const results = await env.DB.batch(item.kind === "version" ? versionStatements(env.DB, item, now) : videoStatements(env.DB, item, now));
      // The audit row is the statement after the delete that decided the race, so its change count says who won.
      const audit = results[item.kind === "version" ? 3 : 4]!;
      if ((audit.meta.changes ?? 0) === 1) purged += 1;
    } catch (error) {
      failed += 1;
      console.error("Video Trash purge failed", { kind: item.kind, id: item.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  return { scanned: due.results.length, purged, failed };
}

function versionStatements(db: D1Database, item: DueItem, now: number): D1PreparedStatement[] {
  const fence = "m.asset_id = ?2 AND m.removed_at IS NOT NULL AND m.purge_at <= ?3";
  const from = "FROM video_version_meta m JOIN assets a ON a.id = m.asset_id JOIN videos v ON v.id = m.video_id";
  return [
    db.prepare(enqueue(`SELECT a.r2_key, NULL, v.project_id, ?1 ${from} WHERE ${fence} AND a.kind = 'video' AND ${notLiveKey("a.r2_key")}`)).bind(now, item.id, now),
    db.prepare(enqueue(`SELECT m.poster_key, NULL, v.project_id, ?1 ${from} WHERE ${fence} AND a.kind = 'video' AND m.poster_key IS NOT NULL AND ${notLiveKey("m.poster_key")}`)).bind(now, item.id, now),
    db.prepare("DELETE FROM assets WHERE id = ?1 AND kind = 'video' AND EXISTS (SELECT 1 FROM video_version_meta m WHERE m.asset_id = assets.id AND m.removed_at IS NOT NULL AND m.purge_at <= ?2)").bind(item.id, now),
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'video_version.purge', 'asset', ?, ?, ? WHERE changes() > 0")
      .bind(crypto.randomUUID(), item.id, auditMeta(item), now),
    // No FK on these: the self-references of the surviving Assets (the routes/assets.ts hard delete does the same), and the reservations that name the Version.
    db.prepare(`UPDATE assets SET
        supersedes_asset_id = CASE WHEN supersedes_asset_id = ?1 THEN NULL ELSE supersedes_asset_id END,
        replaced_by_asset_id = CASE WHEN replaced_by_asset_id = ?1 THEN NULL ELSE replaced_by_asset_id END, updated_at = ?2
      WHERE (supersedes_asset_id = ?1 OR replaced_by_asset_id = ?1) AND NOT EXISTS (SELECT 1 FROM assets WHERE id = ?1)`).bind(item.id, now),
    db.prepare("UPDATE video_upload_reservations SET supersedes_asset_id = NULL WHERE supersedes_asset_id = ?1 AND NOT EXISTS (SELECT 1 FROM assets WHERE id = ?1)").bind(item.id),
    db.prepare(`DELETE FROM video_upload_reservations WHERE asset_id = ?1 AND status IN ${TERMINAL} AND NOT EXISTS (SELECT 1 FROM assets WHERE id = ?1)`).bind(item.id),
  ];
}

function videoStatements(db: D1Database, item: DueItem, now: number): D1PreparedStatement[] {
  const fence = "v.id = ?2 AND v.removed_at IS NOT NULL AND v.purge_at <= ?3";
  const from = "FROM videos v JOIN assets a ON a.version_group_id = v.id AND a.kind = 'video'";
  return [
    db.prepare(enqueue(`SELECT a.r2_key, NULL, v.project_id, ?1 ${from} WHERE ${fence} AND ${notLiveKey("a.r2_key")}`)).bind(now, item.id, now),
    db.prepare(enqueue(`SELECT m.poster_key, NULL, v.project_id, ?1 ${from} JOIN video_version_meta m ON m.asset_id = a.id WHERE ${fence} AND m.poster_key IS NOT NULL AND ${notLiveKey("m.poster_key")}`)).bind(now, item.id, now),
    // Assets have no FK to Videos. Deleting them first takes their meta, notes, markup, grants, events, Releases and digest rows; the `videos` delete then takes the rest.
    db.prepare("DELETE FROM assets WHERE kind = 'video' AND version_group_id = ?1 AND EXISTS (SELECT 1 FROM videos v WHERE v.id = ?1 AND v.removed_at IS NOT NULL AND v.purge_at <= ?2)").bind(item.id, now),
    db.prepare("DELETE FROM videos WHERE id = ?1 AND removed_at IS NOT NULL AND purge_at <= ?2").bind(item.id, now),
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'video.purge', 'video', ?, ?, ? WHERE changes() > 0")
      .bind(crypto.randomUUID(), item.id, auditMeta(item), now),
    db.prepare("UPDATE video_upload_reservations SET supersedes_asset_id = NULL WHERE video_id = ?1 AND supersedes_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM videos WHERE id = ?1)").bind(item.id),
    db.prepare(`DELETE FROM video_upload_reservations WHERE video_id = ?1 AND status IN ${TERMINAL} AND NOT EXISTS (SELECT 1 FROM videos WHERE id = ?1)`).bind(item.id),
  ];
}
