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
 * re-checks everything at delivery. Only call this from a site that notifies: edits, deletes, resolves, paste and a staff-recorded decision emit nothing.
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
  /** The source write's audit row: the fence. */
  auditId: string;
  occurredAt: number;
  /** The gate the request already read (a route reads it once); omitted, it is read here. */
  gate?: VideoReviewGateState;
  /**
   * The people this write mentions (#835), by mention row. A mentioned member of the audience gets `video_mention` (source key `video_mention:<mentionId>`, so a re-add after a removal is a
   * new key) in place of the ordinary kind, never both. The Actor is skipped like everyone else.
   */
  mentions?: Array<{ id: string; userId: string }>;
  /** An edit: only the mentions are told, the ordinary kind goes to nobody (an edit notifies nothing else). */
  mentionsOnly?: boolean;
};

export type Candidate = { userId: string; role: string; name: string; membershipId: string | null };
const VIEWERS = ROLES.filter((role) => roleHasCapability(role, "viewVideo"));
const VIEWER_SQL = VIEWERS.map((role) => `'${role}'`).join(", ");

/**
 * The one audience for every video kind (#835): active users with a `project_members` row on the Project whose role holds `viewVideo`, never the Actor. A non-member Admin is not in it,
 * a Photographer is not, and a guest has no user id. A reply is told to the same people as a note, whoever wrote in the thread.
 */
export async function videoAudience(db: D1Database, input: Pick<VideoReviewEmit, "projectId" | "excludeUserId">): Promise<Candidate[]> {
  return (await db.prepare(`
    SELECT u.id AS userId, u.role AS role, u.name AS name, pm.id AS membershipId
    FROM project_members pm JOIN user u ON u.id = pm.user_id
    WHERE pm.project_id = ?1 AND u.active = 1 AND u.role IN (${VIEWER_SQL}) AND u.id IS NOT ?2
  `).bind(input.projectId, input.excludeUserId).all<Candidate>()).results;
}

const SOURCE_EXISTS: Record<VideoReviewNotificationType, string> = {
  video_version_uploaded: "EXISTS (SELECT 1 FROM assets WHERE id = ?)",
  video_note: "EXISTS (SELECT 1 FROM video_notes WHERE id = ?)",
  video_reply: "EXISTS (SELECT 1 FROM video_notes WHERE id = ?)",
  video_decision: "EXISTS (SELECT 1 FROM video_approval_events WHERE id = ?)",
  video_released: "EXISTS (SELECT 1 FROM video_releases WHERE id = ? AND withdrawn_at IS NULL)",
  video_mention: "EXISTS (SELECT 1 FROM video_note_mentions WHERE id = ?)",
};

export async function videoReviewOutboxStatements(db: D1Database, input: VideoReviewEmit): Promise<{ statements: D1PreparedStatement[]; outboxIds: string[] }> {
  const none = { statements: [], outboxIds: [] };
  const gate = input.gate ?? await readVideoReviewGate(db, input.projectId);
  if (!gate.open || !gate.parts.includes("notify_staff")) return none;
  const candidates = await videoAudience(db, input);
  const people = new Map<string, { role: string; membershipIds: string[] }>();
  for (const candidate of candidates) {
    const person = people.get(candidate.userId) ?? { role: candidate.role, membershipIds: [] };
    if (candidate.membershipId) person.membershipIds.push(candidate.membershipId);
    people.set(candidate.userId, person);
  }
  const eventType = NOTIFICATION_OUTBOX_EVENT_TYPES.projectVideoReview;
  const mentionOf = new Map((input.mentions ?? []).map((mention) => [mention.userId, mention.id]));
  const statements: D1PreparedStatement[] = []; const outboxIds: string[] = [];
  for (const [recipientId, person] of people) {
    if (!person.membershipIds.length) continue;
    const mentionId = mentionOf.get(recipientId);
    if (input.mentionsOnly && mentionId === undefined) continue;
    const kind: VideoReviewNotificationType = mentionId === undefined ? input.kind : "video_mention";
    const sourceId = mentionId ?? input.sourceId;
    const sourceKey = videoReviewNotificationSourceKey(kind, sourceId);
    const payload: VideoReviewNotificationPayload = {
      schemaVersion: 1,
      event: { type: eventType, sourceKey, recipientId },
      authorizationAtOccurrence: { kind: "project_member", membershipIds: [...person.membershipIds].sort() },
      video: { kind, projectId: input.projectId, videoId: input.videoId, assetId: input.assetId, sourceId },
    };
    const outboxId = newId(); outboxIds.push(outboxId);
    statements.push(db.prepare(`
      INSERT INTO notification_outbox (
        id, schema_version, event_type, source_key, project_id, actor_id,
        recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at
      ) SELECT ?, 1, ?, ?, ?, ?, ?, (SELECT authorization_epoch FROM user WHERE id = ?), ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?) AND ${SOURCE_EXISTS[kind]}
    `).bind(outboxId, eventType, sourceKey, input.projectId, input.actorId, recipientId, recipientId, JSON.stringify(payload), input.occurredAt, input.occurredAt, input.occurredAt, input.auditId, sourceId));
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
