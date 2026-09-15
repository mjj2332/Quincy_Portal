import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import {
  NOTIFICATION_ENRICHMENT,
  clampNotificationBody,
  parseNotificationSource,
  roleHasCapability,
  type NotificationSource,
  type NotificationSubjectKind,
} from "@quincy/shared";
import type { SessionUser } from "../env";
import { chunked } from "./project-covers";
import { isUserVisibleAsset } from "./asset-visibility";

export type NotificationEnrichmentActor = { id: string; name: string };
export type NotificationEnrichmentSubject = { kind: NotificationSubjectKind; label: string };
/** `title`/`body` absent = the stored copy stands. A body is never set to null: a source with no text leaves the stored body alone. */
export type NotificationEnrichmentEntry = {
  title?: string;
  body?: string;
  actor: NotificationEnrichmentActor | null;
  subject: NotificationEnrichmentSubject | null;
  assetId: string | null;
};
export type NotificationEnrichmentRow = {
  id: string;
  type: string;
  projectId: string | null;
  sourceKey: string | null;
};

type Db = ReturnType<typeof createDb>;
type SourceOf<K extends NotificationSource["kind"]> = Extract<NotificationSource, { kind: K }>;

/** The types whose actor lives only on the outbox row — the shared declaration is the single list. */
const LEDGER_TYPES = new Set(
  Object.entries(NOTIFICATION_ENRICHMENT).filter(([, entry]) => entry.actor === "ledger").map(([type]) => type),
);

/** A resolvable actor never names the recipient, and never carries a blank name. */
function resolveActor(recipientId: string, actorId: string | null | undefined, actorName: string | null | undefined): NotificationEnrichmentActor | null {
  if (!actorId || !actorName || !actorName.trim()) return null;
  if (actorId === recipientId) return null;
  return { id: actorId, name: actorName };
}

/**
 * READ-time enrichment for the staff notification list. Groups rows by parsed source into at
 * most six batched IN(...) queries (never one query per row), resolves an actor/subject/assetId
 * per row where the source is still live and still visible to this recipient, and composes
 * title/body only where the declared parts for that type all resolve. A row with no map entry
 * is unchanged and goes out with its stored title/body.
 *
 * Two visibility gates, matching the routes that already expose the same facts:
 * - `visibleProjectIds` (general project visibility, `visibleProjectWhere`) gates everything that
 *   has a project — the same predicate `/media/asset/:id` and the annotation routes use.
 * - Comment text and subtask titles additionally need *collaboration* access
 *   (`hasProjectCollaborationAccessForUser`: an admin, or an explicit `project_members` row),
 *   because the comment and subtask routes return 403 to a non-member editor even though
 *   `viewAllProjects` lets them see the project. Resolved here in one batched query rather than
 *   per row.
 */
