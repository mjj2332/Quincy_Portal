import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationsThrough(db: SqliteDatabase, through: number): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort();
  for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  return names;
}

function planDetails(db: SqliteDatabase, sql: string, ...values: unknown[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail);
}

describe("migration 0034 project activity events", () => {
  it("is additive, preserves populated 0033 rows, and enforces the activity contract", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    migrationsThrough(db, 33);
    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Existing', ?, 1, 'editor', 1, ?, ?)").run("tb4c-existing-user", "tb4c-existing@example.test", now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'TB4C Street', 'edited_review', 0, ?, ?)").run("tb4c-project", now, now);
    db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.assignment.created', ?, ?, ?, ?, '{}', 'pending', ?, ?, ?)").run("tb4c-old-outbox", "tb4c-old-source", "tb4c-project", "tb4c-existing-user", "tb4c-existing-user", now, now, now);

    const migration = readFileSync(new URL("../migrations/0034_project_activity_events.sql", import.meta.url), "utf8");
    expect(migration).not.toMatch(/\b(DROP TABLE|PRAGMA|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE\s+notification_outbox)\b/i);
    expect(migration.match(/ALTER TABLE notification_outbox ADD COLUMN/g)).toHaveLength(3);
    expect(migration).not.toMatch(/ALTER TABLE notification_outbox ADD COLUMN[^;]*CHECK/i);
    expect(migration).toContain("CHECK (typeof(occurred_at) = 'integer')");
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("SELECT id, status, coalesce_key, coalesce_until, recipient_membership_cycle_id FROM notification_outbox WHERE id = ?").all("tb4c-old-outbox")).toEqual([{ id: "tb4c-old-outbox", status: "pending", coalesce_key: null, coalesce_until: null, recipient_membership_cycle_id: null }]);
    expect(db.prepare("PRAGMA table_info('project_activity_events')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "schema_version", notnull: 1 }),
      expect.objectContaining({ name: "actor_kind", notnull: 1 }),
      expect.objectContaining({ name: "occurred_at", notnull: 1 }),
      expect.objectContaining({ name: "safe_payload_json", notnull: 1 }),
    ]));
    expect(db.prepare("PRAGMA index_list('project_activity_events')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sqlite_autoindex_project_activity_events_2", unique: 1 })]));
    expect(db.prepare("PRAGMA index_list('notification_outbox')").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notification_outbox_coalesce_idx", unique: 0 })]));

    const valid = ["activity-1", 1, "project.priority.changed", "priority", "tb4c-project", "user", "tb4c-existing-user", now, "project_priority", "tb4c-project", "project-priority:tb4c-project:change:activity", '{"priority":3}', "project", "/projects/tb4c-project", now];
    db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...valid);
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('bad-version', 2, 'x', 'x', 'tb4c-project', 'system', NULL, ?, 'x', 'x', 'bad-version', '{}', 'project', '/', ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('bad-actor', 1, 'x', 'x', 'tb4c-project', 'system', 'tb4c-existing-user', ?, 'x', 'x', 'bad-actor', '{}', 'project', '/', ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('bad-json', 1, 'x', 'x', 'tb4c-project', 'system', NULL, ?, 'x', 'x', 'bad-json', 'not-json', 'project', '/', ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('bad-time', 1, 'x', 'x', 'tb4c-project', 'system', NULL, ?, 'x', 'x', 'bad-time', '{}', 'project', '/', ?)").run(new Date(now).toISOString(), now)).toThrow();
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('bad-link', 1, 'x', 'x', 'tb4c-project', 'system', NULL, ?, 'x', 'x', 'bad-link', '{}', 'admin', '/', ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('duplicate-source', 1, 'project.priority.changed', 'priority', 'tb4c-project', 'user', 'tb4c-existing-user', ?, 'project_priority', 'tb4c-project', 'project-priority:tb4c-project:change:activity', '{\"priority\":3}', 'project', '/projects/tb4c-project', ?)").run(now, now)).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("applies from an empty database and uses the intended dedupe, fan-out, coalescing, delivery, and recovery indexes", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    const names = migrationsThrough(db, 34);
    expect(names.at(-1)).toBe("0034_project_activity_events.sql");
    const dedupe = planDetails(db, "SELECT id FROM project_activity_events WHERE event_type = ? AND source_key = ?", "project.priority.changed", "source");
    expect(dedupe.some((detail) => /project_activity_events.*(sqlite_autoindex|UNIQUE)/i.test(detail))).toBe(true);
    const fanout = planDetails(db, "SELECT member.id FROM project_members member JOIN user recipient ON recipient.id = member.user_id WHERE member.project_id = ? AND member.role_on_project = 'editor' AND member.created_at <= ? AND recipient.active = 1", "project", 1);
    expect(fanout.some((detail) => /(project_members_unique|project_members_user_idx)/i.test(detail))).toBe(true);
    const coalesce = planDetails(db, "SELECT 1 FROM notification_outbox previous WHERE previous.event_type = ? AND previous.recipient_id = ? AND previous.recipient_membership_cycle_id = ? AND previous.coalesce_key = ? AND previous.coalesce_until IS NOT NULL AND previous.coalesce_until > ?", "project.activity.broad", "user", "cycle", "key", 1);
    expect(coalesce.some((detail) => detail.includes("notification_outbox_coalesce_idx"))).toBe(true);
    const delivery = planDetails(db, "SELECT activity.id FROM notification_outbox o LEFT JOIN project_activity_events activity ON activity.id = json_extract(o.payload_json, '$.activity.id') LEFT JOIN project_members member ON member.id = o.recipient_membership_cycle_id WHERE o.id = ? AND member.id = ?", "outbox", "cycle");
    expect(delivery.some((detail) => /sqlite_autoindex_project_activity_events/i.test(detail))).toBe(true);
    expect(delivery.some((detail) => /sqlite_autoindex_project_members/i.test(detail))).toBe(true);
    const recovery = planDetails(db, "SELECT id FROM notification_outbox WHERE status IN ('pending', 'queued', 'processing') AND available_at <= ? ORDER BY available_at, created_at, id LIMIT 100", 1);
    expect(recovery.some((detail) => detail.includes("notification_outbox_status_available_idx"))).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });

  it("keeps the migration journal and snapshot at 0034 without a rebuild", () => {
    const migration = readFileSync(new URL("../migrations/0034_project_activity_events.sql", import.meta.url), "utf8");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const snapshot = JSON.parse(readFileSync(new URL("../migrations/meta/0034_snapshot.json", import.meta.url), "utf8")) as { version: string; tables: Record<string, unknown> };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 34, tag: "0034_project_activity_events" });
    expect(snapshot.tables).toHaveProperty("project_activity_events");
    expect(snapshot.tables).toHaveProperty("notification_outbox");
    expect(migration).not.toMatch(/__new_|DROP TABLE|PRAGMA foreign_keys|INSERT INTO\s+projects|UPDATE\s+projects/i);
  });
});
