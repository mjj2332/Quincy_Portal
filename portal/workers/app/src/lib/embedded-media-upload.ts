import {
  EMBEDDED_POSTER_MAX_BYTES, EMBEDDED_VIDEO_PART_URL_TTL_SECONDS, embeddedMediaKindFor, embeddedMediaObjectKey, embeddedMediaPosterKey, enqueueEmbeddedDisplaySafely, externalEmbeddedMediaCompleteSchema,
  externalEmbeddedMediaPresignSchema, isEmbeddedHeicContentType, isJpeg,
} from "@quincy/shared";
import type { Env } from "../env";
import { newId } from "./ids";
import { abortMultipart, createMultipartPresign, PART_BYTES, PRESIGN_EXPIRES_SECONDS } from "./r2s3";
import {
  abortEmbeddedMedia, claimAndDiscardUploadingMedia, discardUnreferencedObject, enqueueEmbeddedMediaCleanup, getEmbeddedMedia, isUploadedBy, recordedImageSize, settleThrownAdoption, uploaderColumn, uploaderValue,
  verifyUploadedEmbeddedObject, type EmbeddedMediaRow, type MediaUploader,
} from "./embedded-media";
import { isHeicRow } from "./embedded-heic";

/**
 * The upload core of embedded media (#493, #494, #495), parametrised by WHO uploads and by the FENCE their writes carry (#835 C), so the staff routes and the guest ones are one implementation of presign,
 * direct, complete, poster and abort (a reservation, a claim or an adoption must not drift between two copies). Neither caller's gate lives here: a route admits the request (session, capability,
 * Project access, Origin, rate limit) and then hands over. The core reads and writes by `uploader`: the matching uploader column, and `isUploadedBy` for every ownership test.
 *
 * `fence(first)` is the extra ` AND EXISTS (...)` a guest's write repeats at the moment it commits, numbered from `first` (the next free `?n`), or nothing for staff. Every statement that changes a row
 * carries it, so a revoked link or a closed gate lands 0 rows and the caller classifies the refusal.
 */
export type UploadFenceBuilder = (first: number) => { sql: string; binds: unknown[] };
export const NO_FENCE: UploadFenceBuilder = () => ({ sql: "", binds: [] });
export type UploadAudit = (action: string, mediaId: string, meta: Record<string, unknown>) => Promise<void>;
export type UploadScope = { env: Env; projectId: string; uploader: MediaUploader; fence?: UploadFenceBuilder; audit: UploadAudit };
export type MediaOwnerKind = "project_comment" | "whiteboard" | "video_note";

const reply = (status: number, body: unknown): Response => Response.json(body, { status });
const archived = () => reply(409, { error: "Archived projects cannot accept media", code: "project_archived" });
export const stray = () => reply(404, { error: "Media upload not found" });
const fenceOf = (scope: UploadScope) => scope.fence ?? NO_FENCE;

/** `POST .../embedded-media`: reserves the row (fenced on a live Project), starts the multipart upload and hands out the part URLs. The HEIC gate has already been passed by the caller. */
export async function presignEmbeddedMedia(scope: UploadScope, input: { contentType: string; bytes: number; ownerKind: MediaOwnerKind }): Promise<Response> {
  const { env, projectId, uploader } = scope;
  const heic = isEmbeddedHeicContentType(input.contentType);
  const mediaId = newId(); const key = embeddedMediaObjectKey(projectId, mediaId); const now = Date.now();
  const kind = embeddedMediaKindFor(input.contentType)!;
  // Fenced on the Project still being live (and, for a guest, on the session and link), so a reservation never lands in an archived Project.
  const fence = fenceOf(scope)(12);
  const reserved = await env.DB.prepare(`
    INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, ${uploaderColumn(uploader)}, kind, content_type, bytes, original_key, state, created_at, updated_at, rendition_status)
    SELECT ?, ?, NULL, id, ?, ?, ?, ?, ?, 'uploading', ?, ?, ? FROM projects WHERE id = ? AND archived_at IS NULL${fence.sql}
  `).bind(mediaId, input.ownerKind, uploaderValue(uploader), kind, input.contentType, input.bytes, key, now, now, heic ? "pending" : "not_required", projectId, ...fence.binds).run();
  if ((reserved.meta.changes ?? 0) !== 1) return archived();
  const release = () => env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(env, key, input.bytes, input.contentType, PART_BYTES, kind === "video" ? EMBEDDED_VIDEO_PART_URL_TTL_SECONDS : PRESIGN_EXPIRES_SECONDS); }
  catch (error) { await release(); throw error; }
  if (!multipart) {
    // Dev has no R2 S3 credentials: steer the browser to the direct-PUT route (Miniflare R2).
    if (env.APP_ENV === "dev") return reply(200, externalEmbeddedMediaPresignSchema.parse({ mediaId, devDirect: true }));
    await release();
    return reply(503, { error: "R2 S3 upload credentials are not configured" });
  }
  // The reservation and the Project may have gone while R2 was starting the upload (archive, hard delete, a sweep claim): then no URLs go out.
  const storedFence = fenceOf(scope)(4);
  const stored = await env.DB.prepare(`
    UPDATE embedded_media SET upload_id = ? WHERE id = ? AND state = 'uploading' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)${storedFence.sql}
  `).bind(multipart.uploadId, mediaId, projectId, ...storedFence.binds).run();
  if ((stored.meta.changes ?? 0) !== 1) {
    // An abort that fails leaves the upload completable, so the queue takes it over (the sweep aborts it, then deletes the key).
    try { await abortMultipart(env, key, multipart.uploadId); } catch { await enqueueEmbeddedMediaCleanup(env.DB, [{ key, uploadId: multipart.uploadId, projectId }]); }
    await release();
    return reply(409, { error: "This project can no longer accept media", code: "project_unavailable" });
  }
  await scope.audit("embedded_media.presign", mediaId, { projectId, bytes: input.bytes, contentType: input.contentType, ownerKind: input.ownerKind });
  return reply(200, externalEmbeddedMediaPresignSchema.parse({ mediaId, uploadId: multipart.uploadId, partUrls: multipart.partUrls, partBytes: multipart.partBytes }));
}

