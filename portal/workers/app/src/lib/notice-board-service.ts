import { NOTICE_BOARD_READ_MARKER_UPSERT_SQL } from "./notice-board-read-state";

export type NoticeBoardMentionInsert = {
  id: string;
  postId: string;
  mentionedUserId: string;
  createdAt: Date;
};

export type CreateNoticeBoardPostInput = {
  id: string;
  authorId: string;
  body: string;
  contentJson: string;
  mentions: NoticeBoardMentionInsert[];
  wallClockMs: number;
};

/**
 * A post, its mention mappings, and the author's marker are one D1 batch. The marker's SELECT
 * sees the inserted post but cannot absorb a post created after this batch commits.
 */
export async function createNoticeBoardPost(db: D1Database, input: CreateNoticeBoardPostInput): Promise<void> {
  const insert = db.prepare(`
    INSERT INTO notice_board_posts (id, author_id, body, content_json, created_at)
    VALUES (?, ?, ?, ?, MAX(
      ?,
      COALESCE((SELECT MAX(created_at) FROM notice_board_posts), 0) + 1,
      COALESCE((SELECT MAX(last_read_post_created_at)
        FROM notice_board_read_markers), 0) + 1
    ))
  `).bind(input.id, input.authorId, input.body, input.contentJson, input.wallClockMs);
  const mentions = input.mentions.map((mention) => db.prepare(`
    INSERT INTO notice_board_post_mentions (id, post_id, mentioned_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(mention.id, mention.postId, mention.mentionedUserId, mention.createdAt.getTime()));
  const marker = db.prepare(NOTICE_BOARD_READ_MARKER_UPSERT_SQL)
    .bind(input.authorId, input.wallClockMs, input.id);
  await db.batch([insert, ...mentions, marker]);
}
