import { ATTACHMENT_RETENTION_MS, type AttachmentOwnerKind } from "@quincy/shared";
import { enqueueEmbeddedMediaCleanup } from "@quincy/db";
import type { Env } from "../env";
import { isMissingUpload, uploaderColumn, uploaderValue, type MediaUploader } from "./embedded-media";
import { auditMeta, type AuditPrincipal } from "./audit";
import { SQL_UUID_V4 } from "./sql-uuid";

/**
 * Attachments (#945, tracer #952): the D1 row and every helper that writes it outside the upload core. The lifecycle is Embedded
 * media's (`lib/embedded-media.ts`), state for state: `uploading` → `pending` → `attached` ⇄ `detached`. The claim-first discard
 * and abort below are copies of the media originals against this table, kept separate so no media reader can ever meet a file.
 * Objects nobody owns any more go to `embedded_media_cleanup`, keyed by storage key.
 */
export type AttachmentState = "uploading" | "pending" | "attached" | "detached";
export type AttachmentRow = {
  id: string; ownerKind: AttachmentOwnerKind; ownerId: string | null; projectId: string | null; uploaderId: string | null; uploaderGuestId: string | null;
  fileName: string; contentType: string; bytes: number; storageKey: string; uploadId: string | null; state: AttachmentState; detachedAt: number | null; createdAt: number; updatedAt: number;
};
type RawRow = {
  id: string; owner_kind: AttachmentOwnerKind; owner_id: string | null; project_id: string | null; uploader_id: string | null; uploader_guest_id: string | null; file_name: string; content_type: string;
  bytes: number; storage_key: string; upload_id: string | null; state: AttachmentState; detached_at: number | null; created_at: number; updated_at: number;
};

export function attachmentFromRaw(raw: RawRow): AttachmentRow {
  return {
    id: raw.id, ownerKind: raw.owner_kind, ownerId: raw.owner_id, projectId: raw.project_id, uploaderId: raw.uploader_id, uploaderGuestId: raw.uploader_guest_id, fileName: raw.file_name,
    contentType: raw.content_type, bytes: Number(raw.bytes), storageKey: raw.storage_key, uploadId: raw.upload_id, state: raw.state,
    detachedAt: raw.detached_at === null ? null : Number(raw.detached_at), createdAt: Number(raw.created_at), updatedAt: Number(raw.updated_at),
  };
}

export async function getAttachment(db: D1Database, attachmentId: string): Promise<AttachmentRow | null> {
  const raw = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first<RawRow>();
  return raw ? attachmentFromRaw(raw) : null;
}

export const isAttachmentUploadedBy = (row: Pick<AttachmentRow, "uploaderId" | "uploaderGuestId">, uploader: MediaUploader): boolean =>
  ("userId" in uploader ? row.uploaderId === uploader.userId : row.uploaderGuestId === uploader.guestId);

async function deleteObject(env: Pick<Env, "MEDIA">, key: string): Promise<boolean> {
  try { await env.MEDIA.delete(key); return true; } catch { return false; }
}

