import { and, desc, eq, lt, or } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import { staffPathFor, type RichTextDoc } from "@quincy/shared";
import { newId } from "./ids";

const readMarkerUpsertSql = `
INSERT INTO project_comment_read_markers (
  user_id, project_id, last_read_comment_id,
  last_read_comment_created_at, updated_at
)
SELECT ?, project_id, id, created_at, ?
FROM project_comments
WHERE project_id = ? AND id = ?
ON CONFLICT(user_id, project_id) DO UPDATE SET
  last_read_comment_id = excluded.last_read_comment_id,
  last_read_comment_created_at = excluded.last_read_comment_created_at,
  updated_at = excluded.updated_at
WHERE excluded.last_read_comment_created_at > project_comment_read_markers.last_read_comment_created_at
   OR (
     excluded.last_read_comment_created_at = project_comment_read_markers.last_read_comment_created_at
     AND excluded.last_read_comment_id > project_comment_read_markers.last_read_comment_id
   )`;

type CommentRow = { comment: typeof schema.projectComments.$inferSelect; authorId: string; authorName: string };
type CommentDb = ReturnType<typeof createDb>;

export type ProjectCommentCursor = { createdAt: Date; id: string };

export type ProjectCommentActivityOutboxIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type: "project.comment.created" | "project.comment.edited" | "project.comment.deleted";
    projectId: string;
    actorId: string;
    occurredAt: string;
    source: { kind: "project_comment"; id: string; key: string };
    safePayload: { commentId: string };
    deepLink: { kind: "project_collaboration"; path: string };
  };
  broadDelivery: {
    registryKey: "project.comment.created" | "project.comment.edited" | "project.comment.deleted";
    sourceActivityId: string;
    coalesce: null | { key: string; windowSeconds: 300 };
  };
  targetedMentionDelivery: false;
};

export type ProjectCommentReadState = {
  projectId: string;
  marker: null | { throughCommentId: string; throughCreatedAt: string; updatedAt: string };
  latest: null | { commentId: string; createdAt: string };
  unreadCount: number;
};

export type CreateProjectCommentInput = {
  id: string;
  projectId: string;
  authorId: string;
  body: string;
  contentJson: string;
  mentions: Array<{ id: string; commentId: string; mentionedUserId: string; createdAt: Date }>;
  wallClockMs: number;
  occurredAt: Date;
};

export type EditProjectCommentInput = {
  projectId: string;
  commentId: string;
  actorId: string;
  body: string;
  contentJson: string;
  removeMentionIds: string[];
  addMentions: Array<{ id: string; commentId: string; mentionedUserId: string; createdAt: Date }>;
  editedAt: Date;
  occurredAt: Date;
};

export type DeleteProjectCommentInput = {
  projectId: string;
  commentId: string;
  actorId: string;
  occurredAt: Date;
};

