import { Hono, type Context } from "hono";
import { z } from "zod";
import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import {
  EMBEDDED_POSTER_MAX_BYTES, EMBEDDED_VIDEO_PART_URL_TTL_SECONDS, VIDEO_UPLOAD_ACTIVE_STATUSES, VIDEO_UPLOAD_CONTENT_TYPE, VIDEO_UPLOAD_EXPIRY_MS, VIDEO_UPLOAD_MAX_ACTIVE_PER_USER, VIDEO_MAX_BYTES,
  isJpeg, mp4RejectMessage, probeMp4, roleHasCapability, timecodeBaseFor, videoObjectKey, videoPosterKey, videoUploadCompleteInputSchema, videoUploadCompleteResponseSchema,
  videoUploadRejectMessage, videoUploadReserveInputSchema, videoUploadReserveResponseSchema, type Mp4Probe, type Mp4ProbeWarning, type VideoUploadRejectReason,
} from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { audit, auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { abortMultipart, completeMultipart, createMultipartPresign, PART_BYTES, validateMultipartParts } from "../lib/r2s3";
import { discardUnreferencedObject, enqueueEmbeddedMediaCleanup, settleThrownAdoption } from "../lib/embedded-media";
import { readVideoReviewGate, videoReviewGate } from "../lib/video-review-gate";
import { loadVideoDtos } from "../lib/video-dto";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();
const ACTIVE_SQL = VIDEO_UPLOAD_ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");
const iso = (epochMs: number) => new Date(epochMs).toISOString();

/**
 * Staff video upload (#741 PR 4b). Every route checks inline, in this order: malformed id 400, Project visibility (an External editor outside
 * the Project 404, staff 403), the `upload` gate part (closed 404), the `uploadVideo` capability (403), then 409 `project_archived` on a write.
 * No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md). The effective user is `c.get("user")`, so an
 * impersonating Admin acts as, and is audited as, the user they impersonate.
 */
export const videoUploadsRoutes = new Hono<AppEnv>();

type Reservation = {
  id: string; projectId: string; collectionId: string; createdBy: string; videoId: string; newVideoTitle: string | null; version: number; assetId: string; r2Key: string;
  originalFilename: string; bytes: number; uploadId: string | null; supersedesAssetId: string | null; clientProbeJson: string | null; status: string; rejectReason: string | null;
  expiresAt: number; completionAuditId: string;
};

async function loadReservation(db: D1Database, id: string): Promise<Reservation | null> {
  return db.prepare(`
    SELECT id, project_id AS projectId, collection_id AS collectionId, created_by AS createdBy, video_id AS videoId, new_video_title AS newVideoTitle, version, asset_id AS assetId, r2_key AS r2Key,
      original_filename AS originalFilename, bytes, upload_id AS uploadId, supersedes_asset_id AS supersedesAssetId, client_probe_json AS clientProbeJson, status, reject_reason AS rejectReason,
      expires_at AS expiresAt, completion_audit_id AS completionAuditId
    FROM video_upload_reservations WHERE id = ?
  `).bind(id).first<Reservation>();
}

/** Gate (closed 404), capability (403), then Project visibility (External outside 404, staff 403), in that order; the archived 409 follows in each route. Null means the caller may go on. */
async function access(c: Context<AppEnv>, projectId: string): Promise<Response | null> {
  const user = c.get("user");
  if (!await videoReviewGate(c.env.DB, projectId, "upload")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "uploadVideo")) return c.json({ error: "Forbidden", capability: "uploadVideo" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  return null;
}
const archivedResponse = (c: Context<AppEnv>) => c.json({ error: "Archived projects cannot accept uploads", code: "project_archived" }, 409);
const isArchived = async (db: D1Database, projectId: string) => (await db.prepare("SELECT archived_at AS archivedAt FROM projects WHERE id = ?").bind(projectId).first<{ archivedAt: number | null }>())?.archivedAt != null;
const notFound = (c: Context<AppEnv>) => c.json({ error: "Video upload not found" }, 404);
const unavailable = (c: Context<AppEnv>) => c.json({ error: "This upload has expired or was cancelled. Start a new upload.", code: "upload_unavailable" }, 409);
const rejectedResponse = (c: Context<AppEnv>, reason: string | null) => {
  const known = reason ?? "truncated";
  const message = videoUploadRejectMessage(known);
  return c.json({ error: message, code: "video_rejected", reason: known, message }, 422);
};
/** An upload R2 no longer knows is as good as aborted. */
function isMissingMultipartUploadError(error: unknown): boolean {
  for (let current: unknown = error; current; current = current instanceof Error ? current.cause : undefined) {
    if (!current || typeof current !== "object") continue;
    const value = current as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
    if (value.status === 404 || value.code === "NoSuchUpload" || value.name === "NoSuchUpload") return true;
    const text = [value.code, value.name, value.message].filter((item): item is string => typeof item === "string").join(" ");
    if (/no such upload|multipart upload (?:was )?not found|upload (?:does not exist|has already been aborted)|already aborted/i.test(text)) return true;
  }
  return false;
}
/** Aborts a multipart upload through the R2 binding, as the background sweep does: the way to do it with no S3 credentials. */
async function abortThroughBinding(env: AppEnv["Bindings"], key: string, uploadId: string) {
  try { await env.MEDIA.resumeMultipartUpload(key, uploadId).abort(); }
  catch (error) { if (!isMissingMultipartUploadError(error)) throw error; }
}
const errorText = (error: unknown) => (error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error));
/** The cleanup queue's upsert (the one `enqueueEmbeddedMediaCleanup` writes), selecting from a reservation. */
const QUEUE_RESERVATION_SQL = `
  INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at)
  SELECT r2_key, upload_id, project_id, ? FROM video_upload_reservations WHERE id = ? AND status = 'completing'
  ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
`;

const RESERVE_SQL = `
  INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, r2_key,
    original_filename, bytes, content_type, supersedes_asset_id, client_probe_json, status, expires_at, completion_audit_id, created_at, updated_at)
  SELECT ?1, p.id, c.id, ?2, ?3, ?4,
    COALESCE((SELECT MAX(a.version) FROM assets a WHERE a.version_group_id = ?3 AND a.kind = 'video'), 0) + 1,
    ?5, ?6, ?7, ?8, 'video/mp4',
    (SELECT a.id FROM assets a WHERE a.version_group_id = ?3 AND a.kind = 'video' AND a.superseded_at IS NULL),
    ?9, 'pending', ?10, ?11, ?12, ?12
  FROM projects p JOIN collections c ON c.project_id = p.id AND c.kind = 'video'
  WHERE p.id = ?13 AND p.archived_at IS NULL
    AND CASE WHEN ?4 IS NULL THEN EXISTS (SELECT 1 FROM videos v WHERE v.id = ?3 AND v.collection_id = c.id)
             ELSE NOT EXISTS (SELECT 1 FROM videos v WHERE v.id = ?3) END
    AND (SELECT COUNT(*) FROM video_upload_reservations r WHERE r.project_id = p.id AND r.created_by = ?2
         AND r.status IN (${ACTIVE_SQL})) < ${VIDEO_UPLOAD_MAX_ACTIVE_PER_USER}
`;

videoUploadsRoutes.post("/projects/:projectId/video-uploads", terminalRoute("/projects/:projectId/video-uploads", async (c) => {
  const projectId = c.req.param("projectId"); if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const denied = await access(c, projectId); if (denied) return denied;
  if (await isArchived(c.env.DB, projectId)) return archivedResponse(c);
  const data = await jsonInput(c, videoUploadReserveInputSchema); if (data instanceof Response) return data;
  if (data.contentType !== VIDEO_UPLOAD_CONTENT_TYPE) return c.json({ error: "Only video/mp4 can be uploaded", code: "unsupported_media_type" }, 415);
  if (data.bytes > VIDEO_MAX_BYTES) return c.json({ error: mp4RejectMessage("too_large"), code: "too_large", message: mp4RejectMessage("too_large") }, 413);
  const user = c.get("user"); const reservationId = newId(); const assetId = newId(); const videoId = data.videoId ?? newId(); const now = Date.now();
  const key = videoObjectKey(projectId, videoId, assetId); const expiresAt = now + VIDEO_UPLOAD_EXPIRY_MS;
  let inserted: D1Result<{ version: number }>;
  try {
    inserted = await c.env.DB.prepare(`${RESERVE_SQL} RETURNING version`).bind(reservationId, user.id, videoId, data.title ?? null, assetId, key, data.filename, data.bytes, data.clientProbe === undefined ? null : JSON.stringify(data.clientProbe), expiresAt, newId(), now, projectId).all<{ version: number }>();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(errorText(error)) && /video_id/.test(errorText(error))) return uploadInProgress(c, videoId);
    throw error;
  }
  const version = inserted.results[0]?.version;
  if (version === undefined) return reserveRefusal(c, projectId, data.videoId, user.id, videoId);
  const fail = () => c.env.DB.prepare("UPDATE video_upload_reservations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), reservationId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(c.env, key, data.bytes, VIDEO_UPLOAD_CONTENT_TYPE, PART_BYTES, EMBEDDED_VIDEO_PART_URL_TTL_SECONDS); }
  catch (error) { await fail(); throw error; }
  c.header("cache-control", "no-store");
  const reserveMeta = { projectId, videoId, version, bytes: data.bytes };
  if (!multipart) {
    // Dev has no R2 S3 credentials: steer the browser to the direct PUT (Miniflare R2).
    if (c.env.APP_ENV === "dev") {
      await audit(c.env, user, "video.upload.reserve", "video_upload", reservationId, reserveMeta);
      return c.json(videoUploadReserveResponseSchema.parse({ reservationId, videoId, version, devDirect: true, expiresAt: iso(expiresAt) }), 201);
    }
    await fail();
    return c.json({ error: "R2 S3 upload credentials are not configured" }, 503);
  }
  // The Project may have been archived or deleted while R2 was starting the upload: then no URLs go out.
  // An abort that fails leaves the upload completable, so the queue takes it over (the sweep aborts it, then deletes the key).
  const releaseUpload = async () => {
    try { if (!await abortMultipart(c.env, key, multipart.uploadId)) await abortThroughBinding(c.env, key, multipart.uploadId); }
    catch { await enqueueEmbeddedMediaCleanup(c.env.DB, [{ key, uploadId: multipart.uploadId, projectId }]); }
  };
  let stored: D1Result;
  try {
    stored = await c.env.DB.prepare("UPDATE video_upload_reservations SET upload_id = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)")
      .bind(multipart.uploadId, Date.now(), reservationId, projectId).run();
  } catch (error) {
    // The id may not have been stored, so no row points at the upload: end it here, and mark the reservation failed if D1 will let us.
    try { await releaseUpload(); } catch (releaseError) { console.error("Video upload could not be released after a failed reserve", { reservationId, error: errorText(releaseError) }); }
    await fail().catch(() => undefined);
    throw error;
  }
  if ((stored.meta.changes ?? 0) !== 1) {
    await releaseUpload();
    await fail();
    return c.json({ error: "This project can no longer accept uploads", code: "project_unavailable" }, 409);
  }
  await audit(c.env, user, "video.upload.reserve", "video_upload", reservationId, reserveMeta);
  return c.json(videoUploadReserveResponseSchema.parse({ reservationId, videoId, version, uploadId: multipart.uploadId, partUrls: multipart.partUrls, partBytes: multipart.partBytes, expiresAt: iso(expiresAt) }), 201);
}));

/** One read to say why the reserving INSERT matched nothing, in the order a caller can act on. */
async function reserveRefusal(c: Context<AppEnv>, projectId: string, existingVideoId: string | undefined, userId: string, videoId: string): Promise<Response> {
  const db = c.env.DB;
  const project = await db.prepare("SELECT archived_at AS archivedAt, (SELECT id FROM collections WHERE project_id = projects.id AND kind = 'video') AS collectionId FROM projects WHERE id = ?").bind(projectId).first<{ archivedAt: number | null; collectionId: string | null }>();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt !== null) return archivedResponse(c);
  if (!project.collectionId) return c.json({ error: "This project has no Video service. Add it before uploading video.", code: "video_service_missing" }, 409);
  if (existingVideoId && !await db.prepare("SELECT 1 FROM videos WHERE id = ? AND collection_id = ?").bind(existingVideoId, project.collectionId).first()) return c.json({ error: "Video not found" }, 404);
  const active = (await db.prepare(`SELECT COUNT(*) AS n FROM video_upload_reservations WHERE project_id = ? AND created_by = ? AND status IN (${ACTIVE_SQL})`).bind(projectId, userId).first<{ n: number }>())?.n ?? 0;
  if (active >= VIDEO_UPLOAD_MAX_ACTIVE_PER_USER) return c.json({ error: "You already have three uploads in progress in this project. Finish or cancel one first.", code: "too_many_uploads" }, 429);
  return uploadInProgress(c, existingVideoId ?? videoId);
}

