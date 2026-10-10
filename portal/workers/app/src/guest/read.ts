import { reachSql } from "../lib/guest-fence-sql";
import { LIVE_VERSION, LIVE_VIDEO } from "../lib/video-live-sql";
import {
  guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestNoteThreadDtoSchema, guestVideoListResponseSchema,
  type GuestNoteListResponse, type GuestNoteMarkupResponse, type GuestNoteThreadDto, type GuestNoteDto, type GuestVideoListResponse,
} from "@quincy/shared";

/**
 * The guest read queries (#741 12a). Each is its own statement and not a filter on a staff DTO: the staff note list returns both visibilities, and a guest query that began as that
 * one with a `.filter` would leak the day someone forgot the filter. The reach is always link -> LIVE member Video -> LIVE grant -> Version -> Project, joined in SQL, so removing a
 * Video or revoking a grant is the next request's miss with no cache to expire.
 */
const LIVE_ACCESS = `JOIN review_link_videos rv ON rv.link_id = g.link_id AND rv.video_id = g.video_id AND rv.removed_at IS NULL
  JOIN videos v ON v.id = g.video_id AND v.project_id = ?2 AND ${LIVE_VIDEO("v")}
  JOIN assets a ON a.id = g.asset_id AND a.kind = 'video'
  JOIN video_version_meta m ON m.asset_id = a.id AND m.video_id = g.video_id AND ${LIVE_VERSION("m")}`;

const streamUrl = (linkId: string, assetId: string) => `/d/api/links/${linkId}/versions/${assetId}/stream`;
const downloadUrl = (linkId: string, assetId: string) => `/d/api/links/${linkId}/versions/${assetId}/download`;
const posterUrl = (linkId: string, assetId: string) => `/d/api/links/${linkId}/versions/${assetId}/poster`;
const iso = (ms: number) => new Date(ms).toISOString();

type VideoRow = { id: string; title: string; premium: number; unlocked: number };
type VersionRow = {
  asset_id: string; video_id: string; version: number; fps_num: number; fps_den: number; frame_count: number; duration_ms: number; width: number; height: number;
  start_tc_frames: number | null; tc_nominal_fps: number; tc_drop_frame: number; has_audio: number; has_poster: number; note_count: number;
};

/** Current members with at least one live grant, in Video position order, each with its granted Versions newest first. */
export async function listGuestVideos(db: D1Database, linkId: string, projectId: string, guestId: string | null = null, canDownload = false): Promise<GuestVideoListResponse> {
  const [videoResult, versionResult, decisionResult, releaseResult] = await db.batch([
    db.prepare(`SELECT v.id, v.title, v.premium, (p.video_id IS NOT NULL) AS unlocked
      FROM review_link_videos rv JOIN videos v ON v.id = rv.video_id AND v.project_id = ?2 AND ${LIVE_VIDEO("v")} LEFT JOIN video_premium_unlocks p ON p.video_id = v.id
      WHERE rv.link_id = ?1 AND rv.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM review_link_version_grants g JOIN video_version_meta m ON m.asset_id = g.asset_id AND m.video_id = g.video_id AND ${LIVE_VERSION("m")} JOIN assets a ON a.id = g.asset_id AND a.kind = 'video'
                    WHERE g.link_id = rv.link_id AND g.video_id = rv.video_id AND g.revoked_at IS NULL)
      ORDER BY v.position, v.created_at, v.id`).bind(linkId, projectId),
    db.prepare(`SELECT a.id AS asset_id, m.video_id, a.version, m.fps_num, m.fps_den, m.frame_count, m.duration_ms, m.width, m.height, m.start_tc_frames, m.tc_nominal_fps, m.tc_drop_frame, m.has_audio,
        (m.poster_key IS NOT NULL) AS has_poster,
        (SELECT COUNT(*) FROM video_notes n WHERE n.asset_id = a.id AND n.visibility = 'public' AND n.parent_id IS NULL
           AND (n.deleted_at IS NULL OR EXISTS (SELECT 1 FROM video_notes r WHERE r.parent_id = n.id))) AS note_count
      FROM review_link_version_grants g ${LIVE_ACCESS}
      WHERE g.link_id = ?1 AND g.revoked_at IS NULL ORDER BY a.version DESC`).bind(linkId, projectId),
    // The latest decision made ON THIS LINK per Version (14a): a staff-recorded event has no link and never matches. `self` is the viewing guest's own.
    db.prepare(`SELECT e.asset_id, e.decision, e.revision, e.created_at, e.actor_guest_id FROM video_approval_events e
      WHERE e.link_id = ?1 AND e.revision = (SELECT MAX(x.revision) FROM video_approval_events x WHERE x.asset_id = e.asset_id AND x.link_id = e.link_id)`).bind(linkId),
    db.prepare(`SELECT r.asset_id FROM video_releases r JOIN video_version_meta rm ON rm.asset_id = r.asset_id AND ${LIVE_VERSION("rm")} JOIN videos rvd ON rvd.id = r.video_id AND ${LIVE_VIDEO("rvd")}
      WHERE r.withdrawn_at IS NULL AND r.asset_id IN (SELECT g.asset_id FROM review_link_version_grants g WHERE g.link_id = ?1 AND g.revoked_at IS NULL)`).bind(linkId),
  ]);
  const decisionByAsset = new Map((decisionResult!.results as Array<{ asset_id: string; decision: "approved" | "changes_requested"; revision: number; created_at: number; actor_guest_id: string | null }>)
    .map((row) => [row.asset_id, { value: row.decision, revision: row.revision, at: iso(row.created_at), self: guestId !== null && row.actor_guest_id === guestId }] as const));
  const releasedAssets = new Set((releaseResult!.results as Array<{ asset_id: string }>).map((row) => row.asset_id));
  const versionsByVideo = new Map<string, VersionRow[]>();
  for (const row of versionResult!.results as VersionRow[]) versionsByVideo.set(row.video_id, [...(versionsByVideo.get(row.video_id) ?? []), row]);
  return guestVideoListResponseSchema.parse({
    videos: (videoResult!.results as VideoRow[]).map((video) => ({
      id: video.id, title: video.title, premium: video.premium === 1, unlocked: video.premium !== 1 || video.unlocked === 1,
      versions: (versionsByVideo.get(video.id) ?? []).map((row) => ({
        assetId: row.asset_id, version: row.version, fps: { num: row.fps_num, den: row.fps_den }, frameCount: row.frame_count, durationMs: row.duration_ms, width: row.width, height: row.height,
        startTimecodeFrames: row.start_tc_frames, tcNominalFps: row.tc_nominal_fps, tcDropFrame: row.tc_drop_frame === 1, hasAudio: row.has_audio === 1,
        posterUrl: row.has_poster === 1 ? posterUrl(linkId, row.asset_id) : null, streamUrl: streamUrl(linkId, row.asset_id), publicNoteCount: row.note_count,
        decision: decisionByAsset.get(row.asset_id) ?? null, released: releasedAssets.has(row.asset_id),
        // Only a live-released Version of an unlocked Video on a link that allows downloads (`canDownload` is the link flag AND the `delivery` part) names the route.
        downloadUrl: canDownload && releasedAssets.has(row.asset_id) && !(video.premium === 1 && video.unlocked !== 1) ? downloadUrl(linkId, row.asset_id) : null,
      })),
    })).filter((video) => video.versions.length > 0),
  });
}

