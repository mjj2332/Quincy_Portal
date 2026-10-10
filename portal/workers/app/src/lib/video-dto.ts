import { ROLE_LABELS, videoDtoSchema, type Role, type VideoDto } from "@quincy/shared";
import { LIVE_VERSION, LIVE_VIDEO } from "./video-live-sql";

/**
 * The one place a Video row becomes a `VideoDto` (#741 4b and 4c): the list route reads every Video of a Project, the upload completion reads the one it
 * just finished, and both get the same bytes. Three reads in one batch: the Videos, their Versions joined to the probed meta and the uploader, and the
 * upload in flight. The DTO never carries an object key, only the `/media/video/:assetId` addresses a Version is played from.
 */
type VideoRow = { id: string; title: string; premium: number; premium_unlocked: number; position: number; created_at: number };
type VersionRow = {
  asset_id: string; video_id: string; version: number; superseded_at: number | null; original_filename: string; bytes: number; created_at: number;
  fps_num: number; fps_den: number; frame_count: number; duration_ms: number; width: number; height: number; codec: "avc1" | "avc3";
  start_tc_frames: number | null; tc_nominal_fps: number; tc_drop_frame: number; fast_start: number; has_audio: number; poster_key: string | null;
  user_id: string; user_name: string; user_role: Role; user_active: number;
};
type UploadingRow = { reservation_id: string; video_id: string; version: number; expires_at: number; user_id: string; user_name: string; user_role: Role; user_active: number };
const person = (id: string, name: string, role: Role, active: number) => ({ id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) });

/**
 * Every Video of a Project (or only `videoId`), Versions newest first. `withNoteCounts` is the `notes` gate part: on, one grouped query counts the open
 * root notes of each current Version (a tombstone that kept replies counts, an empty one does not: the panel's `noteCounts().totals.open`); off, the
 * query is not run and every `latestNoteCount` is null.
 */
export async function loadVideoDtos(db: D1Database, projectId: string, videoId: string | undefined, withNoteCounts: boolean): Promise<VideoDto[]> {
  const only = videoId === undefined ? "" : " AND v.id = ?2";
  const bindScoped = <T extends D1PreparedStatement>(statement: T, ...rest: unknown[]) => (videoId === undefined ? statement.bind(projectId, ...rest) : statement.bind(projectId, videoId, ...rest));
  // With a Video the second parameter is its id and any later one shifts by one, so number them explicitly.
  const countStatement = withNoteCounts ? [bindScoped(db.prepare(
    `SELECT n.asset_id, COUNT(*) AS open_count
     FROM video_notes n JOIN videos v ON v.id = n.video_id AND v.project_id = n.project_id AND ${LIVE_VIDEO("v")} JOIN assets a ON a.id = n.asset_id AND a.kind = 'video'
     WHERE n.project_id = ?1${only} AND a.superseded_at IS NULL AND n.parent_id IS NULL AND n.resolved_at IS NULL
       AND (n.deleted_at IS NULL OR EXISTS (SELECT 1 FROM video_notes r WHERE r.parent_id = n.id))
     GROUP BY n.asset_id`))] : [];
  const [videoResult, versionResult, uploadingResult, countResult] = await db.batch([
    bindScoped(db.prepare(`SELECT v.id, v.title, v.premium, (p.video_id IS NOT NULL) AS premium_unlocked, v.position, v.created_at FROM videos v LEFT JOIN video_premium_unlocks p ON p.video_id = v.id WHERE v.project_id = ?1 AND ${LIVE_VIDEO("v")}${only} ORDER BY v.position, v.created_at, v.id`)),
    bindScoped(db.prepare(
      `SELECT a.id AS asset_id, m.video_id, a.version, a.superseded_at, a.original_filename, a.bytes, m.created_at, m.fps_num, m.fps_den, m.frame_count, m.duration_ms,
              m.width, m.height, m.codec, m.start_tc_frames, m.tc_nominal_fps, m.tc_drop_frame, m.fast_start, m.has_audio, m.poster_key,
              u.id AS user_id, u.name AS user_name, u.role AS user_role, u.active AS user_active
       FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id JOIN user u ON u.id = m.uploaded_by
       WHERE v.project_id = ?1 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}${only} ORDER BY a.version DESC`)),
    bindScoped(db.prepare(
      `SELECT r.id AS reservation_id, r.video_id, r.version, r.expires_at, u.id AS user_id, u.name AS user_name, u.role AS user_role, u.active AS user_active
       FROM video_upload_reservations r JOIN user u ON u.id = r.created_by
       WHERE r.project_id = ?1${videoId === undefined ? "" : " AND r.video_id = ?2"} AND r.status IN ('pending', 'completing', 'aborting') AND r.expires_at > ?${videoId === undefined ? 2 : 3}`), Date.now()),
    ...countStatement,
  ]);
  const openByAsset = new Map((countResult?.results as Array<{ asset_id: string; open_count: number }> | undefined)?.map((row) => [row.asset_id, row.open_count] as const));
  const versionsByVideo = new Map<string, VersionRow[]>();
  for (const row of (versionResult!.results as VersionRow[])) versionsByVideo.set(row.video_id, [...(versionsByVideo.get(row.video_id) ?? []), row]);
  const uploadingByVideo = new Map((uploadingResult!.results as UploadingRow[]).map((row) => [row.video_id, row]));
  return (videoResult!.results as VideoRow[]).map((video): VideoDto => {
    const versions = (versionsByVideo.get(video.id) ?? []).map((row) => ({
      assetId: row.asset_id, version: row.version, current: row.superseded_at === null, uploadedBy: person(row.user_id, row.user_name, row.user_role, row.user_active),
      createdAt: new Date(row.created_at).toISOString(), originalFilename: row.original_filename, bytes: row.bytes,
      fps: { num: row.fps_num, den: row.fps_den }, frameCount: row.frame_count, durationMs: row.duration_ms, width: row.width, height: row.height, codec: row.codec,
      startTimecodeFrames: row.start_tc_frames, tcNominalFps: row.tc_nominal_fps, tcDropFrame: row.tc_drop_frame === 1, fastStart: row.fast_start === 1, hasAudio: row.has_audio === 1,
      hasPoster: row.poster_key !== null, streamUrl: `/media/video/${row.asset_id}`, posterUrl: row.poster_key !== null ? `/media/video/${row.asset_id}/poster` : null,
    }));
    const uploading = uploadingByVideo.get(video.id);
    // A Video row exists only after a Version 1 completes, so a Video without a current Version is corrupt: parse throws rather than serving it.
    return videoDtoSchema.parse({
      id: video.id, title: video.title, premium: video.premium === 1, premiumUnlocked: video.premium_unlocked === 1, position: video.position, createdAt: new Date(video.created_at).toISOString(),
      currentAssetId: versions.find((version) => version.current)?.assetId ?? null,
      latestNoteCount: withNoteCounts ? openByAsset.get(versions.find((version) => version.current)?.assetId ?? "") ?? 0 : null,
      uploading: uploading ? { reservationId: uploading.reservation_id, version: uploading.version, uploader: person(uploading.user_id, uploading.user_name, uploading.user_role, uploading.user_active), expiresAt: new Date(uploading.expires_at).toISOString() } : null,
      versions,
    });
  });
}

