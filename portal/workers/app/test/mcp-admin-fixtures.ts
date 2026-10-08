/** Rows the admin MCP tools (#709) act on, shared by mcp-admin.test.ts and mcp-audit-parity.test.ts. Each takes the D1 handle. */

/** A notification outbox row whose in-app channel was sent and whose email channel failed: replayable and discardable. */
export async function seedDelivery(DB: D1Database, projectId: string, recipientId: string): Promise<{ outboxId: string }> {
  const outboxId = crypto.randomUUID(); const sourceKey = crypto.randomUUID(); const now = Date.now();
  await DB.batch([
    DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, publish_attempts, delivery_attempts, created_at, updated_at) VALUES (?, 1, 'project.comment.mentioned', ?, ?, ?, ?, '{}', 'completed', ?, 0, 1, ?, ?)")
      .bind(outboxId, sourceKey, projectId, recipientId, recipientId, now - 1000, now - 500, now - 500),
    DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, last_error_code, last_error, created_at, updated_at) VALUES (?, ?, 'project.comment.mentioned', ?, ?, 'in_app', 'sent', 1, NULL, NULL, ?, ?), (?, ?, 'project.comment.mentioned', ?, ?, 'email', 'failed', 1, 'E_INVALID_TO', 'bad address', ?, ?)")
      .bind(crypto.randomUUID(), outboxId, sourceKey, recipientId, now - 500, now - 500, crypto.randomUUID(), outboxId, sourceKey, recipientId, now - 500, now - 500),
  ]);
  return { outboxId };
}

/** An Editor-folder mapping on the Project with an orphan-upload report in the `found` state. */
export async function seedOrphanReport(DB: D1Database, projectId: string): Promise<{ watchId: string }> {
  const now = Date.now(); const connectionId = crypto.randomUUID(); const watchId = crypto.randomUUID();
  const root = `/Editor/01_ACTIVE EDITS/September 2026/18/${projectId}`; const oldPath = `/Editor/01_ACTIVE EDITS/August 2026/01/${projectId}`;
  await DB.batch([
    DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    DB.prepare("INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, shoot_date, project_folder_name, photographer_evidence_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-09-18', 'Orphan', '{}', ?, 'ready', ?, ?)")
      .bind(crypto.randomUUID(), projectId, connectionId, root, root.toLowerCase(), `${root}/Editing Notes`, now, now),
  ]);
  await DB.prepare(`INSERT INTO editor_folder_orphan_watches (id, mapping_id, move_revision, old_path, old_path_key, status, watch_until, found_at, found_detail, created_at, updated_at)
      SELECT ?, m.id, 1, ?, lower(?), 'found', 0, ?, ?, 0, 0 FROM editor_folder_mappings m WHERE m.project_id = ?`)
    .bind(watchId, oldPath, oldPath, now, `${oldPath}/1. Output/late.jpg`, projectId).run();
  return { watchId };
}

/** A frozen AutoHDR handoff on the Project with one readiness unit, plus a current edited asset to resolve it with. */
export async function seedCoverage(DB: D1Database, projectId: string, adminId: string): Promise<{ handoffId: string; assetId: string; readinessUnitKey: string }> {
  const now = Date.now(); const connectionId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const handoffId = crypto.randomUUID();
  const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const rawAssetId = crypto.randomUUID();
  const readinessUnitKey = `asset:${rawAssetId}`;
  await DB.batch([
    DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, 0, ?, ?)").bind(jobId, projectId, now, now),
    DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'selection', ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)")
      .bind(handoffId, projectId, connectionId, JSON.stringify([rawAssetId]), JSON.stringify([{ key: readinessUnitKey, assetIds: [rawAssetId] }]), `/Raw/${projectId}`, adminId, `send:${handoffId}`, jobId, now + 60_000, now, now),
    DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 1, ?, ?)").bind(collectionId, projectId, now, now),
    DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'final.jpg', 10, 'upload', ?, ?)").bind(assetId, collectionId, `fixtures/${assetId}.jpg`, now, now),
  ]);
  return { handoffId, assetId, readinessUnitKey };
}

/** A current photo in a RAW Collection, for the asset delete. */
export async function seedAsset(DB: D1Database, projectId: string): Promise<{ assetId: string }> {
  const now = Date.now(); const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID();
  await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 1, ?, ?)").bind(collectionId, projectId, now, now).run();
  await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'gone.jpg', 10, 'upload', ?, ?)").bind(assetId, collectionId, `fixtures/${assetId}.jpg`, now, now).run();
  return { assetId };
}

/** An open rendition dead letter for a fresh asset. */
export async function seedOpenDeadLetter(DB: D1Database, projectId: string): Promise<{ deadLetterId: string; assetId: string }> {
  const { assetId } = await seedAsset(DB, projectId); const deadLetterId = crypto.randomUUID();
  await DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(deadLetterId, assetId, Date.now()).run();
  return { deadLetterId, assetId };
}

/** A Tonomo webhook event stuck as poison. */
export async function seedPoisonEvent(DB: D1Database): Promise<{ eventId: string }> {
  const eventId = crypto.randomUUID();
  await DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, error, received_at, processed_at) VALUES (?, 'tonomo', ?, '{}', 'poison', 'boom', ?, ?)").bind(eventId, `poison-${eventId}`, Date.now(), Date.now()).run();
  return { eventId };
}
