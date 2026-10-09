/**
 * SQL fragments for `video_notes` writes (#741, 5a). 0068 has no cross-row CHECK and the project forbids triggers in migrations,
 * so a reply takes its visibility, Project, Video and Version from the ROOT ROW inside the INSERT ... SELECT. Any future writer of
 * `video_notes` (5c paste, 13 guest notes) reuses this shape: visibility is never a bind on a reply.
 */

/** The Project is not archived. `?1`-style numbered parameter `n` is the Project id. */
export const projectFence = (n: number): string => `EXISTS (SELECT 1 FROM projects p WHERE p.id = ?${n} AND p.archived_at IS NULL)`;

/** A Version (one video-kind Asset with its probed meta) joined to its Video. */
export const VERSION_FROM = "video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id";

/** Binds: ?1 reply id, ?2 user id, ?3 role, ?4 body, ?5 now, ?6 parent id, ?7 Project id, ?8 audit id. Note: no visibility bind. */
export const REPLY_INSERT_SQL = `INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision, created_at)
  SELECT ?1, p.project_id, p.video_id, p.asset_id, p.id, ?2, NULL, ?3, p.visibility, NULL, NULL, NULL, ?4, 1, ?5
  FROM video_notes p WHERE p.id = ?6 AND p.project_id = ?7 AND p.parent_id IS NULL AND p.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?8)`;
