import {
  ATTACHMENT_STORED_CONTENT_TYPE, attachmentCompleteResponseSchema, attachmentObjectKey, attachmentPresignResponseSchema, attachmentRefusal, attachmentRefusalMessage, normalizeAttachmentName,
  normalizeDeclaredContentType, noticeAttachmentObjectKey, type AttachmentOwnerKind,
} from "@quincy/shared";
import { enqueueEmbeddedMediaCleanup } from "@quincy/db";
import { z } from "zod";
import type { Env } from "../env";
import { audit, type Principal } from "./audit";
import { newId } from "./ids";
import { abortMultipart, completeMultipart, createMultipartPresign, PART_BYTES, validateMultipartParts } from "./r2s3";
import { uploaderColumn, uploaderValue } from "./embedded-media";
import { NO_FENCE, type UploadScope } from "./embedded-media-upload";
import { abortAttachment, claimAndDiscardUploadingAttachment, getAttachment, isAttachmentUploadedBy, type AttachmentRow } from "./attachments";

/**
 * The upload core of Attachments (#952), the Embedded media core's twin (`lib/embedded-media-upload.ts`) on the same `UploadScope`: WHO uploads and the FENCE their writes carry,
 * so the staff routes here and the guest ones (#956) are one implementation. Neither caller's gate lives here. Every object is written as `application/octet-stream` whatever the
 * file is, and completion refuses a stored object of any other type, so even a leaked object read is inert. No byte sniffing (plan D3): a download opens by the name we serve,
 * and that name has passed the blocklist.
 *
 * The scope's `projectId` is the Project the file belongs to, or null for a Notice board post (#954), which has no Project: its object sits
 * under the Notice board prefix and nothing about a Project fences its writes.
 */
export type AttachmentScope = Omit<UploadScope, "projectId"> & { projectId: string | null };

/**
 * The scope of a signed-in staff upload, a Project discussion's (`projectId`) or the Notice board's (null): the user uploads, nothing fences it, and audit rows name them (an impersonating
 * Admin is stamped). The guest scope (`guest/attachments.ts`) differs in all three and builds its own.
 */
export function staffAttachmentScope(env: Env, principal: Principal, projectId: string | null): AttachmentScope {
  return { env, projectId, uploader: { userId: principal.id }, audit: (action, attachmentId, meta) => audit(env, principal, action, "attachment", attachmentId, meta) };
}

/** The complete body every Attachment route takes (staff, Notice board, guest): each multipart part's ETag, none for a dev direct upload. */
export const attachmentCompleteInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional() }).strict();

const reply = (status: number, body: unknown): Response => Response.json(body, { status });
/** The replies the routes and the core share, so each is spelled once. */
export const invalidAttachmentReply = () => reply(400, { error: "Invalid file upload" });
export const archivedAttachmentReply = () => reply(409, { error: "Archived projects cannot accept files", code: "project_archived" });
export const strayAttachmentReply = () => reply(404, { error: "File upload not found" });
const archived = archivedAttachmentReply;
const stray = strayAttachmentReply;
const inUse = () => reply(409, { error: "This file is already in a post", code: "attachment_not_uploading" });
const fenceOf = (scope: AttachmentScope) => scope.fence ?? NO_FENCE;
/** The condition every write repeats: the Project is still live, or nothing for a Notice board file. */
const liveOwner = (projectId: string | null) => projectId === null
  ? { sql: "1 = 1", binds: [] as unknown[] }
  : { sql: "EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)", binds: [projectId] as unknown[] };
const auditScope = (projectId: string | null) => projectId === null ? { scope: "notice_board" } : { projectId };
const mib = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * The checks a presign body passes before anything is reserved, in order: the name (sanitised; nothing left is `invalid_name`), the blocklist on the sanitised name's extension and
 * the normalised declared type (`attachment_blocked`, naming what is blocked), then the size (`attachment_empty`, `attachment_too_large` naming the limit). Returns the values to store.
 */
