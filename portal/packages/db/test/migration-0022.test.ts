import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const oldId = "seed-admin";
const newId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const realEmail = "mjj2332@gmail.com";

type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};
type SqliteDatabase = {
  close: () => void;
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
};

const createdDirectories: string[] = [];

function localSqlite(filename: string): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(filename);
}

function applyLegacyMigrations(db: SqliteDatabase) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^00(?:0\d|1\d|2[01])_.*\.sql$/.test(value)).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

function applyMigration0022(db: SqliteDatabase) {
  db.exec(readFileSync(new URL("../migrations/0022_seed_admin_uuid.sql", import.meta.url), "utf8"));
}

function count(db: SqliteDatabase, table: string, column: string, id: string) {
  return (db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`).get(id) as { count: number }).count;
}

function insertLegacyFixture(db: SqliteDatabase) {
  const now = 1_785_334_000_000;
  const ids = {
    project: "00000000-0000-4000-8000-000000000001",
    collection: "00000000-0000-4000-8000-000000000002",
    asset: "00000000-0000-4000-8000-000000000003",
    connection: "00000000-0000-4000-8000-000000000004",
    job: "00000000-0000-4000-8000-000000000005",
  };
  db.prepare("INSERT INTO user (id, name, email, email_verified, image, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(oldId, "Quincy Admin", realEmail, 1, "https://example.test/quincy.png", "admin", 1, now, now + 1);
  db.prepare("INSERT INTO projects (id, street, stage_key, archived_by, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)")
    .run(ids.project, "Migration Fixture Lane", oldId, now, now);
  db.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', 1, ?, ?)")
    .run(ids.collection, ids.project, now, now);
  db.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'fixture.jpg', 123, 'upload', ?, ?)")
    .run(ids.asset, ids.collection, "projects/fixture/raw/fixture.jpg", now, now);
  db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)")
    .run(ids.connection, now, now);
  db.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, 0, ?, ?)")
    .run(ids.job, ids.project, now, now);

  db.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('fixture-session', ?, 'fixture-session-token', ?, ?, ?)")
    .run(now + 86_400_000, oldId, now, now);
  db.prepare("INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, scope, created_at, updated_at) VALUES ('fixture-account', 'fixture-google-subject', 'google', ?, 'fixture-access-token', 'fixture-refresh-token', 'fixture-id-token', 'openid email', ?, ?)")
    .run(oldId, now, now);
  db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('fixture-member', ?, ?, 'photographer', ?)")
    .run(ids.project, oldId, now);
  db.prepare("INSERT INTO document_uploads (id, project_id, collection_id, created_by, kind, version_group_id, version, pdf_asset_id, pdf_key, pdf_filename, pdf_bytes, pdf_content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES ('fixture-document', ?, ?, ?, 'copy_pdf', 'fixture-document-group', 1, 'fixture-document-pdf-asset', 'projects/fixture/copy/fixture.pdf', 'fixture.pdf', 321, 'application/pdf', 'pending', ?, 'fixture-document-audit', ?, ?)")
    .run(ids.project, ids.collection, oldId, now + 86_400_000, now, now);
  db.prepare("INSERT INTO upload_manifests (id, collection_id, expected_count, filenames_json, created_by, created_at) VALUES ('fixture-manifest', ?, 1, '[\"fixture.jpg\"]', ?, ?)")
    .run(ids.collection, oldId, now);
  db.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES ('fixture-selection', ?, ?, 'selected_for_editing', ?)")
    .run(ids.asset, oldId, now);
  db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('fixture-handoff', ?, ?, 1, 1, 'fixture-selection', '[\"00000000-0000-4000-8000-000000000003\"]', '[{\"key\":\"asset:fixture\",\"assetIds\":[\"00000000-0000-4000-8000-000000000003\"]}]', '/Raw/fixture', ?, 'completed', 'fixture-workflow', ?, ?, ?, ?)")
    .run(ids.project, ids.connection, oldId, ids.job, now + 86_400_000, now, now);
  db.prepare("INSERT INTO asset_review_state (id, asset_id, stars, updated_by, updated_at) VALUES ('fixture-review', ?, 5, ?, ?)")
    .run(ids.asset, oldId, now);
  db.prepare("INSERT INTO annotations (id, asset_id, author_id, author_role, scope, note_text, created_at) VALUES ('fixture-annotation', ?, ?, 'admin', 'raw', 'fixture note', ?)")
    .run(ids.asset, oldId, now);
  db.prepare("INSERT INTO notice_board_posts (id, author_id, body, created_at) VALUES ('fixture-notice', ?, 'fixture notice', ?)")
    .run(oldId, now);
  db.prepare("INSERT INTO publishes (id, project_id, asset_id, publish_version, published_by, published_at) VALUES ('fixture-publish', ?, ?, 1, ?, ?)")
    .run(ids.project, ids.asset, oldId, now);
  db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES ('fixture-audit', ?, 'fixture.action', 'fixture', ?, '{\"unchanged\":true}', ?)")
    .run(oldId, ids.project, now);
  db.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES ('fixture-notification', ?, ?, 'fixture_type', 'Fixture title', 'Fixture body', 'fixture-source', ?)")
    .run(oldId, ids.project, now);
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("migration 0022 seed admin UUID", () => {
  it("rekeys every child FK while preserving the legacy admin identity and session/account fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "quincy-migration-0022-"));
    createdDirectories.push(directory);
    const filename = join(directory, "fixture.sqlite");
    let db = localSqlite(filename);
    db.exec("PRAGMA foreign_keys = ON");
    applyLegacyMigrations(db);
    insertLegacyFixture(db);

    const references: Array<[string, string]> = [
      ["session", "user_id"], ["account", "user_id"], ["projects", "archived_by"], ["project_members", "user_id"],
      ["document_uploads", "created_by"], ["upload_manifests", "created_by"], ["selections", "selected_by"], ["autohdr_handoffs", "initiated_by"],
      ["asset_review_state", "updated_by"], ["annotations", "author_id"], ["notice_board_posts", "author_id"], ["publishes", "published_by"],
      ["audit_log", "actor_id"], ["notifications", "user_id"],
    ];
    const countsBefore = new Map(references.map(([table, column]) => [`${table}.${column}`, count(db, table, column, oldId)]));
    const sessionBefore = db.prepare("SELECT id, token, user_id FROM session WHERE id = 'fixture-session'").get();
    const accountBefore = db.prepare("SELECT account_id, provider_id, access_token, refresh_token, id_token, scope, user_id FROM account WHERE id = 'fixture-account'").get();

    applyMigration0022(db);

    expect(db.prepare("SELECT id, name, email, email_verified, image, role, active, created_at, updated_at FROM user WHERE id = ?").get(newId)).toEqual({
      id: newId, name: "Quincy Admin", email: realEmail, email_verified: 1, image: "https://example.test/quincy.png", role: "admin", active: 1, created_at: 1_785_334_000_000, updated_at: 1_785_334_000_001,
    });
    expect(db.prepare("SELECT id FROM user WHERE id = ?").all(oldId)).toEqual([]);
    for (const [table, column] of references) {
      expect(count(db, table, column, oldId), `${table}.${column} has no old reference`).toBe(0);
      expect(count(db, table, column, newId), `${table}.${column} keeps its count`).toBe(countsBefore.get(`${table}.${column}`));
    }
    expect(sessionBefore).toEqual({ id: "fixture-session", token: "fixture-session-token", user_id: oldId });
    expect(accountBefore).toEqual({ account_id: "fixture-google-subject", provider_id: "google", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", id_token: "fixture-id-token", scope: "openid email", user_id: oldId });
    expect(db.prepare("SELECT id, token, user_id FROM session WHERE id = 'fixture-session'").get()).toEqual({ id: "fixture-session", token: "fixture-session-token", user_id: newId });
    expect(db.prepare("SELECT account_id, provider_id, access_token, refresh_token, id_token, scope, user_id FROM account WHERE id = 'fixture-account'").get()).toEqual({ account_id: "fixture-google-subject", provider_id: "google", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", id_token: "fixture-id-token", scope: "openid email", user_id: newId });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    db.close();
    db = localSqlite(filename);
    db.exec("PRAGMA foreign_keys = ON");
    expect(db.prepare("SELECT email, role, active FROM user WHERE id = ?").get(newId)).toEqual({ email: realEmail, role: "admin", active: 1 });
    expect(db.prepare("SELECT id, token, user_id FROM session WHERE id = 'fixture-session'").get()).toEqual({ id: "fixture-session", token: "fixture-session-token", user_id: newId });
    expect(db.prepare("SELECT account_id, provider_id, access_token, refresh_token, id_token, scope, user_id FROM account WHERE id = 'fixture-account'").get()).toEqual({ account_id: "fixture-google-subject", provider_id: "google", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", id_token: "fixture-id-token", scope: "openid email", user_id: newId });
    for (const [table, column] of references) expect(count(db, table, column, newId)).toBe(countsBefore.get(`${table}.${column}`));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