/** The claim (`claimUploadingMedia`'s twin): one batch queues the still-`uploading` row's key and upload id and deletes the row. True only for the writer whose delete took it. */
async function claimUploadingAttachment(db: D1Database, attachmentId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at)
      SELECT storage_key, upload_id, project_id, ? FROM attachments WHERE id = ? AND state = 'uploading'
      ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
    `).bind(Date.now(), attachmentId),
    db.prepare("DELETE FROM attachments WHERE id = ? AND state = 'uploading'").bind(attachmentId),
  ]);
  return (results[1]!.meta.changes ?? 0) === 1;
}

/** Claim-first discard of an upload whose completion was refused or lost (`claimAndDiscardUploadingMedia`'s twin). Only the claim's winner deletes the object; a refusing R2 leaves the queue entry for the drain. */
export async function claimAndDiscardUploadingAttachment(env: Pick<Env, "DB" | "MEDIA">, row: Pick<AttachmentRow, "id" | "storageKey">): Promise<boolean> {
  if (!await claimUploadingAttachment(env.DB, row.id)) return false;
  if (await deleteObject(env, row.storageKey)) await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND claimed_until IS NULL").bind(row.storageKey).run();
  return true;
}

/**
 * Cancels an upload that has no owner yet (`abortEmbeddedMedia`'s twin): an `uploading` row is claimed and its multipart upload killed before the object is deleted (a late part could
 * otherwise complete it, lessons); a `pending` row is claimed as the sweep would claim it (`detached` at 0, so nothing can attach it), then its object and row go. An attached or
 * detached row belongs to a post and is `in_use`. A lost claim re-reads the row once.
 */
export async function abortAttachment(env: Pick<Env, "DB" | "MEDIA">, row: AttachmentRow): Promise<"aborted" | "in_use" | "gone"> {
  let current = row;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (current.state === "uploading") {
      if (await claimUploadingAttachment(env.DB, current.id)) {
        let dead = true;
        if (current.uploadId) { try { await env.MEDIA.resumeMultipartUpload(current.storageKey, current.uploadId).abort(); } catch (error) { dead = isMissingUpload(error); } }
        if (dead && await deleteObject(env, current.storageKey)) await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND claimed_until IS NULL").bind(current.storageKey).run();
        return "aborted";
      }
    } else if (current.state === "pending" && current.ownerId === null) {
      const claimed = await env.DB.prepare(`
        UPDATE attachments SET state = 'detached', detached_at = 0, owner_id = COALESCE(owner_id, id), updated_at = ?
        WHERE id = ? AND state = 'pending' AND owner_id IS NULL RETURNING storage_key AS storageKey
      `).bind(Date.now(), current.id).first<{ storageKey: string }>();
      if (claimed) {
        if (!await deleteObject(env, claimed.storageKey)) await enqueueEmbeddedMediaCleanup(env.DB, [{ key: claimed.storageKey, projectId: current.projectId }]);
        await env.DB.prepare("DELETE FROM attachments WHERE id = ? AND state = 'detached' AND detached_at = 0").bind(current.id).run();
        return "aborted";
      }
    } else return "in_use";
    const fresh = await getAttachment(env.DB, current.id);
    if (!fresh) return "gone";
    current = fresh;
  }
  return "in_use";
}

/** What owns a set of Attachments. #952 writes `project_comment`; the Notice board (#954) has no Project, a Video note (#955) has one. */
export type AttachmentOwner = { ownerKind: AttachmentOwnerKind; ownerId: string; projectId: string | null };

type PreflightRow = { id: string; state: AttachmentState; owner_id: string | null; uploader_id: string | null; uploader_guest_id: string | null; project_id: string | null; owner_kind: string; created_at: number; detached_at: number | null };

/**
 * The advisory pre-read of the Attachments a save names (`preflightOwnedMedia`'s twin), so an obvious mistake is a clean 400. Each id must be a fresh `pending` upload of this uploader
 * for this owner kind in this scope (under seven days old), or a row this owner already holds (attached, or detached under seven days). At most `max`, no duplicates. The batch's own
 * statements (`ownedAttachmentStatements`) re-check every id in SQL and are the authority.
 */
export async function preflightOwnedAttachments(db: D1Database, input: AttachmentOwner & { uploader: MediaUploader; ids: string[]; max: number; now?: number }): Promise<boolean> {
  if (input.ids.length > input.max || new Set(input.ids).size !== input.ids.length) return false;
  if (!input.ids.length) return true;
  const found = (await db.prepare(`SELECT id, state, owner_id, uploader_id, uploader_guest_id, project_id, owner_kind, created_at, detached_at FROM attachments WHERE id IN (${input.ids.map(() => "?").join(", ")})`).bind(...input.ids).all<PreflightRow>()).results;
  const byId = new Map(found.map((row) => [row.id, row]));
  const cutoff = (input.now ?? Date.now()) - ATTACHMENT_RETENTION_MS;
  return input.ids.every((id) => {
    const row = byId.get(id);
    if (!row || row.project_id !== input.projectId || row.owner_kind !== input.ownerKind) return false;
    const fresh = row.state === "pending" && row.owner_id === null && row[uploaderColumn(input.uploader)] === uploaderValue(input.uploader) && Number(row.created_at) > cutoff;
    const mine = row.owner_id === input.ownerId && (row.state === "attached" || (row.state === "detached" && Number(row.detached_at) > cutoff));
    return fresh || mine;
  });
}

/**
 * The Attachment statements of a save, appended after every statement whose result is read by position and fenced on the save's winner (`ownedMediaStatements`' twin). Self-validating:
 * per id, one UPDATE takes a fresh pending upload of this uploader (and one re-attaches this owner's recently detached row), each followed by its own `attachment.attach` audit row
 * written only when that UPDATE changed a row; then an audit row per attachment about to be detached and the detach itself, under the same predicate; then a guard that violates
 * `bytes > 0` (rolling the whole batch back) unless every wanted id is attached to this owner. The audit rows are written in SQL so they name exactly what the batch did.
 */
export function ownedAttachmentStatements(db: D1Database, input: AttachmentOwner & { uploader: MediaUploader; ids: string[]; now: number; fence: { sql: string; binds: unknown[] }; guardId: string; principal: AuditPrincipal }): D1PreparedStatement[] {
  const { fence, ids, now } = input;
  const cutoff = now - ATTACHMENT_RETENTION_MS;
  const scope = input.projectId === null ? "project_id IS NULL" : "project_id = ?";
  const scopeBinds = input.projectId === null ? [] : [input.projectId];
  const actor = input.principal?.id ?? null;
  const meta = auditMeta(input.principal, { ownerKind: input.ownerKind, ownerId: input.ownerId });
  const attachAudit = (id: string) => db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ${SQL_UUID_V4}, ?, 'attachment.attach', 'attachment', ?, ?, ? WHERE changes() = 1`).bind(actor, id, meta, now);
  const statements: D1PreparedStatement[] = [];
  for (const id of ids) {
    statements.push(db.prepare(`
      UPDATE attachments SET state = 'attached', owner_id = ?, detached_at = NULL, updated_at = ?
      WHERE id = ? AND owner_kind = ? AND ${scope} AND ${fence.sql} AND state = 'pending' AND owner_id IS NULL AND ${uploaderColumn(input.uploader)} = ? AND created_at > ?
    `).bind(input.ownerId, now, id, input.ownerKind, ...scopeBinds, ...fence.binds, uploaderValue(input.uploader), cutoff), attachAudit(id));
    statements.push(db.prepare(`
      UPDATE attachments SET state = 'attached', detached_at = NULL, updated_at = ?
      WHERE id = ? AND owner_kind = ? AND ${scope} AND ${fence.sql} AND owner_id = ? AND state = 'detached' AND detached_at > ?
    `).bind(now, id, input.ownerKind, ...scopeBinds, ...fence.binds, input.ownerId, cutoff), attachAudit(id));
  }
  const keep = ids.length ? `AND id NOT IN (${ids.map(() => "?").join(", ")})` : "";
  statements.push(
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ${SQL_UUID_V4}, ?, 'attachment.detach', 'attachment', id, ?, ? FROM attachments
      WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' ${keep} AND ${fence.sql}`).bind(actor, meta, now, input.ownerKind, input.ownerId, ...ids, ...fence.binds),
    db.prepare(`UPDATE attachments SET state = 'detached', detached_at = ?, updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' ${keep} AND ${fence.sql}`)
      .bind(now, now, input.ownerKind, input.ownerId, ...ids, ...fence.binds),
  );
  if (ids.length) {
    statements.push(db.prepare(`
      INSERT INTO attachments (id, owner_kind, owner_id, project_id, ${uploaderColumn(input.uploader)}, file_name, content_type, bytes, storage_key, state, created_at, updated_at)
      SELECT ?, 'project_comment', NULL, NULL, ?, 'guard', 'guard', 0, ?, 'uploading', ?, ?
      WHERE ${fence.sql} AND (SELECT COUNT(*) FROM attachments WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' AND id IN (${ids.map(() => "?").join(", ")})) <> ?
    `).bind(`guard-${input.guardId}`, uploaderValue(input.uploader), `guard/attachment/${input.guardId}`, now, now, ...fence.binds, input.ownerKind, input.ownerId, ...ids, ids.length));
  }
  return statements;
}

