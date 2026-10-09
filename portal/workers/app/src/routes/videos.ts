import { Hono } from "hono";
import { z } from "zod";
import { ROLE_LABELS, VIDEO_REVIEW_PART_CAPABILITY, roleHasCapability, videoListResponseSchema, videoReviewResponseSchema, type Role, type VideoDto } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { readVideoReviewGate, videoReviewGate } from "../lib/video-review-gate";

const uuid = z.string().uuid();

/**
 * Staff video review (#741). Every route here is checked inline, in this order: malformed id 400, then the
 * gate (closed 404), then the capability (403), then Project visibility (an External editor outside the Project 404, staff 403, as everywhere else). No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
 */
export const videosRoutes = new Hono<AppEnv>();

/**
 * What video review this caller has on this Project. A closed gate is 200 `{ open: false, parts: [] }`
 * so the web needs no 404 branch; the routes behind a part answer 404 themselves. `open` and `parts` are
 * intersected with the caller's capabilities, so a Photographer always reads closed.
 */
videosRoutes.get("/projects/:projectId/video-review", terminalRoute("/projects/:projectId/video-review", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const role = c.get("user").role;
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  const open = gate.open && roleHasCapability(role, "viewVideo");
  return c.json(videoReviewResponseSchema.parse({ open, parts: open ? gate.parts.filter((part) => roleHasCapability(role, VIDEO_REVIEW_PART_CAPABILITY[part])) : [] }));
}));

type VideoRow = { id: string; title: string; premium: number; position: number; created_at: number };
type VersionRow = {
  asset_id: string; video_id: string; version: number; superseded_at: number | null; original_filename: string; bytes: number; created_at: number;
  fps_num: number; fps_den: number; frame_count: number; duration_ms: number; width: number; height: number; codec: "avc1" | "avc3";
  start_tc_frames: number | null; tc_nominal_fps: number; tc_drop_frame: number; fast_start: number; has_audio: number; poster_key: string | null;
  user_id: string; user_name: string; user_role: Role; user_active: number;
};
type UploadingRow = { video_id: string; version: number; expires_at: number; user_id: string; user_name: string; user_role: Role; user_active: number };
const person = (id: string, name: string, role: Role, active: number) => ({ id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) });

/**
 * The Project's Videos with every Version embedded, newest first (no separate versions route). Three reads in one batch: the Videos,
 * their Versions joined to the probed meta and the uploader, and the upload in flight. The gate is the open check alone (`null`): there is
 * no "view" part, and viewing must survive the operator turning `upload` off. The list is the same strict shape for every role; it never
 * carries an object key, only the `/media/video/:assetId` addresses a Version is played from.
 */
videosRoutes.get("/projects/:projectId/videos", terminalRoute("/projects/:projectId/videos", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const user = c.get("user");
  if (!await videoReviewGate(c.env.DB, projectId, null)) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "viewVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const [videoResult, versionResult, uploadingResult] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, title, premium, position, created_at FROM videos WHERE project_id = ?1 ORDER BY position, created_at, id").bind(projectId),
    c.env.DB.prepare(
      `SELECT a.id AS asset_id, m.video_id, a.version, a.superseded_at, a.original_filename, a.bytes, m.created_at, m.fps_num, m.fps_den, m.frame_count, m.duration_ms,
              m.width, m.height, m.codec, m.start_tc_frames, m.tc_nominal_fps, m.tc_drop_frame, m.fast_start, m.has_audio, m.poster_key,
              u.id AS user_id, u.name AS user_name, u.role AS user_role, u.active AS user_active
       FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id JOIN user u ON u.id = m.uploaded_by
       WHERE v.project_id = ?1 ORDER BY a.version DESC`).bind(projectId),
    c.env.DB.prepare(
      `SELECT r.video_id, r.version, r.expires_at, u.id AS user_id, u.name AS user_name, u.role AS user_role, u.active AS user_active
       FROM video_upload_reservations r JOIN user u ON u.id = r.created_by
       WHERE r.project_id = ?1 AND r.status IN ('pending', 'completing', 'aborting') AND r.expires_at > ?2`).bind(projectId, Date.now()),
  ]);
  const versionsByVideo = new Map<string, VersionRow[]>();
  for (const row of (versionResult!.results as VersionRow[])) versionsByVideo.set(row.video_id, [...(versionsByVideo.get(row.video_id) ?? []), row]);
  const uploadingByVideo = new Map((uploadingResult!.results as UploadingRow[]).map((row) => [row.video_id, row]));
  const videos: VideoDto[] = (videoResult!.results as VideoRow[]).map((video) => {
    const versions = (versionsByVideo.get(video.id) ?? []).map((row) => ({
      assetId: row.asset_id, version: row.version, current: row.superseded_at === null, uploadedBy: person(row.user_id, row.user_name, row.user_role, row.user_active),
      createdAt: new Date(row.created_at).toISOString(), originalFilename: row.original_filename, bytes: row.bytes,
      fps: { num: row.fps_num, den: row.fps_den }, frameCount: row.frame_count, durationMs: row.duration_ms, width: row.width, height: row.height, codec: row.codec,
      startTimecodeFrames: row.start_tc_frames, tcNominalFps: row.tc_nominal_fps, tcDropFrame: row.tc_drop_frame === 1, fastStart: row.fast_start === 1, hasAudio: row.has_audio === 1,
      hasPoster: row.poster_key !== null, streamUrl: `/media/video/${row.asset_id}`, posterUrl: row.poster_key !== null ? `/media/video/${row.asset_id}/poster` : null,
    }));
    const uploading = uploadingByVideo.get(video.id);
    return {
      id: video.id, title: video.title, premium: video.premium === 1, position: video.position, createdAt: new Date(video.created_at).toISOString(),
      currentAssetId: versions.find((version) => version.current)?.assetId ?? null,
      uploading: uploading ? { version: uploading.version, uploader: person(uploading.user_id, uploading.user_name, uploading.user_role, uploading.user_active), expiresAt: new Date(uploading.expires_at).toISOString() } : null,
      versions,
    };
  });
  return c.json(videoListResponseSchema.parse({ videos }));
}));
