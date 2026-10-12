import { RENDITION_VARIANT_SPEC, enqueueObjectCrcs } from "@quincy/shared";
import { CRC_STALE_MS } from "./object-crc";
import type { Env } from "./env";

/**
 * The hourly object CRC sweep (#802): backfill, and the repair path for a lost send or a run that went quiet. It queues the CRC job for every original a zip route can include that has no stored CRC
 * and no live work row. Eligible, as the three zip routes include them (`selected-raw.zip` and `download-selection` in `routes/projects.ts`, Download all in `guest/download.ts`): photos in a RAW
 * collection, photos in an Edited collection once published (`ready`), video Versions with a live Release whose Version and Video are not in Trash, and the photos of a Client Delivery page's current set (original and `delivery_web`). Superseded photos are not offered by Download
 * Selection, so they are left out, except a superseded RAW that is still selected for editing, which `selected-raw.zip` includes. A `failed` work row is skipped for good, and a queued or running row is live until it has been quiet for ten minutes, and then a start message claims it (the sweep never changes an existing row).
 */
export const OBJECT_CRC_SWEEP_LIMIT = 500;
/** D1 statements per `batch`. */
const WORK_ROW_BATCH = 100;

// The Client Delivery photo zips (#787 slice 7): every photo in a page's CURRENT set (locked and superseded members included: an Unlock needs no second wait, and a published set never changes), as its original (Full-res)
// and as its current-spec `delivery_web` rendition (Web-size). A page that is switched off still counts. The spec is a constant of ours, never user input.
const DELIVERY_SET_PHOTOS = `FROM delivery_pages dp JOIN delivery_sets ds ON ds.project_id = dp.project_id AND ds.set_number = dp.latest_set_number
    JOIN delivery_set_items di ON di.set_id = ds.id JOIN assets a ON a.id = di.asset_id AND a.kind = 'photo'`;
const ELIGIBLE = `
  SELECT a.r2_key AS r2_key, a.created_at AS at FROM assets a JOIN collections c ON c.id = a.collection_id
    WHERE a.kind = 'photo' AND a.superseded_at IS NULL AND (c.kind = 'raw' OR (c.kind = 'edited' AND a.publish_status = 'ready'))
  UNION ALL
  SELECT a.r2_key, a.created_at FROM assets a JOIN collections c ON c.id = a.collection_id AND c.kind = 'raw' JOIN selections s ON s.asset_id = a.id AND s.state = 'selected_for_editing'
  UNION ALL
  SELECT a.r2_key, a.created_at FROM assets a JOIN video_releases r ON r.asset_id = a.id AND r.withdrawn_at IS NULL
    JOIN video_version_meta m ON m.asset_id = a.id AND m.removed_at IS NULL JOIN videos v ON v.id = m.video_id AND v.removed_at IS NULL
    WHERE a.kind = 'video'
  UNION ALL
  SELECT a.r2_key, a.created_at ${DELIVERY_SET_PHOTOS}
  UNION ALL
  SELECT r.r2_key, a.created_at ${DELIVERY_SET_PHOTOS} JOIN asset_renditions r ON r.asset_id = a.id AND r.variant = 'delivery_web' AND r.spec_version = '${RENDITION_VARIANT_SPEC.delivery_web}'`;

export async function sweepObjectCrcs(env: Pick<Env, "DB" | "OBJECT_CRC_QUEUE">, now: number, limit = OBJECT_CRC_SWEEP_LIMIT): Promise<{ candidates: number; queued: number }> {
  // Keys nobody has a row for come first (newest first), then rows a start can claim: never begun, or quiet for ten minutes (oldest quiet first). A live or failed row is not a candidate.
  const found = await env.DB.prepare(`SELECT e.r2_key AS r2_key, MAX(w.r2_key IS NULL) AS is_new FROM (${ELIGIBLE}) e LEFT JOIN object_crc32_work w ON w.r2_key = e.r2_key
      WHERE NOT EXISTS (SELECT 1 FROM object_crc32 x WHERE x.r2_key = e.r2_key)
        AND (w.r2_key IS NULL OR (w.state != 'failed' AND ((w.state = 'queued' AND w.etag IS NULL) OR w.updated_at <= ?1)))
      GROUP BY e.r2_key ORDER BY is_new DESC, CASE WHEN MAX(w.r2_key IS NULL) = 1 THEN -MAX(e.at) ELSE MAX(w.updated_at) END, e.r2_key LIMIT ?2`).bind(now - CRC_STALE_MS, limit).all<{ r2_key: string; is_new: number }>();
  const fresh = found.results.filter((row) => row.is_new === 1).map((row) => row.r2_key); const existing = found.results.filter((row) => row.is_new !== 1).map((row) => row.r2_key);
  // The sweep only ever INSERTs, and never over a row that exists: it cannot undo a delivery that claimed one a moment ago. An existing row is recovered by the start message's own atomic claim.
  const send = [...existing];
  for (let at = 0; at < fresh.length; at += WORK_ROW_BATCH) {
    const chunk = fresh.slice(at, at + WORK_ROW_BATCH);
    const results = await env.DB.batch(chunk.map((key) => env.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?1, 'queued', 0, ?2, ?2) ON CONFLICT(r2_key) DO NOTHING`).bind(key, now)));
    chunk.forEach((key, index) => { if (results[index]!.meta.changes === 1) send.push(key); });
  }
  return { candidates: found.results.length, queued: await enqueueObjectCrcs(env, send, "object-crc-sweep") };
}