export async function notificationEnrichment(
  db: Db,
  user: Pick<SessionUser, "id" | "role">,
  rows: NotificationEnrichmentRow[],
  visibleProjectIds: ReadonlySet<string>,
): Promise<Map<string, NotificationEnrichmentEntry>> {
  const result = new Map<string, NotificationEnrichmentEntry>();
  const sources = new Map<string, NotificationSource>();
  for (const row of rows) {
    // A historical notification does not grant current project access (see
    // notification-project-context.ts). Notice-board mentions carry no project and are gated
    // by the Notice Board capability below instead.
    if (row.projectId !== null && !visibleProjectIds.has(row.projectId)) continue;
    sources.set(row.id, parseNotificationSource(row.type, row.projectId, row.sourceKey));
  }
  const rowsOfKind = <K extends NotificationSource["kind"]>(...kinds: K[]) =>
    rows.flatMap((row) => {
      const source = sources.get(row.id);
      return source && (kinds as string[]).includes(source.kind) ? [{ row, source: source as SourceOf<K> }] : [];
    });
  const unique = (ids: string[]) => [...new Set(ids)];

  const annotationRows = rowsOfKind("annotation");
  const commentMentionRows = rowsOfKind("project_comment_mention");
  const noticeBoardMentionRows = rowsOfKind("notice_board_mention");
  const subtaskRows = rowsOfKind("subtask_assignment", "subtask_due");
  const ledgerRows = rows.filter((row) => LEDGER_TYPES.has(row.type) && sources.has(row.id));
  const collaborationProjectIds = unique([...commentMentionRows, ...subtaskRows].flatMap(({ row }) => (row.projectId ? [row.projectId] : [])));

  const [annotationDetails, commentMentionDetails, noticeBoardMentionDetails, subtaskDetails, ledgerDetails, collaborates] = await Promise.all([
    loadAnnotationDetails(db, unique(annotationRows.map(({ source }) => source.annotationId))),
    loadProjectCommentMentionDetails(db, unique(commentMentionRows.map(({ source }) => source.mentionId))),
    loadNoticeBoardMentionDetails(db, unique(noticeBoardMentionRows.map(({ source }) => source.mentionId))),
    loadSubtaskDetails(db, unique(subtaskRows.map(({ source }) => source.subtaskId))),
    loadLedgerDetails(db, ledgerRows.map((row) => row.id), user.id),
    loadCollaborationProjectIds(db, user, collaborationProjectIds),
  ]);
  const ledgerActor = (rowId: string) => {
    const ledger = ledgerDetails.get(rowId);
    return ledger ? resolveActor(user.id, ledger.actorId, ledger.actorName) : null;
  };

  for (const { row, source } of annotationRows) {
    const detail = annotationDetails.get(source.annotationId);
    if (!detail || detail.collectionProjectId !== row.projectId) continue;
    const assetVisible = isUserVisibleAsset(detail.collectionKind, detail.publishStatus)
      && detail.supersededAt === null
      && (user.role !== "photographer" || detail.collectionKind === "raw");
    const actor = resolveActor(user.id, detail.authorId, detail.authorName);
    const entry: NotificationEnrichmentEntry = { actor, subject: null, assetId: null };
    // The note is about the Asset, so it goes out only with the Asset: a photographer who may not
    // see an edited frame does not learn what was said about it either. The actor alone is safe —
    // the stored copy already tells them feedback exists on the project.
    if (assetVisible) {
      entry.subject = { kind: "asset", label: detail.originalFilename };
      entry.assetId = detail.assetId;
      if (actor) entry.title = `${actor.name} commented on ${detail.originalFilename}`;
      if (detail.noteText !== null) entry.body = clampNotificationBody(detail.noteText);
    }
    result.set(row.id, entry);
  }

  for (const { row, source } of commentMentionRows) {
    const detail = commentMentionDetails.get(source.mentionId);
    // The mention must be this recipient's, on a comment in this notification's project, and
    // the recipient must still be able to open the project's comments at all.
    if (!detail || detail.mentionedUserId !== user.id || detail.projectId !== row.projectId) continue;
    if (!row.projectId || !collaborates.has(row.projectId)) continue;
    const actor = resolveActor(user.id, detail.authorId, detail.authorName);
    const body = clampNotificationBody(detail.body);
    const entry: NotificationEnrichmentEntry = { actor, subject: { kind: "project_comment", label: body }, assetId: null, body };
    if (actor) entry.title = `${actor.name} mentioned you`;
    result.set(row.id, entry);
  }

  for (const { row, source } of noticeBoardMentionRows) {
    const detail = noticeBoardMentionDetails.get(source.mentionId);
    if (!detail || detail.mentionedUserId !== user.id) continue;
    if (!roleHasCapability(user.role, "viewNoticeBoard")) continue;
    const actor = resolveActor(user.id, detail.authorId, detail.authorName);
    const body = clampNotificationBody(detail.body);
    const entry: NotificationEnrichmentEntry = { actor, subject: { kind: "notice_board_post", label: body }, assetId: null, body };
    if (actor) entry.title = `${actor.name} mentioned you on the Notice Board`;
    result.set(row.id, entry);
  }

  for (const { row, source } of subtaskRows) {
    const detail = subtaskDetails.get(source.subtaskId);
    if (!detail || detail.projectId !== row.projectId) continue;
    if (!row.projectId || !collaborates.has(row.projectId)) continue;
    const entry: NotificationEnrichmentEntry = { actor: null, subject: { kind: "subtask", label: detail.title }, assetId: null, body: detail.title };
    if (source.kind === "subtask_assignment") {
      // Staff `subtask_assigned` rows have no outbox row (only external recipients get one — see
      // packages/db/src/external-notifications.ts), so this resolves an actor for nobody the staff
      // branch serves today. Kept on the ledger path so the day a staff outbox row is emitted, the
      // title composes without a resolver change (owner decision #1 in the PR).
      entry.actor = ledgerActor(row.id);
      if (entry.actor) entry.title = `${entry.actor.name} assigned you a subtask`;
    }
    result.set(row.id, entry);
  }

  for (const row of ledgerRows) {
    if (row.type === "assigned_to_project") {
      const actor = ledgerActor(row.id);
      const entry: NotificationEnrichmentEntry = { actor, subject: null, assetId: null };
      if (actor) entry.title = `${actor.name} assigned you to this project`;
      result.set(row.id, entry);
    } else if (!result.has(row.id)) {
      // project_activity / project_collaboration_activity: the stored body already leads with the
      // actor's name (renderProjectActivityNotification), so only the avatar is filled here.
      result.set(row.id, { actor: ledgerActor(row.id), subject: null, assetId: null });
    }
  }

  return result;
}

