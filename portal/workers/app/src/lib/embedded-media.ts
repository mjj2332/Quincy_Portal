import { EMBEDDED_MEDIA_MAX_PER_POST, EMBEDDED_MEDIA_RETENTION_MS, sniffEmbeddedMediaType } from "@quincy/shared";
import { completeMultipart, validateMultipartParts } from "./r2s3";
import type { Env } from "../env";

/** Embedded media (#493): the D1 row plus the helpers every writer of it shares. */
export type EmbeddedMediaState = "uploading" | "pending" | "attached" | "detached";
export type EmbeddedMediaRow = {
  id: string; ownerKind: "project_comment" | "notice_post" | "whiteboard"; ownerId: string | null; projectId: string | null; uploaderId: string;
  kind: "image" | "video" | "preview_image"; contentType: string; bytes: number; originalKey: string; displayKey: string | null; posterKey: string | null;
  uploadId: string | null; state: EmbeddedMediaState; detachedAt: number | null; createdAt: number; updatedAt: number;
};

type RawRow = {
  id: string; owner_kind: EmbeddedMediaRow["ownerKind"]; owner_id: string | null; project_id: string | null; uploader_id: string; kind: EmbeddedMediaRow["kind"];
  content_type: string; bytes: number; original_key: string; display_key: string | null; poster_key: string | null; upload_id: string | null;
  state: EmbeddedMediaState; detached_at: number | null; created_at: number; updated_at: number;
};

export function embeddedMediaFromRaw(raw: RawRow): EmbeddedMediaRow {
  return {
    id: raw.id, ownerKind: raw.owner_kind, ownerId: raw.owner_id, projectId: raw.project_id, uploaderId: raw.uploader_id, kind: raw.kind,
    contentType: raw.content_type, bytes: Number(raw.bytes), originalKey: raw.original_key, displayKey: raw.display_key, posterKey: raw.poster_key,
    uploadId: raw.upload_id, state: raw.state, detachedAt: raw.detached_at === null ? null : Number(raw.detached_at), createdAt: Number(raw.created_at), updatedAt: Number(raw.updated_at),
  };
}

export async function getEmbeddedMedia(db: D1Database, mediaId: string): Promise<EmbeddedMediaRow | null> {
  const raw = await db.prepare("SELECT * FROM embedded_media WHERE id = ?").bind(mediaId).first<RawRow>();
  return raw ? embeddedMediaFromRaw(raw) : null;
}

export type CleanupEntry = { key: string; uploadId?: string | null; projectId?: string | null };

/**
 * Hands R2 objects (and the multipart uploads that may still create them) to the durable cleanup queue
 * (`embedded_media_cleanup`), which the background sweep drains. Idempotent: a key already queued keeps its row,
 * and gains an upload id if it had none.
 */
export async function enqueueEmbeddedMediaCleanup(db: D1Database, entries: CleanupEntry[], now = Date.now()): Promise<void> {
  if (!entries.length) return;
  await db.batch(entries.map((entry) => db.prepare(`
    INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
  `).bind(entry.key, entry.uploadId ?? null, entry.projectId ?? null, now)));
}

/**
 * Claim-first discard of an object whose completion could not finish (a rejection, a Project that went away). One batch deletes the
 * still-`uploading` row and queues its keys under that same claim, so the object is deleted only by the one writer that owned the row:
 * a row someone else has since promoted, attached or removed is never touched, and neither is its object. Once the claim is won the
 * object is deleted and its queue entry dropped. If R2 refuses, the entry stays for the drain. Returns whether the claim was won.
 */
export async function claimAndDiscardUploadingMedia(env: Pick<Env, "DB" | "MEDIA">, row: Pick<EmbeddedMediaRow, "id" | "originalKey" | "uploadId" | "projectId">): Promise<boolean> {
  if (!await claimUploadingMedia(env.DB, row.id)) return false;
  if (await deleteEmbeddedMediaObjects(env, [{ originalKey: row.originalKey, displayKey: null, posterKey: null }])) {
    await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND claimed_until IS NULL").bind(row.originalKey).run();
  }
  return true;
}

