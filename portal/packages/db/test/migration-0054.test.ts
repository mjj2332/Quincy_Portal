import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0054_email_digest.sql";
const CHECK_FAILED = /CHECK constraint failed/i;
const UNIQUE_FAILED = /UNIQUE constraint failed/i;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

/** Applies a migration the way D1 does: every statement of the file inside ONE transaction. */
function applyAsTransaction(db: SqliteDatabase, name: string): void {
  const source = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  db.exec("BEGIN");
  try {
    for (const statement of source.split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
}

const NOW = 1_800_000_000_000;

function seeded(through: number): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, through);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'Street', 'edited_review', 0, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO notification_preferences (user_id, project_deadline_reminder_emails, updated_at) VALUES ('u1', 0, ?)").run(NOW);
  db.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, created_at) VALUES ('n1', 'u1', 'p1', 'mentioned', 'T', 'B', ?)").run(NOW);
  db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES ('o1', 1, 'project.comment.mentioned', 's1', 'p1', 'u1', 'u1', '{}', 'completed', ?, ?, ?)").run(NOW, NOW, NOW);
  for (const [id, channel, status] of [["l1", "in_app", "sent"], ["l2", "email", "unknown"]] as const) {
    db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, 'o1', 'project.comment.mentioned', 's1', 'u1', ?, ?, 'n1', ?, ?)").run(id, channel, status, NOW, NOW);
  }
  return db;
}

describe("migration 0054 email digest", () => {
  it("is a journal entry", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0054_email_digest")).toBe(true);
  });

  it("defaults existing and new preference rows to twice daily and rejects an unknown cadence", () => {
    const db = seeded(53);
    applyAsTransaction(db, MIGRATION);
    expect(db.prepare("SELECT email_digest_cadence AS c, project_deadline_reminder_emails AS d FROM notification_preferences WHERE user_id = 'u1'").get()).toEqual({ c: "twice_daily", d: 0 });
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u2', 'U2', 'u2@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO notification_preferences (user_id, updated_at) VALUES ('u2', ?)").run(NOW);
    expect(db.prepare("SELECT email_digest_cadence AS c FROM notification_preferences WHERE user_id = 'u2'").get()).toEqual({ c: "twice_daily" });
    for (const cadence of ["immediate", "hourly", "twice_daily", "daily"]) {
      db.prepare("UPDATE notification_preferences SET email_digest_cadence = ? WHERE user_id = 'u1'").run(cadence);
    }
    expect(() => db.prepare("UPDATE notification_preferences SET email_digest_cadence = 'weekly' WHERE user_id = 'u1'").run()).toThrow(CHECK_FAILED);
    db.close();
  });

  it("keeps every ledger row and status, accepts deferred, rejects junk, and recreates the status index", () => {
    const db = seeded(53);
    applyAsTransaction(db, MIGRATION);
    expect(db.prepare("SELECT id, status, channel, notification_id AS notificationId FROM notification_delivery_ledger ORDER BY id").all()).toEqual([
      { id: "l1", status: "sent", channel: "in_app", notificationId: "n1" },
      { id: "l2", status: "unknown", channel: "email", notificationId: "n1" },
    ]);
    db.prepare("UPDATE notification_delivery_ledger SET status = 'deferred' WHERE id = 'l2'").run();
    expect(db.prepare("SELECT status FROM notification_delivery_ledger WHERE id = 'l2'").get()).toEqual({ status: "deferred" });
    expect(() => db.prepare("UPDATE notification_delivery_ledger SET status = 'bogus' WHERE id = 'l2'").run()).toThrow(CHECK_FAILED);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'notification_delivery_ledger_status_updated_idx'").get()).toEqual({ name: "notification_delivery_ledger_status_updated_idx" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("enforces one digest per recipient per slot and one item per notification", () => {
    const db = seeded(53);
    applyAsTransaction(db, MIGRATION);
    const insertDigest = (id: string, slot: number) => db.prepare("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, created_at, updated_at) VALUES (?, 'u1', ?, 'twice_daily', 'claimed', ?, ?)").run(id, slot, NOW, NOW);
    insertDigest("d1", NOW);
    expect(() => insertDigest("d2", NOW)).toThrow(UNIQUE_FAILED);
    insertDigest("d3", NOW + 3_600_000);
    expect(() => db.prepare("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, created_at, updated_at) VALUES ('d4', 'u1', ?, 'daily', 'nope', ?, ?)").run(NOW + 7_200_000, NOW, NOW)).toThrow(CHECK_FAILED);
    const insertItem = (id: string, notificationId: string | null) => db.prepare("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, created_at, updated_at) VALUES (?, 'u1', ?, 'l2', 'p1', 'mentioned', ?, ?)").run(id, notificationId, NOW, NOW);
    insertItem("i1", "n1");
    expect(() => insertItem("i2", "n1")).toThrow(UNIQUE_FAILED);
    insertItem("i3", null);
    insertItem("i4", null);
    expect(db.prepare("SELECT state FROM notification_digest_items WHERE id = 'i1'").get()).toEqual({ state: "pending" });
    expect(() => db.prepare("UPDATE notification_digest_items SET state = 'weird' WHERE id = 'i1'").run()).toThrow(CHECK_FAILED);
    db.close();
  });

  it("never blocks deleting a notification, ledger row or project once an item points at them", () => {
    const db = seeded(53);
    applyAsTransaction(db, MIGRATION);
    db.prepare("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, created_at, updated_at) VALUES ('i1', 'u1', 'n1', 'l2', 'p1', 'mentioned', ?, ?)").run(NOW, NOW);
    db.prepare("DELETE FROM notification_delivery_ledger WHERE id = 'l2'").run();
    expect(db.prepare("SELECT ledger_id AS ledgerId FROM notification_digest_items WHERE id = 'i1'").get()).toEqual({ ledgerId: null });
    db.prepare("DELETE FROM notifications WHERE id = 'n1'").run();
    expect(db.prepare("SELECT notification_id AS n FROM notification_digest_items WHERE id = 'i1'").get()).toEqual({ n: null });
    db.prepare("DELETE FROM notification_delivery_ledger").run();
    db.prepare("DELETE FROM notification_outbox").run();
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT count(*) AS c FROM notification_digest_items").get()).toEqual({ c: 0 });
    db.close();
  });
});
