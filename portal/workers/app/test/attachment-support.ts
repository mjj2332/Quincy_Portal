import { attachmentObjectKey } from "@quincy/shared";
import { database, ids } from "./embedded-media-support";

/** Attachments (#952) reuse the Embedded media fixture (people, Projects, sessions); this adds rows of their own table. */
export type AttachmentRowInput = {
  id?: string; projectId?: string; uploader?: string; state?: "uploading" | "pending" | "attached" | "detached"; ownerId?: string | null; ownerKind?: "project_comment" | "notice_post" | "video_note";
  fileName?: string; contentType?: string; bytes?: number; detachedAt?: number | null; createdAt?: number; uploadId?: string | null; object?: Uint8Array | null;
};

/** Inserts an `attachments` row and (unless `object: null`) its stored object, stored as octet-stream as the upload path stores it. */
export async function seedAttachment(input: AttachmentRowInput = {}) {
  const id = input.id ?? crypto.randomUUID(); const projectId = input.projectId ?? ids.project; const state = input.state ?? "pending";
  const ownerId = input.ownerId === undefined ? (state === "attached" || state === "detached" ? crypto.randomUUID() : null) : input.ownerId;
  const detachedAt = input.detachedAt === undefined ? (state === "detached" ? Date.now() : null) : input.detachedAt;
  const bytes = input.bytes ?? 32; const key = attachmentObjectKey(projectId, id); const createdAt = input.createdAt ?? Date.now();
  await database.DB.prepare("INSERT INTO attachments (id, owner_kind, owner_id, project_id, uploader_id, file_name, content_type, bytes, storage_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.ownerKind ?? "project_comment", ownerId, projectId, input.uploader ?? ids.member, input.fileName ?? "Floor plan.pdf", input.contentType ?? "application/pdf", bytes, key, input.uploadId ?? null, state, detachedAt, createdAt, createdAt).run();
  if (input.object !== null) await database.MEDIA.put(key, input.object ?? fileBytes(bytes), { httpMetadata: { contentType: "application/octet-stream" } });
  return { id, key };
}

export function fileBytes(size = 32): Uint8Array { const bytes = new Uint8Array(size); for (let i = 0; i < size; i += 1) bytes[i] = (i * 13) % 251; return bytes; }
export const attachmentRow = (id: string) => database.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<Record<string, unknown>>();
export const attachmentAudits = (id: string) => database.DB.prepare("SELECT action, actor_id AS actorId, meta_json AS meta FROM audit_log WHERE target_type = 'attachment' AND target_id = ? ORDER BY created_at, rowid").bind(id).all<{ action: string; actorId: string; meta: string | null }>().then((result) => result.results);
/** A comment document: a line of text, then one attachment node per id. */
export const fileDoc = (...attachmentIds: string[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Files" }] }, ...attachmentIds.map((attachmentId) => ({ type: "attachment", attrs: { attachmentId } }))] });