async function uploadInProgress(c: Context<AppEnv>, videoId: string): Promise<Response> {
  const active = await c.env.DB.prepare(`SELECT u.name AS name, r.expires_at AS expiresAt FROM video_upload_reservations r JOIN user u ON u.id = r.created_by WHERE r.video_id = ? AND r.status IN (${ACTIVE_SQL}) LIMIT 1`).bind(videoId).first<{ name: string; expiresAt: number }>();
  if (!active) return c.json({ error: "Could not reserve this upload. Try again.", code: "upload_unavailable" }, 409);
  return c.json({ error: `${active.name} is already uploading a new version of this video`, code: "upload_in_progress", uploader: { name: active.name }, expiresAt: iso(active.expiresAt) }, 409);
}

videoUploadsRoutes.put("/projects/:projectId/video-uploads/:reservationId/direct", terminalRoute("/projects/:projectId/video-uploads/:reservationId/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const projectId = c.req.param("projectId"); const reservationId = c.req.param("reservationId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(reservationId).success) return c.json({ error: "Invalid video upload" }, 400);
  const denied = await access(c, projectId); if (denied) return denied;
  // A reservation made before the Project was archived takes no bytes afterwards (#501).
  if (await isArchived(c.env.DB, projectId)) return archivedResponse(c);
  const row = await loadReservation(c.env.DB, reservationId);
  if (!row || row.projectId !== projectId || row.createdBy !== c.get("user").id || row.status !== "pending" || row.expiresAt <= Date.now()) return notFound(c);
  if (Number(c.req.header("content-length") ?? "0") > row.bytes) return c.json({ error: "The file is larger than the size that was reserved" }, 413);
  const keyInUse = () => c.env.DB.prepare("SELECT 1 AS used FROM assets WHERE r2_key = ?").bind(row.r2Key).first();
  // Never write over the object a completed Version plays.
  if (await keyInUse()) return unavailable(c);
  // Write-once: the put succeeds only if the key holds no object, so a delayed or repeated PUT can never replace bytes already written (or completed).
  const written = await c.env.MEDIA.put(row.r2Key, c.req.raw.body, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: VIDEO_UPLOAD_CONTENT_TYPE } });
  if (!written) return unavailable(c);
  const stored = await c.env.MEDIA.head(row.r2Key);
  if (stored && stored.size > row.bytes) { await c.env.MEDIA.delete(row.r2Key); return c.json({ error: "The file is larger than the size that was reserved" }, 413); }
  // The write took time. A reservation an abort or the sweep has taken (`aborting`, `failed`, `expired`) can never complete, so what we wrote
  // is an orphan and ours to delete: the abort's own delete may already have run before this write landed. `completing` or `completed`
  // means a completion owns these bytes, so then the object is left alone.
  const current = await loadReservation(c.env.DB, reservationId);
  if (current?.status !== "pending" || current.createdBy !== c.get("user").id || current.expiresAt <= Date.now()) {
    if ((current?.status === "aborting" || current?.status === "failed" || current?.status === "expired") && !await keyInUse()) {
      try { await c.env.MEDIA.delete(row.r2Key); } catch { await enqueueEmbeddedMediaCleanup(c.env.DB, [{ key: row.r2Key, projectId }]); }
    }
    return unavailable(c);
  }
  return c.body(null, 204);
}));

