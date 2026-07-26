import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

declare const __PORTAL_MIGRATION_SQL_BEFORE_0015__: string;
declare const __PORTAL_MIGRATION_0015_SQL__: string;
const database = env as unknown as { DB: D1Database };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL_BEFORE_0015__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection', 'dropbox', 'connected', ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('user', 'Admin', 'migration@test.invalid', 1, 'admin', 1, ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('project', 'Migration', 'editing_autohdr', ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES ('collection', 'project', 'edited', 'received', 1, ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('asset', 'collection', 'migration/asset.jpg', 'asset.jpg', 1, 'dropbox', ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES ('send-job', 'autohdr', 'done', 'project', 0, ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES ('fetch-job', 'fetch_edited', 'done', 'project', 0, ?, ?)").bind(now, now),
    database.DB.prepare(
      "INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) " +
      "VALUES ('handoff', 'project', 'connection', 1, 1, 'hash', '[\"asset\"]', '[]', '/raw', 'user', 'raw_review', 'started', 'send-workflow', 'send-job', ?, ?, ?, ?)",
    ).bind(now + 60_000, now, now, now),
    database.DB.prepare(
      "INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, final_path, final_path_key, folder_id, observed_at, created_at, updated_at) " +
      "VALUES ('mapping', 'project', 'handoff', 'connection', 1, 'active', '/AutoHDR/Migration/04-FINAL-Photos', '/autohdr/migration/04-final-photos', 'folder', ?, ?, ?)",
    ).bind(now, now, now),
    database.DB.prepare(
      "INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, folder_id, state, created_at, updated_at) " +
      "VALUES ('path-claim', 'mapping', 'handoff', 'project', 'connection', 'final', '/AutoHDR/Migration/04-FINAL-Photos', '/autohdr/migration/04-final-photos', 'folder', 'active', ?, ?)",
    ).bind(now, now),
    database.DB.prepare(
      "INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, started_at, completed_at, created_at, updated_at) " +
      "VALUES ('fetch-claim', 'project', 'handoff', 'mapping', 1, 'connection', 'fetch-workflow', 'fetch-job', 'done', ?, 'manual', '{}', ?, ?, ?, ?)",
    ).bind(now + 60_000, now, now, now, now),
    database.DB.prepare(
      "INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, content_hash, handoff_id, updated_at, created_at) " +
      "VALUES ('edited-claim', 'collection', '/autohdr/migration/04-final-photos/asset.jpg', 'asset', 'hash', 'handoff', ?, ?)",
    ).bind(now, now),
    database.DB.prepare(
      "INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) " +
      "VALUES ('association', 'handoff', 'asset', 'unit', 'manual', ?)",
    ).bind(now),
  ]);
  await executeSql(__PORTAL_MIGRATION_0015_SQL__);
});

describe("migration 0015", () => {
  it("preserves the handoff and every child table with clean foreign keys", async () => {
    const counts = await database.DB.prepare(
      "SELECT " +
      "(SELECT count(*) FROM autohdr_handoffs) handoffs, " +
      "(SELECT count(*) FROM autohdr_output_mappings) mappings, " +
      "(SELECT count(*) FROM autohdr_path_claims) path_claims, " +
      "(SELECT count(*) FROM autohdr_fetch_claims) fetch_claims, " +
      "(SELECT count(*) FROM edited_source_claims) edited_claims, " +
      "(SELECT count(*) FROM autohdr_final_associations) associations",
    ).first();
    expect(counts).toEqual({
      handoffs: 1,
      mappings: 1,
      path_claims: 1,
      fetch_claims: 1,
      edited_claims: 1,
      associations: 1,
    });
    const foreignKeys = await database.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);
    const initiatedBy = await database.DB.prepare(
      "SELECT [notnull] FROM pragma_table_info('autohdr_handoffs') WHERE name = 'initiated_by'",
    ).first();
    expect(initiatedBy).toEqual({ notnull: 0 });
  });
});
