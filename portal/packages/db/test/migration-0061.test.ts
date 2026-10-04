import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

// 0059 (#547) and 0060 (#548) are reserved by open PRs: this migration is numbered 0061 and must land after them or be renumbered at merge.
const MIGRATION = "0061_project_whiteboard_versions.sql";
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

type Row = Partial<{ id: string; project_id: string; r2_key: string; ordinal: number; generation: number; scene_revision: number; created_at: number; created_by: string | null; reason: string; scene_sha256: string; byte_count: number; element_count: number; state: string }>;
function insert(db: SqliteDatabase, row: Row = {}): void {
  const id = row.id ?? "v1";
  const value = { id, project_id: "p1", r2_key: `projects/p1/whiteboard/versions/${id}.json`, ordinal: 1, generation: 1, scene_revision: 1, created_at: NOW, created_by: "u1", reason: "interval", scene_sha256: "ab", byte_count: 10, element_count: 1, state: "ready", ...row };
  db.prepare("INSERT INTO project_whiteboard_versions (id, project_id, r2_key, ordinal, generation, scene_revision, created_at, created_by, reason, scene_sha256, byte_count, element_count, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(value.id, value.project_id, value.r2_key, value.ordinal, value.generation, value.scene_revision, value.created_at, value.created_by, value.reason, value.scene_sha256, value.byte_count, value.element_count, value.state);
}

function seeded(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 61);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").run(NOW, NOW);
  for (const id of ["p1", "p2"]) db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing', 0, ?, ?)").run(id, NOW, NOW);
  return db;
}

describe("migration 0061 adds Project whiteboard versions (#500)", () => {
  it("is journaled as idx 61, adds a table and indexes only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 61 });
    const previous = journal.entries.filter((candidate) => candidate.idx < 61).map((candidate) => candidate.when);
    expect(entry!.when).toBeGreaterThan(Math.max(...previous));
  });

  it("applies to a database that already has the earlier migrations and creates no rows", () => {
    const db = localSqlite();
    applyThrough(db, 58);
    db.exec("BEGIN");
    for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
    expect(db.prepare("SELECT count(*) AS n FROM project_whiteboard_versions").get()).toEqual({ n: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("indexes (project, state, ordinal) and enforces unique ordinals per Project and unique R2 keys", () => {
    const db = seeded();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_whiteboard_versions'").all() as Array<{ name: string }>;
    expect(indexes.map((entry) => entry.name)).toContain("project_whiteboard_versions_project_state_ordinal_idx");
    insert(db, { id: "a", ordinal: 1 });
    expect(() => insert(db, { id: "b", ordinal: 1, r2_key: "projects/p1/whiteboard/versions/b.json" })).toThrow(/UNIQUE/i);
    insert(db, { id: "c", ordinal: 1, project_id: "p2", r2_key: "projects/p2/whiteboard/versions/c.json" });      // the same ordinal in another Project is fine
    expect(() => insert(db, { id: "d", ordinal: 2, r2_key: "projects/p1/whiteboard/versions/a.json" })).toThrow(/UNIQUE/i);
    db.close();
  });

  it("accepts the three reasons and both states and rejects anything else", () => {
    const db = seeded();
    let ordinal = 1;
    for (const reason of ["interval", "last_leave", "pre_restore"]) insert(db, { id: `r-${reason}`, reason, ordinal: ordinal++ });
    for (const state of ["ready", "pruning"]) insert(db, { id: `s-${state}`, state, ordinal: ordinal++ });
    expect(() => insert(db, { id: "x1", reason: "manual", ordinal: ordinal++ })).toThrow(/CHECK constraint failed/i);
    expect(() => insert(db, { id: "x2", state: "deleted", ordinal: ordinal++ })).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  it("rejects negative or fractional counters, ordinals, generations and revisions, and NULL where a value is required", () => {
    const db = seeded();
    let ordinal = 1;
    for (const bad of [{ ordinal: -1 }, { generation: -1 }, { scene_revision: -1 }, { byte_count: -1 }, { element_count: -1 }, { generation: 1.5 }, { element_count: 0.5 }, { created_at: -1 }]) {
      expect(() => insert(db, { id: `bad-${ordinal}`, ...bad, ...("ordinal" in bad ? {} : { ordinal: ordinal++ }) }), JSON.stringify(bad)).toThrow(/CHECK constraint failed/i);
    }
    expect(() => insert(db, { id: "n1", ordinal: ordinal++, scene_sha256: null as unknown as string })).toThrow(/NOT NULL/i);
    insert(db, { id: "ok0", ordinal: 0, generation: 0, scene_revision: 0, byte_count: 0, element_count: 0 });
    db.close();
  });

  it("cascades with the Project, and keeps a version when its author is deleted", () => {
    const db = seeded();
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u2', 'U2', 'u2@example.test', 1, 'editor', 1, ?, ?)").run(NOW, NOW);
    insert(db, { id: "a", ordinal: 1, created_by: "u2" });
    insert(db, { id: "b", ordinal: 2, created_by: null });
    db.prepare("DELETE FROM user WHERE id = 'u2'").run();
    expect(db.prepare("SELECT created_by AS by FROM project_whiteboard_versions WHERE id = 'a'").get()).toEqual({ by: null });
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM project_whiteboard_versions").get()).toEqual({ n: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
