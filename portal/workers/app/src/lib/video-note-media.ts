import { LIVE_VERSION_EXISTS } from "./video-live-sql";
import type { EmbeddedMediaRow } from "./embedded-media";

/**
 * Whose media a video note can show (#835). The predicate lives here so the staff serve route and the guest one (slice C) read it the same way.
 * An ATTACHED row follows its note: the owner note must be live (not deleted) on a live Version of a live Video, and the Project it names must be the row's own. Until then (pending,
 * detached, or an owner that is gone) the uploader is the only reader. The caller adds the viewer's own checks (gate, capability, Project access, visibility).
 */
export type AttachedNote = { projectId: string; assetId: string; visibility: "public" | "internal" };

export async function attachedVideoNote(db: D1Database, row: Pick<EmbeddedMediaRow, "ownerId" | "projectId">): Promise<AttachedNote | null> {
  if (!row.ownerId || !row.projectId) return null;
  const note = await db.prepare(`SELECT n.project_id AS projectId, n.asset_id AS assetId, n.visibility AS visibility FROM video_notes n
    WHERE n.id = ?1 AND n.project_id = ?2 AND n.deleted_at IS NULL AND ${LIVE_VERSION_EXISTS("n.asset_id")}`).bind(row.ownerId, row.projectId).first<AttachedNote>();
  return note ?? null;
}
