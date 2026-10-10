import { DEFAULT_EXPORT_START_TIMECODE, timecodeBaseFor, timecodeToFrames, type ExportContext, type ExportSourceNote } from "@quincy/shared";
import { VERSION_FROM } from "./video-notes-sql";

/**
 * The scoped read behind the NLE marker export (#741, 8): the Version's probed facts, its Video title and every note row of the Version in ONE statement, anchored on
 * the Version with LEFT JOINs so a Version with no notes still answers. Which rows export is `exportNotesFromThreads`' rule (packages/shared), not SQL's.
 */
type Row = {
  video_id: string; title: string; version: number; fps_num: number; fps_den: number; frame_count: number; width: number; height: number; start_tc_frames: number | null; tc_drop_frame: number;
  n_id: string | null; n_parent_id: string | null; n_visibility: "public" | "internal" | null; n_start: number | null; n_end: number | null; n_body: string | null;
  n_resolved_at: number | null; n_deleted_at: number | null; n_created_at: number | null; author_name: string | null; guest_name: string | null; n_has_guest: number | null;
};

export type MarkerExportSnapshot = {
  videoId: string;
  /** The Version number, for the filename and the title. */
  version: number;
  videoTitle: string;
  context: Omit<ExportContext, "includeInternal">;
  notes: ExportSourceNote[];
};

/** The Version of this Project and its notes, or null when the Asset is not a video Version of the Project. */
export async function loadMarkerExportSnapshot(db: D1Database, projectId: string, assetId: string): Promise<MarkerExportSnapshot | null> {
  const rows = (await db.prepare(
    `SELECT v.id AS video_id, v.title, a.version, m.fps_num, m.fps_den, m.frame_count, m.width, m.height, m.start_tc_frames, m.tc_drop_frame,
       n.id AS n_id, n.parent_id AS n_parent_id, n.visibility AS n_visibility, n.start_frame AS n_start, n.end_frame AS n_end, n.body AS n_body,
       n.resolved_at AS n_resolved_at, n.deleted_at AS n_deleted_at, n.created_at AS n_created_at, u.name AS author_name, g.display_name AS guest_name, (n.author_guest_id IS NOT NULL) AS n_has_guest
     FROM ${VERSION_FROM}
     LEFT JOIN video_notes n ON n.asset_id = m.asset_id AND n.project_id = v.project_id AND n.video_id = v.id
     LEFT JOIN user u ON u.id = n.author_user_id LEFT JOIN guest_reviewers g ON g.id = n.author_guest_id
     WHERE m.asset_id = ?1 AND v.project_id = ?2
     ORDER BY n.created_at, n.id`,
  ).bind(assetId, projectId).all<Row>()).results;
  const head = rows[0];
  if (!head) return null;
  const fps = { num: head.fps_num, den: head.fps_den };
  const base = timecodeBaseFor(fps, head.tc_drop_frame === 1);
  // A real source start of zero stays zero; only a missing one takes the default, calculated on this Version's own base.
  const startFrames = head.start_tc_frames ?? timecodeToFrames(DEFAULT_EXPORT_START_TIMECODE, base);
  if (startFrames === null) throw new Error("marker export: the default start timecode does not fit this timecode base");
  const notes: ExportSourceNote[] = [];
  for (const row of rows) {
    if (row.n_id === null) continue;
    notes.push({
      id: row.n_id, parentId: row.n_parent_id, authorName: row.n_has_guest === 1 ? row.guest_name ?? "Client reviewer" : row.author_name ?? "Unknown",
      body: row.n_body ?? "", startFrame: row.n_start, endFrame: row.n_end, resolved: row.n_resolved_at !== null, visibility: row.n_visibility ?? "public",
      createdAt: row.n_created_at ?? 0, deleted: row.n_deleted_at !== null,
    });
  }
  return {
    videoId: head.video_id, version: head.version, videoTitle: head.title, notes,
    context: { fps, base, startFrames, title: `${head.title} · v${head.version}`, width: head.width, height: head.height, frameCount: head.frame_count },
  };
}
