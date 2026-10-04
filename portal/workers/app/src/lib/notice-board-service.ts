import { NOTICE_BOARD_READ_MARKER_UPSERT_SQL } from "./notice-board-read-state";
import { isMediaGuardFailure, ownedMediaStatements } from "./embedded-media";

export type NoticeBoardMentionInsert = {
  id: string;
  postId: string;
  mentionedUserId: string;
  createdAt: Date;
};

/** The images a post's save wants (#496): the batch itself validates and reconciles them, `preflightOwnedMedia` only pre-checks. */
export type NoticeBoardMediaChanges = { authorId: string; ids: string[] };

export class NoticeBoardMediaConflictError extends Error { constructor() { super("An image in this notice is no longer available"); this.name = "NoticeBoardMediaConflictError"; } }

export type CreateNoticeBoardPostInput = {
  id: string;
  authorId: string;
  body: string;
  contentJson: string;
  mentions: NoticeBoardMentionInsert[];
  wallClockMs: number;
  media?: NoticeBoardMediaChanges;
};

/** True only while this author still owns this post: every media statement is fenced on it, so a save that lost a race to a delete writes nothing. */
const postFence = (postId: string, authorId: string) => ({ sql: "EXISTS (SELECT 1 FROM notice_board_posts WHERE id = ? AND author_id = ?)", binds: [postId, authorId] });

function mediaStatements(db: D1Database, postId: string, authorId: string, media: NoticeBoardMediaChanges | undefined, now: number): D1PreparedStatement[] {
  return ownedMediaStatements(db, { ownerKind: "notice_post", ownerId: postId, projectId: null, uploaderId: authorId, ids: media?.ids ?? [], now, fence: postFence(postId, authorId), guardId: `notice-${postId}-${now}` });
}

/** A batch that tripped the media guard failed on its CHECK: report it as a conflict, and rethrow anything else. */
function rethrowMediaConflict(error: unknown, media: NoticeBoardMediaChanges | undefined): never {
  if (isMediaGuardFailure(error, media?.ids)) throw new NoticeBoardMediaConflictError();
  throw error;
}

/**
 * A post, its mention mappings, the author's marker and its media are one D1 batch. The marker's SELECT
 * sees the inserted post but cannot absorb a post created after this batch commits. The media statements come last:
 * if the guard trips, the whole batch (post, mentions, marker) rolls back.
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
  await db.batch([insert, ...mentions, marker, ...mediaStatements(db, input.id, input.authorId, input.media, input.wallClockMs)]).catch((error) => rethrowMediaConflict(error, input.media));
}

export type EditNoticeBoardPostInput = {
  id: string;
  authorId: string;
  body: string;
  contentJson: string;
  editedAt: Date;
  removeMentionIds: string[];
  addMentions: NoticeBoardMentionInsert[];
  media?: NoticeBoardMediaChanges;
};

/**
 * Edits an author's own post: the text, its mention mappings and its media in one batch. `updated` is false when no post of
 * this author matched (deleted meanwhile): nothing else was written, and the images stay pending.
 */
export async function editNoticeBoardPost(db: D1Database, input: EditNoticeBoardPostInput): Promise<{ updated: boolean }> {
  const fence = postFence(input.id, input.authorId);
  const update = db.prepare("UPDATE notice_board_posts SET body = ?, content_json = ?, edited_at = ? WHERE id = ? AND author_id = ?")
    .bind(input.body, input.contentJson, input.editedAt.getTime(), input.id, input.authorId);
  const removed = input.removeMentionIds.map((mentionId) => db.prepare(`DELETE FROM notice_board_post_mentions WHERE id = ? AND post_id = ? AND ${fence.sql}`).bind(mentionId, input.id, ...fence.binds));
  const added = input.addMentions.map((mention) => db.prepare(`
    INSERT INTO notice_board_post_mentions (id, post_id, mentioned_user_id, created_at)
    SELECT ?, ?, ?, ? WHERE ${fence.sql}
  `).bind(mention.id, mention.postId, mention.mentionedUserId, mention.createdAt.getTime(), ...fence.binds));
  const results = await db.batch([update, ...removed, ...added, ...mediaStatements(db, input.id, input.authorId, input.media, input.editedAt.getTime())]).catch((error) => rethrowMediaConflict(error, input.media));
  return { updated: (results[0]?.meta.changes ?? 0) === 1 };
}

/**
 * Deletes an author's own post and, in the same batch, leaves its images detached and due now (`detached_at = 0`), which is
 * the state the sweep reclaims first. The caller deletes the objects and rows best effort afterwards. Returns whether a post was deleted.
 */
export async function deleteNoticeBoardPost(db: D1Database, input: { id: string; authorId: string }): Promise<boolean> {
  const results = await db.batch([
    db.prepare("DELETE FROM notice_board_posts WHERE id = ? AND author_id = ?").bind(input.id, input.authorId),
    db.prepare(`
      UPDATE embedded_media SET state = 'detached', detached_at = 0, updated_at = ?
      WHERE owner_kind = 'notice_post' AND owner_id = ? AND state IN ('attached', 'detached')
        AND NOT EXISTS (SELECT 1 FROM notice_board_posts WHERE id = ?)
    `).bind(Date.now(), input.id, input.id),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}
