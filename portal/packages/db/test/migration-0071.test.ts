import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0071_delivery_schema.sql";
const NOW = 1_800_000_000_000;
const NEW_TABLES = ["asset_premium_unlocks", "delivery_pages", "delivery_set_items", "delivery_sets"];

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

/** Applies 0071 statement by statement with foreign_keys=ON throughout (D1 does not honour a PRAGMA toggle). */
function apply0071(db: SqliteDatabase): void {
  expect(existsSync(new URL(`../migrations/${MIGRATION}`, import.meta.url)), `${MIGRATION} exists`).toBe(true);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

function baseRows(db: SqliteDatabase): void {
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p2', 'T', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'edited', 1, 1)");
  for (const id of ["a1", "a2", "a3"]) {
    db.exec(`INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('${id}', 'c1', 'k-${id}', '${id}.jpg', 10, 'upload', 1, 1)`);
  }
}

/** A populated 0070 database so the migration is applied over live data. */
function legacy(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 70);
  baseRows(db);
  return db;
}

function migrated(): SqliteDatabase {
  const db = legacy();
  apply0071(db);
  return db;
}

type Fields = Record<string, unknown>;
function insert(db: SqliteDatabase, table: string, fields: Fields): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}
const count = (db: SqliteDatabase, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const columns = (db: SqliteDatabase, table: string) => db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${table}')`).all() as Array<{ name: string; type: string; nn: number; dflt: string | null; pk: number }>;
const column = (db: SqliteDatabase, table: string, name: string) => columns(db, table).find((value) => value.name === name);
const fks = (db: SqliteDatabase, table: string) => db.prepare(`SELECT "from" AS col, "table" AS parent, "to" AS target, on_delete AS onDelete FROM pragma_foreign_key_list('${table}') ORDER BY "from"`).all();

const page = (overrides: Fields = {}): Fields => ({ project_id: "p1", slug: "1-main-street-suburb-k7f2xm", enabled: 1, latest_set_number: 1, created_at: NOW, updated_at: NOW, ...overrides });
const set = (overrides: Fields = {}): Fields => ({ id: "s1", project_id: "p1", set_number: 1, operation_id: "op-1", cover_asset_id: "a1", published_by: "u1", published_at: NOW, ...overrides });
const item = (overrides: Fields = {}): Fields => ({ set_id: "s1", asset_id: "a1", handle: "abcdefghjkmnpqrs", position: 0, ...overrides });
const unlock = (overrides: Fields = {}): Fields => ({ asset_id: "a1", project_id: "p1", unlocked_by: "u1", unlocked_at: NOW, ...overrides });

describe("migration 0071 adds the Client Delivery schema (#787 slice 1)", () => {
  it("exists, is journaled as idx 71, and keeps the worker harness's splitting rules", () => {
    expect(existsSync(new URL(`../migrations/${MIGRATION}`, import.meta.url))).toBe(true);
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|RENAME|INSERT INTO|UPDATE /i);
    expect(code.match(/ALTER TABLE \w+ ADD COLUMN \w+/gi)).toEqual(["ALTER TABLE assets ADD COLUMN delivery_premium"]);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 71 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 71).map((candidate) => candidate.when)));
  });

  it("creates exactly the four new tables and leaves the legacy publishes and premium_unlocks alone", () => {
    const before = legacy();
    const tablesBefore = (before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tablesBefore.filter((name) => NEW_TABLES.includes(name))).toEqual([]);
    const legacySql = (db: SqliteDatabase) => db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('publishes','premium_unlocks') OR tbl_name IN ('publishes','premium_unlocks') ORDER BY name").all();
    const legacyBefore = legacySql(before);
    const db = migrated();
    const tablesAfter = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tablesAfter.filter((name) => !tablesBefore.includes(name))).toEqual(NEW_TABLES);
    expect(legacySql(db)).toEqual(legacyBefore);
  });

  it("adds assets.delivery_premium as NOT NULL default 0 constrained to 0 and 1, and existing assets stay unmarked", () => {
    const db = migrated();
    expect(column(db, "assets", "delivery_premium")).toMatchObject({ type: "INTEGER", nn: 1, dflt: "0" });
    expect(count(db, "SELECT count(*) AS n FROM assets WHERE delivery_premium = 0")).toBe(3);
    expect(column(db, "assets", "is_premium")).toBeDefined();
    expect(() => db.exec("UPDATE assets SET delivery_premium = 2 WHERE id = 'a1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE assets SET delivery_premium = 1 WHERE id = 'a1'")).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("delivery_pages: keyed on project_id, unique slug, bounded fields, cascades with the Project", () => {
    const db = migrated();
    expect(column(db, "delivery_pages", "project_id")).toMatchObject({ pk: 1, nn: 1 });
    expect(column(db, "delivery_pages", "enabled")).toMatchObject({ nn: 1, dflt: "1" });
    expect(fks(db, "delivery_pages")).toEqual([{ col: "project_id", parent: "projects", target: "id", onDelete: "CASCADE" }]);
    insert(db, "delivery_pages", page());
    expect(() => insert(db, "delivery_pages", page())).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "p2" }))).toThrow(/UNIQUE/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "p2", slug: "short" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "p2", slug: "another-slug-abcdef", enabled: 2 }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "p2", slug: "another-slug-abcdef", latest_set_number: 0 }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "p2", slug: "another-slug-abcdef", created_at: "now" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_pages", page({ project_id: "ghost", slug: "another-slug-abcdef" }))).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM projects WHERE id = 'p1'");
    expect(count(db, "SELECT count(*) AS n FROM delivery_pages")).toBe(0);
  });

  it("delivery_sets: unique set number and operation id per Project, FKs, cover goes NULL when its Asset is deleted", () => {
    const db = migrated();
    expect(fks(db, "delivery_sets")).toEqual([
      { col: "cover_asset_id", parent: "assets", target: "id", onDelete: "SET NULL" },
      { col: "project_id", parent: "projects", target: "id", onDelete: "CASCADE" },
      { col: "published_by", parent: "user", target: "id", onDelete: "NO ACTION" },
    ]);
    insert(db, "delivery_sets", set());
    expect(() => insert(db, "delivery_sets", set({ id: "s2", operation_id: "op-2" }))).toThrow(/UNIQUE/);
    expect(() => insert(db, "delivery_sets", set({ id: "s2", set_number: 2 }))).toThrow(/UNIQUE/);
    insert(db, "delivery_sets", set({ id: "s3", project_id: "p2", cover_asset_id: null }));
    expect(() => insert(db, "delivery_sets", set({ id: "s4", set_number: 0, operation_id: "op-4" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_sets", set({ id: "s4", set_number: 4, operation_id: "" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_sets", set({ id: "s4", set_number: 4, operation_id: "x".repeat(65) }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_sets", set({ id: "s4", set_number: 4, operation_id: "op-4", published_at: "now" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_sets", set({ id: "s4", set_number: 4, operation_id: "op-4", published_by: "ghost" }))).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM assets WHERE id = 'a1'");
    expect(db.prepare("SELECT cover_asset_id AS c FROM delivery_sets WHERE id = 's1'").get()).toEqual({ c: null });
  });

  it("delivery_set_items: one row per asset per set, unique handle, 16-char handle, cascades from the set and the Asset", () => {
    const db = migrated();
    expect(fks(db, "delivery_set_items")).toEqual([
      { col: "asset_id", parent: "assets", target: "id", onDelete: "CASCADE" },
      { col: "set_id", parent: "delivery_sets", target: "id", onDelete: "CASCADE" },
    ]);
    expect(columns(db, "delivery_set_items").filter((value) => value.pk > 0).map((value) => value.name).sort()).toEqual(["asset_id", "set_id"]);
    insert(db, "delivery_sets", set());
    insert(db, "delivery_sets", set({ id: "s2", set_number: 2, operation_id: "op-2" }));
    insert(db, "delivery_set_items", item());
    expect(() => insert(db, "delivery_set_items", item({ handle: "zzzzzzzzzzzzzzzz" }))).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, "delivery_set_items", item({ asset_id: "a2" }))).toThrow(/UNIQUE/);
    insert(db, "delivery_set_items", item({ set_id: "s2" }));
    expect(() => insert(db, "delivery_set_items", item({ asset_id: "a2", handle: "short" }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_set_items", item({ asset_id: "a2", position: -1 }))).toThrow(/CHECK/);
    expect(() => insert(db, "delivery_set_items", item({ asset_id: "ghost", handle: "qqqqqqqqqqqqqqqq" }))).toThrow(/FOREIGN KEY/);
    expect(() => insert(db, "delivery_set_items", item({ set_id: "ghost", handle: "qqqqqqqqqqqqqqqq" }))).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM assets WHERE id = 'a1'");
    expect(count(db, "SELECT count(*) AS n FROM delivery_set_items")).toBe(0);
    insert(db, "delivery_set_items", item({ asset_id: "a2", set_id: "s2" }));
    db.exec("DELETE FROM delivery_sets WHERE id = 's2'");
    expect(count(db, "SELECT count(*) AS n FROM delivery_set_items")).toBe(0);
  });

  it("indexes the asset column of delivery_set_items for the current-set guard", () => {
    const db = migrated();
    const indexes = db.prepare("SELECT name FROM pragma_index_list('delivery_set_items')").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("delivery_set_items_asset_idx");
    const asset = db.prepare("SELECT name FROM pragma_index_info('delivery_set_items_asset_idx')").all();
    expect(asset).toEqual([{ name: "asset_id" }]);
  });

  it("asset_premium_unlocks mirrors video_premium_unlocks: PK on asset, FKs, payment ref length, integer time", () => {
    const db = migrated();
    expect(column(db, "asset_premium_unlocks", "asset_id")).toMatchObject({ pk: 1, nn: 1 });
    expect(fks(db, "asset_premium_unlocks")).toEqual([
      { col: "asset_id", parent: "assets", target: "id", onDelete: "CASCADE" },
      { col: "project_id", parent: "projects", target: "id", onDelete: "CASCADE" },
      { col: "unlocked_by", parent: "user", target: "id", onDelete: "NO ACTION" },
    ]);
    insert(db, "asset_premium_unlocks", unlock());
    expect(() => insert(db, "asset_premium_unlocks", unlock())).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, "asset_premium_unlocks", unlock({ asset_id: "a2", payment_ref: "x".repeat(201) }))).toThrow(/CHECK/);
    expect(() => insert(db, "asset_premium_unlocks", unlock({ asset_id: "a2", payment_ref: "x".repeat(200) }))).not.toThrow();
    expect(() => insert(db, "asset_premium_unlocks", unlock({ asset_id: "a3", unlocked_at: "yesterday" }))).toThrow(/CHECK/);
    expect(() => insert(db, "asset_premium_unlocks", unlock({ asset_id: "a3", unlocked_by: "ghost" }))).toThrow(/FOREIGN KEY/);
    expect(() => insert(db, "asset_premium_unlocks", unlock({ asset_id: "ghost" }))).toThrow(/FOREIGN KEY/);
    const idx = db.prepare("SELECT name FROM pragma_index_list('asset_premium_unlocks')").all() as Array<{ name: string }>;
    expect(idx.map((row) => row.name)).toContain("asset_premium_unlocks_project_idx");
    db.exec("DELETE FROM assets WHERE id = 'a1'");
    expect(count(db, "SELECT count(*) AS n FROM asset_premium_unlocks WHERE asset_id = 'a1'")).toBe(0);
  });

  it("passes the foreign key check over the populated database", () => {
    const db = migrated();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
