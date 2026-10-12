import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0073_review_link_token_secret.sql";
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
}
function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}
const legacyInsert = (id: string, kind: "delivery" | "video_review") =>
  `INSERT INTO client_links (id, project_id, token_hash, kind, ${kind === "delivery" ? "publish_version, " : "created_by, updated_at, "}expires_at, created_at) VALUES ('${id}', 'p1', 'th-${id}', '${kind}', ${kind === "delivery" ? "1, " : "'u1', 1, "}${NOW}, 1)`;

describe("migration 0073 adds client_links.token_secret (#815)", () => {
  it("is journaled as idx 73, one additive ALTER, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code).toHaveLength(1);
    expect(code[0]).toMatch(/^ALTER TABLE client_links ADD COLUMN token_secret text CHECK/);
    expect(code.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |INSERT INTO|DEFAULT/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 73 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 73).map((candidate) => candidate.when)));
  });

  it("adds a nullable column with no default, leaves existing rows NULL and keeps old inserts working", () => {
    const db = localSqlite(); applyUpTo(db, 72); seed(db);
    db.exec(legacyInsert("old-review", "video_review")); db.exec(legacyInsert("old-delivery", "delivery"));
    applyMigration(db);
    const column = (db.prepare("PRAGMA table_info(client_links)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>).find((c) => c.name === "token_secret");
    expect(column).toMatchObject({ notnull: 0, dflt_value: null, type: "TEXT" });
    expect(db.prepare("SELECT count(*) AS n FROM client_links WHERE token_secret IS NULL").get()).toEqual({ n: 2 });
    db.exec(legacyInsert("new-review", "video_review"));
    expect(db.prepare("SELECT token_secret FROM client_links WHERE id = 'new-review'").get()).toEqual({ token_secret: null });
  });

  it("accepts a secret, accepts NULL again, and rejects the empty string", () => {
    const db = localSqlite(); applyUpTo(db, 72); seed(db); applyMigration(db);
    db.exec(legacyInsert("a", "video_review"));
    db.prepare("UPDATE client_links SET token_secret = ? WHERE id = 'a'").run("abc");
    expect(db.prepare("SELECT token_secret FROM client_links WHERE id = 'a'").get()).toEqual({ token_secret: "abc" });
    db.prepare("UPDATE client_links SET token_secret = NULL WHERE id = 'a'").run();
    expect(() => db.prepare("UPDATE client_links SET token_secret = '' WHERE id = 'a'").run()).toThrow();
  });
});