/** `PUT .../direct` (dev only): the bytes of a `devDirect` reservation, from its uploader alone, with the stored content type. */
export async function directEmbeddedMedia(scope: UploadScope, mediaId: string, body: ReadableStream | null): Promise<Response> {
  const row = await getEmbeddedMedia(scope.env.DB, mediaId);
  if (!row || row.projectId !== scope.projectId || !isUploadedBy(row, scope.uploader) || row.state !== "uploading") return reply(404, { error: "Media upload is unavailable" });
  await scope.env.MEDIA.put(row.originalKey, body, { httpMetadata: { contentType: row.contentType } });
  return new Response(null, { status: 204 });
}

/**
 * `POST .../complete`: finishes the multipart upload, checks the stored object against the reservation, and promotes the row to `pending` under the fence. Idempotent for a row already `pending`.
 * `heicRefusal` is the caller's HEIC gate, asked only for a HEIC row, again here on the person completing now (#495).
 */
export async function completeEmbeddedMedia(
  scope: UploadScope, mediaId: string, data: { parts?: Array<{ partNumber: number; etag: string }> | undefined; width?: number | undefined; height?: number | undefined }, heicRefusal: () => Promise<Response | null>,
): Promise<Response> {
  const { env, projectId, uploader } = scope;
  const row = await getEmbeddedMedia(env.DB, mediaId);
  if (!row) return stray();
  if (row.projectId !== projectId || !isUploadedBy(row, uploader)) return stray();
  const heic = isHeicRow(row);
  if (heic) { const refused = await heicRefusal(); if (refused) return refused; }
  const completed = (rendition: string) => reply(200, externalEmbeddedMediaCompleteSchema.parse({ mediaId, state: "pending", ...(heic ? { rendition } : {}) }));
  if (row.state === "pending") return completed(row.renditionStatus);
  if (row.state !== "uploading") return reply(409, { error: "This media is already in use", code: "media_not_uploading" });

  const verdict = await verifyUploadedEmbeddedObject(env, row, data.parts);
  if (!verdict.ok) return reply(verdict.status, verdict.body);

  // Fenced on the Project still being live and unarchived: R2 was awaited above, so the Project may have been deleted or archived meanwhile.
  const promotedAt = Date.now(); const size = recordedImageSize(row, data);
  const fence = fenceOf(scope)(7);
  const promoted = await env.DB.prepare(`UPDATE embedded_media SET state = 'pending', updated_at = ?, width = COALESCE(?, width), height = COALESCE(?, height), rendition_requested_at = CASE WHEN rendition_status = 'pending' THEN ? ELSE NULL END
    WHERE id = ? AND state = 'uploading' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)${fence.sql}`).bind(promotedAt, size.width, size.height, promotedAt, mediaId, projectId, ...fence.binds).run();
  if ((promoted.meta.changes ?? 0) !== 1) {
    const current = await getEmbeddedMedia(env.DB, mediaId);
    if (!current) return stray();
    if (current.state === "uploading") {
      // Lost to the Project's (or the link's) lifecycle, not to another writer: nothing will ever own this object.
      if (!await claimAndDiscardUploadingMedia(env, current)) return reply(409, { error: "This media is already in use", code: "media_not_uploading" });
      return reply(409, { error: "This project can no longer accept media", code: "project_unavailable" });
    }
    if (current.state !== "pending") return reply(409, { error: "This media is already in use", code: "media_not_uploading" });
  } else {
    await scope.audit("embedded_media.upload", mediaId, { projectId, bytes: row.bytes, contentType: row.contentType });
    // Only the promotion winner sends, so a repeated or racing complete queues the conversion once. A lost send is re-sent by the minute cron.
    if (heic) await enqueueEmbeddedDisplaySafely(env, mediaId, "complete", promotedAt);
  }
  return completed("pending");
}