function rows<T>(result: D1Result<T> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function one<T>(result: D1Result<T> | undefined): T | undefined {
  return rows(result)[0];
}

function readStateFromResults(
  projectId: string,
  markerResult: D1Result<MarkerRow>,
  latestResult: D1Result<LatestRow>,
  unreadResult: D1Result<UnreadRow>,
): ProjectCommentReadState {
  const marker = one(markerResult);
  const latest = one(latestResult);
  return {
    projectId,
    marker: marker
      ? {
          throughCommentId: marker.last_read_comment_id,
          throughCreatedAt: new Date(Number(marker.last_read_comment_created_at)).toISOString(),
          updatedAt: new Date(Number(marker.updated_at)).toISOString(),
        }
      : null,
    latest: latest
      ? { commentId: latest.id, createdAt: new Date(Number(latest.created_at)).toISOString() }
      : null,
    unreadCount: Number(one(unreadResult)?.unread_count ?? 0),
  };
}

type MarkerRow = { last_read_comment_id: string; last_read_comment_created_at: number; updated_at: number };
type LatestRow = { id: string; created_at: number };
type UnreadRow = { unread_count: number };

function markerRead(db: D1Database, userId: string, projectId: string) {
  return db.prepare(`
    SELECT last_read_comment_id, last_read_comment_created_at, updated_at
    FROM project_comment_read_markers
    WHERE user_id = ? AND project_id = ?
  `).bind(userId, projectId);
}

function latestRead(db: D1Database, projectId: string) {
  return db.prepare(`
    SELECT id, created_at
    FROM project_comments
    WHERE project_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(projectId);
}

function unreadRead(db: D1Database, userId: string, projectId: string) {
  return db.prepare(`
    SELECT COUNT(*) AS unread_count
    FROM project_comments AS comment
    LEFT JOIN project_comment_read_markers AS marker
      ON marker.user_id = ? AND marker.project_id = comment.project_id
    WHERE comment.project_id = ?
      AND (
        marker.user_id IS NULL
        OR comment.created_at > marker.last_read_comment_created_at
        OR (
          comment.created_at = marker.last_read_comment_created_at
          AND comment.id > marker.last_read_comment_id
        )
      )
  `).bind(userId, projectId);
}

export function createProjectCommentActivityIntent(input: {
  type: "created" | "edited" | "deleted";
  projectId: string;
  actorId: string;
  commentId: string;
  occurredAt: Date;
}): ProjectCommentActivityOutboxIntent {
  const activityId = newId();
  const registryKey = `project.comment.${input.type}` as ProjectCommentActivityOutboxIntent["activity"]["type"];
  const sourceKey = input.type === "created"
    ? `project-comment:${input.commentId}:created`
    : input.type === "deleted"
      ? `project-comment:${input.commentId}:deleted`
      : `project-comment:${input.commentId}:edited:${activityId}`;
  return {
    schemaVersion: 1,
    activity: {
      id: activityId,
      type: registryKey,
      projectId: input.projectId,
      actorId: input.actorId,
      occurredAt: input.occurredAt.toISOString(),
      source: { kind: "project_comment", id: input.commentId, key: sourceKey },
      safePayload: { commentId: input.commentId },
      deepLink: { kind: "project_collaboration", path: staffPathFor({ kind: "project", projectId: input.projectId, collaboration: "open" }) },
    },
    broadDelivery: {
      registryKey,
      sourceActivityId: activityId,
      coalesce: input.type === "edited"
        ? { key: `project-comment-edit:${input.projectId}:${input.commentId}:${input.actorId}`, windowSeconds: 300 }
        : null,
    },
    targetedMentionDelivery: false,
  };
}

export async function listProjectComments(db: CommentDb, projectId: string, input: { limit: number; before?: ProjectCommentCursor | null }) {
  const before = input.before ?? null;
  const rows = await db.select({ comment: schema.projectComments, authorId: schema.user.id, authorName: schema.user.name })
    .from(schema.projectComments)
    .innerJoin(schema.user, eq(schema.projectComments.authorId, schema.user.id))
    .where(and(
      eq(schema.projectComments.projectId, projectId),
      before ? or(lt(schema.projectComments.createdAt, before.createdAt), and(eq(schema.projectComments.createdAt, before.createdAt), lt(schema.projectComments.id, before.id))) : undefined,
    ))
    .orderBy(desc(schema.projectComments.createdAt), desc(schema.projectComments.id))
    .limit(input.limit)
    .all();
  return rows as CommentRow[];
}

export async function findProjectComment(db: CommentDb, projectId: string, commentId: string) {
  return await db.select({ comment: schema.projectComments, authorId: schema.user.id, authorName: schema.user.name })
    .from(schema.projectComments)
    .innerJoin(schema.user, eq(schema.projectComments.authorId, schema.user.id))
    .where(and(eq(schema.projectComments.id, commentId), eq(schema.projectComments.projectId, projectId)))
    .get() as CommentRow | undefined;
}

export async function createProjectComment(db: D1Database, input: CreateProjectCommentInput) {
  const insert = db.prepare(`
    INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at)
    VALUES (?, ?, ?, ?, ?, MAX(
      ?,
      COALESCE((SELECT MAX(created_at) FROM project_comments WHERE project_id = ?), 0) + 1,
      COALESCE((SELECT MAX(last_read_comment_created_at)
        FROM project_comment_read_markers WHERE project_id = ?), 0) + 1
    ))
  `).bind(input.id, input.projectId, input.authorId, input.body, input.contentJson, input.wallClockMs, input.projectId, input.projectId);
  const mentions = input.mentions.map((mention) => db.prepare(`
    INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(mention.id, mention.commentId, mention.mentionedUserId, mention.createdAt.getTime()));
  const marker = db.prepare(readMarkerUpsertSql).bind(input.authorId, input.occurredAt.getTime(), input.projectId, input.id);
  await db.batch([insert, ...mentions, marker]);
  const comment = await findProjectComment(createDb(db), input.projectId, input.id);
  if (!comment) throw new Error("Comment could not be created");
  return { comment, activity: createProjectCommentActivityIntent({ type: "created", projectId: input.projectId, actorId: input.authorId, commentId: input.id, occurredAt: input.occurredAt }) };
}

