import {
  CLIENT_DELIVERY_ALL_PROJECTS_FLAG, CLIENT_DELIVERY_MASTER_FLAG, DELIVERY_CLIENT_OUTBOX_ACTOR, DELIVERY_UNLOCK_NOTIFICATION_EVENT, ROLES, clientDeliveryPilotFlag, deliveryUnlockSourceKey, roleHasCapability,
} from "@quincy/shared";
import { newId } from "./ids";
import { lockedSql } from "./delivery-lock";
import { SQL_UUID_V4 } from "./sql-uuid";
import { LIVE_VERSION_EXISTS } from "./video-live-sql";
import { publishOutboxDetached } from "./server-timing";

/**
 * Writes a client's unlock request (#787 slice 8), public-safe: no staff principal, no session. ONE batch: the audit row (actor NULL, the address only as its bucket hash), one outbox row per
 * recipient and an `in_app` ledger row for each (no `email` row: email is off for this type, so `finishEmail` can never send it).
 *
 * Every statement is fenced in SQL, so nothing is decided from a stale read: the audit row exists only while the page is ON, the Client Delivery gate is open, the handle is in the page's LATEST
 * set and the item is STILL locked (and a Video Version still live); the outbox rows exist only while the audit row does. Recipients are chosen in the same statement that writes them: every
 * active Admin, plus every active Editor holding an `editor` membership on the Project (the user role holds `manageExtras`, so an External editor and a Photographer are excluded by construction,
 * whatever their membership). Nothing here touches premium or Unlock state.
 */
export type UnlockRequest = { slug: string; handle: string; projectId: string; setId: string; setNumber: number; assetId: string; label: string; ipBucket: string; now: number };

const ELIGIBLE_ROLES = ROLES.filter((role) => roleHasCapability(role, "manageExtras")).map((role) => `'${role}'`).join(", ");
const GATE = `(EXISTS (SELECT 1 FROM feature_flags WHERE key = '${CLIENT_DELIVERY_MASTER_FLAG}' AND enabled = 1)
  AND (EXISTS (SELECT 1 FROM feature_flags WHERE key = '${CLIENT_DELIVERY_ALL_PROJECTS_FLAG}' AND enabled = 1) OR EXISTS (SELECT 1 FROM feature_flags WHERE key = '${clientDeliveryPilotFlag("")}' || p.project_id AND enabled = 1)))`;

export async function writeUnlockRequest(db: D1Database, input: UnlockRequest): Promise<{ landed: boolean; outboxIds: string[] }> {
  const auditId = newId(); const sourceKey = deliveryUnlockSourceKey(auditId); const { now } = input;
  const meta = JSON.stringify({ via: "public_delivery", handle: input.handle, label: input.label, setNumber: input.setNumber, ipBucket: input.ipBucket });
  const results = await db.batch([
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'delivery.unlock_request', 'project', p.project_id, ?2, ?3
      FROM delivery_pages p JOIN delivery_sets s ON s.project_id = p.project_id AND s.set_number = p.latest_set_number
        JOIN delivery_set_items i ON i.set_id = s.id JOIN assets a ON a.id = i.asset_id
      WHERE p.slug = ?4 AND p.enabled = 1 AND s.id = ?5 AND i.handle = ?6 AND i.asset_id = ?7 AND ${GATE}
        AND (a.kind <> 'video' OR ${LIVE_VERSION_EXISTS("a.id")}) AND ${lockedSql("a")} = 1`)
      .bind(auditId, meta, now, input.slug, input.setId, input.handle, input.assetId),
    db.prepare(`INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at)
      SELECT ${SQL_UUID_V4}, 1, ?1, ?2, ?3, ?4, u.id, u.authorization_epoch,
        json_object('schemaVersion', 1, 'event', json_object('type', ?1, 'sourceKey', ?2, 'recipientId', u.id),
          'authorizationAtOccurrence', CASE WHEN u.role = 'admin' THEN json_object('kind', 'admin')
            ELSE json_object('kind', 'project_member', 'membershipIds', json((SELECT json_group_array(m.id) FROM (SELECT id FROM project_members WHERE project_id = ?3 AND user_id = u.id AND role_on_project = 'editor' ORDER BY id) m))) END,
          'delivery', json_object('projectId', ?3, 'setId', ?5, 'assetId', ?6, 'handle', ?7, 'label', ?8)),
        'pending', ?9, ?9, ?9
      FROM user u
      WHERE u.active = 1 AND u.role IN (${ELIGIBLE_ROLES})
        AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ?3 AND pm.user_id = u.id AND pm.role_on_project = 'editor'))
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?10)
      ON CONFLICT (event_type, source_key, recipient_id) DO NOTHING
      RETURNING id`)
      .bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey, input.projectId, DELIVERY_CLIENT_OUTBOX_ACTOR, input.setId, input.assetId, input.handle, input.label, now, auditId),
    db.prepare(`INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
      SELECT ${SQL_UUID_V4}, o.id, o.event_type, o.source_key, o.recipient_id, 'in_app', 'pending', ?3, ?3
      FROM notification_outbox o WHERE o.event_type = ?1 AND o.source_key = ?2 AND o.status = 'pending'
      ON CONFLICT (outbox_id, channel) DO NOTHING`)
      .bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey, now),
  ]);
  const landed = (results[0]?.meta.changes ?? 0) === 1;
  const outboxIds = landed ? (results[1]?.results ?? []).map((row) => (row as { id?: unknown }).id).filter((id): id is string => typeof id === "string") : [];
  return { landed, outboxIds };
}

export { publishOutboxDetached as publishUnlockOutbox };