/** The claim itself: one batch queues the still-`uploading` row's key and upload id and deletes the row. True only for the writer whose delete took the row. */
async function claimUploadingMedia(db: D1Database, mediaId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at)
      SELECT original_key, upload_id, project_id, ? FROM embedded_media WHERE id = ? AND state = 'uploading'
      ON CONFLICT(storage_key) DO UPDATE SET project_id = COALESCE(embedded_media_cleanup.project_id, excluded.project_id), upload_id = COALESCE(embedded_media_cleanup.upload_id, excluded.upload_id), queued_at = MAX(embedded_media_cleanup.queued_at + 1, excluded.queued_at), claimed_until = NULL
    `).bind(Date.now(), mediaId),
    db.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'uploading'").bind(mediaId),
  ]);
  return (results[1]!.meta.changes ?? 0) === 1;
}

/** R2 answers an upload it no longer knows (already aborted or completed) in several shapes; for an abort that is as good as done. */
function isMissingUpload(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown } | null;
  if (!value || typeof value !== "object") return false;
  const text = [value.code, value.name, value.message].filter((item): item is string => typeof item === "string").join(" ");
  return value.status === 404 || /NoSuchUpload|no such upload|upload (?:does not exist|was not found)|multipart upload (?:does not exist|not found)|already aborted|\(10024\)/i.test(text);
}

/**
 * A cancelled upload (#494). Claim-first like a rejection, and the multipart upload is killed before its object is deleted: a part
 * that lands after the delete could still complete the upload and resurrect the object (lessons). If R2 will not abort, the queue
 * entry (which carries the upload id) stays and the sweep finishes the job. Returns whether the claim was won.
 */
export async function claimAndAbortUploadingMedia(env: Pick<Env, "DB" | "MEDIA">, row: Pick<EmbeddedMediaRow, "id" | "originalKey" | "uploadId" | "projectId">): Promise<boolean> {
  if (!await claimUploadingMedia(env.DB, row.id)) return false;
  let dead = true;
  if (row.uploadId) {
    try { await env.MEDIA.resumeMultipartUpload(row.originalKey, row.uploadId).abort(); }
    catch (error) { dead = isMissingUpload(error); }
  }
  if (dead && await deleteEmbeddedMediaObjects(env, [{ originalKey: row.originalKey, displayKey: null, posterKey: null }])) {
    await env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND claimed_until IS NULL").bind(row.originalKey).run();
  }
  return true;
}

/**
 * Cancels an upload that has no owner yet: a row still `uploading` (the multipart upload is aborted, then its object deleted), or one
 * already `pending` whose completion won (claimed the way the sweep claims it, `detached` at 0, so nothing can attach it, then its
 * objects and poster go). An attached or detached row belongs to a comment and is `in_use`. A lost claim re-reads the row once, because
 * the writer that won may have promoted it.
 */
export async function abortEmbeddedMedia(env: Pick<Env, "DB" | "MEDIA">, row: EmbeddedMediaRow): Promise<"aborted" | "in_use" | "gone"> {
  let current = row;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (current.state === "uploading") { if (await claimAndAbortUploadingMedia(env, current)) return "aborted"; }
    else if (current.state === "pending" && current.ownerId === null) {
      const claim = await env.DB.prepare(`
        UPDATE embedded_media SET state = 'detached', detached_at = 0, owner_id = COALESCE(owner_id, id), updated_at = ?
        WHERE id = ? AND state = 'pending' AND owner_id IS NULL
        RETURNING original_key AS originalKey, display_key AS displayKey, poster_key AS posterKey
      `).bind(Date.now(), current.id).all<Pick<EmbeddedMediaRow, "originalKey" | "displayKey" | "posterKey">>();
      const claimed = claim.results[0];
      if (claimed) {
        if (!await deleteEmbeddedMediaObjects(env, [claimed])) await enqueueEmbeddedMediaCleanup(env.DB, [claimed.originalKey, claimed.displayKey, claimed.posterKey].filter((key): key is string => Boolean(key)).map((key) => ({ key, projectId: current.projectId })));
        await env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'detached' AND detached_at = 0").bind(current.id).run();
        return "aborted";
      }
    } else return "in_use";
    const fresh = await getEmbeddedMedia(env.DB, current.id);
    if (!fresh) return "gone";
    current = fresh;
  }
  return "in_use";
}

/** Every object a row can own. Best effort: returns whether R2 accepted the deletes. */
export async function deleteEmbeddedMediaObjects(env: Pick<Env, "MEDIA">, rows: Array<Pick<EmbeddedMediaRow, "originalKey" | "displayKey" | "posterKey">>): Promise<boolean> {
  const keys = rows.flatMap((row) => [row.originalKey, row.displayKey, row.posterKey]).filter((key): key is string => Boolean(key));
  if (!keys.length) return true;
  try {
    for (let index = 0; index < keys.length; index += 1000) await env.MEDIA.delete(keys.slice(index, index + 1000));
    return true;
  } catch { return false; }
}

/** What owns a set of embedded media: a Project comment (inside its Project) or a Notice board post (no Project). */
export type OwnedMediaOwner = { ownerKind: "project_comment" | "notice_post"; ownerId: string; projectId: string | null };

type OwnedMediaRow = { id: string; state: EmbeddedMediaState; owner_id: string | null; uploader_id: string; project_id: string | null; owner_kind: string; kind: string; created_at: number; detached_at: number | null };

/**
 * Pre-checks the images a save wants before its batch so an obvious mistake is a clean 400. It is only advisory: the batch's
 * own statements (`ownedMediaStatements`) are the authority and re-validate every id in SQL, so a concurrent edit, delete or
 * sweep between this read and the batch can never leave a retained image detached. More than ten, or a duplicate, is refused.
 */
export async function preflightOwnedMedia(db: D1Database, input: OwnedMediaOwner & { uploaderId: string; ids: string[]; videoIds?: string[]; now?: number }): Promise<boolean> {
  const videos = new Set(input.videoIds ?? []);
  const now = input.now ?? Date.now();
  if (input.ids.length > EMBEDDED_MEDIA_MAX_PER_POST || new Set(input.ids).size !== input.ids.length) return false;
  if (!input.ids.length) return true;
  const placeholders = input.ids.map(() => "?").join(", ");
  const found = (await db.prepare(`SELECT id, state, owner_id, uploader_id, project_id, owner_kind, kind, created_at, detached_at FROM embedded_media WHERE id IN (${placeholders})`).bind(...input.ids).all<OwnedMediaRow>()).results;
  const byId = new Map(found.map((row) => [row.id, row]));
  const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
  for (const id of input.ids) {
    const row = byId.get(id);
    if (!row || row.project_id !== input.projectId || row.owner_kind !== input.ownerKind || row.kind !== (videos.has(id) ? "video" : "image")) return false;
    const fresh = row.state === "pending" && row.owner_id === null && row.uploader_id === input.uploaderId && Number(row.created_at) > cutoff;
    const mine = row.owner_id === input.ownerId && (row.state === "attached" || (row.state === "detached" && Number(row.detached_at) > cutoff));
    if (!fresh && !mine) return false;
  }
  return true;
}

/**
 * The media statements of a save, appended after every other statement so positional results stay valid and fenced on the
 * winner (`fence`: an EXISTS clause that is true only while this save still owns the right to write, lessons #364). They are
 * self-validating: every wanted id is attached by one UPDATE whose WHERE accepts only a fresh pending image upload of this
 * uploader in this scope, or a row this owner already owns (attached, or detached under seven days), then everything else the
 * owner holds is detached, then a guard statement violates a CHECK (rolling the whole batch back) if the wanted ids are not all
 * attached to this owner. A link preview's image (`preview_image`, #497) is never touched here: `linkPreviewStatements` owns it. A node names its kind (`videoIds` are the video nodes, every other id an image): the attach and the guard both
 * require the stored row to be of that kind, so a video node cannot take an image row, nor the reverse. A save that lost the fence is skipped.
 */
export function ownedMediaStatements(db: D1Database, input: OwnedMediaOwner & { uploaderId: string; ids: string[]; videoIds?: string[]; now: number; fence: { sql: string; binds: unknown[] }; guardId: string }): D1PreparedStatement[] {
  const { fence, ids, now } = input;
  const videos = new Set(input.videoIds ?? []);
  const kindOf = (id: string) => (videos.has(id) ? "video" : "image");
  const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
  const marks = ids.map(() => "?").join(", ");
  const scope = input.projectId === null ? "project_id IS NULL" : "project_id = ?";
  const scopeBinds = input.projectId === null ? [] : [input.projectId];
  const statements = ids.map((id) => db.prepare(`
    UPDATE embedded_media SET state = 'attached', owner_id = ?, detached_at = NULL, updated_at = ?
    WHERE id = ? AND owner_kind = ? AND ${scope} AND kind = ? AND ${fence.sql}
      AND ((state = 'pending' AND owner_id IS NULL AND uploader_id = ? AND created_at > ?)
        OR (owner_id = ? AND (state = 'attached' OR (state = 'detached' AND detached_at > ?))))
  `).bind(input.ownerId, now, id, input.ownerKind, ...scopeBinds, kindOf(id), ...fence.binds, input.uploaderId, cutoff, input.ownerId, cutoff));
  statements.push(db.prepare(`
    UPDATE embedded_media SET state = 'detached', detached_at = ?, updated_at = ?
    WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' AND kind <> 'preview_image' ${ids.length ? `AND id NOT IN (${marks})` : ""} AND ${fence.sql}
  `).bind(now, now, input.ownerKind, input.ownerId, ...ids, ...fence.binds));
  if (ids.length) {
    statements.push(db.prepare(`
      INSERT INTO embedded_media (id, owner_kind, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at)
      SELECT ?, ?, ?, 'image', 'guard', 0, ?, 'uploading', ?, ?
      WHERE ${fence.sql} AND (SELECT COUNT(*) FROM embedded_media WHERE owner_kind = ? AND owner_id = ? AND state = 'attached' AND (${ids.map(() => "(id = ? AND kind = ?)").join(" OR ")})) <> ?
    `).bind(`guard-${input.guardId}`, input.ownerKind, input.uploaderId, `guard/${input.guardId}`, now, now, ...fence.binds, input.ownerKind, input.ownerId, ...ids.flatMap((id) => [id, kindOf(id)]), ids.length));
  }
  return statements;
}

/** True when a batch failed on the media guard's CHECK: the caller reports a conflict, and rethrows anything else. */
export function isMediaGuardFailure(error: unknown, ids: string[] | undefined): boolean {
  return Boolean(ids?.length) && /CHECK constraint failed/i.test(error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error));
}

/**
 * After an owner was deleted its media is left detached and due now (the delete's own batch did that). Deletes the objects, then
 * the rows, best effort: the daily sweep is the backstop (#493).
 */
export async function purgeDetachedOwnerMedia(env: Pick<Env, "DB" | "MEDIA">, ownerKind: OwnedMediaOwner["ownerKind"], ownerId: string): Promise<void> {
  try {
    const owned = (await env.DB.prepare("SELECT * FROM embedded_media WHERE owner_kind = ? AND owner_id = ? AND state = 'detached'").bind(ownerKind, ownerId).all<Parameters<typeof embeddedMediaFromRaw>[0]>()).results.map(embeddedMediaFromRaw);
    if (owned.length && await deleteEmbeddedMediaObjects(env, owned)) await env.DB.batch(owned.map((row) => env.DB.prepare("DELETE FROM embedded_media WHERE id = ? AND state = 'detached' AND owner_id = ?").bind(row.id, ownerId)));
  } catch { /* the sweep reclaims rows left behind */ }
}

export type UploadVerdict = { ok: true } | { ok: false; status: 400 | 409 | 502; body: Record<string, unknown> };

/**
 * The middle of every completion (#493, #496): finishes the multipart upload if there is one, then checks the stored object
 * against what was reserved (size, content type, first bytes). A rejection is claim-first: the still-`uploading` row and its
 * queue entry change in one batch and only the winner deletes the object. The caller then promotes the row to `pending`
 * under its own fence (a live Project, or nothing for a Notice board post).
 */
export async function verifyUploadedEmbeddedObject(env: Env, row: EmbeddedMediaRow, parts: Array<{ partNumber: number; etag: string }> | undefined): Promise<UploadVerdict> {
  if (row.uploadId) {
    if (!parts?.length) return { ok: false, status: 400, body: { error: "Multipart uploads require completed parts" } };
    try { validateMultipartParts(row.bytes, parts); } catch (error) { return { ok: false, status: 400, body: { error: error instanceof Error ? error.message : "Invalid multipart parts" } }; }
    try { await completeMultipart(env, row.originalKey, row.uploadId, parts, row.bytes); }
    catch (error) {
      // A retry after a lost response finds the upload already completed: carry on if the object is there.
      if (!await env.MEDIA.head(row.originalKey)) return { ok: false, status: 502, body: { error: error instanceof Error ? error.message : "Upload could not be completed" } };
    }
  }
  const head = await env.MEDIA.head(row.originalKey);
  if (!head) return { ok: false, status: 400, body: { error: "The file has not finished uploading", code: "upload_missing" } };
  const reject = async (message: string): Promise<UploadVerdict> => {
    if (!await claimAndDiscardUploadingMedia(env, row)) return { ok: false, status: 409, body: { error: "This media is already in use", code: "media_not_uploading" } };
    return { ok: false, status: 400, body: { error: message, code: "media_rejected" } };
  };
  if (head.size !== row.bytes) return reject("The uploaded file is not the size that was reserved");
  if (head.httpMetadata?.contentType !== row.contentType) return reject("The uploaded file is not the type that was reserved");
  const first = await env.MEDIA.get(row.originalKey, { range: { offset: 0, length: 16 } });
  const sniffed = first ? sniffEmbeddedMediaType(row.kind === "video" ? "video" : "image", new Uint8Array(await first.arrayBuffer())) : null;
  // A video's declared type is the browser's guess from the file extension, so any MP4 or MOV container is accepted whichever it declared.
  if (row.kind === "video" ? !sniffed : sniffed !== row.contentType) return reject(row.kind === "video" ? "The uploaded file is not an MP4 or MOV video" : "The uploaded file is not a JPEG, PNG or WebP image");
  return { ok: true };
}