export function judgeAttachmentPresign(input: { name: string; contentType: string; bytes: number }, maxBytes: number): { fileName: string; contentType: string } | Response {
  const fileName = normalizeAttachmentName(input.name);
  if (!fileName) return reply(400, { error: "The file needs a name", code: "invalid_name" });
  const contentType = normalizeDeclaredContentType(input.contentType);
  const refusal = attachmentRefusal(fileName, contentType);
  if (refusal) return reply(400, { error: attachmentRefusalMessage(fileName, refusal), code: "attachment_blocked" });
  if (input.bytes <= 0) return reply(400, { error: `${fileName} is empty.`, code: "attachment_empty" });
  if (input.bytes > maxBytes) return reply(400, { error: `${fileName} is larger than ${mib(maxBytes)} MB, the most a file can be.`, code: "attachment_too_large" });
  return { fileName, contentType };
}

/** `POST .../attachments`: judges the body, reserves the row (fenced on a live Project), starts the multipart upload and hands out the part URLs. */
export async function presignAttachment(scope: AttachmentScope, input: { name: string; contentType: string; bytes: number; ownerKind: AttachmentOwnerKind; maxBytes: number }): Promise<Response> {
  const { env, projectId, uploader } = scope;
  const judged = judgeAttachmentPresign(input, input.maxBytes); if (judged instanceof Response) return judged;
  const attachmentId = newId(); const key = projectId === null ? noticeAttachmentObjectKey(attachmentId) : attachmentObjectKey(projectId, attachmentId); const now = Date.now();
  // Ten binds, then the live-owner condition's, then the fence's from the next free number.
  const live = liveOwner(projectId);
  const fence = fenceOf(scope)(11 + live.binds.length);
  const reserved = await env.DB.prepare(`
    INSERT INTO attachments (id, owner_kind, owner_id, project_id, ${uploaderColumn(uploader)}, file_name, content_type, bytes, storage_key, state, created_at, updated_at)
    SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'uploading', ?, ? WHERE ${live.sql}${fence.sql}
  `).bind(attachmentId, input.ownerKind, projectId, uploaderValue(uploader), judged.fileName, judged.contentType, input.bytes, key, now, now, ...live.binds, ...fence.binds).run();
  if ((reserved.meta.changes ?? 0) !== 1) return archived();
  const release = () => env.DB.prepare("DELETE FROM attachments WHERE id = ? AND state = 'uploading'").bind(attachmentId).run();
  let multipart: Awaited<ReturnType<typeof createMultipartPresign>>;
  try { multipart = await createMultipartPresign(env, key, input.bytes, ATTACHMENT_STORED_CONTENT_TYPE, PART_BYTES); }
  catch (error) { await release(); throw error; }
  if (!multipart) {
    if (env.APP_ENV === "dev") {
      await scope.audit("attachment.presign", attachmentId, { ...auditScope(projectId), bytes: input.bytes, contentType: judged.contentType, ownerKind: input.ownerKind });
      return reply(200, attachmentPresignResponseSchema.parse({ attachmentId, devDirect: true }));
    }
    await release();
    return reply(503, { error: "R2 S3 upload credentials are not configured" });
  }
  const storedFence = fenceOf(scope)(3 + live.binds.length);
  const stored = await env.DB.prepare(`
    UPDATE attachments SET upload_id = ? WHERE id = ? AND state = 'uploading' AND ${live.sql}${storedFence.sql}
  `).bind(multipart.uploadId, attachmentId, ...live.binds, ...storedFence.binds).run();
  if ((stored.meta.changes ?? 0) !== 1) {
    try { await abortMultipart(env, key, multipart.uploadId); } catch { await enqueueEmbeddedMediaCleanup(env.DB, [{ key, uploadId: multipart.uploadId, projectId }]); }
    await release();
    return reply(409, { error: "This project can no longer accept files", code: "project_unavailable" });
  }
  await scope.audit("attachment.presign", attachmentId, { ...auditScope(projectId), bytes: input.bytes, contentType: judged.contentType, ownerKind: input.ownerKind });
  return reply(200, attachmentPresignResponseSchema.parse({ attachmentId, uploadId: multipart.uploadId, partUrls: multipart.partUrls, partBytes: multipart.partBytes }));
}

