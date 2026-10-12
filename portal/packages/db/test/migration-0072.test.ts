import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0072_object_crc32.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function migrated(): SqliteDatabase {
  const db = localSqlite();
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 71).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
  return db;
}

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ r2_key: "projects/p/raw/a.jpg", crc32: 0xdeadbeef, bytes: 10, etag: "abc", computed_at: NOW, ...overrides });
function insert(db: SqliteDatabase, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO object_crc32 (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

describe("migration 0072 adds the object CRC-32 cache and its work table (#802)", () => {
  it("is journaled as idx 72, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |ALTER |INSERT INTO feature_flags/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 72 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 72).map((candidate) => candidate.when)));
  });

  it("is keyed by R2 key and accepts the unsigned 32-bit range", () => {
    const db = migrated();
    insert(db, row({ crc32: 0 }));
    insert(db, row({ r2_key: "k2", crc32: 4_294_967_295 }));
    expect(() => insert(db, row())).toThrow();
  });

  it("rejects a CRC outside unsigned 32 bits, negative bytes, an empty etag or key, and non-integer times", () => {
    const db = migrated();
    for (const bad of [{ crc32: -1 }, { crc32: 4_294_967_296 }, { crc32: "x" }, { bytes: -1 }, { bytes: "x" }, { etag: "" }, { r2_key: "" }, { computed_at: "x" }]) {
      expect(() => insert(db, row(bad)), JSON.stringify(bad)).toThrow();
    }
  });

  it("upserts by key", () => {
    const db = migrated();
    insert(db, row());
    db.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET crc32 = excluded.crc32, etag = excluded.etag").run("projects/p/raw/a.jpg", 7, 10, "def", NOW + 1);
    expect(db.prepare("SELECT crc32, etag FROM object_crc32").get()).toEqual({ crc32: 7, etag: "def" });
  });
});

const work = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ r2_key: "projects/p/raw/a.jpg", etag: "abc", bytes: 10, offset: 0, crc_partial: 0, state: "queued", attempts: 0, requested_at: NOW, updated_at: NOW, last_error: null, ...overrides });
function insertWork(db: SqliteDatabase, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO object_crc32_work (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

describe("object_crc32_work, the resumable job's state (#802)", () => {
  it("accepts a queued row with no etag or size yet, a running row mid-object, and a failed row with its error", () => {
    const db = migrated();
    insertWork(db, work({ r2_key: "queued", etag: null, bytes: null }));
    insertWork(db, work({ r2_key: "running", state: "running", offset: 5, crc_partial: 4_294_967_295 }));
    insertWork(db, work({ r2_key: "failed", state: "failed", attempts: 3, last_error: "boom" }));
    expect((db.prepare("SELECT count(*) AS n FROM object_crc32_work").get() as { n: number }).n).toBe(3);
  });

  it("carries a claim token, NULL while nobody holds the row, that fences each owner of a row", () => {
    const db = migrated();
    insertWork(db, work({ r2_key: "default" })); insertWork(db, work({ r2_key: "held", state: "running", claim_token: "3f2c9d7e-0000-4000-8000-000000000001" }));
    expect(db.prepare("SELECT r2_key, claim_token FROM object_crc32_work ORDER BY r2_key").all()).toEqual([{ r2_key: "default", claim_token: null }, { r2_key: "held", claim_token: "3f2c9d7e-0000-4000-8000-000000000001" }]);
  });

  it("is keyed by R2 key", () => {
    const db = migrated();
    insertWork(db, work());
    expect(() => insertWork(db, work())).toThrow();
  });

  it("rejects an unknown state, a partial CRC outside unsigned 32 bits, a negative offset or attempts, an offset past the size, and non-integer times", () => {
    const db = migrated();
    for (const bad of [{ state: "done" }, { state: null }, { crc_partial: -1 }, { crc_partial: 4_294_967_296 }, { crc_partial: "x" }, { offset: -1 }, { offset: "x" }, { offset: 11 }, { bytes: -1 }, { attempts: -1 }, { attempts: "x" }, { claim_token: "" }, { etag: "" }, { r2_key: "" }, { requested_at: "x" }, { updated_at: "x" }, { etag: null, bytes: 10 }, { etag: null, bytes: null, offset: 1 }]) {
      expect(() => insertWork(db, work(bad)), JSON.stringify(bad)).toThrow();
    }
  });

  it("has no foreign key, so a row outlives any asset", () => {
    const db = migrated();
    expect(db.prepare("PRAGMA foreign_key_list(object_crc32_work)").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(object_crc32)").all()).toEqual([]);
  });
});
