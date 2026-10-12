import { VIDEO_REVIEW_ALL_PROJECTS_FLAG, VIDEO_REVIEW_MASTER_FLAG, videoReviewPartFlag, videoReviewPilotFlag } from "@quincy/shared";

/**
 * Where a staff video-note notification lands (#835, story 6). Resolved at read from the notification's source key, never stored (ADR 0007/0008): the key names a note, a reply or a mention row, and
 * the answer is the Video, the Version number and the thread's root note. A note that has since been deleted, or whose Version or Video is in Trash, resolves to nothing, so the row falls back to the
 * tab. The caller passes only rows on Projects the viewer can see; Externals use a different list and stay at tab level.
 */
export type VideoNotificationLink = { id: string; version: number; note: string };
type Row = { id: string; type: string; projectId: string; sourceKey: string | null };

const PREFIX: Record<string, string> = { video_note: "video_note:", video_reply: "video_reply:", video_mention: "video_mention:" };

const CHUNK = 80;
/** D1 allows 100 bound parameters a statement; a row binds four, so the link read takes 24 rows at a time. */
const LINK_CHUNK = 24;

/**
 * The Projects whose video notes the viewer's Project routes would let them read: video review open and the `notes` part on, the same gate the notes API applies before it answers (ADR 0007: an enriched
 * fact is gated by the route that already exposes it). One flag read per chunk of Projects, not one per row. The caller has already checked the role's `viewVideo` and the Project's visibility.
 */
export async function projectsWithVideoNotes(db: D1Database, projectIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(projectIds)];
  if (!unique.length) return new Set();
  const on = new Set<string>();
  const keys = [VIDEO_REVIEW_MASTER_FLAG, VIDEO_REVIEW_ALL_PROJECTS_FLAG, videoReviewPartFlag("notes")];
  for (let index = 0; index < unique.length; index += CHUNK) {
    const chunk = unique.slice(index, index + CHUNK);
    const wanted = [...keys, ...chunk.map(videoReviewPilotFlag)];
    const found = await db.prepare(`SELECT key FROM feature_flags WHERE enabled = 1 AND key IN (${wanted.map(() => "?").join(", ")})`).bind(...wanted).all<{ key: string }>();
    for (const row of found.results) on.add(row.key);
  }
  if (!on.has(VIDEO_REVIEW_MASTER_FLAG) || !on.has(videoReviewPartFlag("notes"))) return new Set();
  return new Set(unique.filter((id) => on.has(VIDEO_REVIEW_ALL_PROJECTS_FLAG) || on.has(videoReviewPilotFlag(id))));
}

export async function videoNotificationLinks(db: D1Database, rows: Row[]): Promise<Map<string, VideoNotificationLink | null>> {
  const out = new Map<string, VideoNotificationLink | null>();
  const pending = rows.flatMap((row) => {
    const prefix = PREFIX[row.type];
    return prefix && row.sourceKey?.startsWith(prefix) ? [{ row, sourceId: row.sourceKey.slice(prefix.length) }] : [];
  });
  // One statement per chunk of rows (ADR 0007 bounds every read in chunks). A row is matched on its Project as well as its source id, so a key that names another Project's note resolves to nothing.
  for (let index = 0; index < pending.length; index += LINK_CHUNK) {
    const chunk = pending.slice(index, index + LINK_CHUNK);
    const found = await db.prepare(`
      WITH wanted(notification_id, project_id, source_id, kind) AS (VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")})
      SELECT w.notification_id AS notificationId, v.id AS id, a.version AS version, COALESCE(n.parent_id, n.id) AS note
      FROM wanted w
      JOIN video_notes n ON n.project_id = w.project_id
        AND n.id = CASE WHEN w.kind = 'video_mention' THEN (SELECT note_id FROM video_note_mentions WHERE id = w.source_id) ELSE w.source_id END
      JOIN videos v ON v.id = n.video_id AND v.project_id = n.project_id
      JOIN assets a ON a.id = n.asset_id
      JOIN video_version_meta m ON m.asset_id = a.id
      WHERE n.deleted_at IS NULL AND m.removed_at IS NULL AND v.removed_at IS NULL
    `).bind(...chunk.flatMap(({ row, sourceId }) => [row.id, row.projectId, sourceId, row.type])).all<VideoNotificationLink & { notificationId: string }>();
    const byNotification = new Map(found.results.map((hit) => [hit.notificationId, { id: hit.id, version: hit.version, note: hit.note }]));
    for (const { row } of chunk) out.set(row.id, byNotification.get(row.id) ?? null);
  }
  return out;
}