export type GrantedVersion = { r2Key: string; posterKey: string | null; videoId: string };
/** The resolver for stream, poster and notes: a Version reachable through a live member Video AND a live grant of this link, or null. */
export async function resolveGrantedVersion(db: D1Database, linkId: string, projectId: string, assetId: string): Promise<GrantedVersion | null> {
  const row = await db.prepare(`SELECT a.r2_key AS r2_key, m.poster_key AS poster_key, g.video_id AS video_id FROM review_link_version_grants g ${LIVE_ACCESS} WHERE g.link_id = ?1 AND g.asset_id = ?3 AND g.revoked_at IS NULL`)
    .bind(linkId, projectId, assetId).first<{ r2_key: string; poster_key: string | null; video_id: string }>();
  return row ? { r2Key: row.r2_key, posterKey: row.poster_key, videoId: row.video_id } : null;
}

type NoteRow = {
  id: string; parent_id: string | null; author_guest_id: string | null; start_frame: number | null; end_frame: number | null; drawing_frame: number | null; body: string; revision: number;
  resolved_at: number | null; deleted_at: number | null; created_at: number; edited_at: number | null; u_name: string | null; g_name: string | null; has_markup: number;
};

/** `viewer` is the guest id of the session reading (null while unverified): `self` is true only for the viewer's own notes, and no guest is ever shown another's email or id. */
function noteDto(row: NoteRow, viewer: string | null): GuestNoteDto {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id, parentId: row.parent_id,
    author: row.author_guest_id !== null ? { kind: "guest", name: row.g_name ?? "Client reviewer", self: viewer !== null && row.author_guest_id === viewer } : { kind: "studio", name: row.u_name ?? "Studio" },
    startFrame: row.start_frame, endFrame: row.end_frame, drawingFrame: deleted ? null : row.drawing_frame, hasMarkup: deleted ? false : row.has_markup === 1,
    body: deleted ? "" : row.body, deleted, revision: row.revision, resolved: row.resolved_at !== null, createdAt: iso(row.created_at), editedAt: row.edited_at === null ? null : iso(row.edited_at),
  };
}

/**
 * Public roots with their replies for one Version. `visibility = 'public'` is in the WHERE of the single query: visibility is immutable and a reply inherits its root's, so roots and
 * replies are both covered, the Version is REACHED through the link in the same statement (a removal between the resolver and this read lists nothing), and `has_markup` is read off the public rows alone. A root deleted with no reply left is not shown (a tombstone is shown only while it holds a thread).
 */