/** Thrown from a probe read when R2 cannot give the bytes the HEAD described: transient (503), never a rejection of the file. */
class ProbeUnavailable extends Error {}

/** The fields a client probe may be compared on, against the server's. A mismatch is audited and never stored. */
export function clientProbeDisagreement(json: string | null, probe: Mp4Probe): string[] {
  if (!json) return [];
  let claimed: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(json); if (!parsed || typeof parsed !== "object") return []; claimed = parsed as Record<string, unknown>; } catch { return []; }
  const disagreed: string[] = [];
  const fps = claimed.fps as { num?: unknown; den?: unknown } | undefined;
  if (fps !== undefined && !(typeof fps?.num === "number" && typeof fps?.den === "number" && fps.den > 0 && fps.num * probe.fps.den === fps.den * probe.fps.num)) disagreed.push("fps");
  for (const field of ["frameCount", "width", "height", "durationMs", "codec"] as const) if (claimed[field] !== undefined && claimed[field] !== probe[field]) disagreed.push(field);
  return disagreed;
}

async function completedResponse(c: Context<AppEnv>, row: Reservation, status: 200 | 201, warnings?: Mp4ProbeWarning[]): Promise<Response> {
  const video = (await loadVideoDtos(c.env.DB, row.projectId, row.videoId, (await readVideoReviewGate(c.env.DB, row.projectId)).parts.includes("notes")))[0];
  const version = video?.versions.find((candidate) => candidate.assetId === row.assetId);
  if (!video || !version) return notFound(c);
  let stored = warnings;
  if (!stored) {
    const meta = (await c.env.DB.prepare("SELECT meta_json AS meta FROM audit_log WHERE id = ?").bind(row.completionAuditId).first<{ meta: string | null }>())?.meta;
    try { const parsed = meta ? JSON.parse(meta) as { warnings?: unknown } : {}; stored = Array.isArray(parsed.warnings) ? parsed.warnings as Mp4ProbeWarning[] : []; } catch { stored = []; }
  }
  c.header("cache-control", "no-store");
  return c.json(videoUploadCompleteResponseSchema.parse({ video, version, warnings: stored }), status);
}

