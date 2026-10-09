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

/**
 * A source note is already on the target Version (#741, 5c): the target holds a copy of it, holds its original, or holds a sibling copy of
 * the same original. One step of lineage, on purpose: a deeper chain (v1 to v2 to v3, then v1 to v3 again) can still duplicate. A tombstoned
 * target copy still counts (the row exists); a hard-deleted one does not. The planner's read and the INSERT both use this, so they cannot drift.
 */
export const alreadyOnTarget = (alias: string, targetParam: string): string =>
  `EXISTS (SELECT 1 FROM video_notes t WHERE t.asset_id = ${targetParam} AND (t.copied_from_note_id = ${alias}.id OR t.id = ${alias}.copied_from_note_id OR (${alias}.copied_from_note_id IS NOT NULL AND t.copied_from_note_id = ${alias}.copied_from_note_id)))`;

/** Parameter numbers, in the statement being built, of the values the paste fence reads. */
export type PasteFenceParams = { target: number; project: number; source: number; expected: number; count: number };

/**
 * The commit's whole-snapshot fence, repeated by the INSERT and by the audit statement of one batch so both stand or fall together: the Project is
 * not archived, every requested source note (skipped ones included) still has exactly the revision the preview showed, and the target and source
 * Versions are Versions of one Video in this Project. `expected` is a JSON array of `{ id, rev }`; `count` is its length.
 */
export const pasteFence = (p: PasteFenceParams): string => `${projectFence(p.project)}
    AND (SELECT COUNT(*) FROM json_each(?${p.expected}) e JOIN video_notes x ON x.id = json_extract(e.value, '$.id') AND x.project_id = ?${p.project} AND x.asset_id = ?${p.source}
         AND x.revision = json_extract(e.value, '$.rev')) = ?${p.count}
    AND EXISTS (SELECT 1 FROM video_version_meta tm JOIN assets ta ON ta.id = tm.asset_id AND ta.kind = 'video' JOIN videos tv ON tv.id = tm.video_id
         JOIN video_version_meta sm ON sm.asset_id = ?${p.source} AND sm.video_id = tm.video_id
         WHERE tm.asset_id = ?${p.target} AND tv.project_id = ?${p.project})`;

/**
 * Binds: ?1 copies JSON `[{ id, src, start, end }]` (mapped rows only), ?2 target Version, ?3 Project, ?4 source Version, ?5 user id, ?6 role,
 * ?7 source Version number, ?8 now, ?9 expected JSON `[{ id, rev }]`, ?10 its length. Body and visibility come from the source ROW, never from a bind.
 * The conflict target's WHERE repeats the partial index's predicate exactly, or SQLite refuses the upsert. A lost race inserts nothing.
 */
export const PASTE_INSERT_SQL = `INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision,
    copied_from_note_id, copied_from_version, original_author_name, original_author_role, created_at)
  SELECT json_extract(r.value, '$.id'), s.project_id, s.video_id, ?2, NULL, ?5, NULL, ?6, s.visibility, json_extract(r.value, '$.start'), json_extract(r.value, '$.end'), NULL, s.body, 1,
    s.id, ?7, COALESCE(s.original_author_name, su.name, g.display_name, 'Unknown'), COALESCE(s.original_author_role, s.author_role), ?8
  FROM json_each(?1) r JOIN video_notes s ON s.id = json_extract(r.value, '$.src')
  LEFT JOIN user su ON su.id = s.author_user_id LEFT JOIN guest_reviewers g ON g.id = s.author_guest_id
  WHERE s.project_id = ?3 AND s.asset_id = ?4 AND s.parent_id IS NULL AND s.deleted_at IS NULL AND s.revision = (SELECT json_extract(x.value, '$.rev') FROM json_each(?9) x WHERE json_extract(x.value, '$.id') = s.id)
    AND ${pasteFence({ target: 2, project: 3, source: 4, expected: 9, count: 10 })}
    AND EXISTS (SELECT 1 FROM video_version_meta tm WHERE tm.asset_id = ?2 AND tm.frame_count > json_extract(r.value, '$.start') AND (json_extract(r.value, '$.end') IS NULL OR json_extract(r.value, '$.end') <= tm.frame_count))
    AND NOT ${alreadyOnTarget("s", "?2")}
  ON CONFLICT (asset_id, copied_from_note_id) WHERE copied_from_note_id IS NOT NULL DO NOTHING`;

/**
 * Binds: ?1 audit id, ?2 actor, ?3 target Version, ?4 meta JSON, ?5 now, ?6 Project, ?7 source Version, ?8 expected JSON, ?9 its length, ?10 requested count,
 * ?11 planned copies, ?12 planned already_copied. Runs straight after the INSERT: `changes()` is that INSERT's count, so `copied` is what landed and a mapped row
 * that lost a race is counted as already_copied. It carries the same fence, so a commit that wrote nothing because the fence failed writes no audit row either.
 */
export const PASTE_AUDIT_SQL = `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
  SELECT ?1, ?2, 'video_note.paste', 'asset', ?3,
    json_set(?4, '$.copied', changes(), '$.skipped', ?10 - changes(), '$.skippedByReason.already_copied', ?12 + (?11 - changes())), ?5
  WHERE ${pasteFence({ target: 3, project: 6, source: 7, expected: 8, count: 9 })}`;
