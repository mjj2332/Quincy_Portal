import { database, ids } from "./embedded-media-support";
import { ensureCollection } from "./video-review-support";

/** Fixtures for the Client Delivery (#787) suites, on top of the embedded-media fixture's people and Projects. */
export const DELIVERY_FLAG_SQL = "key = 'client_delivery' OR key = 'client_delivery_all_projects' OR key LIKE 'client_delivery_pilot:%'";
export async function clearDeliveryFlags() { await database.DB.prepare(`DELETE FROM feature_flags WHERE ${DELIVERY_FLAG_SQL}`).run(); }
/** Inserts flag rows, enabled by default. `[key, false]` inserts a row that is present but off. */
export async function setDeliveryFlags(...rows: Array<string | [string, boolean]>) {
  const now = Date.now();
  for (const row of rows) {
    const [key, enabled] = typeof row === "string" ? [row, true] as const : row;
    await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(key, enabled ? 1 : 0, now).run();
  }
}
export const openDelivery = (...projectIds: string[]) => setDeliveryFlags("client_delivery", ...projectIds.map((id) => `client_delivery_pilot:${id}`));

export type AssetKind = "photo" | "floorplan_pdf" | "floorplan_preview" | "copy_pdf";
const COLLECTION_OF: Record<AssetKind, string> = { photo: "edited", floorplan_pdf: "floorplan", floorplan_preview: "floorplan", copy_pdf: "copy" };
/** A committed non-video Asset (current unless `superseded`). Floorplan halves share `versionGroupId` and `version`. */
export async function seedAsset(kind: AssetKind, input: { projectId?: string; id?: string; versionGroupId?: string | null; version?: number; deliveryPremium?: boolean; superseded?: boolean } = {}) {
  const projectId = input.projectId ?? ids.project; const collectionId = await ensureCollection(projectId, COLLECTION_OF[kind]);
  const id = input.id ?? crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, delivery_premium, superseded_at, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 10, 'upload', ?, ?, ?, ?, 'ready', ?, ?)")
    .bind(id, collectionId, kind, `projects/${projectId}/delivery-test/${id}`, `${id}.bin`, input.versionGroupId ?? null, input.version ?? 1, input.deliveryPremium ? 1 : 0, input.superseded ? now : null, now, now).run();
  return { id, projectId, collectionId };
}
export async function seedUnlock(assetId: string, projectId = ids.project, paymentRef: string | null = null) {
  await database.DB.prepare("INSERT INTO asset_premium_unlocks (asset_id, project_id, unlocked_by, unlocked_at, payment_ref) VALUES (?, ?, ?, ?, ?)").bind(assetId, projectId, ids.admin, Date.now(), paymentRef).run();
}

/** A Delivery page whose latest set is `setNumber`, with `assetIds` as the items of that set (and optionally of earlier sets). */
export async function seedPage(input: { projectId?: string; slug?: string; setNumber?: number; assetIds: string[]; olderSets?: string[][]; enabled?: boolean }) {
  const projectId = input.projectId ?? ids.project; const now = Date.now(); const setNumber = input.setNumber ?? (input.olderSets?.length ?? 0) + 1;
  await database.DB.prepare("INSERT INTO delivery_pages (project_id, slug, enabled, latest_set_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(projectId, input.slug ?? `slug-${crypto.randomUUID().slice(0, 12)}`, input.enabled === false ? 0 : 1, setNumber, now, now).run();
  const sets = [...(input.olderSets ?? []), input.assetIds];
  for (const [index, members] of sets.entries()) {
    const setId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)").bind(setId, projectId, index + 1, crypto.randomUUID().slice(0, 32), ids.admin, now).run();
    for (const [position, assetId] of members.entries())
      await database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, ?, ?)").bind(setId, assetId, crypto.randomUUID().replaceAll("-", "").slice(0, 16), position).run();
  }
}
/** A photo in the RAW collection: eligible for nothing on a Delivery page. */
export async function seedRawPhoto(projectId = ids.project) {
  const collectionId = await ensureCollection(projectId, "raw"); const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, 10, 'upload', 1, 'ready', ?, ?)").bind(id, collectionId, `projects/${projectId}/raw-test/${id}`, `${id}.cr3`, now, now).run();
  return { id, projectId, collectionId };
}
/** A Project of its own (so a Stage move leaves the shared fixture Projects alone), with the pilot gate row open. */
export async function seedOpenProject(input: { stageKey?: string; street?: string; suburb?: string | null; postcode?: string | null; agencyName?: string | null; directoryAgency?: string; agentName?: string; agentEmail?: string; archived?: boolean } = {}) {
  const id = crypto.randomUUID(); const now = Date.now();
  let agencyId: string | null = null;
  if (input.directoryAgency !== undefined) {
    agencyId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO agencies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(agencyId, input.directoryAgency, now, now).run();
  }
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, postcode, agency_name, agency_id, agent_name, agent_email, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, input.street ?? "12 Test Street", input.suburb === undefined ? "Testville" : input.suburb, input.postcode ?? null, input.agencyName ?? null, agencyId, input.agentName ?? null, input.agentEmail ?? null, input.stageKey ?? "editing_autohdr", input.archived ? now : null, now, now).run();
  await openDelivery(id);
  return id;
}
export async function wipeDelivery() {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM delivery_set_items"), database.DB.prepare("DELETE FROM delivery_sets"), database.DB.prepare("DELETE FROM delivery_pages"), database.DB.prepare("DELETE FROM asset_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'asset.delivery_premium%' OR action LIKE 'asset.premium_%' OR action LIKE 'delivery.%' OR action = 'stage.set'"),
    database.DB.prepare("DELETE FROM notification_delivery_ledger WHERE event_type = 'project.delivery.unlock_requested'"), database.DB.prepare("DELETE FROM notification_outbox WHERE event_type = 'project.delivery.unlock_requested'"),
    database.DB.prepare("DELETE FROM guest_rate_limits WHERE bucket LIKE 'unlock:%'"),
    database.DB.prepare("DELETE FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE source_key IN (SELECT id FROM project_activity_events WHERE event_type IN ('project.delivery.published', 'project.stage.changed')))"),
    database.DB.prepare("DELETE FROM notification_outbox WHERE source_key IN (SELECT id FROM project_activity_events WHERE event_type IN ('project.delivery.published', 'project.stage.changed'))"),
    database.DB.prepare("DELETE FROM project_activity_events WHERE event_type IN ('project.delivery.published', 'project.stage.changed')"),
  ]);
}
