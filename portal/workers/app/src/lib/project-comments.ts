import { and, desc, eq, lt, or } from "drizzle-orm";
import { buildProjectActivityStatements, createDb, schema } from "@quincy/db";
import { NOTIFICATION_OUTBOX_EVENT_TYPE, staffPathFor, type RichTextDoc } from "@quincy/shared";
import type { ProjectActivityIntent } from "@quincy/shared";
import { newId } from "./ids";
import { auditMeta, type AuditPrincipal } from "./audit";

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

export type ProjectCommentActivityOutboxIntent = ProjectActivityIntent & { targetedMentionDelivery: false };

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
  auditPrincipal?: AuditPrincipal;
};

export type EditProjectCommentInput = {
  projectId: string;
  commentId: string;
  actorId: string;
  body: string;
  contentJson: string;
  removeMentionIds: string[];
  addMentions: Array<{ id: string; commentId: string; mentionedUserId: string; createdAt: Date }>;
  /** The complete desired mention set; supplied by the route so same-state retries are no-ops. */
  mentionIds?: string[];
  editedAt: Date;
  occurredAt: Date;
  auditPrincipal?: AuditPrincipal;
};

export type DeleteProjectCommentInput = {
  projectId: string;
  commentId: string;
  actorId: string;
  occurredAt: Date;
  auditPrincipal?: AuditPrincipal;
};

export type ProjectCommentMentionAuthorizationSnapshot =
  | { kind: "admin" }
  | { kind: "project_member"; membershipIds: string[] };

export type ProjectCommentMentionOutboxPayload = {
  schemaVersion: 1;
  event: {
    type: "project.comment.mentioned";
    sourceKey: string;
    recipientId: string;
  };
  authorizationAtOccurrence: ProjectCommentMentionAuthorizationSnapshot;
  projectCommentActivity: ProjectCommentActivityOutboxIntent;
};

export type ProjectCommentMutationResult = {
  comment?: CommentRow;
  activity: ProjectCommentActivityOutboxIntent;
  notificationOutboxIds: string[];
};