/**
 * `PUT .../poster`: the poster frame the browser captured from a video (#494). Best effort: a video without one plays from its first frame. Only the uploader, only for a video that has finished
 * uploading and is not yet in a note, only once. The write order leaves no orphan whichever way a race goes: the key is queued first, then written, then one batch sets it on the row and unqueues it,
 * but only if the row still wants it. A batch that loses deletes the object, and if R2 refuses, the queued key is left for the daily sweep.
 */
export async function posterEmbeddedMedia(scope: UploadScope, mediaId: string, request: { body: (max: number) => Promise<Uint8Array | null> }): Promise<Response> {
  const { env, projectId, uploader } = scope;
  const row = await getEmbeddedMedia(env.DB, mediaId);
  if (!row || row.projectId !== projectId || !isUploadedBy(row, uploader) || row.kind !== "video") return stray();
  if (row.state !== "pending" || row.posterKey) return reply(409, { error: "This video cannot take a poster", code: "poster_unavailable" });
  // Read with the cap (a declared length over it is refused unread, an undeclared one is cut off at it), so no body can make the Worker buffer more than 2 MB.
  const body = await request.body(EMBEDDED_POSTER_MAX_BYTES);
  if (body === null) return reply(413, { error: "The poster is larger than 2 MB" });
  if (!isJpeg(body)) return reply(400, { error: "The poster must be a JPEG image" });
  const posterKey = embeddedMediaPosterKey(projectId, mediaId, newId());
  // The queue entry is the fence: the adopting batch needs it to exist, unchanged and unleased, and removes it in the same batch. A sweep that leased it (even a lease since expired), finished and dequeued it, or a re-queue that bumped it all make the adoption lose.
  const queuedAt = Date.now();
  await env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(posterKey, projectId, queuedAt).run();
  try { await env.MEDIA.put(posterKey, body, { httpMetadata: { contentType: "image/jpeg" } }); }
  catch (error) {
    // A thrown PUT may still have committed the object, so it is discarded (deleted, re-queued if R2 refuses) rather than just dropping its entry (#574).
    await discardUnreferencedObject(env, posterKey, projectId);
    throw error;
  }
  const fence = fenceOf(scope)(8);
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE embedded_media SET poster_key = ?, updated_at = ?
        WHERE id = ? AND kind = 'video' AND state = 'pending' AND poster_key IS NULL AND ${uploaderColumn(uploader)} = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL)${fence.sql}
      `).bind(posterKey, Date.now(), mediaId, uploaderValue(uploader), projectId, posterKey, queuedAt, ...fence.binds),
      env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL AND (SELECT poster_key FROM embedded_media WHERE id = ?) = ?").bind(posterKey, queuedAt, mediaId, posterKey),
    ]);
  } catch (error) {
    // A throw can still follow a commit: adopted keeps the object (204), unknown keeps it too (500), only a confirmed miss discards it.
    const outcome = await settleThrownAdoption(env, { key: posterKey, projectId, mediaId, what: "Embedded poster", error, isAdopted: async () => (await getEmbeddedMedia(env.DB, mediaId))?.posterKey === posterKey });
    if (outcome === "adopted") return new Response(null, { status: 204 });
    throw error;
  }
  if ((results[0]!.meta.changes ?? 0) === 1) return new Response(null, { status: 204 });
  // Lost: nothing references the object, and a sweep's claim on its entry can never be undone (adoption needs an unclaimed entry).
  await discardUnreferencedObject(env, posterKey, projectId);
  return reply(409, { error: "This video can no longer take a poster", code: "poster_unavailable" });
}

/** `POST .../abort`: a cancelled upload (#494), see `abortEmbeddedMedia`. The uploader's alone, in any Project state, since cleaning up is never harmful. */
export async function abortEmbeddedUpload(scope: UploadScope, mediaId: string): Promise<Response> {
  const row = await getEmbeddedMedia(scope.env.DB, mediaId);
  if (!row || row.projectId !== scope.projectId || !isUploadedBy(row, scope.uploader)) return stray();
  const outcome = await abortEmbeddedMedia(scope.env, row);
  if (outcome === "gone") return stray();
  if (outcome === "in_use") return reply(409, { error: "This media is already in use", code: "media_not_uploading" });
  return new Response(null, { status: 204 });
}

export type { EmbeddedMediaRow };