/**
 * The statements a post's delete adds to its own batch: an audit row per attached file, then every attached or detached row is detached and due now (`detached_at = 0`), so a download
 * stops the moment the post is gone. Both are conditioned on the post's own delete audit row (`deleteAuditId`), which the caller writes earlier in the same batch only when its delete
 * won. The objects and rows are reclaimed by the sweep (#953).
 */
export function deletedOwnerAttachmentStatements(db: D1Database, input: { ownerKind: AttachmentOwnerKind; ownerId: string; now: number; principal: AuditPrincipal; deleteAuditId: string }): D1PreparedStatement[] {
  const won = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
  const meta = auditMeta(input.principal, { ownerKind: input.ownerKind, ownerId: input.ownerId, reason: "owner_deleted" });
  return [
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ${SQL_UUID_V4}, ?, 'attachment.detach', 'attachment', id, ?, ? FROM attachments
      WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' AND ${won}`).bind(input.principal?.id ?? null, meta, input.now, input.ownerKind, input.ownerId, input.deleteAuditId),
    db.prepare(`UPDATE attachments SET state = 'detached', detached_at = 0, updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND state IN ('attached', 'detached') AND ${won}`)
      .bind(input.now, input.ownerKind, input.ownerId, input.deleteAuditId),
  ];
}

/** True when a batch failed on the attachment guard's CHECK. */
export function isAttachmentGuardFailure(error: unknown, ids: string[] | undefined): boolean {
  return Boolean(ids?.length) && /CHECK constraint failed/i.test(error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error));
}
