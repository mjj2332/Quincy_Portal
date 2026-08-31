import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

describe("migration 0036 External Editor assigned-scope access", () => {
  it("is additive, preserves legacy rows, and enforces the upload/session contract", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, 35);
    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb4e-user', 'TB4E User', 'tb4e@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, notes, created_at, updated_at) VALUES ('tb4e-project', 'TB4E Street', 'edited_review', 0, 'internal legacy note', ?, ?)").run(now, now);
    db.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES ('tb4e-edited', 'tb4e-project', 'edited', 'empty', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES ('tb4e-outbox', 1, 'project.assignment.created', 'tb4e-source', 'tb4e-project', 'tb4e-user', 'tb4e-user', '{}', 'pending', ?, ?, ?)").run(now, now, now);

    const migration = readFileSync(new URL("../migrations/0036_external_editor_assigned_scope.sql", import.meta.url), "utf8");
    expect(migration.match(/ALTER TABLE .* ADD COLUMN/g)).toHaveLength(3);
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration.match(/CREATE (?:UNIQUE )?INDEX/g)).toHaveLength(3);
    expect(migration).not.toMatch(/PRAGMA foreign_keys|DROP TABLE|__new_|INSERT INTO|UPDATE\s+|DELETE FROM/i);
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("SELECT notes, production_notes FROM projects WHERE id = 'tb4e-project'").get()).toEqual({ notes: "internal legacy note", production_notes: null });
    expect(db.prepare("SELECT authorization_epoch FROM user WHERE id = 'tb4e-user'").get()).toEqual({ authorization_epoch: 0 });
    expect(db.prepare("SELECT recipient_authorization_epoch FROM notification_outbox WHERE id = 'tb4e-outbox'").get()).toEqual({ recipient_authorization_epoch: null });
    expect(db.prepare("PRAGMA table_info('projects')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "production_notes", notnull: 0 })]));
    expect(db.prepare("PRAGMA table_info('user')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "authorization_epoch", notnull: 1, dflt_value: "0" })]));
    expect(db.prepare("PRAGMA table_info('notification_outbox')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recipient_authorization_epoch", notnull: 0, dflt_value: null })]));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('external_edited_upload_sessions', 'external_edited_upload_parts') ORDER BY name").all()).toEqual([
      { name: "external_edited_upload_parts" },
      { name: "external_edited_upload_sessions" },
    ]);
    expect(db.prepare("PRAGMA index_list('external_edited_upload_sessions')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "external_edited_upload_sessions_token_hash_idx", unique: 1 }),
      expect.objectContaining({ name: "external_edited_upload_sessions_principal_status_idx", unique: 0 }),
      expect.objectContaining({ name: "external_edited_upload_sessions_sweep_idx", unique: 0 }),
    ]));

    const validSession = ["tb4e-session", "tb4e-token", "tb4e-project", "tb4e-edited", "tb4e-asset", "tb4e-user", "tb4e-cycle", 0, "edited.jpg", 10, "media/key", "upload-id", 10, 1, "open", now + 86_400_000, now, now];
    db.prepare("INSERT INTO external_edited_upload_sessions (id, token_hash, project_id, collection_id, asset_id, created_by, membership_cycle_id, authorization_epoch, original_filename, bytes, r2_key, r2_upload_id, part_bytes, part_count, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...validSession);
    expect(() => db.prepare("UPDATE external_edited_upload_sessions SET authorization_epoch = -1 WHERE id = 'tb4e-session'").run()).toThrow();
    expect(() => db.prepare("INSERT INTO external_edited_upload_parts (session_id, part_number, expected_bytes, status, updated_at) VALUES ('tb4e-session', 1, 10, 'uploaded', ?)").run(now)).toThrow();
    expect(() => db.prepare("INSERT INTO external_edited_upload_parts (session_id, part_number, expected_bytes, status, upload_lease_token, updated_at) VALUES ('tb4e-session', 1, 10, 'uploading', 'lease', ?)").run(now)).toThrow();
    db.prepare("INSERT INTO external_edited_upload_parts (session_id, part_number, expected_bytes, status, updated_at) VALUES ('tb4e-session', 1, 10, 'pending', ?)").run(now);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps the 0036 snapshot and committed migration entry", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const snapshot = JSON.parse(readFileSync(new URL("../migrations/meta/0036_snapshot.json", import.meta.url), "utf8")) as { tables: Record<string, unknown> };
    expect(journal.entries.find((entry) => entry.idx === 36)).toMatchObject({ idx: 36, tag: "0036_external_editor_assigned_scope" });
    expect(journal.entries.find((entry) => entry.idx === 37)).toMatchObject({ idx: 37, tag: "0037_project_board_order_contract" });
    expect(snapshot.tables).toHaveProperty("external_edited_upload_sessions");
    expect(snapshot.tables).toHaveProperty("external_edited_upload_parts");
    expect(snapshot.tables).toHaveProperty("projects");
    expect(snapshot.tables).toHaveProperty("user");
    expect(snapshot.tables).toHaveProperty("notification_outbox");
    expect(readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value))).toContain("0037_project_board_order_contract.sql");
  });
});
