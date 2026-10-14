import { videoVersionSummariesResponseSchema, type VideoVersionSummariesResponse } from "@quincy/shared";
import { LIVE_VERSION, LIVE_VIDEO } from "./video-live-sql";

/** The open-root-note rule shared with `loadVideoDtos` and the guest list: a tombstone that kept replies counts, an empty one does not, a resolved one does not. */
const OPEN_ROOT = `n.parent_id IS NULL AND n.resolved_at IS NULL AND (n.deleted_at IS NULL OR EXISTS (SELECT 1 FROM video_notes r WHERE r.parent_id = n.id))`;

type Row = { asset_id: string; version: number; created_at: number; open_count: number | null };

/** Staff: every LIVE Version of one Video, newest first, with its open root notes of both visibilities (`null` when the notes part is off). Null when the Video is not a live Video of the Project. */
export async function loadStaffVersionSummaries(db: D1Database, projectId: string, videoId: string, withCounts: boolean): Promise<VideoVersionSummariesResponse | null> {
  const video = await db.prepare(`SELECT v.id FROM videos v WHERE v.id = ?1 AND v.project_id = ?2 AND ${LIVE_VIDEO("v")}`).bind(videoId, projectId).first();
  if (!video) return null;
  const rows = (await db.prepare(`SELECT a.id AS asset_id, a.version, m.created_at,
      (SELECT COUNT(*) FROM video_notes n WHERE n.asset_id = a.id AND ${OPEN_ROOT}) AS open_count
    FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
    WHERE m.video_id = ?1 AND ${LIVE_VERSION("m")} ORDER BY a.version DESC`).bind(videoId).all<Row>()).results;
  return videoVersionSummariesResponseSchema.parse({ versions: rows.map((row) => ({ assetId: row.asset_id, version: row.version, createdAt: new Date(row.created_at).toISOString(), openNoteCount: withCounts ? row.open_count : null })) });
}

/** Guest: only the Versions this link has a live grant on, through a live member Video, counting PUBLIC open roots. Null when the Video is not a live member of the link. */
export async function loadGuestVersionSummaries(db: D1Database, linkId: string, projectId: string, videoId: string): Promise<VideoVersionSummariesResponse | null> {
  const member = await db.prepare(`SELECT v.id FROM review_link_videos rv JOIN videos v ON v.id = rv.video_id AND v.project_id = ?3 AND ${LIVE_VIDEO("v")} WHERE rv.link_id = ?1 AND rv.video_id = ?2 AND rv.removed_at IS NULL`).bind(linkId, videoId, projectId).first();
  if (!member) return null;
  const rows = (await db.prepare(`SELECT a.id AS asset_id, a.version, m.created_at,
      (SELECT COUNT(*) FROM video_notes n WHERE n.asset_id = a.id AND n.visibility = 'public' AND ${OPEN_ROOT}) AS open_count
    FROM review_link_version_grants g JOIN assets a ON a.id = g.asset_id AND a.kind = 'video' JOIN video_version_meta m ON m.asset_id = a.id AND m.video_id = g.video_id AND ${LIVE_VERSION("m")}
    WHERE g.link_id = ?1 AND g.video_id = ?2 AND g.revoked_at IS NULL ORDER BY a.version DESC`).bind(linkId, videoId).all<Row>()).results;
  return videoVersionSummariesResponseSchema.parse({ versions: rows.map((row) => ({ assetId: row.asset_id, version: row.version, createdAt: new Date(row.created_at).toISOString(), openNoteCount: row.open_count ?? 0 })) });
}
