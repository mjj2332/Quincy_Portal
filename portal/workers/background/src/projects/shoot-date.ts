import type { Env } from "../env";
import { errorMessage } from "../lib/db";

export type ShootDateChange = {
  projectId: string;
  previous: string;
  next: string;
  orderId: string;
  /** When the webhook carrying the new date was received; older than the last accepted change means stale. */
  receivedAt: Date;
};

/**
 * Guarded write of a verified Tonomo shoot date with its audit row in one D1 batch: the UPDATE is
 * fenced on the shoot_date the caller read and on no accepted change coming from a webhook
 * received after this one (compared by receipt time, not processing time, so a retried or
 * redelivered older event cannot roll a newer reschedule back while a lagging newer event still
 * lands), and the audit INSERT fires only when that UPDATE landed.
 * Returns false when the fence lost, which the caller treats as "already handled".
 */
export async function commitShootDateChange(env: Env, change: ShootDateChange): Promise<boolean> {
  const at = Date.now();
  const meta = JSON.stringify({ actor: "tonomo", orderId: change.orderId, previousShootDate: change.previous, shootDate: change.next, eventReceivedAt: change.receivedAt.getTime() });
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE projects SET shoot_date = ?, updated_at = ? WHERE id = ? AND shoot_date = ? AND archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM audit_log a WHERE a.action = 'project.shoot_date.changed' AND a.target_type = 'project' AND a.target_id = projects.id
             AND json_extract(a.meta_json, '$.eventReceivedAt') > ?
         )`,
    ).bind(change.next, at, change.projectId, change.previous, change.receivedAt.getTime()),
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'project.shoot_date.changed', 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND shoot_date = ? AND updated_at = ?)",
    ).bind(crypto.randomUUID(), change.projectId, meta, at, change.projectId, change.next, at),
  ]);
  // A lost fence is not retried: either a newer webhook already moved the date, or another writer
  // changed shoot_date since the processor read it, and the next Tonomo event re-evaluates both.
  if ((result?.meta.changes ?? 0) === 0) {
    console.log("Shoot date change lost the fence; a newer change or another writer landed first", { projectId: change.projectId, orderId: change.orderId });
    return false;
  }
  return true;
}

/**
 * Records why an incoming Tonomo shoot date was not adopted. Idempotent on (project, stored
 * date, incoming date, reason) so a redelivered webhook adds no row; never fails the webhook.
 */
export async function recordShootDateDecline(env: Env, input: { projectId: string; orderId: string; stored: string; incoming: string; reason: string }): Promise<void> {
  const meta = JSON.stringify({ actor: "tonomo", orderId: input.orderId, storedShootDate: input.stored, incomingShootDate: input.incoming, reason: input.reason });
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
     SELECT ?, NULL, 'project.shoot_date.declined', 'project', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_log WHERE action = 'project.shoot_date.declined' AND target_type = 'project' AND target_id = ?
         AND json_extract(meta_json, '$.storedShootDate') = ? AND json_extract(meta_json, '$.incomingShootDate') = ?
         AND json_extract(meta_json, '$.reason') = ?
     )`,
  ).bind(crypto.randomUUID(), input.projectId, meta, Date.now(), input.projectId, input.stored, input.incoming, input.reason).run()
    .catch((error) => console.error("Shoot date decline audit failed", { projectId: input.projectId, error: errorMessage(error) }));
}
