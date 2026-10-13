import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0079_social_overlays.sql";
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
function migrated(): SqliteDatabase {
  const db = localSqlite(); applyUpTo(db, 78);
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  return db;
}
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "o1", name: "Instagram Reel", platform_label: "Instagram", image_key: "social-overlays/o1/a.png", width: 1080, height: 1920, bytes: 100,
  created_by: "u1", updated_by: "u1", created_at: NOW, updated_at: NOW, ...overrides,
});
function insert(db: SqliteDatabase, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO social_overlays (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

describe("migration 0079 creates social_overlays (#869)", () => {
  it("is journaled as idx 79, additive, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code[0]).toMatch(/^CREATE TABLE social_overlays/);
    expect(code.slice(1).every((statement) => /^CREATE (UNIQUE )?INDEX /.test(statement))).toBe(true);
    expect(code.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |INSERT INTO/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 79 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 79).map((candidate) => candidate.when)));
  });

  it("stores a row with defaults: not default, revision 1, not archived", () => {
    const db = migrated(); insert(db, row());
    expect(db.prepare("SELECT is_default, image_rev, archived_at, archived_by FROM social_overlays WHERE id = 'o1'").get()).toEqual({ is_default: 0, image_rev: 1, archived_at: null, archived_by: null });
  });

  it("allows only one default row, and never an archived default", () => {
    const db = migrated();
    insert(db, row({ is_default: 1 }));
    expect(() => insert(db, row({ id: "o2", name: "TikTok", image_key: "k2", is_default: 1 }))).toThrow();
    insert(db, row({ id: "o3", name: "Shorts", image_key: "k3" }));
    expect(() => db.prepare("UPDATE social_overlays SET archived_at = ? WHERE id = 'o1'").run(NOW)).toThrow();
    db.prepare("UPDATE social_overlays SET archived_at = ?, archived_by = 'u1' WHERE id = 'o3'").run(NOW);
  });

  it("keeps names unique ignoring case and image keys unique", () => {
    const db = migrated(); insert(db, row());
    expect(() => insert(db, row({ id: "o2", name: "instagram reel", image_key: "k2" }))).toThrow();
    expect(() => insert(db, row({ id: "o2", name: "Other", image_key: "social-overlays/o1/a.png" }))).toThrow();
  });

  it("enforces length bounds, integer times, positive sizes and user foreign keys", () => {
    const db = migrated();
    expect(() => insert(db, row({ name: "" }))).toThrow();
    expect(() => insert(db, row({ name: "x".repeat(81) }))).toThrow();
    expect(() => insert(db, row({ platform_label: "" }))).toThrow();
    expect(() => insert(db, row({ platform_label: "x".repeat(41) }))).toThrow();
    expect(() => insert(db, row({ created_at: "yesterday" }))).toThrow();
    expect(() => insert(db, row({ bytes: 0 }))).toThrow();
    expect(() => insert(db, row({ created_by: "ghost" }))).toThrow();
    expect(() => insert(db, row({ is_default: 2 }))).toThrow();
  });
});
