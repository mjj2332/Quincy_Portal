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
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 30).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

function names(rows: unknown[]): string[] { return rows.map((row) => (row as { name: string }).name); }

describe("migration 0031 notification outbox and delivery ledger", () => {
  it("applies the exact additive shape, preserves durable history, and uses the notification FK index for both delete plans", () => {
    const db = localSqlite(); db.exec("PRAGMA foreign_keys = ON"); applyBaseline(db);
    const migration = readFileSync(new URL("../migrations/0031_notification_outbox_and_delivery_ledger.sql", import.meta.url), "utf8");
    expect(migration).toContain("CREATE INDEX notification_delivery_ledger_notification_idx");
    expect(migration).not.toMatch(/\bDROP TABLE\b|\bALTER TABLE\b|\bPRAGMA\b|\bBACKFILL\b|\bCOPY\b/i);
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("PRAGMA table_info('notification_outbox')").all()).toEqual([
      { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "schema_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "event_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "source_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "project_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: "actor_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 6, name: "recipient_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 7, name: "payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 8, name: "status", type: "TEXT", notnull: 1, dflt_value: "'pending'", pk: 0 },
      { cid: 9, name: "available_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 10, name: "queue_published_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 11, name: "lease_token", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 12, name: "lease_expires_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 13, name: "publish_attempts", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { cid: 14, name: "delivery_attempts", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { cid: 15, name: "last_error_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 16, name: "last_error", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 17, name: "completed_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 18, name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 19, name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(db.prepare("PRAGMA table_info('notification_delivery_ledger')").all()).toHaveLength(16);
    expect(names(db.prepare("PRAGMA index_list('notification_outbox')").all())).toEqual(expect.arrayContaining([
      "notification_outbox_status_available_idx", "notification_outbox_status_lease_idx", "notification_outbox_status_queue_idx", "notification_outbox_status_updated_idx",
    ]));
    expect(names(db.prepare("PRAGMA index_list('notification_delivery_ledger')").all())).toEqual(expect.arrayContaining([
      "notification_delivery_ledger_outbox_idx", "notification_delivery_ledger_status_updated_idx", "notification_delivery_ledger_notification_idx",
    ]));
    expect(db.prepare("PRAGMA foreign_key_list('notification_delivery_ledger')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "notification_outbox", from: "outbox_id", to: "id", on_delete: "RESTRICT" }),
      expect.objectContaining({ table: "notifications", from: "notification_id", to: "id", on_delete: "SET NULL" }),
    ]));

    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb4-user', 'TB4 User', 'tb4@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4-project', 'TB4 Street', 'edited_review', 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, created_at) VALUES ('tb4-notification', 'tb4-user', 'tb4-project', 'mentioned', 'Mention', ?)").run(now);
    db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, available_at, created_at, updated_at) VALUES ('tb4-outbox', 1, 'project.comment.mentioned', 'tb4-map', 'tb4-project', 'tb4-user', 'tb4-user', '{}', ?, ?, ?)").run(now, now, now);
    db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, notification_id, created_at, updated_at) VALUES ('tb4-ledger', 'tb4-outbox', 'project.comment.mentioned', 'tb4-map', 'tb4-user', 'in_app', 'tb4-notification', ?, ?)").run(now, now);
    db.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES ('tb4-comment', 'tb4-project', 'tb4-user', 'Durable comment', '{}', ?)").run(now);
    db.prepare("INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at) VALUES ('tb4-map', 'tb4-comment', 'tb4-user', ?)").run(now);
    expect(() => db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, available_at, created_at, updated_at) VALUES ('tb4-outbox-dup', 1, 'project.comment.mentioned', 'tb4-map', 'tb4-project', 'tb4-user', 'tb4-user', '{}', ?, ?, ?)").run(now, now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, created_at, updated_at) VALUES ('tb4-ledger-dup', 'tb4-outbox', 'project.comment.mentioned', 'tb4-map', 'tb4-user', 'in_app', ?, ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES ('tb4-invalid-status', 1, 'project.comment.mentioned', 'tb4-invalid-status', 'tb4-project', 'tb4-user', 'tb4-user', '{}', 'bogus', ?, ?, ?)").run(now, now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, lease_token, created_at, updated_at) VALUES ('tb4-invalid-lease', 1, 'project.comment.mentioned', 'tb4-invalid-lease', 'tb4-project', 'tb4-user', 'tb4-user', '{}', 'pending', ?, 'stale-token', ?, ?)").run(now, now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES ('tb4-invalid-channel', 'tb4-outbox', 'project.comment.mentioned', 'tb4-invalid-channel', 'tb4-user', 'push', 'pending', 0, ?, ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES ('tb4-invalid-attempts', 'tb4-outbox', 'project.comment.mentioned', 'tb4-invalid-attempts', 'tb4-user', 'email', 'pending', -1, ?, ?)").run(now, now)).toThrow();

    const singleDeletePlan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM notifications WHERE id = ?").all("tb4-notification") as Array<{ detail: string }>;
    const pruneDeletePlan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?").all(now + 1) as Array<{ detail: string }>;
    expect(singleDeletePlan.some((entry) => /SEARCH notification_delivery_ledger USING COVERING INDEX notification_delivery_ledger_notification_idx \(notification_id=\?\)/.test(entry.detail))).toBe(true);
    expect(pruneDeletePlan.some((entry) => /SEARCH notification_delivery_ledger USING COVERING INDEX notification_delivery_ledger_notification_idx \(notification_id=\?\)/.test(entry.detail))).toBe(true);
    db.prepare("DELETE FROM project_comments WHERE id = 'tb4-comment'").run();
    expect(db.prepare("SELECT id FROM notification_outbox WHERE id = 'tb4-outbox'").get()).toEqual({ id: "tb4-outbox" });
    expect(db.prepare("SELECT id FROM project_comment_mentions WHERE id = 'tb4-map'").get()).toBeUndefined();
    db.prepare("DELETE FROM notifications WHERE id = 'tb4-notification'").run();
    expect(db.prepare("SELECT notification_id FROM notification_delivery_ledger WHERE id = 'tb4-ledger'").get()).toEqual({ notification_id: null });
    expect(db.prepare("SELECT id FROM notification_outbox WHERE id = 'tb4-outbox'").get()).toEqual({ id: "tb4-outbox" });
    db.prepare("DELETE FROM projects WHERE id = 'tb4-project'").run();
    expect(db.prepare("SELECT id FROM notification_outbox WHERE id = 'tb4-outbox'").get()).toEqual({ id: "tb4-outbox" });
    db.prepare("DELETE FROM user WHERE id = 'tb4-user'").run();
    expect(db.prepare("SELECT id FROM notification_outbox WHERE id = 'tb4-outbox'").get()).toEqual({ id: "tb4-outbox" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    db.close();
  });
});
