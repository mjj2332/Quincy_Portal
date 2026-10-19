import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0081_video_collection_on_every_project.sql";
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
function before(): SqliteDatabase {
  const db = localSqlite(); applyUpTo(db, 80);
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  return db;
}
function migrate(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}
function insertProject(db: SqliteDatabase, id: string): void {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>;
  const required = columns.filter((column) => column.notnull === 1 && column.dflt_value === null);
  const values = required.map((column) => (column.name === "id" ? id : column.type.toLowerCase().includes("int") ? NOW : column.name.endsWith("_id") ? "u1" : `${id}-${column.name}`));
  db.prepare(`INSERT INTO projects (${required.map((column) => column.name).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`).run(...values);
}

function collection(db: SqliteDatabase, projectId: string, kind: string, id = `${projectId}-${kind}`): void {
  db.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").run(id, projectId, kind, NOW, NOW);
}
const videoRows = (db: SqliteDatabase, projectId: string) => db.prepare("SELECT id, status, received_count AS receivedCount, created_at AS createdAt FROM collections WHERE project_id = ? AND kind = 'video'").all(projectId) as Array<{ id: string; status: string; receivedCount: number; createdAt: number }>;
const total = (db: SqliteDatabase) => (db.prepare("SELECT count(*) AS n FROM collections").get() as { n: number }).n;

describe("migration 0081 gives every Project a Video Collection", () => {
  it("is journaled as idx 81, data-only, with no trigger and no semicolons in comments", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code.every((statement) => /^INSERT INTO collections/.test(statement))).toBe(true);
    expect(code.join("\n")).not.toMatch(/CREATE |TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|ALTER /i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 81 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 81).map((candidate) => candidate.when)));
  });

  it("adds one video row to Projects that lack it, archived included, and leaves populated ones alone", () => {
    const db = before();
    for (const id of ["missing", "archived", "has-video"]) insertProject(db, id);
    db.prepare("UPDATE projects SET archived_at = ? WHERE id = 'archived'").run(NOW);
    collection(db, "missing", "raw"); collection(db, "archived", "raw"); collection(db, "archived", "edited"); collection(db, "has-video", "raw"); collection(db, "has-video", "video", "existing-video");
    db.prepare("UPDATE collections SET received_count = 7, status = 'received' WHERE id = 'existing-video'").run();
    insertProject(db, "no-collections");
    const beforeIds = (db.prepare("SELECT id FROM collections ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    migrate(db);
    for (const id of ["missing", "archived", "has-video", "no-collections"]) expect(videoRows(db, id), id).toHaveLength(1);
    expect(videoRows(db, "has-video")[0]).toMatchObject({ id: "existing-video", status: "received", receivedCount: 7 });
    expect(total(db)).toBe(beforeIds.length + 3);
    const afterIds = (db.prepare("SELECT id FROM collections ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    for (const id of beforeIds) expect(afterIds).toContain(id);
    expect(db.prepare("SELECT count(*) AS n FROM collections WHERE project_id = 'archived'").get()).toEqual({ n: 3 });
  });

  it("mints a distinct UUIDv4 per new row and an empty Collection", () => {
    const db = before();
    for (const id of ["a", "b", "c"]) { insertProject(db, id); collection(db, id, "raw"); }
    migrate(db);
    const ids = ["a", "b", "c"].map((id) => videoRows(db, id)[0]!);
    for (const row of ids) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(row).toMatchObject({ status: "empty", receivedCount: 0 });
      expect(row.createdAt).toBeGreaterThan(0);
    }
    expect(new Set(ids.map((row) => row.id)).size).toBe(3);
  });

  it("is a no-op when applied again", () => {
    const db = before(); insertProject(db, "a"); collection(db, "a", "raw");
    migrate(db);
    const first = total(db); const id = videoRows(db, "a")[0]!.id;
    migrate(db);
    expect(total(db)).toBe(first);
    expect(videoRows(db, "a")[0]!.id).toBe(id);
  });
});
