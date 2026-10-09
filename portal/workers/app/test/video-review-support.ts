import { videoObjectKey, videoPosterKey } from "@quincy/shared";
import { database, ids, mp4Bytes, jpegBytes } from "./embedded-media-support";

/** Fixtures for the staff video review (#741) suites, on top of the embedded-media fixture's people and Projects. */
export const VIDEO_FLAG_PREFIX = "video_review";

/** Removes every video review flag row, so each case states the rows it needs. */
export async function clearVideoFlags() { await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review' OR key LIKE 'video_review_%' OR key LIKE 'video_review_pilot:%'").run(); }
/** Inserts flag rows, enabled by default. `[key, false]` inserts a row that is present but off. */
export async function setVideoFlags(...rows: Array<string | [string, boolean]>) {
  const now = Date.now();
  for (const row of rows) {
    const [key, enabled] = typeof row === "string" ? [row, true] as const : row;
    await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(key, enabled ? 1 : 0, now).run();
  }
}

export async function ensureCollection(projectId: string, kind: string): Promise<string> {
  const existing = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = ?").bind(projectId, kind).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").bind(id, projectId, kind, now, now).run();
  return id;
}

export type VideoVersionInput = { projectId?: string; videoId?: string; assetId?: string; version?: number; poster?: boolean; uploader?: string; object?: boolean; title?: string };
/** A committed Video Version: the Video (first Version only), its video-kind Asset, the probed meta row and the stored object. */
export async function seedVideoVersion(input: VideoVersionInput = {}) {
  const projectId = input.projectId ?? ids.project; const collectionId = await ensureCollection(projectId, "video");
  const videoId = input.videoId ?? crypto.randomUUID(); const assetId = input.assetId ?? crypto.randomUUID(); const version = input.version ?? 1; const now = Date.now(); const uploader = input.uploader ?? ids.member;
  const key = videoObjectKey(projectId, videoId, assetId);
  if (!await database.DB.prepare("SELECT 1 FROM videos WHERE id = ?").bind(videoId).first())
    await database.DB.prepare("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)").bind(videoId, projectId, collectionId, input.title ?? "Walkthrough", uploader, now, now).run();
  await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'video', ?, 'cut.mp4', 4096, 'upload', ?, ?, 'ready', ?, ?)").bind(assetId, collectionId, key, videoId, version, now, now).run();
  const posterKey = input.poster ? videoPosterKey(projectId, videoId, assetId, "seed") : null;
  await database.DB.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, ?, ?, ?)").bind(assetId, videoId, posterKey, uploader, now).run();
  if (input.object !== false) await database.MEDIA.put(key, mp4Bytes(4096), { httpMetadata: { contentType: "video/mp4" } });
  if (posterKey) await database.MEDIA.put(posterKey, jpegBytes(32), { httpMetadata: { contentType: "image/jpeg" } });
  return { projectId, collectionId, videoId, assetId, key, posterKey };
}

export type ReservationInput = { projectId?: string; status?: "pending" | "completing" | "aborting" | "completed" | "rejected" | "expired" | "failed"; uploadId?: string | null; creator?: string; videoId?: string; expiresAt?: number };
/** An upload reservation for a new Video (version 1), in the state a case needs. */
export async function seedReservation(input: ReservationInput = {}) {
  const projectId = input.projectId ?? ids.project; const collectionId = await ensureCollection(projectId, "video");
  const id = crypto.randomUUID(); const videoId = input.videoId ?? crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now(); const key = videoObjectKey(projectId, videoId, assetId);
  await database.DB.prepare("INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, r2_key, original_filename, bytes, content_type, upload_id, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Reserved cut', 1, ?, ?, 'cut.mp4', 1000, 'video/mp4', ?, ?, ?, ?, ?, ?)")
    .bind(id, projectId, collectionId, input.creator ?? ids.member, videoId, assetId, key, input.uploadId === undefined ? "s3-upload-video" : input.uploadId, input.status ?? "pending", input.expiresAt ?? now + 7 * 3_600_000, crypto.randomUUID(), now, now).run();
  return { id, videoId, assetId, key, projectId, collectionId };
}
export const reservationStatus = async (id: string) => (await database.DB.prepare("SELECT status FROM video_upload_reservations WHERE id = ?").bind(id).first<{ status: string }>())?.status ?? null;

export type NoteInput = {
  assetId: string; author?: string; guest?: boolean; role?: "admin" | "editor" | "external_editor" | "photographer"; visibility?: "public" | "internal"; parentId?: string;
  startFrame?: number; endFrame?: number | null; body?: string; deletedAt?: number | null; resolvedBy?: string | null; markup?: boolean; createdAt?: number; revision?: number; id?: string;
};
/** A note or reply straight into `video_notes`, scoped from its Version. A guest note is public and authored by a fresh `guest_reviewers` row. */
export async function seedVideoNote(input: NoteInput) {
  const id = input.id ?? crypto.randomUUID(); const now = input.createdAt ?? Date.now();
  const scope = await database.DB.prepare("SELECT v.project_id AS projectId, v.id AS videoId FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?").bind(input.assetId).first<{ projectId: string; videoId: string }>();
  if (!scope) throw new Error("seedVideoNote: unknown Version");
  let guestId: string | null = null;
  if (input.guest) { guestId = crypto.randomUUID(); await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Client Person', ?)").bind(guestId, `${guestId}@guest.test`, now).run(); }
  const reply = input.parentId !== undefined; const author = guestId ? null : input.author ?? ids.member;
  const resolved = input.resolvedBy ?? null;
  await database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, body, resolved_at, resolved_by, revision, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, scope.projectId, scope.videoId, input.assetId, input.parentId ?? null, author, guestId, guestId ? "guest" : input.role ?? "editor", guestId ? "public" : input.visibility ?? "public",
      reply ? null : input.startFrame ?? 10, reply ? null : input.endFrame ?? null, input.body ?? "Seeded note", resolved ? now : null, resolved, input.revision ?? 1, input.deletedAt ?? null, now).run();
  if (input.markup) await database.DB.prepare("INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) VALUES (?, '[]', ?, ?)").bind(id, now, now).run();
  return { id, guestId, projectId: scope.projectId, videoId: scope.videoId };
}
export const clearVideoNotes = async () => { await database.DB.batch([database.DB.prepare("DELETE FROM video_note_markup"), database.DB.prepare("DELETE FROM video_notes"), database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_note.%'")]); };
export const noteRow = (id: string) => database.DB.prepare("SELECT * FROM video_notes WHERE id = ?").bind(id).first<Record<string, unknown>>();
export const noteAudit = async (action?: string) => (await database.DB.prepare(`SELECT actor_id, action, target_id, meta_json FROM audit_log WHERE action LIKE 'video_note.%'${action ? " AND action = ?" : ""} ORDER BY created_at, id`).bind(...(action ? [action] : [])).all<{ actor_id: string; action: string; target_id: string; meta_json: string | null }>()).results;
