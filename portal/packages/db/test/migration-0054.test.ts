import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0054_project_deadline_source.sql";

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

function applyAsTransaction(db: SqliteDatabase): void {
  const source = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
  db.exec("BEGIN");
  try {
    for (const statement of source.split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("migration 0054 stores Deadline provenance (#484)", () => {
  it("is journaled, additive, and free of triggers and semicolons in comments", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 54)?.tag).toBe(MIGRATION.replace(/\.sql$/, ""));
  });

  it("classifies every held Deadline as manual, leaves the rest none, and backfills nothing", () => {
    const db = localSqlite();
    applyThrough(db, 53);
    const now = Date.now();
    const insert = db.prepare("INSERT INTO projects (id, street, stage_key, board_position, shoot_date, deadline_at, deadline_version, created_at, updated_at) VALUES (?, 'S', 'editing', 0, ?, ?, ?, ?, ?)");
    insert.run("held", "2026-06-01", now + 86_400_000, 2, now, now);
    insert.run("empty-with-date", "2026-06-01", null, 0, now, now);
    insert.run("empty", null, null, 0, now, now);
    applyAsTransaction(db);
    const rows = db.prepare("SELECT id, deadline_source AS source, deadline_at AS deadlineAt, deadline_version AS version FROM projects ORDER BY id").all() as Array<{ id: string; source: string; deadlineAt: number | null; version: number }>;
    expect(rows.map((row) => [row.id, row.source])).toEqual([["empty", "none"], ["empty-with-date", "none"], ["held", "manual"]]);
    expect(rows.find((row) => row.id === "empty-with-date")).toMatchObject({ deadlineAt: null, version: 0 });
    expect(rows.find((row) => row.id === "held")?.version).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM project_deadline_occurrences").get()).toEqual({ n: 0 });
    db.close();
  });

  it("accepts only automatic, manual or none", () => {
    const db = localSqlite();
    applyThrough(db, 54);
    const now = Date.now();
    for (const [index, source] of ["automatic", "manual", "none"].entries()) {
      db.prepare("INSERT INTO projects (id, street, stage_key, board_position, deadline_source, created_at, updated_at) VALUES (?, 'S', 'editing', 0, ?, ?, ?)").run(`ok-${index}`, source, now, now);
    }
    expect(() => db.prepare("INSERT INTO projects (id, street, stage_key, board_position, deadline_source, created_at, updated_at) VALUES ('bad', 'S', 'editing', 0, 'bogus', ?, ?)").run(now, now)).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare("INSERT INTO projects (id, street, stage_key, board_position, deadline_source, created_at, updated_at) VALUES ('null', 'S', 'editing', 0, NULL, ?, ?)").run(now, now)).toThrow(/NOT NULL constraint failed/i);
    expect(db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('default', 'S', 'editing', 0, ?, ?)").run(now, now).changes).toBe(1);
    expect(db.prepare("SELECT deadline_source AS source FROM projects WHERE id = 'default'").get()).toEqual({ source: "none" });
    db.close();
  });
});
