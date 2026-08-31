export type NoticeBoardReadState = {
  marker: null | {
    throughPostId: string;
    throughCreatedAt: string;
    updatedAt: string;
  };
  latest: null | { postId: string; createdAt: string };
  unreadCount: number;
};

/**
 * The marker stores the stream tuple resolved from D1, never a browser-supplied timestamp.
 * The conditional update makes every marker write monotonic in the same order as the board.
 */
export const NOTICE_BOARD_READ_MARKER_UPSERT_SQL = `
INSERT INTO notice_board_read_markers (
  user_id, last_read_post_id, last_read_post_created_at, updated_at
)
SELECT ?, id, created_at, ?
FROM notice_board_posts
WHERE id = ?
ON CONFLICT(user_id) DO UPDATE SET
  last_read_post_id = excluded.last_read_post_id,
  last_read_post_created_at = excluded.last_read_post_created_at,
  updated_at = MAX(
    excluded.updated_at,
    notice_board_read_markers.updated_at + 1
  )
WHERE excluded.last_read_post_created_at > notice_board_read_markers.last_read_post_created_at
   OR (
     excluded.last_read_post_created_at = notice_board_read_markers.last_read_post_created_at
     AND excluded.last_read_post_id > notice_board_read_markers.last_read_post_id
   )`;

type MarkerRow = { last_read_post_id: string; last_read_post_created_at: number; updated_at: number };
type LatestRow = { id: string; created_at: number };
type UnreadRow = { unread_count: number };

function rows<T>(result: D1Result<T> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function one<T>(result: D1Result<T> | undefined): T | undefined {
  return rows(result)[0];
}

function markerRead(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT last_read_post_id, last_read_post_created_at, updated_at
    FROM notice_board_read_markers
    WHERE user_id = ?
  `).bind(userId);
}

function latestRead(db: D1Database) {
  return db.prepare(`
    SELECT id, created_at
    FROM notice_board_posts
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
}

function unreadRead(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT COUNT(*) AS unread_count
    FROM notice_board_posts AS post
    LEFT JOIN notice_board_read_markers AS marker
      ON marker.user_id = ?
    WHERE marker.user_id IS NULL
      OR post.created_at > marker.last_read_post_created_at
      OR (
        post.created_at = marker.last_read_post_created_at
        AND post.id > marker.last_read_post_id
      )
  `).bind(userId);
}

function readStateFromResults(
  markerResult: D1Result<MarkerRow>,
  latestResult: D1Result<LatestRow>,
  unreadResult: D1Result<UnreadRow>,
): NoticeBoardReadState {
  const marker = one(markerResult);
  const latest = one(latestResult);
  return {
    marker: marker
      ? {
          throughPostId: marker.last_read_post_id,
          throughCreatedAt: new Date(Number(marker.last_read_post_created_at)).toISOString(),
          updatedAt: new Date(Number(marker.updated_at)).toISOString(),
        }
      : null,
    latest: latest
      ? { postId: latest.id, createdAt: new Date(Number(latest.created_at)).toISOString() }
      : null,
    unreadCount: Number(one(unreadResult)?.unread_count ?? 0),
  };
}

export async function getNoticeBoardReadState(db: D1Database, userId: string): Promise<NoticeBoardReadState> {
  const [marker, latest, unread] = await db.batch([markerRead(db, userId), latestRead(db), unreadRead(db, userId)]);
  return readStateFromResults(marker as D1Result<MarkerRow>, latest as D1Result<LatestRow>, unread as D1Result<UnreadRow>);
}

export async function advanceNoticeBoardReadMarker(
  db: D1Database,
  userId: string,
  throughPostId: string,
  updatedAtMs = Date.now(),
): Promise<{ targetExists: boolean; state: NoticeBoardReadState }> {
  const exists = db.prepare("SELECT id, created_at FROM notice_board_posts WHERE id = ?").bind(throughPostId);
  const upsert = db.prepare(NOTICE_BOARD_READ_MARKER_UPSERT_SQL).bind(userId, updatedAtMs, throughPostId);
  const [existence, _upsertResult, marker, latest, unread] = await db.batch([
    exists,
    upsert,
    markerRead(db, userId),
    latestRead(db),
    unreadRead(db, userId),
  ]);
  return {
    targetExists: rows(existence as D1Result<{ id: string; created_at: number }>).length > 0,
    state: readStateFromResults(marker as D1Result<MarkerRow>, latest as D1Result<LatestRow>, unread as D1Result<UnreadRow>),
  };
}