videoUploadsRoutes.post("/projects/:projectId/video-uploads/:reservationId/complete", terminalRoute("/projects/:projectId/video-uploads/:reservationId/complete", async (c) => {
  const projectId = c.req.param("projectId"); const reservationId = c.req.param("reservationId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(reservationId).success) return c.json({ error: "Invalid video upload" }, 400);
  const denied = await access(c, projectId); if (denied) return denied;
  const user = c.get("user"); const db = c.env.DB;
  const row = await loadReservation(db, reservationId);
  if (!row || row.projectId !== projectId || row.createdBy !== user.id) return notFound(c);
  if (row.status === "completed") return completedResponse(c, row, 200);
  if (row.status === "rejected") return rejectedResponse(c, row.rejectReason);
  if (await isArchived(db, projectId)) return archivedResponse(c);
  const input = await jsonInput(c, videoUploadCompleteInputSchema); if (input instanceof Response) return input;

  // Claim: pending -> completing, fenced on the expiry and a live Project. An existing `completing` claim is continued (re-entrant, as documents are).
  let claimedHere = false;
  if (row.status === "pending") {
    const at = Date.now();
    const claimed = await db.prepare("UPDATE video_upload_reservations SET status = 'completing', completing_at = ?, updated_at = ? WHERE id = ? AND created_by = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)")
      .bind(at, at, row.id, user.id, at, projectId).run();
    if ((claimed.meta.changes ?? 0) === 1) claimedHere = true;
    else {
      const current = await loadReservation(db, row.id);
      if (current?.status === "completed") return completedResponse(c, current, 200);
      if (current?.status === "rejected") return rejectedResponse(c, current.rejectReason);
      if (current?.status !== "completing") return unavailable(c);
    }
  } else if (row.status !== "completing") return unavailable(c);
  const release = async () => { if (claimedHere) await db.prepare("UPDATE video_upload_reservations SET status = 'pending', completing_at = NULL, updated_at = ? WHERE id = ? AND status = 'completing'").bind(Date.now(), row.id).run(); };

  // One claim-first rejection: the object's queue entry and the terminal status change in one batch, and only the winner deletes the object.
  const reject = async (reason: VideoUploadRejectReason): Promise<Response> => {
    const at = Date.now();
    const results = await db.batch([
      db.prepare(QUEUE_RESERVATION_SQL).bind(at, row.id),
      db.prepare("UPDATE video_upload_reservations SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ? AND status = 'completing'").bind(reason, at, row.id),
    ]);
    if ((results[1]!.meta.changes ?? 0) === 1) {
      try { await c.env.MEDIA.delete(row.r2Key); await db.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND claimed_until IS NULL").bind(row.r2Key).run(); }
      catch { /* the queue entry stays for the drain */ }
      return rejectedResponse(c, reason);
    }
    const current = await loadReservation(db, row.id);
    if (current?.status === "completed") return completedResponse(c, current, 200);
    if (current?.status === "rejected") return rejectedResponse(c, current.rejectReason);
    return unavailable(c);
  };

  if (row.uploadId) {
    if (!input.parts?.length) { await release(); return c.json({ error: "Multipart uploads require completed parts" }, 400); }
    try { validateMultipartParts(row.bytes, input.parts); } catch (error) { await release(); return c.json({ error: error instanceof Error ? error.message : "Invalid multipart parts" }, 400); }
    try { await completeMultipart(c.env, row.r2Key, row.uploadId, input.parts, row.bytes); }
    catch (error) {
      // A retry after a lost response finds the upload already completed: carry on if the object is there.
      if (!await c.env.MEDIA.head(row.r2Key)) { await release(); return c.json({ error: "The file has not finished uploading", code: "upload_missing" }, 400); }
    }
  }
  const head = await c.env.MEDIA.head(row.r2Key);
  if (!head) { await release(); return c.json({ error: "The file has not finished uploading", code: "upload_missing" }, 400); }
  if (head.size !== row.bytes) return reject("size_mismatch");
  if (head.httpMetadata?.contentType !== VIDEO_UPLOAD_CONTENT_TYPE) return reject("content_type");

  // The server probes the stored object itself. Every read is pinned to the HEAD's ETag, so a swap between the HEAD and a read is a 503, never a verdict on the wrong bytes.
  let probed: Awaited<ReturnType<typeof probeMp4>>;
  try {
    probed = await probeMp4({
      size: head.size,
      read: async (offset, length) => {
        const object = await c.env.MEDIA.get(row.r2Key, { range: { offset, length }, onlyIf: { etagMatches: head.etag } });
        if (!object || !("body" in object) || !object.body) throw new ProbeUnavailable("The stored video changed or is not readable");
        const bytes = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
        if (bytes.byteLength < Math.min(length, head.size - offset)) throw new ProbeUnavailable("The stored video returned a short read");
        return bytes;
      },
    });
  } catch (error) {
    if (error instanceof ProbeUnavailable) return c.json({ error: "The video could not be read just now. Try again in a moment.", code: "probe_unavailable" }, 503);
    throw error;
  }
  if (!probed.ok) return reject(probed.reason);
  const probe = probed.probe;

  const now = Date.now(); const fps = probe.fps;
  const base = timecodeBaseFor(fps, null);
  const startTimecode = probe.startTimecode ?? { frames: null, dropFrame: base.dropFrame, nominalFps: base.nominalFps };
  const fence = "EXISTS (SELECT 1 FROM video_upload_reservations WHERE id = ? AND status = 'completing') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)";
  const fenceBinds = [row.id, projectId];
  const statements: D1PreparedStatement[] = [];
  if (row.version === 1) {
    statements.push(db.prepare(`INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, 0, COALESCE((SELECT MAX(position) + 1 FROM videos WHERE collection_id = ?), 0), ?, ?, ? WHERE ${fence}`)
      .bind(row.videoId, projectId, row.collectionId, row.newVideoTitle, row.collectionId, user.id, now, now, ...fenceBinds));
  }
  // The batch guard: a lost fence yields a NULL asset id, which violates NOT NULL and aborts the whole batch before anything commits.
  statements.push(
    db.prepare(`INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, width, height, source, publish_status, version, supersedes_asset_id, version_group_id, created_at, updated_at)
      SELECT CASE WHEN ${fence} THEN ? ELSE NULL END, ?, 'video', ?, ?, ?, ?, ?, 'upload', 'ready', ?, ?, ?, ?, ?`)
      .bind(...fenceBinds, row.assetId, row.collectionId, row.r2Key, row.originalFilename, row.bytes, probe.width, probe.height, row.version, row.supersedesAssetId, row.videoId, now, now),
    // From the server probe only: `client_probe_json` is never read for storage.
    db.prepare(`INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string,
      start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`)
      .bind(row.assetId, row.videoId, fps.num, fps.den, probe.mediaTimescale, probe.frameDelta, probe.frameCount, probe.durationMs, probe.width, probe.height, probe.codec, probe.codecString,
        startTimecode.frames, startTimecode.nominalFps, startTimecode.dropFrame ? 1 : 0, probe.fastStart ? 1 : 0, probe.hasAudio ? 1 : 0, user.id, now),
  );
  if (row.supersedesAssetId) statements.push(db.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL").bind(now, row.assetId, now, row.supersedesAssetId));
  statements.push(
    db.prepare("UPDATE videos SET updated_at = ? WHERE id = ?").bind(now, row.videoId),
    // The unique audit id makes a duplicate batch fail, so a completion is recorded once.
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'video.version.upload', 'asset', ?, ?, ?)")
      .bind(row.completionAuditId, user.id, row.assetId, auditMeta(user, { projectId, videoId: row.videoId, version: row.version, bytes: row.bytes, fps: { num: fps.num, den: fps.den }, frameCount: probe.frameCount, warnings: probe.warnings, clientProbeDisagreed: clientProbeDisagreement(row.clientProbeJson, probe) }), now),
    db.prepare("UPDATE video_upload_reservations SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'completing'").bind(now, now, row.id),
    db.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(row.collectionId, now)),
  );
  try { await db.batch(statements); }
  catch {
    const current = await loadReservation(db, row.id);
    if (current?.status === "completed") return completedResponse(c, current, 200);
    // Abort or the sweep owns the row now: touch nothing. Otherwise the claim is kept for its lease and the client may retry.
    if (current?.status !== "completing") return unavailable(c);
    return c.json({ error: "Could not finish this upload. Try again.", code: "completion_failed" }, 409);
  }
  return completedResponse(c, row, 201, probe.warnings);
}));

videoUploadsRoutes.post("/projects/:projectId/video-uploads/:reservationId/abort", terminalRoute("/projects/:projectId/video-uploads/:reservationId/abort", async (c) => {
  const projectId = c.req.param("projectId"); const reservationId = c.req.param("reservationId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(reservationId).success) return c.json({ error: "Invalid video upload" }, 400);
  const denied = await access(c, projectId); if (denied) return denied;
  const db = c.env.DB; const row = await loadReservation(db, reservationId);
  if (!row || row.projectId !== projectId || row.createdBy !== c.get("user").id) return notFound(c);
  if (row.status === "completed") return c.json({ error: "A completed upload cannot be cancelled", code: "upload_completed" }, 409);
  if (row.status !== "pending" && row.status !== "completing" && row.status !== "aborting") return c.body(null, 204);
  // Claim first: from here the completion's batch cannot commit. The multipart upload dies before the object is deleted (a late part would resurrect it).
  const claimed = await db.prepare(`UPDATE video_upload_reservations SET status = 'aborting', updated_at = ? WHERE id = ? AND status IN (${ACTIVE_SQL})`).bind(Date.now(), row.id).run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    const current = await loadReservation(db, row.id);
    if (current?.status === "completed") return c.json({ error: "A completed upload cannot be cancelled", code: "upload_completed" }, 409);
    return c.body(null, 204);
  }
  try {
    // With no S3 credentials the binding does it; a failure either way leaves the row `aborting` for the sweep, and the upload is never reported cancelled while it lives.
    if (row.uploadId && !await abortMultipart(c.env, row.r2Key, row.uploadId)) await abortThroughBinding(c.env, row.r2Key, row.uploadId);
    await c.env.MEDIA.delete(row.r2Key);
  } catch { return c.json({ error: "Cancelling is pending. Try again in a moment.", code: "abort_pending" }, 503); }
  const at = Date.now();
  // The audit row rides the state change and exists only if this call made it, so a retry or a race writes no second one.
  await db.batch([
    db.prepare("UPDATE video_upload_reservations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'aborting'").bind(at, row.id),
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'video.upload.abort', 'video_upload', ?, ?, ? WHERE changes() > 0")
      .bind(newId(), c.get("user").id, row.id, auditMeta(c.get("user"), { projectId, videoId: row.videoId, version: row.version }), at),
  ]);
  return c.body(null, 204);
}));

/**
 * The poster frame the browser captured (#741). Best effort: a Version without one plays from its first frame. Only the uploader, only once, in a live
 * Project. The write order leaves no orphan whichever way a race goes (the embedded poster protocol, docs/lessons.md): queue a fresh-nonce key, write it,
 * then one batch sets it on the row and unqueues it, only if the row still wants it. A batch that loses deletes the object, and if R2 refuses the key stays queued.
 */
videoUploadsRoutes.put("/projects/:projectId/video-versions/:assetId/poster", terminalRoute("/projects/:projectId/video-versions/:assetId/poster", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid video version" }, 400);
  const denied = await access(c, projectId); if (denied) return denied;
  const user = c.get("user"); const db = c.env.DB;
  if (await isArchived(db, projectId)) return archivedResponse(c);
  const row = await db.prepare("SELECT m.video_id AS videoId, m.poster_key AS posterKey, m.uploaded_by AS uploadedBy FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ? AND v.project_id = ?").bind(assetId, projectId).first<{ videoId: string; posterKey: string | null; uploadedBy: string }>();
  if (!row || row.uploadedBy !== user.id) return c.json({ error: "Video version not found" }, 404);
  if (row.posterKey) return c.json({ error: "This video already has a poster", code: "poster_unavailable" }, 409);
  if (Number(c.req.header("content-length") ?? "0") > EMBEDDED_POSTER_MAX_BYTES) return c.json({ error: "The poster is larger than 2 MB" }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > EMBEDDED_POSTER_MAX_BYTES) return c.json({ error: "The poster is larger than 2 MB" }, 413);
  if (!isJpeg(body)) return c.json({ error: "The poster must be a JPEG image" }, 400);
  const posterKey = videoPosterKey(projectId, row.videoId, assetId, newId());
  // The queue entry is the fence: the adopting batch needs it to exist, unchanged and unleased, and removes it in the same batch.
  const queuedAt = Date.now();
  await db.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(posterKey, projectId, queuedAt).run();
  try { await c.env.MEDIA.put(posterKey, body, { httpMetadata: { contentType: "image/jpeg" } }); }
  catch (error) { await discardUnreferencedObject(c.env, posterKey, projectId); throw error; }
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`
        UPDATE video_version_meta SET poster_key = ?
        WHERE asset_id = ? AND poster_key IS NULL AND uploaded_by = ?
          AND EXISTS (SELECT 1 FROM videos v JOIN projects p ON p.id = v.project_id WHERE v.id = video_version_meta.video_id AND p.id = ? AND p.archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL)
      `).bind(posterKey, assetId, user.id, projectId, posterKey, queuedAt),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'video.poster.set', 'asset', ?, ?, ? WHERE changes() > 0")
        .bind(newId(), user.id, assetId, auditMeta(user, { projectId, videoId: row.videoId }), queuedAt),
      db.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL AND (SELECT poster_key FROM video_version_meta WHERE asset_id = ?) = ?").bind(posterKey, queuedAt, assetId, posterKey),
    ]);
  } catch (error) {
    // A throw can still follow a commit: adopted keeps the object (204), unknown keeps it too (500), only a confirmed miss discards it.
    const outcome = await settleThrownAdoption(c.env, { key: posterKey, projectId, mediaId: assetId, what: "Video poster", error, isAdopted: async () => (await db.prepare("SELECT poster_key AS posterKey FROM video_version_meta WHERE asset_id = ?").bind(assetId).first<{ posterKey: string | null }>())?.posterKey === posterKey });
    if (outcome === "adopted") return c.body(null, 204);
    throw error;
  }
  if ((results[0]!.meta.changes ?? 0) === 1) return c.body(null, 204);
  // Lost: nothing references the object, and a sweep's claim on its entry can never be undone (adoption needs an unclaimed entry).
  await discardUnreferencedObject(c.env, posterKey, projectId);
  return c.json({ error: "This video can no longer take a poster", code: "poster_unavailable" }, 409);
}));
