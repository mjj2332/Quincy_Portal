import type { Context } from "hono";
import {
  inspectOverlayPng, OVERLAY_PNG_MESSAGES, SOCIAL_OVERLAY_BODY_SLACK_BYTES, SOCIAL_OVERLAY_MAX_BYTES, socialOverlayDto, socialOverlayImagePath,
  type OverlayPngResult, type SocialOverlayDto,
} from "@quincy/shared";
import type { AppEnv, Env, SessionUser } from "../env";
import { auditMeta } from "./audit";
import { readBoundedBytes } from "./bounded-body";
import { newId } from "./ids";

/** The Social overlay library (#869): row shape, the DTO, the multipart reader and the write helpers. See `routes/social-overlays.ts` for the endpoints. */
export type OverlayRow = {
  id: string; name: string; platform_label: string; image_key: string; image_rev: number; width: number; height: number; bytes: number; is_default: number;
  archived_at: number | null; created_at: number; updated_at: number; updated_by: string; updated_by_name: string;
};
const SELECT = `SELECT o.id, o.name, o.platform_label, o.image_key, o.image_rev, o.width, o.height, o.bytes, o.is_default, o.archived_at, o.created_at, o.updated_at, o.updated_by, COALESCE(u.name, '') AS updated_by_name
  FROM social_overlays o LEFT JOIN user u ON u.id = o.updated_by`;

export const overlayKey = (overlayId: string, imageUuid: string): string => `social-overlays/${overlayId}/${imageUuid}.png`;
const uuidOfKey = (key: string): string => key.slice(key.lastIndexOf("/") + 1, -".png".length);

export function overlayDto(row: OverlayRow): SocialOverlayDto {
  return socialOverlayDto.parse({
    id: row.id, name: row.name, platformLabel: row.platform_label, isDefault: row.is_default === 1, archivedAt: row.archived_at,
    imageUrl: socialOverlayImagePath(row.id, uuidOfKey(row.image_key)), width: row.width, height: row.height, bytes: row.bytes, revision: row.image_rev,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: { id: row.updated_by, name: row.updated_by_name },
  });
}

export const listOverlays = async (db: D1Database): Promise<OverlayRow[]> =>
  (await db.prepare(`${SELECT} ORDER BY o.is_default DESC, o.name COLLATE NOCASE, o.id`).all<OverlayRow>()).results;
export const getOverlay = (db: D1Database, id: string): Promise<OverlayRow | null> => db.prepare(`${SELECT} WHERE o.id = ?1`).bind(id).first<OverlayRow>();
export const nameTaken = async (db: D1Database, name: string, exceptId: string | null): Promise<boolean> =>
  (await db.prepare("SELECT 1 AS hit FROM social_overlays WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2").bind(name, exceptId).first()) !== null;
export const isUnique = (error: unknown, what: RegExp): boolean => error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && what.test(error.message);

export type OverlayError = { status: 400 | 404 | 409 | 413 | 422; code: string; message: string };
export const overlayError = (c: Context<AppEnv>, e: OverlayError): Response => c.json({ error: e.message, code: e.code }, e.status);
export const pngRefusal = (result: Extract<OverlayPngResult, { ok: false }>): OverlayError => ({ status: 422, code: result.code, message: OVERLAY_PNG_MESSAGES[result.code] });

/**
 * Reads a multipart body with a ceiling BEFORE any parse (`readBoundedBytes` refuses a declared length over it and stops a chunked body at it), so an oversize upload never reaches `formData()`.
 * The `image` part must be a File no larger than the cap. Text fields come back as strings.
 */
export async function readOverlayForm(c: Context<AppEnv>): Promise<{ fields: Record<string, string>; image: Uint8Array | null } | OverlayError> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) return { status: 400, code: "invalid_form", message: "Send the overlay as multipart form data." };
  const body = await readBoundedBytes(c.req.raw, SOCIAL_OVERLAY_MAX_BYTES + SOCIAL_OVERLAY_BODY_SLACK_BYTES);
  if (!body) return { status: 413, code: "overlay_too_large", message: "The PNG is larger than 8 MB." };
  let form: FormData;
  try { form = await new Response(body.buffer as ArrayBuffer, { headers: { "content-type": contentType } }).formData(); }
  catch { return { status: 400, code: "invalid_form", message: "The upload could not be read." }; }
  const fields: Record<string, string> = {}; let image: Uint8Array | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") { fields[key] = value; continue; }
    if (key !== "image") continue;
    if (value.size > SOCIAL_OVERLAY_MAX_BYTES) return { status: 413, code: "overlay_too_large", message: "The PNG is larger than 8 MB." };
    image = new Uint8Array(await value.arrayBuffer());
  }
  return { fields, image };
}

export const inspectUpload = (image: Uint8Array | null): { width: number; height: number } | OverlayError => {
  if (!image) return { status: 400, code: "image_required", message: "Choose a PNG to upload." };
  const result = inspectOverlayPng(image);
  return result.ok ? { width: result.width, height: result.height } : pngRefusal(result);
};

/** The audit insert that only lands when the statement before it changed a row, so a refused write leaves no audit row. */
export function fencedAudit(env: Env, principal: Pick<SessionUser, "id" | "impersonatedBy" | "via">, action: string, overlayId: string, meta: Record<string, unknown>, at: number): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, ?3, 'social_overlay', ?4, ?5, ?6 WHERE changes() > 0")
    .bind(newId(), principal.id, action, overlayId, auditMeta(principal, meta), at);
}

/**
 * Cleanup ownership for an overlay PNG (the poster pattern of `embedded-media-upload.ts`). The key is queued in `embedded_media_cleanup` BEFORE the PUT, so an object written by a request
 * that then dies is swept by the background drain. The row write is fenced on the reservation (still ours, unclaimed) and the same batch dequeues it, so a sweep that claimed it wins and the write loses.
 */
export async function reserveOverlayObject(db: D1Database, key: string): Promise<number> {
  const queuedAt = Date.now();
  await db.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?1, NULL, NULL, ?2)").bind(key, queuedAt).run();
  return queuedAt;
}
/** The reservation is still ours and unclaimed. `key` and `queuedAt` are numbered parameters already bound by the caller. */
export const reservationHeld = (key: string, queuedAt: string): string => `EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ${key} AND queued_at = ${queuedAt} AND claimed_until IS NULL)`;
export const adoptDequeue = (db: D1Database, key: string, queuedAt: number): D1PreparedStatement =>
  db.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ?1 AND queued_at = ?2 AND claimed_until IS NULL AND EXISTS (SELECT 1 FROM social_overlays WHERE image_key = ?1)").bind(key, queuedAt);
/** Queues a key a committed write just replaced, in the same batch, so a crash before its delete still sweeps it. */
export const queueReplaced = (db: D1Database, oldKey: string, overlayId: string, newKey: string, now: number): D1PreparedStatement =>
  db.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) SELECT ?1, NULL, NULL, ?2 WHERE EXISTS (SELECT 1 FROM social_overlays WHERE id = ?3 AND image_key = ?4) ON CONFLICT(storage_key) DO NOTHING").bind(oldKey, now, overlayId, newKey);
