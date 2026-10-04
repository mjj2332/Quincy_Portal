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

/** Every object a row can own. Best effort: returns whether R2 accepted the deletes. */
export async function deleteEmbeddedMediaObjects(env: Pick<Env, "MEDIA">, rows: Array<Pick<EmbeddedMediaRow, "originalKey" | "displayKey" | "posterKey">>): Promise<boolean> {
  const keys = rows.flatMap((row) => [row.originalKey, row.displayKey, row.posterKey]).filter((key): key is string => Boolean(key));
  if (!keys.length) return true;
  try {
    for (let index = 0; index < keys.length; index += 1000) await env.MEDIA.delete(keys.slice(index, index + 1000));
    return true;
  } catch { return false; }
}