export async function editProjectComment(db: D1Database, input: EditProjectCommentInput) {
  const statements: D1PreparedStatement[] = [db.prepare(`
    UPDATE project_comments
    SET body = ?, content_json = ?, edited_at = ?
    WHERE id = ? AND project_id = ?
  `).bind(input.body, input.contentJson, input.editedAt.getTime(), input.commentId, input.projectId)];
  statements.push(...input.removeMentionIds.map((id) => db.prepare("DELETE FROM project_comment_mentions WHERE id = ? AND comment_id = ?").bind(id, input.commentId)));
  statements.push(...input.addMentions.map((mention) => db.prepare(`
    INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(mention.id, mention.commentId, mention.mentionedUserId, mention.createdAt.getTime())));
  await db.batch(statements);
  const comment = await findProjectComment(createDb(db), input.projectId, input.commentId);
  if (!comment) throw new Error("Comment could not be updated");
  return { comment, activity: createProjectCommentActivityIntent({ type: "edited", projectId: input.projectId, actorId: input.actorId, commentId: input.commentId, occurredAt: input.occurredAt }) };
}

export async function deleteProjectComment(db: D1Database, input: DeleteProjectCommentInput) {
  await db.prepare("DELETE FROM project_comments WHERE id = ? AND project_id = ?").bind(input.commentId, input.projectId).run();
  return { activity: createProjectCommentActivityIntent({ type: "deleted", projectId: input.projectId, actorId: input.actorId, commentId: input.commentId, occurredAt: input.occurredAt }) };
}

export async function getProjectCommentReadState(db: D1Database, userId: string, projectId: string): Promise<ProjectCommentReadState> {
  const [marker, latest, unread] = await db.batch([markerRead(db, userId, projectId), latestRead(db, projectId), unreadRead(db, userId, projectId)]);
  return readStateFromResults(projectId, marker as D1Result<MarkerRow>, latest as D1Result<LatestRow>, unread as D1Result<UnreadRow>);
}

export async function advanceProjectCommentReadMarker(db: D1Database, userId: string, projectId: string, throughCommentId: string): Promise<{ targetExists: boolean; state: ProjectCommentReadState }> {
  const exists = db.prepare("SELECT id, created_at FROM project_comments WHERE project_id = ? AND id = ?").bind(projectId, throughCommentId);
  const upsert = db.prepare(readMarkerUpsertSql).bind(userId, Date.now(), projectId, throughCommentId);
  const [existence, _upsertResult, marker, latest, unread] = await db.batch([exists, upsert, markerRead(db, userId, projectId), latestRead(db, projectId), unreadRead(db, userId, projectId)]);
  return {
    targetExists: rows(existence as D1Result<{ id: string; created_at: number }>).length > 0,
    state: readStateFromResults(projectId, marker as D1Result<MarkerRow>, latest as D1Result<LatestRow>, unread as D1Result<UnreadRow>),
  };
}

export function serializeProjectComment(row: CommentRow) {
  return {
    id: row.comment.id,
    author: { id: row.authorId, name: row.authorName },
    body: row.comment.body,
    content: JSON.parse(row.comment.contentJson) as RichTextDoc,
    createdAt: row.comment.createdAt.toISOString(),
    editedAt: row.comment.editedAt?.toISOString() ?? null,
  };
}
