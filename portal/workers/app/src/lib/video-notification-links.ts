/**
 * Where a staff video-note notification lands (#835, story 6). Resolved at read from the notification's source key, never stored (ADR 0007/0008): the key names a note, a reply or a mention row, and
 * the answer is the Video, the Version number and the thread's root note. A note that has since been deleted, or whose Version or Video is in Trash, resolves to nothing, so the row falls back to the
 * tab. The caller passes only rows on Projects the viewer can see; Externals use a different list and stay at tab level.
 */
export type VideoNotificationLink = { id: string; version: number; note: string };
type Row = { id: string; type: string; projectId: string; sourceKey: string | null };

const PREFIX: Record<string, string> = { video_note: "video_note:", video_reply: "video_reply:", video_mention: "video_mention:" };

export async function videoNotificationLinks(db: D1Database, rows: Row[]): Promise<Map<string, VideoNotificationLink | null>> {
  const out = new Map<string, VideoNotificationLink | null>();
  const pending = rows.flatMap((row) => {
    const prefix = PREFIX[row.type];
    return prefix && row.sourceKey?.startsWith(prefix) ? [{ row, sourceId: row.sourceKey.slice(prefix.length) }] : [];
  });
  for (const { row, sourceId } of pending) {
    const found = await db.prepare(`
      SELECT v.id AS id, a.version AS version, COALESCE(n.parent_id, n.id) AS note
      FROM video_notes n
      JOIN videos v ON v.id = n.video_id AND v.project_id = n.project_id
      JOIN assets a ON a.id = n.asset_id
      JOIN video_version_meta m ON m.asset_id = a.id
      WHERE n.project_id = ?1 AND n.deleted_at IS NULL AND m.removed_at IS NULL AND v.removed_at IS NULL
        AND n.id = CASE WHEN ?3 = 'video_mention' THEN (SELECT note_id FROM video_note_mentions WHERE id = ?2) ELSE ?2 END
    `).bind(row.projectId, sourceId, row.type).first<VideoNotificationLink>();
    out.set(row.id, found ?? null);
  }
  return out;
}
