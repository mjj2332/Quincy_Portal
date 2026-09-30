import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0051_tonomo_order_tombstones.sql";
const NOW = 1_787_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
}

function audit(db: SqliteDatabase, id: string, action: string, targetId: string, meta: string | null, createdAt: number, actorId: string | null = null): void {
  db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, 'project', ?, ?, ?)").run(id, actorId, action, targetId, meta, createdAt);
}

type Row = Record<string, unknown>;
const tombstones = (db: SqliteDatabase) => db.prepare("SELECT * FROM tonomo_order_tombstones ORDER BY order_id").all() as Row[];
const tombstone = (db: SqliteDatabase, orderId: string) => db.prepare("SELECT * FROM tonomo_order_tombstones WHERE order_id = ?").get(orderId) as Row | undefined;

/** Schema 50 with audit history for a mix of deleted and live Projects. */
function seeded(): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, 50);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('admin1', 'Admin', 'admin1@example.test', 1, 'admin', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, order_id, stage_key, board_position, created_at, updated_at) VALUES ('live', 'Live Street', 'order-live', 'awaiting_raw', 0, ?, ?)").run(NOW, NOW);
  return db;
}

describe("migration 0051 adds tonomo_order_tombstones", () => {
  it("is journaled after 0050", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((value) => value.idx === 51);
    expect(entry?.tag).toBe("0051_tonomo_order_tombstones");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((value) => value.idx === 50)!.when);
  });

  it("creates the table with the documented columns and no project_id column", () => {
    const db = seeded();
    db.exec(migrationSql(MIGRATION));
    const columns = (db.prepare("SELECT name, \"notnull\" AS required, pk FROM pragma_table_info('tonomo_order_tombstones') ORDER BY cid").all() as Array<{ name: string; required: number; pk: number }>);
    expect(columns.map((column) => column.name)).toEqual(["order_id", "deleted_project_id", "street", "deleted_at", "deleted_by", "source", "created_at"]);
    expect(columns.find((column) => column.name === "order_id")?.pk).toBe(1);
    expect(tombstones(db)).toEqual([]);
    db.close();
  });

  it("seeds an order from the create row of a Project that no longer exists", () => {
    const db = seeded();
    audit(db, "a1", "project.create", "gone1", JSON.stringify({ actor: "tonomo", orderId: "order-1" }), NOW + 10);
    db.exec(migrationSql(MIGRATION));
    expect(tombstone(db, "order-1")).toMatchObject({ deleted_project_id: "gone1", street: null, deleted_at: null, deleted_by: null, source: "migration_0051" });
    expect(typeof tombstone(db, "order-1")!.created_at).toBe("number");
    db.close();
  });

  it("seeds from a project.update row as well", () => {
    const db = seeded();
    audit(db, "a1", "project.update", "gone2", JSON.stringify({ actor: "tonomo", orderId: "order-2" }), NOW + 10);
    db.exec(migrationSql(MIGRATION));
    expect(tombstone(db, "order-2")).toMatchObject({ deleted_project_id: "gone2", source: "migration_0051" });
    db.close();
  });

  it("keeps the latest audit row when two deleted Projects held the same order", () => {
    const db = seeded();
    audit(db, "a1", "project.create", "old", JSON.stringify({ orderId: "order-3" }), NOW + 10);
    audit(db, "a2", "project.update", "new", JSON.stringify({ orderId: "order-3" }), NOW + 20);
    db.exec(migrationSql(MIGRATION));
    expect(tombstones(db)).toHaveLength(1);
    expect(tombstone(db, "order-3")?.deleted_project_id).toBe("new");
    db.close();
  });

  it("skips null, invalid, empty and order-less meta", () => {
    const db = seeded();
    audit(db, "n1", "project.create", "g-null", null, NOW + 1);
    audit(db, "n2", "project.create", "g-invalid", "{not json", NOW + 2);
    audit(db, "n3", "project.create", "g-empty", JSON.stringify({ orderId: "" }), NOW + 3);
    audit(db, "n4", "project.create", "g-blank", JSON.stringify({ orderId: "   " }), NOW + 4);
    audit(db, "n5", "project.create", "g-none", JSON.stringify({ street: "No order" }), NOW + 5);
    audit(db, "n6", "project.create", "g-null-order", JSON.stringify({ orderId: null }), NOW + 6);
    db.exec(migrationSql(MIGRATION));
    expect(tombstones(db)).toEqual([]);
    db.close();
  });

  it("excludes an order whose Project still exists", () => {
    const db = seeded();
    audit(db, "a1", "project.update", "live", JSON.stringify({ actor: "tonomo", orderId: "order-live" }), NOW + 10);
    db.exec(migrationSql(MIGRATION));
    expect(tombstones(db)).toEqual([]);
    db.close();
  });

  it("fills street, deleted_at and deleted_by from the project.delete row", () => {
    const db = seeded();
    audit(db, "a1", "project.create", "gone4", JSON.stringify({ actor: "tonomo", orderId: "order-4" }), NOW + 10);
    audit(db, "a2", "project.delete", "gone4", JSON.stringify({ street: "4 Deleted Road", assetCount: 0, r2Prefix: "projects/gone4/" }), NOW + 99, "admin1");
    db.exec(migrationSql(MIGRATION));
    expect(tombstone(db, "order-4")).toMatchObject({ deleted_project_id: "gone4", street: "4 Deleted Road", deleted_at: NOW + 99, deleted_by: "admin1", source: "migration_0051" });
    db.close();
  });

  it("seeds an order from the project.delete row's own orderId (audit meta written by #delete route)", () => {
    const db = seeded();
    audit(db, "a1", "project.delete", "gone5", JSON.stringify({ street: "5 Road", orderId: "order-5", assetCount: 0, r2Prefix: "projects/gone5/" }), NOW + 50, "admin1");
    db.exec(migrationSql(MIGRATION));
    expect(tombstone(db, "order-5")).toMatchObject({ deleted_project_id: "gone5", street: "5 Road", deleted_by: "admin1" });
    db.close();
  });
});
