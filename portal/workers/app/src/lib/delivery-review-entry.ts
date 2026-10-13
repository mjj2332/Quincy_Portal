import { reviewLinkOpenSql } from "@quincy/db";
import { LIVE_VERSION, LIVE_VIDEO } from "./video-live-sql";
import { readVideoReviewGate } from "./video-review-gate";
import type { DeliveryReviewEntries } from "./delivery-dto";

/**
 * The way into review from the PUBLIC Delivery page (#847, ADR 0023): per film of the page's latest set, the relative address of the Project's Delivery review link. READ-ONLY and a leaf: it
 * imports no staff module and writes nothing (`test/delivery-public-boundary.guard.test.ts` scans it). The address carries the link's secret in the fragment and the film's Video id, which is
 * the one credential on the public page, by design; staff Preview and the staff read never call this, so they carry none.
 *
 * An entry exists only when ALL hold, read in one statement at the same moment: the guest part of the video review gate is open; the Delivery review link is open (`reviewLinkOpenSql`); the
 * film is a live member of it; the published Version is live, granted and unlocked. A locked film is never an entry (the lock check is the caller's `locked` flag as well).
 */
export async function readDeliveryReviewEntries(db: D1Database, projectId: string, now: number): Promise<DeliveryReviewEntries> {
  const gate = await readVideoReviewGate(db, projectId);
  const entries = new Map<string, { url: string }>();
  if (!gate.open || !gate.parts.includes("guest")) return entries;
  const rows = (await db.prepare(`SELECT a.id AS assetId, l.id AS linkId, l.token_secret AS secret, v.id AS videoId
      FROM client_links l
      JOIN delivery_pages dp ON dp.project_id = l.project_id
      JOIN delivery_sets ds ON ds.project_id = dp.project_id AND ds.set_number = dp.latest_set_number
      JOIN delivery_set_items di ON di.set_id = ds.id
      JOIN assets a ON a.id = di.asset_id AND a.kind = 'video'
      JOIN video_version_meta vm ON vm.asset_id = a.id AND ${LIVE_VERSION("vm")}
      JOIN videos v ON v.id = vm.video_id AND ${LIVE_VIDEO("v")}
      JOIN review_link_videos rv ON rv.link_id = l.id AND rv.video_id = v.id AND rv.removed_at IS NULL
      JOIN review_link_version_grants g ON g.link_id = l.id AND g.asset_id = a.id AND g.revoked_at IS NULL
      WHERE l.project_id = ?1 AND l.delivery_review = 1 AND l.token_secret IS NOT NULL AND ${reviewLinkOpenSql("l", "?2")}
        AND (v.premium = 0 OR EXISTS (SELECT 1 FROM video_premium_unlocks vu WHERE vu.video_id = v.id))`)
    .bind(projectId, now).all<{ assetId: string; linkId: string; secret: string; videoId: string }>()).results;
  for (const row of rows) entries.set(row.assetId, { url: `/d/review?link=${row.linkId}#t=${row.secret}&v=${row.videoId}` });
  return entries;
}
