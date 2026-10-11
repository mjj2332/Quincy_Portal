import { enqueueObjectCrcs } from "@quincy/shared";
import { CRC_STALE_MS } from "./object-crc";
import type { Env } from "./env";

/**
 * The hourly object CRC sweep (#802): backfill, and the repair path for a lost send or a run that went quiet. It queues the CRC job for every original a zip route can include that has no stored CRC
 * and no live work row. Eligible, as the three zip routes include them (`selected-raw.zip` and `download-selection` in `routes/projects.ts`, Download all in `guest/download.ts`): photos in a RAW
 * collection, photos in an Edited collection once published (`ready`), and video Versions with a live Release whose Version and Video are not in Trash. Superseded photos are not offered by Download
 * Selection, so they are left out. A `failed` work row is skipped for good, and a queued or running row is live until it has been quiet for ten minutes.
 */
export const OBJECT_CRC_SWEEP_LIMIT = 500;
/** D1 statements per `batch`. */
const WORK_ROW_BATCH = 100;

const ELIGIBLE = `
  SELECT a.r2_key AS r2_key, a.created_at AS at FROM assets a JOIN collections c ON c.id = a.collection_id
    WHERE a.kind = 'photo' AND a.superseded_at IS NULL AND (c.kind = 'raw' OR (c.kind = 'edited' AND a.publish_status = 'ready'))
  UNION ALL
  SELECT a.r2_key, a.created_at FROM assets a JOIN video_releases r ON r.asset_id = a.id AND r.withdrawn_at IS NULL
    JOIN video_version_meta m ON m.asset_id = a.id AND m.removed_at IS NULL JOIN videos v ON v.id = m.video_id AND v.removed_at IS NULL
    WHERE a.kind = 'video'`;

export async function sweepObjectCrcs(env: Pick<Env, "DB" | "OBJECT_CRC_QUEUE">, now: number, limit = OBJECT_CRC_SWEEP_LIMIT): Promise<{ candidates: number; queued: number }> {
  const found = await env.DB.prepare(`SELECT e.r2_key AS r2_key FROM (${ELIGIBLE}) e
      WHERE NOT EXISTS (SELECT 1 FROM object_crc32 x WHERE x.r2_key = e.r2_key)
        AND NOT EXISTS (SELECT 1 FROM object_crc32_work w WHERE w.r2_key = e.r2_key AND (w.state = 'failed' OR w.updated_at > ?1))
      GROUP BY e.r2_key ORDER BY MAX(e.at) DESC, e.r2_key LIMIT ?2`).bind(now - CRC_STALE_MS, limit).all<{ r2_key: string }>();
  const keys = found.results.map((row) => row.r2_key);
  // The work rows first, so a download that asks "is it being worked on?" sees the answer yes as soon as the send is made. A row gone quiet is handed back as queued, keeping its progress, so the start message can claim it.
  for (let at = 0; at < keys.length; at += WORK_ROW_BATCH) {
    await env.DB.batch(keys.slice(at, at + WORK_ROW_BATCH).map((key) => env.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?1, 'queued', 0, ?2, ?2)
      ON CONFLICT(r2_key) DO UPDATE SET state = 'queued', updated_at = excluded.updated_at WHERE object_crc32_work.state != 'failed'`).bind(key, now)));
  }
  return { candidates: keys.length, queued: await enqueueObjectCrcs(env, keys, "object-crc-sweep") };
}