export async function listGuestNotes(db: D1Database, link: { id: string; projectId: string }, assetId: string, viewer: string | null): Promise<GuestNoteListResponse> {
  const rows = (await db.prepare(`SELECT n.id, n.parent_id, n.author_guest_id, n.start_frame, n.end_frame, n.drawing_frame, n.body, n.revision, n.resolved_at, n.deleted_at, n.created_at, n.edited_at,
      u.name AS u_name, g.display_name AS g_name, (k.note_id IS NOT NULL) AS has_markup
    FROM video_notes n LEFT JOIN user u ON u.id = n.author_user_id LEFT JOIN guest_reviewers g ON g.id = n.author_guest_id LEFT JOIN video_note_markup k ON k.note_id = n.id
    WHERE n.asset_id = ?1 AND n.project_id = ?2 AND n.visibility = 'public' AND ${reachSql("?3", "?2", "?1")} ORDER BY (n.parent_id IS NOT NULL), n.start_frame, n.created_at, n.id`).bind(assetId, link.projectId, link.id).all<NoteRow>()).results;
  const threads = new Map<string, GuestNoteThreadDto>(); const order: GuestNoteThreadDto[] = [];
  for (const row of rows) if (row.parent_id === null) { const thread = { ...noteDto(row, viewer), replies: [] as GuestNoteDto[] }; threads.set(row.id, thread); order.push(thread); }
  for (const row of rows) if (row.parent_id !== null) threads.get(row.parent_id)?.replies.push(noteDto(row, viewer));
  return guestNoteListResponseSchema.parse({ notes: order.filter((thread) => !thread.deleted || thread.replies.length > 0) });
}

/**
 * The drawing of a public, live ROOT note whose Version this link reaches (live member and live grant), else null. The Version join is in the same statement as the note, so an
 * internal note, a reply, a tombstone, an ungranted Version and a removed Video are all one miss. A public root with no drawing is `markup: null`, which leaks nothing.
 */
export async function readGuestMarkup(db: D1Database, linkId: string, projectId: string, noteId: string): Promise<GuestNoteMarkupResponse | null> {
  const row = await db.prepare(`SELECT n.revision, k.strokes_json
    FROM video_notes n JOIN review_link_version_grants g ON g.asset_id = n.asset_id AND g.video_id = n.video_id AND g.link_id = ?1 AND g.revoked_at IS NULL ${LIVE_ACCESS}
    LEFT JOIN video_note_markup k ON k.note_id = n.id
    WHERE n.id = ?3 AND n.project_id = ?2 AND n.visibility = 'public' AND n.parent_id IS NULL AND n.deleted_at IS NULL`).bind(linkId, projectId, noteId).first<{ revision: number; strokes_json: string | null }>();
  if (!row) return null;
  let markup: unknown[] | null = null;
  if (row.strokes_json !== null) { try { const parsed: unknown = JSON.parse(row.strokes_json); markup = Array.isArray(parsed) ? parsed : null; } catch { markup = null; } }
  return guestNoteMarkupResponseSchema.parse({ noteId, revision: row.revision, markup });
}

/**
 * One public root with its replies, in the guest projection, or null: the answer of every guest note write and the thread of a 409. Its own statement, like `listGuestNotes`, with
 * `visibility = 'public'` in the WHERE and the Version REACHED through the link in the same query, so nothing here can carry an internal note, a staff id or an email, and a link
 * that lost the Version between the write and this read gets null (the caller answers the stub).
 */
export async function readGuestThread(db: D1Database, link: { id: string; projectId: string }, rootId: string, viewer: string | null): Promise<GuestNoteThreadDto | null> {
  const rows = (await db.prepare(`SELECT n.id, n.parent_id, n.author_guest_id, n.start_frame, n.end_frame, n.drawing_frame, n.body, n.revision, n.resolved_at, n.deleted_at, n.created_at, n.edited_at,
      u.name AS u_name, g.display_name AS g_name, (k.note_id IS NOT NULL) AS has_markup
    FROM video_notes n LEFT JOIN user u ON u.id = n.author_user_id LEFT JOIN guest_reviewers g ON g.id = n.author_guest_id LEFT JOIN video_note_markup k ON k.note_id = n.id
    WHERE n.project_id = ?2 AND (n.id = ?3 OR n.parent_id = ?3) AND n.visibility = 'public' AND ${reachSql("?1", "?2", "n.asset_id")}
    ORDER BY (n.parent_id IS NOT NULL), n.created_at, n.id`).bind(link.id, link.projectId, rootId).all<NoteRow>()).results;
  const root = rows.find((row) => row.parent_id === null);
  if (!root) return null;
  return guestNoteThreadDtoSchema.parse({ ...noteDto(root, viewer), replies: rows.filter((row) => row.parent_id !== null).map((row) => noteDto(row, viewer)) });
}
