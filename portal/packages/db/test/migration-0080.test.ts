import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0080_project_social_overlays.sql";
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
  const db = localSqlite(); applyUpTo(db, 79);
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.prepare("INSERT INTO social_overlays (id, name, platform_label, image_key, width, height, bytes, created_by, updated_by, created_at, updated_at) VALUES ('o1', 'Reel', 'Instagram', 'k1', 1080, 1920, 100, 'u1', 'u1', ?, ?)").run(NOW, NOW);
  return db;
}
function insertProject(db: SqliteDatabase, id: string): void {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>;
  const required = columns.filter((column) => column.notnull === 1 && column.dflt_value === null);
  const values = required.map((column) => (column.name === "id" ? id : column.type.toLowerCase().includes("int") ? NOW : column.name.endsWith("_id") ? "u1" : `${id}-${column.name}`));
  db.prepare(`INSERT INTO projects (${required.map((column) => column.name).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`).run(...values);
}
const join = (db: SqliteDatabase, projectId: string, overlayId: string): void => {
  db.prepare("INSERT INTO project_social_overlays (project_id, overlay_id) VALUES (?, ?)").run(projectId, overlayId);
};

describe("migration 0080 creates project_social_overlays (#870)", () => {
  it("is journaled as idx 80, additive, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code[0]).toMatch(/^CREATE TABLE project_social_overlays/);
    expect(code.slice(1).every((statement) => /^CREATE (UNIQUE )?INDEX /.test(statement))).toBe(true);
    expect(code.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |INSERT INTO/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 80 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 80).map((candidate) => candidate.when)));
  });

  it("stores one join per Project and overlay and rejects a duplicate", () => {
    const db = migrated(); insertProject(db, "p1");
    join(db, "p1", "o1");
    expect(() => join(db, "p1", "o1")).toThrow();
  });

  it("rejects joins to a Project or overlay that does not exist", () => {
    const db = migrated(); insertProject(db, "p1");
    expect(() => join(db, "ghost", "o1")).toThrow();
    expect(() => join(db, "p1", "ghost")).toThrow();
  });

  it("removes a Project's joins with the Project and leaves the overlay", () => {
    const db = migrated(); insertProject(db, "p1"); join(db, "p1", "o1");
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM project_social_overlays").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM social_overlays").get()).toEqual({ n: 1 });
  });

  it("refuses to delete an overlay that a Project still selects", () => {
    const db = migrated(); insertProject(db, "p1"); join(db, "p1", "o1");
    expect(() => db.prepare("DELETE FROM social_overlays WHERE id = 'o1'").run()).toThrow();
  });
});