/**
 * The project ids among `projectIds` this recipient may collaborate on — the batched form of
 * `hasProjectCollaborationAccessForUser`: every project for an admin, an explicit membership
 * row for any other staff role, nothing for a role without the capability.
 */
async function loadCollaborationProjectIds(db: Db, user: Pick<SessionUser, "id" | "role">, projectIds: string[]): Promise<ReadonlySet<string>> {
  if (!projectIds.length || !roleHasCapability(user.role, "collaborateOnProject")) return new Set();
  if (user.role === "admin") return new Set(projectIds);
  const members = new Set<string>();
  for (const ids of chunked(projectIds)) {
    const rows = await db.select({ projectId: schema.projectMembers.projectId })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.userId, user.id), inArray(schema.projectMembers.projectId, ids)))
      .all();
    for (const row of rows) members.add(row.projectId);
  }
  return members;
}

type AnnotationDetail = {
  authorId: string;
  authorName: string;
  assetId: string;
  originalFilename: string;
  publishStatus: string;
  supersededAt: number | Date | null;
  collectionKind: string;
  collectionProjectId: string;
  noteText: string | null;
};

async function loadAnnotationDetails(db: Db, annotationIds: string[]): Promise<Map<string, AnnotationDetail>> {
  const details = new Map<string, AnnotationDetail>();
  for (const ids of chunked(annotationIds)) {
    const rows = await db.select({
      annotationId: schema.annotations.id,
      authorId: schema.annotations.authorId,
      authorName: schema.user.name,
      assetId: schema.assets.id,
      originalFilename: schema.assets.originalFilename,
      publishStatus: schema.assets.publishStatus,
      supersededAt: schema.assets.supersededAt,
      collectionKind: schema.collections.kind,
      collectionProjectId: schema.collections.projectId,
      noteText: schema.annotations.noteText,
    })
      .from(schema.annotations)
      .innerJoin(schema.user, eq(schema.user.id, schema.annotations.authorId))
      .innerJoin(schema.assets, eq(schema.assets.id, schema.annotations.assetId))
      .innerJoin(schema.collections, eq(schema.collections.id, schema.assets.collectionId))
      .where(inArray(schema.annotations.id, ids))
      .all();
    for (const row of rows) details.set(row.annotationId, row);
  }
  return details;
}

type MentionDetail = { authorId: string; authorName: string; body: string; mentionedUserId: string; projectId: string | null };

