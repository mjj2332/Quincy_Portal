import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyBaseline(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 31).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

describe("migration 0032 admin impersonation", () => {
  it("applies the additive compatibility fields and fail-closed feature singleton", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyBaseline(db);
    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'admin', 1, ?, ?)").run("tb5-updater", "TB5 Updater", "tb5-updater@example.test", now, now);
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run("tb5-existing", "TB5 Existing", "tb5-existing@example.test", now, now);
    db.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("tb5-session", now + 3_600_000, "tb5-session-token", "tb5-existing", now, now);

    const migration = readFileSync(new URL("../migrations/0032_admin_impersonation.sql", import.meta.url), "utf8");
    expect(migration).toBe(`ALTER TABLE user ADD COLUMN banned integer NOT NULL DEFAULT 0;\n--> statement-breakpoint\nALTER TABLE user ADD COLUMN ban_reason text;\n--> statement-breakpoint\nALTER TABLE user ADD COLUMN ban_expires integer;\n--> statement-breakpoint\nALTER TABLE session ADD COLUMN impersonated_by text;\n--> statement-breakpoint\nCREATE TABLE feature_flags (\n  key text PRIMARY KEY NOT NULL,\n  enabled integer NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),\n  updated_by text REFERENCES user(id) ON DELETE set null,\n  updated_at integer NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX feature_flags_updated_by_idx ON feature_flags (updated_by);\n--> statement-breakpoint\nINSERT INTO feature_flags (key, enabled, updated_by, updated_at)\nVALUES ('user_impersonation', 0, NULL, unixepoch('now') * 1000);\n`);
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("SELECT banned, ban_reason, ban_expires FROM user WHERE id = 'tb5-existing'").get()).toEqual({ banned: 0, ban_reason: null, ban_expires: null });
    expect(db.prepare("SELECT impersonated_by FROM session WHERE id = 'tb5-session'").get()).toEqual({ impersonated_by: null });
    expect(db.prepare("SELECT key, enabled, updated_by FROM feature_flags").all()).toEqual([{ key: "user_impersonation", enabled: 0, updated_by: null }]);
    expect(() => db.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('bad', 2, ?)").run(now)).toThrow();
    expect(db.prepare("PRAGMA index_list('feature_flags')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "feature_flags_updated_by_idx", unique: 0 })]));
    expect(db.prepare("PRAGMA foreign_key_list('feature_flags')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "user", from: "updated_by", to: "id", on_delete: "SET NULL" })]));
    db.prepare("UPDATE feature_flags SET enabled = 1, updated_by = ? WHERE key = 'user_impersonation'").run("tb5-updater");
    db.prepare("DELETE FROM user WHERE id = 'tb5-updater'").run();
    expect(db.prepare("SELECT updated_by FROM feature_flags WHERE key = 'user_impersonation'").get()).toEqual({ updated_by: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps the committed migration tail after the 0032 snapshot", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
    expect(names).toContain("0032_admin_impersonation.sql");
    expect(names).toContain("0033_project_deadline_and_reminders.sql");
    expect(names).toContain("0034_project_activity_events.sql");
    expect(names).toContain("0035_project_subtask_scheduling_ranges.sql");
    expect(names.filter((value) => Number(value.slice(0, 4)) > 35)).toEqual([]);
  });
});
