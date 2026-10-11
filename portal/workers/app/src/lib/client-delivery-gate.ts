import { CLIENT_DELIVERY_ALL_PROJECTS_FLAG, CLIENT_DELIVERY_MASTER_FLAG, clientDeliveryPilotFlag } from "@quincy/shared";

/**
 * The Client Delivery gate (#787), a set of `feature_flags` rows read in one statement and shaped like `video-review-gate.ts`: `client_delivery` (master) plus either
 * `client_delivery_all_projects` or `client_delivery_pilot:<projectId>`. A missing row is off, so a Project nobody opened has no Delivery page by construction and the
 * operator turns it on by inserting rows. There are no parts: the page, its premium controls and its public surface open and close together.
 */
export async function clientDeliveryGate(db: D1Database, projectId: string): Promise<boolean> {
  const keys = [CLIENT_DELIVERY_MASTER_FLAG, CLIENT_DELIVERY_ALL_PROJECTS_FLAG, clientDeliveryPilotFlag(projectId)];
  const rows = (await db.prepare(`SELECT key FROM feature_flags WHERE enabled = 1 AND key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).all<{ key: string }>()).results;
  const on = new Set(rows.map((row) => row.key));
  return on.has(CLIENT_DELIVERY_MASTER_FLAG) && (on.has(CLIENT_DELIVERY_ALL_PROJECTS_FLAG) || on.has(clientDeliveryPilotFlag(projectId)));
}
