import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0058_include_project_activity.sql";
const CHECK_FAILED = /CHECK constraint failed/i;
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

function seeded(through: number): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, subtask_reminder_emails, email_digest_cadence, updated_at) VALUES ('u1', 0, 0, 'daily', ?)").run(NOW);
  return db;
}

describe("migration 0058 include Project activity", () => {
  it("is a journal entry", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0058_include_project_activity")).toBe(true);
  });

  it("adds the column with every existing and new row defaulting on, and keeps the other preferences", () => {
    const db = seeded(56);
    db.exec(migrationSql(MIGRATION));
    expect(db.prepare("SELECT include_project_activity AS a, email_digest_cadence AS c, project_deadline_reminder_emails AS d, subtask_reminder_emails AS s FROM notification_preferences WHERE user_id = 'u1'").get()).toEqual({ a: 1, c: "daily", d: 0, s: 0 });
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u2', 'U2', 'u2@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO notification_preferences (user_id, updated_at) VALUES ('u2', ?)").run(NOW);
    expect(db.prepare("SELECT include_project_activity AS a FROM notification_preferences WHERE user_id = 'u2'").get()).toEqual({ a: 1 });
    db.close();
  });

  it("accepts 0 and 1 and rejects anything else, including NULL", () => {
    const db = seeded(56);
    db.exec(migrationSql(MIGRATION));
    db.prepare("UPDATE notification_preferences SET include_project_activity = 0 WHERE user_id = 'u1'").run();
    db.prepare("UPDATE notification_preferences SET include_project_activity = 1 WHERE user_id = 'u1'").run();
    expect(() => db.prepare("UPDATE notification_preferences SET include_project_activity = 2 WHERE user_id = 'u1'").run()).toThrow(CHECK_FAILED);
    expect(() => db.prepare("UPDATE notification_preferences SET include_project_activity = NULL WHERE user_id = 'u1'").run()).toThrow(/NOT NULL/i);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
