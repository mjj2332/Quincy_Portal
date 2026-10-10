import { gateSql, reachSql } from "./guest-fence-sql";
import { SQL_UUID_V4 } from "./sql-uuid";

/**
 * Producers of the client hourly digest (#741 15b). Each is ONE `INSERT ... SELECT` into `guest_notification_digest` over the subscribed members (`unsubscribed_at IS NULL`) of the live
 * Review links that reach the Video or Version, appended to the SOURCE write's `db.batch` and fenced on that write's audit row, so a refused or rolled-back write leaves nothing behind.
 * The gate (`video_review`, scope, `guest` and `notify_client`) is part of each statement: a part turned off before the batch commits produces nothing, and no pre-read can go stale.
 *
 * Only PUBLIC staff text is ever a digest row: an internal note or reply, and a guest's own writes, produce nothing here (the callers pass only what qualifies, and each statement
 * re-checks visibility and authorship in SQL). Ids come from `SQL_UUID_V4`, one per output row. The email itself is composed at send time by the background Worker, which re-filters
 * every row again (docs/plans/741-13-15.md section 6, settled decisions 10 and 11).
 */
export type GuestDigestEmit =
  /** A Video added to ONE link (11a add-Video): that link's subscribers. */
  | { kind: "video_added"; linkId: string; videoId: string }
  /** Versions newly granted on ONE link: `grantIds` are the pre-generated ids of the grants this write inserts, so only a grant that actually landed produces a row. */
  | { kind: "version_granted"; linkId: string; grantIds: string[] }
  /** A staff ROOT note with `visibility = 'public'`: subscribers of every link that reaches its Version. */
  | { kind: "public_note"; noteId: string }
  /** A staff reply under a public root: the guests who authored the root or a reply in that thread, on every link that reaches the Version. */
  | { kind: "staff_reply"; replyId: string; rootId: string }
  /** A Release: subscribers of every link with a live grant of the Version and `allow_download`. */
  | { kind: "video_released"; releaseId: string };

const AUDITED = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
/** A live link in this Project, with the digest gate (`guest` and `notify_client`). `?` placeholders are listed in `LIVE_BINDS`. */
const LIVE_LINK = `l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ? AND ${gateSql(["guest", "notify_client"])}`;
const COLUMNS = "(id, guest_id, link_id, event_type, video_id, asset_id, note_id, created_at)";
const SUBSCRIBED = "m.unsubscribed_at IS NULL";

/** The statements for one event, to append after the audit statement of the write that caused it. */
export function guestDigestStatements(db: D1Database, event: GuestDigestEmit, auditId: string, now: number): D1PreparedStatement[] {
  switch (event.kind) {
    case "video_added":
      return [db.prepare(`INSERT INTO guest_notification_digest ${COLUMNS}
        SELECT ${SQL_UUID_V4}, m.guest_id, m.link_id, 'video_added', ?, NULL, NULL, ?
        FROM guest_link_members m JOIN client_links l ON l.id = m.link_id
        WHERE m.link_id = ? AND ${SUBSCRIBED} AND ${LIVE_LINK}
          AND EXISTS (SELECT 1 FROM review_link_videos rv WHERE rv.link_id = l.id AND rv.video_id = ? AND rv.removed_at IS NULL) AND ${AUDITED}`)
        .bind(event.videoId, now, event.linkId, now, event.videoId, auditId)];
    case "version_granted":
      return [db.prepare(`INSERT INTO guest_notification_digest ${COLUMNS}
        SELECT ${SQL_UUID_V4}, m.guest_id, m.link_id, 'version_granted', g.video_id, g.asset_id, NULL, ?
        FROM review_link_version_grants g JOIN client_links l ON l.id = g.link_id JOIN guest_link_members m ON m.link_id = l.id
        WHERE g.link_id = ? AND g.revoked_at IS NULL AND g.id IN (SELECT value FROM json_each(?)) AND ${SUBSCRIBED} AND ${LIVE_LINK}
          AND EXISTS (SELECT 1 FROM review_link_videos rv WHERE rv.link_id = l.id AND rv.video_id = g.video_id AND rv.removed_at IS NULL) AND ${AUDITED}`)
        .bind(now, event.linkId, JSON.stringify(event.grantIds), now, auditId)];
    case "public_note":
      return [db.prepare(`INSERT INTO guest_notification_digest ${COLUMNS}
        SELECT ${SQL_UUID_V4}, m.guest_id, m.link_id, 'public_note', n.video_id, n.asset_id, n.id, ?
        FROM video_notes n JOIN client_links l ON l.project_id = n.project_id JOIN guest_link_members m ON m.link_id = l.id
        WHERE n.id = ? AND n.parent_id IS NULL AND n.visibility = 'public' AND n.author_user_id IS NOT NULL AND n.deleted_at IS NULL AND ${SUBSCRIBED} AND ${LIVE_LINK}
          AND ${reachSql("l.id", "l.project_id", "n.asset_id")} AND ${AUDITED}`)
        .bind(now, event.noteId, now, auditId)];
    case "staff_reply":
      return [db.prepare(`INSERT INTO guest_notification_digest ${COLUMNS}
        SELECT ${SQL_UUID_V4}, m.guest_id, m.link_id, 'staff_reply', r.video_id, r.asset_id, r.id, ?
        FROM video_notes r JOIN video_notes n ON n.id = r.parent_id JOIN client_links l ON l.project_id = r.project_id JOIN guest_link_members m ON m.link_id = l.id
        WHERE r.id = ? AND n.id = ? AND r.author_user_id IS NOT NULL AND r.deleted_at IS NULL AND n.parent_id IS NULL AND n.visibility = 'public' AND n.deleted_at IS NULL
          AND m.guest_id IN (SELECT t.author_guest_id FROM video_notes t WHERE (t.id = n.id OR t.parent_id = n.id) AND t.author_guest_id IS NOT NULL AND t.deleted_at IS NULL)
          AND ${SUBSCRIBED} AND ${LIVE_LINK} AND ${reachSql("l.id", "l.project_id", "r.asset_id")} AND ${AUDITED}`)
        .bind(now, event.replyId, event.rootId, now, auditId)];
    case "video_released":
      return [db.prepare(`INSERT INTO guest_notification_digest ${COLUMNS}
        SELECT ${SQL_UUID_V4}, m.guest_id, m.link_id, 'video_released', rel.video_id, rel.asset_id, NULL, ?
        FROM video_releases rel JOIN client_links l ON l.project_id = rel.project_id AND l.allow_download = 1 JOIN guest_link_members m ON m.link_id = l.id
        WHERE rel.id = ? AND rel.withdrawn_at IS NULL AND ${SUBSCRIBED} AND ${LIVE_LINK} AND ${reachSql("l.id", "l.project_id", "rel.asset_id")} AND ${AUDITED}`)
        .bind(now, event.releaseId, now, auditId)];
  }
}
