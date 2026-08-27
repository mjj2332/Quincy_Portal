import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Statement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => Statement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

function planDetails(db: SqliteDatabase, sql: string, ...values: unknown[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail);
}

describe("migration 0033 project Deadline and reminders", () => {
  it("is strictly additive and enforces the complete schema contract", () => {
    const migration = readFileSync(new URL("../migrations/0033_project_deadline_and_reminders.sql", import.meta.url), "utf8");
    expect(migration).not.toMatch(/\b(DROP TABLE|PRAGMA|__new_projects|INSERT INTO projects|UPDATE projects)\b/i);
    expect(migration.match(/ALTER TABLE projects ADD COLUMN/g)).toHaveLength(7);
    expect(migration).toContain("CHECK (fire_at = deadline_at - (reminder_offset_minutes * 60000))");
    const db = localSqlite(); db.exec("PRAGMA foreign_keys = ON"); applyMigrations(db, 32);
    const now = 1_790_000_000_000;
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4b-existing-project', 'Existing', 'edited_review', 0, ?, ?)").run(now, now);
    const before = db.prepare("SELECT id FROM projects WHERE id = 'tb4b-existing-project'").all();
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));
    expect(db.prepare("PRAGMA table_info('projects')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "deadline_local_civil", notnull: 0 }),
      expect.objectContaining({ name: "deadline_version", notnull: 1, dflt_value: "0" }),
    ]));
    expect(db.prepare("SELECT id, deadline_at, deadline_version FROM projects WHERE id = 'tb4b-existing-project'").all()).toEqual(before.length ? [{ id: "tb4b-existing-project", deadline_at: null, deadline_version: 0 }] : []);
    expect(db.prepare("PRAGMA index_list('project_deadline_occurrences')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "project_deadline_occurrences_due_idx" }),
      expect.objectContaining({ name: "project_deadline_occurrences_project_version_idx" }),
    ]));
    expect(db.prepare("PRAGMA index_list('notification_outbox')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notification_outbox_project_event_status_idx" })]));
    expect(db.prepare("PRAGMA foreign_key_list('project_deadline_occurrences')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "projects", from: "project_id", on_delete: "CASCADE" })]));
    expect(db.prepare("PRAGMA foreign_key_list('notification_preferences')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ table: "user", from: "user_id", on_delete: "CASCADE" })]));
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb4b-user', 'TB4B', 'tb4b@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at, deadline_version) VALUES ('tb4b-project', 'TB4B Street', 'edited_review', 0, ?, ?, 1)").run(now, now);
    expect(() => db.prepare("INSERT INTO project_deadline_occurrences (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, status, created_by, created_at, updated_at) VALUES ('bad-fire', 'tb4b-project', 1, 'advance', 60, ?, ?, '2026-08-27T09:00', 'Australia/Sydney', 600, 0, 'pending', 'tb4b-user', ?, ?)").run(now - 1, now, now, now)).toThrow();
    db.prepare("INSERT INTO notification_preferences (user_id, updated_at) VALUES ('tb4b-user', ?)").run(now);
    expect(db.prepare("SELECT project_deadline_reminder_emails FROM notification_preferences WHERE user_id = ?").get("tb4b-user")).toEqual({ project_deadline_reminder_emails: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("uses the new due, lifecycle, outbox and preference indexes", () => {
    const db = localSqlite(); db.exec("PRAGMA foreign_keys = ON"); applyMigrations(db, 33);
    const due = planDetails(db, "SELECT id FROM project_deadline_occurrences WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at, project_id, id LIMIT 100", 1);
    expect(due.some((detail) => detail.includes("project_deadline_occurrences_due_idx"))).toBe(true);
    const lifecycle = planDetails(db, "SELECT id FROM project_deadline_occurrences WHERE project_id = ? AND schedule_version = ? AND status = 'pending'", "project", 1);
    expect(lifecycle.some((detail) => detail.includes("project_deadline_occurrences_project_version_idx"))).toBe(true);
    const outbox = planDetails(db, "SELECT id FROM notification_outbox WHERE project_id = ? AND event_type = ? AND status = 'pending' AND source_key = ?", "project", "project.deadline.reminder", "occurrence");
    expect(outbox.some((detail) => detail.includes("notification_outbox_project_event_status_idx"))).toBe(true);
    const preference = planDetails(db, "SELECT project_deadline_reminder_emails FROM notification_preferences WHERE user_id = ?", "user");
    expect(preference.some((detail) => /notification_preferences.*(PRIMARY KEY|sqlite_autoindex)/i.test(detail))).toBe(true);
    db.close();
  });
});