function rows<T>(result: D1Result<T> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function one<T>(result: D1Result<T> | undefined): T | undefined {
  return rows(result)[0];
}

export function assertUniqueMentions(mentions: Array<{ id: string; commentId: string; mentionedUserId: string }>): void {
  // Reject malformed direct callers before opening the domain batch. The route already
  // canonicalizes rich-text mentions, but this keeps duplicate mappings from reaching D1 where
  // a constraint error could otherwise leave a non-transactional test/runtime adapter with only
  // the earlier producer statements applied.
  const mentionIds = new Set<string>();
  const recipients = new Set<string>();
  for (const mention of mentions) {
    if (mentionIds.has(mention.id) || recipients.has(mention.mentionedUserId)) {
      throw new Error("Duplicate project comment mention");
    }
    mentionIds.add(mention.id);
    recipients.add(mention.mentionedUserId);
  }
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

type MentionSnapshotRow = { userId: string; role: string; membershipId: string | null };

async function mentionOccurrenceSnapshots(
  db: D1Database,
  projectId: string,
  mentions: Array<{ id: string; mentionedUserId: string }>,
): Promise<Map<string, ProjectCommentMentionAuthorizationSnapshot>> {
  const ids = [...new Set(mentions.map((mention) => mention.mentionedUserId))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`
    SELECT u.id AS userId, u.role AS role, pm.id AS membershipId
    FROM user u
    LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?
    WHERE u.id IN (${placeholders}) AND u.active = 1
    ORDER BY u.id, pm.id
  `).bind(projectId, ...ids).all<MentionSnapshotRow>();
  const grouped = new Map<string, MentionSnapshotRow[]>();
  for (const row of result.results) grouped.set(row.userId, [...(grouped.get(row.userId) ?? []), row]);
  const snapshots = new Map<string, ProjectCommentMentionAuthorizationSnapshot>();
  for (const [userId, rows] of grouped) {
    if (rows[0]?.role === "admin") snapshots.set(userId, { kind: "admin" });
    else {
      const membershipIds = rows.map((row) => row.membershipId).filter((id): id is string => Boolean(id)).sort();
      if (membershipIds.length) snapshots.set(userId, { kind: "project_member", membershipIds });
    }
  }
  return snapshots;
}

function mentionOutboxStatements(
  db: D1Database,
  projectId: string,
  actorId: string,
  activity: ProjectCommentActivityOutboxIntent,
  mentions: Array<{ id: string; mentionedUserId: string }>,
  snapshots: Map<string, ProjectCommentMentionAuthorizationSnapshot>,
  occurredAt: number,
  winnerAuditId?: string,
): { statements: D1PreparedStatement[]; outboxIds: string[] } {
  const statements: D1PreparedStatement[] = [];
  const outboxIds: string[] = [];
  for (const mention of mentions) {
    if (mention.mentionedUserId === actorId) continue;
    // Every non-self mapping gets an envelope (plan §3): a mentioned user who is inactive or has
    // no current admin/membership snapshot -- a narrow eligibility race, since the composer only
    // offers eligible targets -- still gets one, with an authorization snapshot that deterministically
    // fails reauthorization at delivery time (background/src/notification-delivery.ts's
    // resolveRecipient), rather than leaving the mapping with no tracked delivery intent at all.
    const authorizationAtOccurrence = snapshots.get(mention.mentionedUserId) ?? { kind: "project_member", membershipIds: [] };
    const outboxId = newId();
    const payload: ProjectCommentMentionOutboxPayload = {
      schemaVersion: 1,
      event: { type: NOTIFICATION_OUTBOX_EVENT_TYPE, sourceKey: mention.id, recipientId: mention.mentionedUserId },
      authorizationAtOccurrence,
      projectCommentActivity: activity,
    };
    outboxIds.push(outboxId);
    const auditGate = winnerAuditId === undefined ? "" : " AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
    statements.push(db.prepare(`
      INSERT INTO notification_outbox (
        id, schema_version, event_type, source_key, project_id, actor_id,
        recipient_id, payload_json, status, available_at, created_at, updated_at
      ) SELECT ?, 1, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
      WHERE 1 = 1${auditGate}
    `).bind(
      outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mention.id, projectId, actorId,
      mention.mentionedUserId, JSON.stringify(payload), occurredAt, occurredAt, occurredAt,
      ...(winnerAuditId === undefined ? [] : [winnerAuditId]),
    ));
    for (const channel of ["in_app", "email"] as const) {
      statements.push(db.prepare(`
        INSERT INTO notification_delivery_ledger (
          id, outbox_id, event_type, source_key, recipient_id, channel,
          status, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND event_type = ? AND source_key = ? AND recipient_id = ?)
      `).bind(newId(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mention.id, mention.mentionedUserId, channel, occurredAt, occurredAt, outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mention.id, mention.mentionedUserId));
    }
  }
  return { statements, outboxIds };
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

export async function createProjectComment(db: D1Database, input: CreateProjectCommentInput): Promise<ProjectCommentMutationResult> {
  assertUniqueMentions(input.mentions);
  const activity = createProjectCommentActivityIntent({ type: "created", projectId: input.projectId, actorId: input.authorId, commentId: input.id, occurredAt: input.occurredAt });
  const snapshots = await mentionOccurrenceSnapshots(db, input.projectId, input.mentions);
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
  const auditId = newId();
  const audit = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    VALUES (?, ?, 'project_comment.create', 'project_comment', ?, ?, ?)
  `).bind(auditId, input.auditPrincipal?.id ?? input.authorId, input.id, auditMeta(input.auditPrincipal ?? { id: input.authorId, impersonatedBy: null }), input.occurredAt.getTime());
  const outbox = mentionOutboxStatements(db, input.projectId, input.authorId, activity, input.mentions, snapshots, input.occurredAt.getTime(), auditId);
  const activityStatements = buildProjectActivityStatements({ db, intent: activity, winnerAuditId: auditId, createdAt: input.occurredAt.getTime() });
  const activityStatementStart = 1 + mentions.length + 2 + outbox.statements.length;
  const results = await db.batch([insert, ...mentions, marker, audit, ...outbox.statements, ...activityStatements.statements]);
  const comment = await findProjectComment(createDb(db), input.projectId, input.id);
  if (!comment) throw new Error("Comment could not be created");
  const broad = rows<{ id: string }>(results[activityStatementStart + activityStatements.broadOutboxIndex] as D1Result<{ id: string }>).map((row) => row.id);
  return { comment, activity, notificationOutboxIds: [...outbox.outboxIds, ...broad] };
}

export async function editProjectComment(db: D1Database, input: EditProjectCommentInput): Promise<ProjectCommentMutationResult> {
  assertUniqueMentions(input.addMentions);
  const activity = createProjectCommentActivityIntent({ type: "edited", projectId: input.projectId, actorId: input.actorId, commentId: input.commentId, occurredAt: input.occurredAt });
  const snapshots = await mentionOccurrenceSnapshots(db, input.projectId, input.addMentions);
  const desiredMentionIds = input.mentionIds ?? [];
  const mentionChanged = input.mentionIds === undefined
    ? "0 = 1"
    : desiredMentionIds.length
    ? `(
        EXISTS (SELECT 1 FROM project_comment_mentions current_mentions WHERE current_mentions.comment_id = ? AND current_mentions.mentioned_user_id NOT IN (${desiredMentionIds.map(() => "?").join(", ")}))
        OR (SELECT COUNT(*) FROM project_comment_mentions current_mentions WHERE current_mentions.comment_id = ?) <> ?
      )`
    : "EXISTS (SELECT 1 FROM project_comment_mentions current_mentions WHERE current_mentions.comment_id = ?)";
  const mentionChangedBindings = input.mentionIds === undefined
    ? []
    : desiredMentionIds.length
    ? [input.commentId, ...desiredMentionIds, input.commentId, desiredMentionIds.length]
    : [input.commentId];
  const auditId = newId();
  const statements: D1PreparedStatement[] = [db.prepare(`
    UPDATE project_comments
    SET body = ?, content_json = ?, edited_at = ?
    WHERE id = ? AND project_id = ?
      AND (body IS NOT ? OR content_json IS NOT ? OR ${mentionChanged})
  `).bind(input.body, input.contentJson, input.editedAt.getTime(), input.commentId, input.projectId, input.body, input.contentJson, ...mentionChangedBindings)];
  statements.push(db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'project_comment.edit', 'project_comment', ?, ?, ?
    WHERE changes() = 1
  `).bind(auditId, input.auditPrincipal?.id ?? input.actorId, input.commentId, auditMeta(input.auditPrincipal ?? { id: input.actorId, impersonatedBy: null }), input.occurredAt.getTime()));
  statements.push(...input.removeMentionIds.map((id) => db.prepare("DELETE FROM project_comment_mentions WHERE id = ? AND comment_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)").bind(id, input.commentId, auditId)));
  statements.push(...input.addMentions.map((mention) => db.prepare(`
    INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
  `).bind(mention.id, mention.commentId, mention.mentionedUserId, mention.createdAt.getTime(), auditId)));
  const outbox = mentionOutboxStatements(db, input.projectId, input.actorId, activity, input.addMentions, snapshots, input.occurredAt.getTime(), auditId);
  const activityStatements = buildProjectActivityStatements({ db, intent: activity, winnerAuditId: auditId, createdAt: input.occurredAt.getTime() });
  const activityStatementStart = statements.length + outbox.statements.length;
  const results = await db.batch([...statements, ...outbox.statements, ...activityStatements.statements]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    // A rebuilt request whose complete canonical body/content/mention state is still current is
    // the bounded retry identity for this command. It is a successful no-op: no new audit,
    // activity, mention delivery, or broad outbox was admitted by the marker gate.
    const current = await findProjectComment(createDb(db), input.projectId, input.commentId);
    if (current) return { comment: current, activity, notificationOutboxIds: [] };
    throw new Error("Comment could not be updated");
  }
  const comment = await findProjectComment(createDb(db), input.projectId, input.commentId);
  if (!comment) throw new Error("Comment could not be updated");
  const broad = rows<{ id: string }>(results[activityStatementStart + activityStatements.broadOutboxIndex] as D1Result<{ id: string }>).map((row) => row.id);
  return { comment, activity, notificationOutboxIds: [...outbox.outboxIds, ...broad] };
}

export async function deleteProjectComment(db: D1Database, input: DeleteProjectCommentInput): Promise<ProjectCommentMutationResult> {
  const activity = createProjectCommentActivityIntent({ type: "deleted", projectId: input.projectId, actorId: input.actorId, commentId: input.commentId, occurredAt: input.occurredAt });
  const deletion = db.prepare("DELETE FROM project_comments WHERE id = ? AND project_id = ?").bind(input.commentId, input.projectId);
  const auditId = newId();
  const audit = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'project_comment.delete', 'project_comment', ?, ?, ?
    WHERE changes() = 1
  `).bind(auditId, input.auditPrincipal?.id ?? input.actorId, input.commentId, auditMeta(input.auditPrincipal ?? { id: input.actorId, impersonatedBy: null }), input.occurredAt.getTime());
  const activityStatements = buildProjectActivityStatements({ db, intent: activity, winnerAuditId: auditId, createdAt: input.occurredAt.getTime() });
  const activityStatementStart = 2;
  const results = await db.batch([deletion, audit, ...activityStatements.statements]);
  // The JS-level .meta.changes on the DELETE includes cascade-deleted
  // project_comment_mentions rows (ON DELETE CASCADE), so the outer check must accept any
  // positive value. The SQL-level changes() function used by the audit guard excludes those
  // cascades, so its exact-one guard is correct here, as it is for create and edit.
  if ((results[0]?.meta.changes ?? 0) < 1) throw new Error("Comment could not be deleted");
  const broad = rows<{ id: string }>(results[activityStatementStart + activityStatements.broadOutboxIndex] as D1Result<{ id: string }>).map((row) => row.id);
  return { activity, notificationOutboxIds: broad };
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
