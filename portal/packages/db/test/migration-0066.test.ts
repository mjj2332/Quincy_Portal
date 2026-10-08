import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0066_mcp_access.sql";
const NOW = 1_800_000_000_000;

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

function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

const insertUser = (db: SqliteDatabase, id: string) =>
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', ?, 1, 'admin', 1, ?, ?)").run(id, `${id}@example.test`, NOW, NOW);
const insertConnection = (db: SqliteDatabase, id: string, userId: string, grant: string | null) =>
  db.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, oauth_grant_id, created_at) VALUES (?, ?, 'c1', 'Claude', 'claude.ai', '[\"read\"]', 0, ?, ?)").run(id, userId, grant, NOW);

describe("migration 0066 adds MCP access (#701)", () => {
  it("is journaled as idx 66, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE /i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 66 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 66).map((candidate) => candidate.when)));
  });

  it("seeds mcp_access off and never overwrites an operator's choice on replay", () => {
    const db = localSqlite();
    applyThrough(db, 65);
    applyMigration(db);
    expect(db.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = 'mcp_access'").get()).toEqual({ enabled: 0, updated_by: null });
    insertUser(db, "u1");
    db.prepare("UPDATE feature_flags SET enabled = 1, updated_by = 'u1' WHERE key = 'mcp_access'").run();
    db.exec(readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")[0]!);
    expect(db.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = 'mcp_access'").get()).toEqual({ enabled: 1, updated_by: "u1" });
  });

  it("creates mcp_connections with its indexes, a unique nullable grant id and a cascade from user", () => {
    const db = localSqlite();
    applyThrough(db, 65);
    applyMigration(db);
    const indexes = db.prepare("SELECT name FROM pragma_index_list('mcp_connections') WHERE name LIKE 'mcp_connections_%' ORDER BY name").all();
    expect(indexes).toEqual([{ name: "mcp_connections_client_idx" }, { name: "mcp_connections_user_revoked_idx" }]);
    insertUser(db, "u1");
    insertConnection(db, "a", "u1", null);
    insertConnection(db, "b", "u1", null);
    insertConnection(db, "c", "u1", "grant-1");
    expect(() => insertConnection(db, "d", "u1", "grant-1")).toThrow();
    expect(() => insertConnection(db, "e", "missing-user", null)).toThrow();
    db.prepare("DELETE FROM user WHERE id = 'u1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM mcp_connections").get()).toEqual({ n: 0 });
  });
});
