import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0062_project_whiteboard_version_media.sql";
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

function seed(db: SqliteDatabase): void {
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'S', 'editing', 0, ?, ?)").run(NOW, NOW);
}
function insertVersion(db: SqliteDatabase, id: string, ordinal: number, mediaIds?: unknown): void {
  const base = [id, "p1", `projects/p1/whiteboard/versions/${id}.json`, ordinal, 1, 1, NOW, "u1", "interval", "ab", 10, 1];
  if (mediaIds === undefined) db.prepare("INSERT INTO project_whiteboard_versions (id, project_id, r2_key, ordinal, generation, scene_revision, created_at, created_by, reason, scene_sha256, byte_count, element_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...base);
  else db.prepare("INSERT INTO project_whiteboard_versions (id, project_id, r2_key, ordinal, generation, scene_revision, created_at, created_by, reason, scene_sha256, byte_count, element_count, media_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...base, mediaIds);
}

describe("migration 0062 adds the media ids a whiteboard version references (#501)", () => {
  it("is journaled as idx 62, one ALTER TABLE ADD COLUMN, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 62 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 62).map((candidate) => candidate.when)));
  });

  it("gives every existing version an empty list, which is correct because image elements were refused until now", () => {
    const db = localSqlite();
    applyThrough(db, 61); seed(db);
    insertVersion(db, "old-1", 1); insertVersion(db, "old-2", 2);
    db.exec("BEGIN");
    for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
    expect(db.prepare("SELECT id, media_ids AS mediaIds FROM project_whiteboard_versions ORDER BY ordinal").all()).toEqual([{ id: "old-1", mediaIds: "[]" }, { id: "old-2", mediaIds: "[]" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("defaults a new row to an empty list and stores the list it is given", () => {
    const db = localSqlite();
    applyThrough(db, 62); seed(db);
    insertVersion(db, "a", 1); insertVersion(db, "b", 2, JSON.stringify(["m1", "m2"]));
    expect(db.prepare("SELECT id, media_ids AS mediaIds FROM project_whiteboard_versions ORDER BY ordinal").all()).toEqual([{ id: "a", mediaIds: "[]" }, { id: "b", mediaIds: '["m1","m2"]' }]);
    db.close();
  });

  it("refuses a value that is not a JSON array, and NULL", () => {
    const db = localSqlite();
    applyThrough(db, 62); seed(db);
    let ordinal = 1;
    for (const bad of ["not json", "", "{}", '{"a":1}', "1", '"x"', "null", "[", "true"]) {
      expect(() => insertVersion(db, `bad-${ordinal}`, ordinal++, bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => insertVersion(db, "null-1", ordinal++, null)).toThrow(/NOT NULL/i);
    expect(db.prepare("SELECT count(*) AS n FROM project_whiteboard_versions").get()).toEqual({ n: 0 });
    insertVersion(db, "ok", ordinal++, "[]");
    expect(() => db.prepare("UPDATE project_whiteboard_versions SET media_ids = 'oops' WHERE id = 'ok'").run()).toThrow();
    db.close();
  });

  it("reads back through json_each: the kept set the reconcile subquery builds", () => {
    const db = localSqlite();
    applyThrough(db, 62); seed(db);
    insertVersion(db, "a", 1, JSON.stringify(["m1", "m2"])); insertVersion(db, "b", 2, JSON.stringify(["m2", "m3"])); insertVersion(db, "c", 3, "[]");
    db.prepare("UPDATE project_whiteboard_versions SET state = 'pruning' WHERE id = 'a'").run();
    const kept = db.prepare("SELECT DISTINCT j.value AS id FROM project_whiteboard_versions v, json_each(v.media_ids) j WHERE v.project_id = ? AND v.state = 'ready' ORDER BY j.value").all("p1");
    expect(kept).toEqual([{ id: "m2" }, { id: "m3" }]);
    db.close();
  });
});
