import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0077_delivery_review_link.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
function applyUpTo(db: SqliteDatabase, max: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= max).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}
function seed(db: SqliteDatabase): void {
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p2', 'S2', 'editing_autohdr', 1, 1)");
}
function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}
const reviewInsert = (id: string, project: string, expires: string, extra = "") =>
  `INSERT INTO client_links (id, project_id, token_hash, kind, created_by, updated_at, expires_at, created_at${extra ? ", delivery_review" : ""}) VALUES ('${id}', '${project}', 'th-${id}', 'video_review', 'u1', 1, ${expires}, 1${extra ? `, ${extra}` : ""})`;

describe("migration 0077 makes client_links.expires_at nullable and adds delivery_review (#847)", () => {
  it("is journaled as idx 77 and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|PRAGMA|__new_/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 77 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 77).map((candidate) => candidate.when)));
  });

  it("keeps every existing expiry value and every row, and the result is nullable", () => {
    const db = localSqlite(); applyUpTo(db, 76); seed(db);
    db.exec(reviewInsert("a", "p1", String(NOW)));
    db.exec(`INSERT INTO client_links (id, project_id, token_hash, kind, publish_version, expires_at, created_at) VALUES ('d', 'p1', 'th-d', 'delivery', 1, ${NOW + 5}, 1)`);
    db.exec("INSERT INTO client_links (id, project_id, token_hash, kind, created_by, updated_at, expires_at, created_at, deleted_at, deleted_by, revoked_at, revoked_by) VALUES ('z', 'p1', 'th-z', 'video_review', 'u1', 1, 7, 1, 9, 'u1', 9, 'u1')");
    applyMigration(db);
    expect(db.prepare("SELECT id, expires_at, delivery_review, deleted_at FROM client_links ORDER BY id").all()).toEqual([
      { id: "a", expires_at: NOW, delivery_review: 0, deleted_at: null },
      { id: "d", expires_at: NOW + 5, delivery_review: 0, deleted_at: null },
      { id: "z", expires_at: 7, delivery_review: 0, deleted_at: 9 },
    ]);
    const columns = db.prepare("PRAGMA table_info(client_links)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    expect(columns.find((c) => c.name === "expires_at")).toMatchObject({ notnull: 0 });
    expect(columns.find((c) => c.name === "delivery_review")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("accepts NULL expiry, rejects a non-integer expiry and a bad marker", () => {
    const db = localSqlite(); applyUpTo(db, 76); seed(db); applyMigration(db);
    db.exec(reviewInsert("n", "p1", "NULL"));
    expect(db.prepare("SELECT expires_at FROM client_links WHERE id = 'n'").get()).toEqual({ expires_at: null });
    expect(() => db.exec(reviewInsert("t", "p1", "'soon'"))).toThrow();
    expect(() => db.exec(reviewInsert("m", "p1", "NULL", "2"))).toThrow();
  });

  it("allows one Delivery review link per Project for life, beside any number of ordinary links", () => {
    const db = localSqlite(); applyUpTo(db, 76); seed(db); applyMigration(db);
    db.exec(reviewInsert("o1", "p1", String(NOW))); db.exec(reviewInsert("o2", "p1", String(NOW)));
    db.exec(reviewInsert("x1", "p1", "NULL", "1"));
    expect(() => db.exec(reviewInsert("x2", "p1", "NULL", "1"))).toThrow(/UNIQUE/);
    db.exec(reviewInsert("y1", "p2", "NULL", "1"));
    // revoked and deleted rows still hold the slot
    db.exec("UPDATE client_links SET revoked_at = 5, revoked_by = 'u1', deleted_at = 5, deleted_by = 'u1' WHERE id = 'x1'");
    expect(() => db.exec(reviewInsert("x3", "p1", "NULL", "1"))).toThrow(/UNIQUE/);
  });

  it("keeps the child tables intact across the column swap", () => {
    const db = localSqlite(); applyUpTo(db, 76); seed(db);
    db.exec(reviewInsert("a", "p1", String(NOW)));
    db.exec("INSERT INTO guest_sessions (id, token_hash, link_id, link_generation, created_at, expires_at, last_seen_at) VALUES ('s', 'sh', 'a', 1, 1, 5, 1)");
    applyMigration(db);
    expect(db.prepare("SELECT count(*) AS n FROM guest_sessions WHERE link_id = 'a'").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