const ownRow = (row: AttachmentRow | null, scope: AttachmentScope): row is AttachmentRow => Boolean(row && row.projectId === scope.projectId && isAttachmentUploadedBy(row, scope.uploader));

/** `PUT .../direct` (dev only): the bytes of a `devDirect` reservation, from its uploader alone, stored as octet-stream. */
export async function directAttachment(scope: AttachmentScope, attachmentId: string, body: ReadableStream | null): Promise<Response> {
  const row = await getAttachment(scope.env.DB, attachmentId);
  if (!ownRow(row, scope) || row.state !== "uploading") return reply(404, { error: "File upload is unavailable" });
  await scope.env.MEDIA.put(row.storageKey, body, { httpMetadata: { contentType: ATTACHMENT_STORED_CONTENT_TYPE } });
  return new Response(null, { status: 204 });
}

/**
 * `POST .../complete`: finishes the multipart upload, checks the stored object (its size is the size reserved, its type octet-stream), then promotes the row to `pending` under
 * the fence. A refused object is discarded claim-first. Idempotent for a row already `pending`.
 */
export async function completeAttachment(scope: AttachmentScope, attachmentId: string, data: { parts?: Array<{ partNumber: number; etag: string }> | undefined }): Promise<Response> {
  const { env, projectId } = scope;
  const row = await getAttachment(env.DB, attachmentId);
  if (!ownRow(row, scope)) return stray();
  const completed = () => reply(200, attachmentCompleteResponseSchema.parse({ attachmentId, state: "pending" }));
  if (row.state === "pending") return completed();
  if (row.state !== "uploading") return inUse();
  if (row.uploadId) {
    if (!data.parts?.length) return reply(400, { error: "Multipart uploads require completed parts" });
    try { validateMultipartParts(row.bytes, data.parts); } catch (error) { return reply(400, { error: error instanceof Error ? error.message : "Invalid multipart parts" }); }
    try { await completeMultipart(env, row.storageKey, row.uploadId, data.parts, row.bytes); }
    catch (error) { if (!await env.MEDIA.head(row.storageKey)) return reply(502, { error: error instanceof Error ? error.message : "Upload could not be completed" }); }
  }
  const head = await env.MEDIA.head(row.storageKey);
  if (!head) return reply(400, { error: "The file has not finished uploading", code: "upload_missing" });
  if (head.size !== row.bytes || head.httpMetadata?.contentType !== ATTACHMENT_STORED_CONTENT_TYPE) {
    if (!await claimAndDiscardUploadingAttachment(env, row)) return inUse();
    return reply(400, { error: head.size !== row.bytes ? "The uploaded file is not the size that was reserved" : "The uploaded file was not stored as expected", code: "attachment_rejected" });
  }
  const live = liveOwner(projectId);
  const fence = fenceOf(scope)(3 + live.binds.length);
  const promoted = await env.DB.prepare(`UPDATE attachments SET state = 'pending', upload_id = NULL, updated_at = ?
    WHERE id = ? AND state = 'uploading' AND ${live.sql}${fence.sql}`).bind(Date.now(), attachmentId, ...live.binds, ...fence.binds).run();
  if ((promoted.meta.changes ?? 0) !== 1) {
    const current = await getAttachment(env.DB, attachmentId);
    if (!current) return stray();
    if (current.state === "uploading") {
      if (!await claimAndDiscardUploadingAttachment(env, current)) return inUse();
      return reply(409, { error: "This project can no longer accept files", code: "project_unavailable" });
    }
    if (current.state !== "pending") return inUse();
    return completed();
  }
  await scope.audit("attachment.upload", attachmentId, { ...auditScope(projectId), bytes: row.bytes, contentType: row.contentType });
  return completed();
}

/** `POST .../abort`: a cancelled upload, the uploader's alone, in any Project state. */
export async function abortAttachmentUpload(scope: AttachmentScope, attachmentId: string): Promise<Response> {
  const row = await getAttachment(scope.env.DB, attachmentId);
  if (!ownRow(row, scope)) return stray();
  const outcome = await abortAttachment(scope.env, row);
  if (outcome === "gone") return stray();
  if (outcome === "in_use") return inUse();
  return new Response(null, { status: 204 });
}
