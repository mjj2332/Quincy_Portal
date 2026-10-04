import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0057_embedded_media.sql";

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

const now = 1_800_000_000_000;
type Row = Partial<{ id: string; owner_kind: string; owner_id: string | null; project_id: string | null; kind: string; bytes: number; original_key: string; state: string; detached_at: number | null }>;
function insert(db: SqliteDatabase, row: Row = {}): void {
  const value = { id: "m1", owner_kind: "project_comment", owner_id: null, project_id: "p1", kind: "image", bytes: 10, original_key: `projects/p1/embedded-media/${row.id ?? "m1"}/original`, state: "uploading", detached_at: null, ...row };
  db.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'u1', ?, 'image/png', ?, ?, ?, ?, ?, ?)")
    .run(value.id, value.owner_kind, value.owner_id, value.project_id, value.kind, value.bytes, value.original_key, value.state, value.detached_at, now, now);
}

function seeded(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 57);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'S', 'editing', 0, ?, ?)").run(now, now);
  return db;
}

describe("migration 0057 adds embedded media (#493)", () => {
  it("is journaled, adds a table and indexes only, and has no trigger or semicolon in a comment", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.tag === MIGRATION.replace(/\.sql$/, ""))).toBeDefined();
  });

  it("applies to a database that already has the earlier migrations, and creates no rows", () => {
    const db = localSqlite();
    applyThrough(db, 55);
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    db.exec("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
    expect(db.prepare("SELECT count(*) AS n FROM embedded_media").get()).toEqual({ n: 0 });
    db.close();
  });

  it("holds an uploading or pending row with no owner, and an attached or detached row with one", () => {
    const db = seeded();
    insert(db, { id: "up", state: "uploading" });
    insert(db, { id: "pe", state: "pending" });
    insert(db, { id: "at", state: "attached", owner_id: "c1" });
    insert(db, { id: "de", state: "detached", owner_id: "c1", detached_at: now });
    expect(() => insert(db, { id: "bad1", state: "uploading", owner_id: "c1" })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "bad2", state: "attached", owner_id: null })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "bad3", state: "detached", owner_id: "c1", detached_at: null })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "bad4", state: "attached", owner_id: "c1", detached_at: now })).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  it("ties a Project to every owner kind except a Notice board post", () => {
    const db = seeded();
    insert(db, { id: "wb", owner_kind: "whiteboard" });
    expect(() => insert(db, { id: "np", owner_kind: "notice_post", project_id: "p1" })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "pc", owner_kind: "project_comment", project_id: null })).toThrow(/CHECK constraint failed/i);
    insert(db, { id: "np2", owner_kind: "notice_post", project_id: null });
    db.close();
  });

  it("accepts only known owner kinds, media kinds and states, a positive size and a unique key", () => {
    const db = seeded();
    expect(() => insert(db, { id: "k1", owner_kind: "elsewhere" })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "k2", kind: "audio" })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "k3", state: "gone" })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "k4", bytes: 0 })).toThrow(/CHECK constraint failed/i);
    insert(db, { id: "dup1", original_key: "same" });
    expect(() => insert(db, { id: "dup2", original_key: "same" })).toThrow(/UNIQUE constraint failed/i);
    db.close();
  });

  it("is removed with its Project by the cascade", () => {
    const db = seeded();
    insert(db, { id: "a" });
    insert(db, { id: "b", state: "attached", owner_id: "c1" });
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM embedded_media").get()).toEqual({ n: 0 });
    db.close();
  });
});
