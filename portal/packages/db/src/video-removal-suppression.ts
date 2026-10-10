import { NOTIFICATION_OUTBOX_EVENT_TYPES } from "@quincy/shared";

/**
 * Terminally suppresses what is outstanding for a removed Video or Version (#776 C), fenced on the removal's audit row. The subject is the Version (`$.video.assetId`) or, for a Video, the Video
 * (`$.video.videoId`) in the payload of a video-review outbox row. Lives here, not in the app Worker, so the background Worker's tests drive the very statements a removal runs.
 *
 * A pending or queued outbox row, a pending or deferred ledger row and a pending digest item go to `suppressed` WHATEVER the outbox row's lease state: a worker that claimed the row before the
 * removal and resumes after an Undo would pass the live re-check, but its send claim needs a `pending` ledger row, so it finds none. The outbox row itself is left to its lease holder when `processing`.
 *
 * A ledger row that is `processing` is a claim that already passed the live re-check, so an Undo would let it through. An IN-APP one is terminally suppressed too: its notification insert and its
 * `sent` convergence both need a `processing` row, so the resumed worker inserts nothing. An EMAIL one is a send attempt that may already be on the wire, so its status is NOT rewritten (an
 * accepted or ambiguous send keeps whatever outcome the worker records); it is marked with `last_error_code = 'video_removed'` instead, and the one path that would rearm it, the quota
 * release-and-retry, reads that mark and suppresses rather than re-arming. A delivery that already went out is kept.
 */
export function videoRemovalSuppressionStatements(db: D1Database, input: { projectId: string; path: "$.video.assetId" | "$.video.videoId"; subjectId: string; auditId: string; now: number }): D1PreparedStatement[] {
  const binds = [input.now, NOTIFICATION_OUTBOX_EVENT_TYPES.projectVideoReview, input.projectId, input.path, input.subjectId, input.auditId] as const;
  const fence = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?6)";
  const subject = "o.event_type = ?2 AND o.project_id = ?3 AND json_extract(o.payload_json, ?4) = ?5";
  return [
    db.prepare(`UPDATE notification_digest_items SET state = 'suppressed', outcome_code = 'video_removed', updated_at = ?1
      WHERE state = 'pending' AND ledger_id IN (SELECT l.id FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE ${subject}) AND ${fence}`).bind(...binds),
    db.prepare(`UPDATE notification_delivery_ledger SET status = 'suppressed', last_error_code = 'video_removed', last_error = 'The Video or Version was removed.', updated_at = ?1
      WHERE (status IN ('pending', 'deferred') OR (status = 'processing' AND channel = 'in_app')) AND outbox_id IN (SELECT o.id FROM notification_outbox o WHERE ${subject}) AND ${fence}`).bind(...binds),
    db.prepare(`UPDATE notification_delivery_ledger SET last_error_code = 'video_removed', last_error = 'The Video or Version was removed.', updated_at = ?1
      WHERE status = 'processing' AND channel = 'email' AND outbox_id IN (SELECT o.id FROM notification_outbox o WHERE ${subject}) AND ${fence}`).bind(...binds),
    db.prepare(`UPDATE notification_outbox SET status = 'suppressed', last_error_code = 'video_removed', last_error = 'The Video or Version was removed.', lease_token = NULL, lease_expires_at = NULL, completed_at = ?1, updated_at = ?1
      WHERE event_type = ?2 AND project_id = ?3 AND status IN ('pending', 'queued') AND json_extract(payload_json, ?4) = ?5 AND ${fence}`).bind(...binds),
  ];
}