async function loadProjectCommentMentionDetails(db: Db, mentionIds: string[]): Promise<Map<string, MentionDetail>> {
  const details = new Map<string, MentionDetail>();
  for (const ids of chunked(mentionIds)) {
    const rows = await db.select({
      mentionId: schema.projectCommentMentions.id,
      mentionedUserId: schema.projectCommentMentions.mentionedUserId,
      projectId: schema.projectComments.projectId,
      authorId: schema.projectComments.authorId,
      authorName: schema.user.name,
      body: schema.projectComments.body,
    })
      .from(schema.projectCommentMentions)
      .innerJoin(schema.projectComments, eq(schema.projectComments.id, schema.projectCommentMentions.commentId))
      .innerJoin(schema.user, eq(schema.user.id, schema.projectComments.authorId))
      .where(inArray(schema.projectCommentMentions.id, ids))
      .all();
    for (const row of rows) details.set(row.mentionId, row);
  }
  return details;
}

async function loadNoticeBoardMentionDetails(db: Db, mentionIds: string[]): Promise<Map<string, MentionDetail>> {
  const details = new Map<string, MentionDetail>();
  for (const ids of chunked(mentionIds)) {
    const rows = await db.select({
      mentionId: schema.noticeBoardPostMentions.id,
      mentionedUserId: schema.noticeBoardPostMentions.mentionedUserId,
      authorId: schema.noticeBoardPosts.authorId,
      authorName: schema.user.name,
      body: schema.noticeBoardPosts.body,
    })
      .from(schema.noticeBoardPostMentions)
      .innerJoin(schema.noticeBoardPosts, eq(schema.noticeBoardPosts.id, schema.noticeBoardPostMentions.postId))
      .innerJoin(schema.user, eq(schema.user.id, schema.noticeBoardPosts.authorId))
      .where(inArray(schema.noticeBoardPostMentions.id, ids))
      .all();
    for (const row of rows) details.set(row.mentionId, { ...row, projectId: null });
  }
  return details;
}

type SubtaskDetail = { title: string; projectId: string };

async function loadSubtaskDetails(db: Db, subtaskIds: string[]): Promise<Map<string, SubtaskDetail>> {
  const details = new Map<string, SubtaskDetail>();
  for (const ids of chunked(subtaskIds)) {
    const rows = await db.select({ id: schema.projectSubtasks.id, title: schema.projectSubtasks.title, projectId: schema.projectSubtasks.projectId })
      .from(schema.projectSubtasks)
      .where(inArray(schema.projectSubtasks.id, ids))
      .all();
    for (const row of rows) details.set(row.id, { title: row.title, projectId: row.projectId });
  }
  return details;
}

type LedgerDetail = { actorId: string; actorName: string };

async function loadLedgerDetails(db: Db, notificationIds: string[], recipientId: string): Promise<Map<string, LedgerDetail>> {
  const details = new Map<string, LedgerDetail>();
  for (const ids of chunked(notificationIds)) {
    const rows = await db.select({
      notificationId: schema.notificationDeliveryLedger.notificationId,
      actorId: schema.notificationOutbox.actorId,
      actorName: schema.user.name,
    })
      .from(schema.notificationDeliveryLedger)
      // An inner join on `user` also drops PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, which has no
      // user row: a system actor resolves to no actor without a sentinel check here.
      .innerJoin(schema.notificationOutbox, eq(schema.notificationOutbox.id, schema.notificationDeliveryLedger.outboxId))
      .innerJoin(schema.user, eq(schema.user.id, schema.notificationOutbox.actorId))
      .where(and(
        inArray(schema.notificationDeliveryLedger.notificationId, ids),
        eq(schema.notificationDeliveryLedger.channel, "in_app"),
        eq(schema.notificationDeliveryLedger.status, "sent"),
        eq(schema.notificationDeliveryLedger.recipientId, recipientId),
      ))
      .all();
    for (const row of rows) {
      if (row.notificationId) details.set(row.notificationId, { actorId: row.actorId, actorName: row.actorName });
    }
  }
  return details;
}
