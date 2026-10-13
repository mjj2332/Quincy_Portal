/**
 * The live-row fragments of video Trash (#776 B). A Version or a Video that is in Trash keeps its rows, its R2 objects, its notes, grants and decisions, so every read and every
 * committing write over `video_version_meta` or `videos` states that it wants the LIVE row. Nothing here can remove a row yet (slice C does); until then every row is live and
 * these predicates change no result. `video-live.guard.test.ts` fails any SQL string that names either table without one of them.
 */

import { FILM_TITLE_FALLBACK, FILM_TITLE_MAX_CODE_POINTS } from "@quincy/shared";

/** The Version is not in Trash. `metaAlias` is the alias of `video_version_meta`. */
export const LIVE_VERSION = (metaAlias: string): string => `${metaAlias}.removed_at IS NULL`;

/** The Video is not in Trash. `videoAlias` is the alias of `videos`. */
export const LIVE_VIDEO = (videoAlias: string): string => `${videoAlias}.removed_at IS NULL`;

/** Both: a live Version of a live Video. */
export const LIVE_VERSION_OF_VIDEO = (metaAlias: string, videoAlias: string): string => `${LIVE_VERSION(metaAlias)} AND ${LIVE_VIDEO(videoAlias)}`;

/** A statement-level fence: the Version `asset` (a SQL expression) is a live Version of a live Video. For a write whose own FROM does not already join both. */
export const LIVE_VERSION_EXISTS = (asset: string): string =>
  `EXISTS (SELECT 1 FROM video_version_meta lm JOIN videos lv ON lv.id = lm.video_id WHERE lm.asset_id = ${asset} AND ${LIVE_VERSION("lm")} AND ${LIVE_VIDEO("lv")})`;

/** The Video `video` (a SQL expression) is live. For a write over a table that does not join `videos` itself. */
export const LIVE_VIDEO_EXISTS = (video: string): string => `EXISTS (SELECT 1 FROM videos lv WHERE lv.id = ${video} AND ${LIVE_VIDEO("lv")})`;

/**
 * A film's title from a file name (#828): `trim()` (SQLite trims spaces only), drop one trailing `.mp4` or `.mov` of any case, trim, cut to 200 code points, trim, and "Untitled film" when nothing is left.
 * `filename` is a SQL expression, repeated several times, so pass a column or a bound parameter. `filmTitleFromFilename` in `@quincy/shared` is the TypeScript twin and the parity test holds them equal.
 * Migration 0074 repeats this text for its backfill, and a guard test holds that copy equal to this one.
 */
export const FILM_TITLE_SQL = (filename: string): string => {
  const name = `trim(${filename})`;
  const stem = `trim(CASE WHEN lower(substr(${name}, -4)) IN ('.mp4', '.mov') THEN substr(${name}, 1, length(${name}) - 4) ELSE ${name} END)`;
  return `COALESCE(NULLIF(trim(substr(${stem}, 1, ${FILM_TITLE_MAX_CODE_POINTS})), ''), '${FILM_TITLE_FALLBACK}')`;
};

/**
 * The newest LIVE Version of the Video `?1`, as an `assets.id`, or NULL when the Video is removed (or has no live Version). Binds `?1` only.
 * Newest by Version number: numbers are never reused (`videos.version_high_water`), so a higher number is always a later upload.
 */
const NEWEST_LIVE_SQL = `(SELECT na.id FROM assets na JOIN video_version_meta nm ON nm.asset_id = na.id AND nm.video_id = ?1 JOIN videos nv ON nv.id = nm.video_id
    WHERE na.kind = 'video' AND na.version_group_id = ?1 AND ${LIVE_VERSION("nm")} AND ${LIVE_VIDEO("nv")} ORDER BY na.version DESC LIMIT 1)`;

/**
 * Keeps two invariants: the film's title is its newest live Version's file name, and exactly one `superseded_at IS NULL` video asset per live Video, the newest live Version; every other video asset of the group is superseded, including every
 * asset of a removed Video. Run as a batch, in order, each bound `(videoId, now)` (`?1`, `?2`). Idempotent. Rows already superseded keep their original timestamp.
 * Upload completion, remove and restore all end with it, so the collection count, the note counts and the reserve SQL read `superseded_at` and need no live filter of their own.
 */
export const RECOMPUTE_CURRENT_SQL: readonly [string, string, string] = [
  // Supersede whatever is current and is not the newest live Version. `replaced_by_asset_id` names the newer live Version when there is one.
  `UPDATE assets SET superseded_at = ?2, updated_at = ?2,
      replaced_by_asset_id = COALESCE(replaced_by_asset_id, (SELECT na.id FROM assets na WHERE na.id = ${NEWEST_LIVE_SQL} AND na.version > assets.version))
    WHERE kind = 'video' AND version_group_id = ?1 AND superseded_at IS NULL AND id IS NOT COALESCE(${NEWEST_LIVE_SQL}, '')`,
  // Make the newest live Version current (a restore, or a removal of the former current one).
  `UPDATE assets SET superseded_at = NULL, replaced_by_asset_id = NULL, updated_at = ?2
    WHERE kind = 'video' AND version_group_id = ?1 AND superseded_at IS NOT NULL AND id = ${NEWEST_LIVE_SQL}`,
  // The film is titled by its newest live Version's file name (#828). A Video in Trash keeps its title (the live fence), and a Video with no live Version keeps it too (COALESCE).
  // `?2 IS NOT NULL` is always true: it uses the bound `now`, because D1 refuses a bound value no `?N` in the statement names. The statement ends in a WHERE, so `fencedRecompute` can append its audit fence.
  `UPDATE videos SET title = COALESCE((SELECT ${FILM_TITLE_SQL("ta.original_filename")} FROM assets ta WHERE ta.id = ${NEWEST_LIVE_SQL}), title)
    WHERE id = ?1 AND ${LIVE_VIDEO("videos")} AND ?2 IS NOT NULL
      AND title IS NOT COALESCE((SELECT ${FILM_TITLE_SQL("ta.original_filename")} FROM assets ta WHERE ta.id = ${NEWEST_LIVE_SQL}), title)`,
];

/** `RECOMPUTE_CURRENT_SQL` as prepared statements for a batch. */
export const recomputeCurrentStatements = (db: D1Database, videoId: string, now: number): D1PreparedStatement[] => RECOMPUTE_CURRENT_SQL.map((sql) => db.prepare(sql).bind(videoId, now));

/** The current-Version recompute, each statement also fenced on the mutation's audit row, so a refused fence moves no asset. */
export const fencedRecomputeStatements = (db: D1Database, videoId: string, now: number, auditId: string): D1PreparedStatement[] =>
  RECOMPUTE_CURRENT_SQL.map((sql) => db.prepare(`${sql.trimEnd()} AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`).bind(videoId, now, auditId));

/** Whether the Version is a live Version of a live Video of this Project, from a fresh read. For a handler that built its answer before a last admission (an export, a stream). */
export async function versionIsLive(db: D1Database, projectId: string, assetId: string): Promise<boolean> {
  return await db.prepare(`SELECT 1 AS ok FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?1 AND v.project_id = ?2 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`).bind(assetId, projectId).first() !== null;
}
