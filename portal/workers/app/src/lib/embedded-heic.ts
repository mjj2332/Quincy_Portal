import type { Context } from "hono";
import { EMBEDDED_HEIC_UPLOADS_FLAG, enqueueEmbeddedDisplaySafely, externalEmbeddedMediaRenditionSchema, isEmbeddedHeicContentType, renditionsEnabled } from "@quincy/shared";
import type { AppEnv, Env, SessionUser } from "../env";
import type { EmbeddedMediaRow } from "./embedded-media";

/** HEIC in Embedded media (#495): who may upload one, and the uploader's status and retry answers. */
export async function heicFlagEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT enabled FROM feature_flags WHERE key = ?").bind(EMBEDDED_HEIC_UPLOADS_FLAG).first<{ enabled: number }>();
  return row?.enabled === 1;
}

/** An Admin always may (the slice that proves it in production), everyone else only once the owner has turned the flag on. Read on the effective user, so an impersonating Admin is the staff they act as. */
export async function heicUploadsAllowed(env: Pick<Env, "DB">, user: Pick<SessionUser, "role">): Promise<boolean> {
  return user.role === "admin" || await heicFlagEnabled(env.DB);
}

/**
 * The gate every HEIC upload passes at presign and again at complete. Renditions off is a loud 503, not a silent drop: the conversion cannot run,
 * so the upload is refused up front. Returns the refusal, or null when the upload may go on.
 */
export async function heicGate(c: Context<AppEnv>): Promise<Response | null> {
  if (!renditionsEnabled(c.env)) return c.json({ error: "HEIC images are unavailable right now", code: "heic_unavailable" }, 503);
  if (!await heicUploadsAllowed(c.env, c.get("user"))) return c.json({ error: "HEIC images are not enabled yet", code: "heic_not_enabled" }, 403);
  return null;
}

export const isHeicRow = (row: Pick<EmbeddedMediaRow, "contentType">) => isEmbeddedHeicContentType(row.contentType);

/** `GET .../rendition`: where the uploader's display copy has got to. Never carries the error text or a key. */
export function renditionStatusResponse(c: Context<AppEnv>, row: EmbeddedMediaRow): Response {
  return c.json(externalEmbeddedMediaRenditionSchema.parse({ mediaId: row.id, status: row.renditionStatus }));
}

/**
 * `POST .../rendition/retry`: a failed display copy goes back to pending with a fresh attempt count, then is queued again. One writer wins the
 * compare-and-set, so only that one enqueues. A row that is already pending answers the same without a second message, and any other state is a 409.
 */
export async function retryRendition(c: Context<AppEnv>, row: EmbeddedMediaRow): Promise<Response> {
  if (!renditionsEnabled(c.env)) return c.json({ error: "HEIC images are unavailable right now", code: "heic_unavailable" }, 503);
  const now = Date.now();
  const reset = await c.env.DB.prepare(`
    UPDATE embedded_media SET rendition_status = 'pending', rendition_attempts = 0, rendition_lease_until = NULL, rendition_error = NULL, rendition_requested_at = ?, updated_at = ?
    WHERE id = ? AND rendition_status = 'failed' AND state IN ('pending', 'attached') AND uploader_id = ?
  `).bind(now, now, row.id, row.uploaderId).run();
  if ((reset.meta.changes ?? 0) === 1) {
    await enqueueEmbeddedDisplaySafely(c.env, row.id, "retry");
    return c.json(externalEmbeddedMediaRenditionSchema.parse({ mediaId: row.id, status: "pending" }));
  }
  const current = await c.env.DB.prepare("SELECT rendition_status AS status FROM embedded_media WHERE id = ?").bind(row.id).first<{ status: string }>();
  if (!current) return c.json({ error: "Media upload not found" }, 404);
  if (current.status === "pending") return c.json(externalEmbeddedMediaRenditionSchema.parse({ mediaId: row.id, status: "pending" }));
  return c.json({ error: "This image is not waiting for a retry", code: "rendition_not_failed" }, 409);
}
