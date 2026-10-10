import {
  NOTIFICATION_OUTBOX_EVENT_TYPES, ROLES, roleHasCapability, videoReviewNotificationSourceKey,
  type VideoReviewNotificationPayload, type VideoReviewNotificationType,
} from "@quincy/shared";
import { newId } from "./ids";
import { readVideoReviewGate, type VideoReviewGateState } from "./video-review-gate";

/**
 * Staff video-review notifications (#741 15a). `videoReviewOutboxStatements` is the `mentionOutboxStatements` shape (lib/project-comments.ts): one outbox row per recipient plus an `in_app` and
 * an `email` ledger row, appended to the SOURCE write's `db.batch` and fenced on that write's audit row, so a refused or rolled-back write leaves nothing behind. The payload names the source
 * row and nothing else: no staff notification carries note text (docs/plans/741-13-15.md section 1.7), and the consumer composes the title at delivery.
 *
 * The recipients and the `notify_staff` gate are read just BEFORE the batch (the batch is where the source row appears), so a person added a millisecond later is simply not told; the consumer
 * re-checks everything at delivery. Only call this from a site that notifies: edits, deletes, resolves, paste, a staff-recorded decision and Release emit nothing.
 */
export type VideoReviewEmit = {
  kind: VideoReviewNotificationType;
  projectId: string; videoId: string; assetId: string;
  /** The note, reply, decision event or Version (asset) the notification is about. */
  sourceId: string;
  /** The outbox actor: the user id, or `guest:<guestId>`. */
  actorId: string;
  /** The user never told about their own action; null for a guest. */
  excludeUserId: string | null;
  /** The thread's root note, for a reply: its authors are told, with the Version's uploader. */
  threadRootId?: string;
  /** The source write's audit row: the fence. */
  auditId: string;
  occurredAt: number;
  /** The gate the request already read (a route reads it once); omitted, it is read here. */
  gate?: VideoReviewGateState;
};

type Candidate = { userId: string; role: string; membershipId: string | null };
const VIEWERS = ROLES.filter((role) => roleHasCapability(role, "viewVideo"));
const VIEWER_SQL = VIEWERS.map((role) => `'${role}'`).join(", ");

/** Users who have a `project_members` row on the Project: told of an upload, a new note or a client decision. */
async function projectMembers(db: D1Database, input: VideoReviewEmit): Promise<Candidate[]> {
  return (await db.prepare(`
    SELECT u.id AS userId, u.role AS role, pm.id AS membershipId
    FROM project_members pm JOIN user u ON u.id = pm.user_id
    WHERE pm.project_id = ?1 AND u.active = 1 AND u.role IN (${VIEWER_SQL}) AND u.id IS NOT ?2
  `).bind(input.projectId, input.excludeUserId).all<Candidate>()).results;
}

/** A reply: everyone who wrote the root or a reply in the thread, plus the Version's uploader; each must be an Admin or a current member. Guests never appear (no user id). */
async function threadParticipants(db: D1Database, input: VideoReviewEmit): Promise<Candidate[]> {
  return (await db.prepare(`
    SELECT u.id AS userId, u.role AS role, pm.id AS membershipId
    FROM user u LEFT JOIN project_members pm ON pm.project_id = ?1 AND pm.user_id = u.id
    WHERE u.active = 1 AND u.role IN (${VIEWER_SQL}) AND u.id IS NOT ?2
      AND (u.role = 'admin' OR pm.id IS NOT NULL)
      AND u.id IN (
        SELECT n.author_user_id FROM video_notes n WHERE n.project_id = ?1 AND (n.id = ?3 OR n.parent_id = ?3) AND n.author_user_id IS NOT NULL
        UNION SELECT m.uploaded_by FROM video_version_meta m WHERE m.asset_id = ?4
      )
  `).bind(input.projectId, input.excludeUserId, input.threadRootId ?? null, input.assetId).all<Candidate>()).results;
}

const SOURCE_EXISTS: Record<VideoReviewNotificationType, string> = {
  video_version_uploaded: "EXISTS (SELECT 1 FROM assets WHERE id = ?)",
  video_note: "EXISTS (SELECT 1 FROM video_notes WHERE id = ?)",
  video_reply: "EXISTS (SELECT 1 FROM video_notes WHERE id = ?)",
  video_decision: "EXISTS (SELECT 1 FROM video_approval_events WHERE id = ?)",
};

export async function videoReviewOutboxStatements(db: D1Database, input: VideoReviewEmit): Promise<{ statements: D1PreparedStatement[]; outboxIds: string[] }> {
  const none = { statements: [], outboxIds: [] };
  const gate = input.gate ?? await readVideoReviewGate(db, input.projectId);
  if (!gate.open || !gate.parts.includes("notify_staff")) return none;
  const candidates = input.kind === "video_reply" ? await threadParticipants(db, input) : await projectMembers(db, input);
  const people = new Map<string, { role: string; membershipIds: string[] }>();
  for (const candidate of candidates) {
    const person = people.get(candidate.userId) ?? { role: candidate.role, membershipIds: [] };
    if (candidate.membershipId) person.membershipIds.push(candidate.membershipId);
    people.set(candidate.userId, person);
  }
  const sourceKey = videoReviewNotificationSourceKey(input.kind, input.sourceId);
  const eventType = NOTIFICATION_OUTBOX_EVENT_TYPES.projectVideoReview;
  const statements: D1PreparedStatement[] = []; const outboxIds: string[] = [];
  for (const [recipientId, person] of people) {
    if (person.role !== "admin" && !person.membershipIds.length) continue;
    const payload: VideoReviewNotificationPayload = {
      schemaVersion: 1,
      event: { type: eventType, sourceKey, recipientId },
      authorizationAtOccurrence: person.role === "admin" ? { kind: "admin" } : { kind: "project_member", membershipIds: [...person.membershipIds].sort() },
      video: { kind: input.kind, projectId: input.projectId, videoId: input.videoId, assetId: input.assetId, sourceId: input.sourceId },
    };
    const outboxId = newId(); outboxIds.push(outboxId);
    statements.push(db.prepare(`
      INSERT INTO notification_outbox (
        id, schema_version, event_type, source_key, project_id, actor_id,
        recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at
      ) SELECT ?, 1, ?, ?, ?, ?, ?, (SELECT authorization_epoch FROM user WHERE id = ?), ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?) AND ${SOURCE_EXISTS[input.kind]}
    `).bind(outboxId, eventType, sourceKey, input.projectId, input.actorId, recipientId, recipientId, JSON.stringify(payload), input.occurredAt, input.occurredAt, input.occurredAt, input.auditId, input.sourceId));
    for (const channel of ["in_app", "email"] as const) {
      statements.push(db.prepare(`
        INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND event_type = ? AND source_key = ? AND recipient_id = ?)
      `).bind(newId(), outboxId, eventType, sourceKey, recipientId, channel, input.occurredAt, input.occurredAt, outboxId, eventType, sourceKey, recipientId));
    }
  }
  return statements.length ? { statements, outboxIds } : none;
}
