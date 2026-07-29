import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyLegacyMigrations(db: SqliteDatabase): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter((value) => /^00(?:0\d|1\d|2[0-2])_.*\.sql$/.test(value)).sort();
  for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  return names;
}

function insertLegacyHandoff(db: SqliteDatabase) {
  const now = 1_785_360_000_000;
  db.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('fixture-project', 'Migration Fixture Lane', 'editing_autohdr', ?, ?)").run(now, now);
  db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('fixture-connection', 'dropbox', 'connected', ?, ?)").run(now, now);
  db.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES ('fixture-job', 'autohdr', 'done', 'fixture-project', 0, ?, ?)").run(now, now);
  db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('fixture-handoff', 'fixture-project', 'fixture-connection', 1, 1, 'fixture', '[]', '[]', '/Raw/fixture', 'started', 'fixture-workflow', 'fixture-job', ?, ?, ?)").run(now + 86_400_000, now, now);
}

describe("migration 0023 AutoHDR stalled notification guard", () => {
  it("adds only a nullable marker after the complete 0000–0022 baseline", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    const applied = applyLegacyMigrations(db);
    expect(applied).toHaveLength(23);
    expect(applied).toContain("0022_seed_admin_uuid.sql");
    expect(applied[0]).toMatch(/^0000_/);
    expect(applied[applied.length - 1]).toBe("0022_seed_admin_uuid.sql");
    insertLegacyHandoff(db);

    const source = readFileSync(new URL("../migrations/0023_autohdr_stalled_notification_guard.sql", import.meta.url), "utf8");
    expect(source.replace(/\s+/g, " ").trim()).toBe("ALTER TABLE autohdr_handoffs ADD COLUMN stalled_notified_at INTEGER;");
    db.exec(source);

    const column = (db.prepare("PRAGMA table_info('autohdr_handoffs')").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>)
      .find((value) => value.name === "stalled_notified_at");
    expect(column).toMatchObject({ name: "stalled_notified_at", type: "INTEGER", notnull: 0, dflt_value: null });
    expect(db.prepare("SELECT stalled_notified_at FROM autohdr_handoffs WHERE id = 'fixture-handoff'").get()).toEqual({ stalled_notified_at: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
