import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import {
  clampNotificationBody,
  parseNotificationSource,
  type NotificationSource,
} from "@quincy/shared";
import type { SessionUser } from "../env";
import { chunked } from "./project-covers";
import { isUserVisibleAsset } from "./asset-visibility";

export type NotificationEnrichmentActor = { id: string; name: string };
export type NotificationEnrichmentSubject = {
  kind: "asset" | "subtask" | "project_comment" | "notice_board_post";
  label: string;
};
export type NotificationEnrichmentEntry = {
  title?: string;
  body?: string | null;
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

const LEDGER_TYPES = new Set<string>(["assigned_to_project", "project_activity", "project_collaboration_activity"]);

/** A resolvable actor never names the recipient, and never carries a blank name. */
function resolveActor(recipientId: string, actorId: string | null | undefined, actorName: string | null | undefined): NotificationEnrichmentActor | null {
  if (!actorId || !actorName || !actorName.trim()) return null;
  if (actorId === recipientId) return null;
  return { id: actorId, name: actorName };
}

/**
 * A historical notification does not grant current project access (see
 * notification-project-context.ts). Notice-board mentions carry no projectId and are exempt
 * from this gate; every other enrichable type is scoped to its stored project.
 */
function projectVisible(row: NotificationEnrichmentRow, visibleProjectIds: ReadonlySet<string>): boolean {
  return row.projectId === null || visibleProjectIds.has(row.projectId);
}

/**
 * READ-time enrichment for the staff notification list. Groups rows by parsed source into at
 * most five batched IN(...) queries (never one query per row), resolves an actor/subject/assetId
 * per row where the source is still live and its project/Asset are still visible to this
 * recipient, and composes title/body only where the contract's declared parts for that type all
 * resolve. A row with no map entry is unchanged (falls back to its stored title/body).
 */
export async function notificationEnrichment(
  db: ReturnType<typeof createDb>,
  user: Pick<SessionUser, "id" | "role">,
  rows: NotificationEnrichmentRow[],
  visibleProjectIds: ReadonlySet<string>,
): Promise<Map<string, NotificationEnrichmentEntry>> {
  const result = new Map<string, NotificationEnrichmentEntry>();
  const sourceByRowId = new Map<string, NotificationSource>();
  for (const row of rows) {
    if (!projectVisible(row, visibleProjectIds)) continue;
    sourceByRowId.set(row.id, parseNotificationSource(row.type, row.projectId, row.sourceKey));
  }

  const annotationIdList = [...new Set(
    rows
      .filter((row) => row.type === "comment_added")
      .map((row) => sourceByRowId.get(row.id))
      .filter((source): source is Extract<NotificationSource, { kind: "annotation" }> => source?.kind === "annotation")
      .map((source) => source.annotationId),
  )];

  const projectCommentMentionIds = [...new Set(
    rows.map((row) => sourceByRowId.get(row.id))
      .filter((source): source is Extract<NotificationSource, { kind: "project_comment_mention" }> => source?.kind === "project_comment_mention")
      .map((source) => source.mentionId),
  )];

  const noticeBoardMentionIds = [...new Set(
    rows.map((row) => sourceByRowId.get(row.id))
      .filter((source): source is Extract<NotificationSource, { kind: "notice_board_mention" }> => source?.kind === "notice_board_mention")
      .map((source) => source.mentionId),
  )];

  const subtaskIds = [...new Set(
    rows.map((row) => sourceByRowId.get(row.id))
      .filter((source): source is Extract<NotificationSource, { kind: "subtask_assignment" | "subtask_due" }> => source?.kind === "subtask_assignment" || source?.kind === "subtask_due")
      .map((source) => source.subtaskId),
  )];

  const ledgerNotificationIds = rows.filter((row) => LEDGER_TYPES.has(row.type) && sourceByRowId.has(row.id)).map((row) => row.id);

  const [annotationDetails, projectCommentMentionDetails, noticeBoardMentionDetails, subtaskDetails, ledgerDetails] = await Promise.all([
    loadAnnotationDetails(db, annotationIdList),
    loadProjectCommentMentionDetails(db, projectCommentMentionIds),
    loadNoticeBoardMentionDetails(db, noticeBoardMentionIds),
    loadSubtaskDetails(db, subtaskIds),
    loadLedgerDetails(db, ledgerNotificationIds, user.id),
  ]);

  for (const row of rows) {
    const source = sourceByRowId.get(row.id);
    if (!source) continue;

    if (row.type === "comment_added" && source.kind === "annotation") {
      const detail = annotationDetails.get(source.annotationId);
      if (!detail) continue;
      if (detail.collectionProjectId !== row.projectId) continue;
      const assetGateOk = isUserVisibleAsset(detail.collectionKind, detail.publishStatus)
        && detail.supersededAt === null
        && (user.role !== "photographer" || detail.collectionKind === "raw");
      const actor = resolveActor(user.id, detail.authorId, detail.authorName);
      const entry: NotificationEnrichmentEntry = { actor, subject: null, assetId: null };
      // The note is about the Asset, so it goes out only with the Asset: a photographer who may not
      // see an edited frame does not learn what was said about it either. The actor alone is safe —
      // the stored copy already tells them feedback exists on the project.
      if (assetGateOk) {
        entry.subject = { kind: "asset", label: detail.originalFilename };
        entry.assetId = detail.assetId;
        if (actor) entry.title = `${actor.name} commented on ${detail.originalFilename}`;
        if (detail.noteText !== null) entry.body = clampNotificationBody(detail.noteText);
      }
      result.set(row.id, entry);
      continue;
    }

    if (row.type === "mentioned" && source.kind === "project_comment_mention") {
      const detail = projectCommentMentionDetails.get(source.mentionId);
      if (!detail) continue;
      const actor = resolveActor(user.id, detail.authorId, detail.authorName);
      const body = clampNotificationBody(detail.body);
      const entry: NotificationEnrichmentEntry = {
        actor,
        subject: { kind: "project_comment", label: body },
        assetId: null,
        body,
      };
      if (actor) entry.title = `${actor.name} mentioned you`;
      result.set(row.id, entry);
      continue;
    }

    if (row.type === "mentioned" && source.kind === "notice_board_mention") {
      const detail = noticeBoardMentionDetails.get(source.mentionId);
      if (!detail) continue;
      const actor = resolveActor(user.id, detail.authorId, detail.authorName);
      const body = clampNotificationBody(detail.body);
      const entry: NotificationEnrichmentEntry = {
        actor,
        subject: { kind: "notice_board_post", label: body },
        assetId: null,
        body,
      };
      if (actor) entry.title = `${actor.name} mentioned you on the Notice Board`;
      result.set(row.id, entry);
      continue;
    }

    if (row.type === "subtask_assigned" && source.kind === "subtask_assignment") {
      const detail = subtaskDetails.get(source.subtaskId);
      if (!detail) continue;
      // Staff `subtask_assigned` rows have no outbox row (only external recipients get one — see
      // packages/db/src/external-notifications.ts), so the ledger lookup never resolves an actor
      // for a staff recipient here. Tracked as a follow-up (owner decision #1 in the plan).
      const ledger = ledgerDetails.get(row.id);
      const actor = ledger ? resolveActor(user.id, ledger.actorId, ledger.actorName) : null;
      const entry: NotificationEnrichmentEntry = {
        actor,
        subject: { kind: "subtask", label: detail.title },
        assetId: null,
        body: detail.title,
      };
      if (actor) entry.title = `${actor.name} assigned you a subtask`;
      result.set(row.id, entry);
      continue;
    }

    if (row.type === "subtask_due_today" && source.kind === "subtask_due") {
      const detail = subtaskDetails.get(source.subtaskId);
      if (!detail) continue;
      result.set(row.id, { actor: null, subject: { kind: "subtask", label: detail.title }, assetId: null, body: detail.title });
      continue;
    }

    if (row.type === "assigned_to_project") {
      const ledger = ledgerDetails.get(row.id);
      const actor = ledger ? resolveActor(user.id, ledger.actorId, ledger.actorName) : null;
      const entry: NotificationEnrichmentEntry = { actor, subject: null, assetId: null };
      if (actor) entry.title = `${actor.name} assigned you to this project`;
      result.set(row.id, entry);
      continue;
    }

    if (row.type === "project_activity" || row.type === "project_collaboration_activity") {
      const ledger = ledgerDetails.get(row.id);
      const actor = ledger ? resolveActor(user.id, ledger.actorId, ledger.actorName) : null;
      result.set(row.id, { actor, subject: null, assetId: null });
      continue;
    }
  }

  return result;
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

async function loadAnnotationDetails(db: ReturnType<typeof createDb>, annotationIds: string[]): Promise<Map<string, AnnotationDetail>> {
  const details = new Map<string, AnnotationDetail>();
  if (!annotationIds.length) return details;
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

type MentionAuthorDetail = { authorId: string; authorName: string; body: string };

async function loadProjectCommentMentionDetails(db: ReturnType<typeof createDb>, mentionIds: string[]): Promise<Map<string, MentionAuthorDetail>> {
  const details = new Map<string, MentionAuthorDetail>();
  if (!mentionIds.length) return details;
  for (const ids of chunked(mentionIds)) {
    const rows = await db.select({
      mentionId: schema.projectCommentMentions.id,
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

async function loadNoticeBoardMentionDetails(db: ReturnType<typeof createDb>, mentionIds: string[]): Promise<Map<string, MentionAuthorDetail>> {
  const details = new Map<string, MentionAuthorDetail>();
  if (!mentionIds.length) return details;
  for (const ids of chunked(mentionIds)) {
    const rows = await db.select({
      mentionId: schema.noticeBoardPostMentions.id,
      authorId: schema.noticeBoardPosts.authorId,
      authorName: schema.user.name,
      body: schema.noticeBoardPosts.body,
    })
      .from(schema.noticeBoardPostMentions)
      .innerJoin(schema.noticeBoardPosts, eq(schema.noticeBoardPosts.id, schema.noticeBoardPostMentions.postId))
      .innerJoin(schema.user, eq(schema.user.id, schema.noticeBoardPosts.authorId))
      .where(inArray(schema.noticeBoardPostMentions.id, ids))
      .all();
    for (const row of rows) details.set(row.mentionId, row);
  }
  return details;
}

type SubtaskDetail = { title: string };

async function loadSubtaskDetails(db: ReturnType<typeof createDb>, subtaskIds: string[]): Promise<Map<string, SubtaskDetail>> {
  const details = new Map<string, SubtaskDetail>();
  if (!subtaskIds.length) return details;
  for (const ids of chunked(subtaskIds)) {
    const rows = await db.select({ id: schema.projectSubtasks.id, title: schema.projectSubtasks.title })
      .from(schema.projectSubtasks)
      .where(inArray(schema.projectSubtasks.id, ids))
      .all();
    for (const row of rows) details.set(row.id, { title: row.title });
  }
  return details;
}

type LedgerDetail = { actorId: string; actorName: string };

async function loadLedgerDetails(db: ReturnType<typeof createDb>, notificationIds: string[], recipientId: string): Promise<Map<string, LedgerDetail>> {
  const details = new Map<string, LedgerDetail>();
  if (!notificationIds.length) return details;
  for (const ids of chunked(notificationIds)) {
    const rows = await db.select({
      notificationId: schema.notificationDeliveryLedger.notificationId,
      actorId: schema.notificationOutbox.actorId,
      actorName: schema.user.name,
    })
      .from(schema.notificationDeliveryLedger)
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
