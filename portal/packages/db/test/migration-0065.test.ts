import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0065_embedded_media_image_dimensions.sql";
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

const insertMedia = (db: SqliteDatabase, id: string) => {
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?) ON CONFLICT(id) DO NOTHING").run(NOW, NOW);
  db.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at) VALUES (?, 'notice_post', NULL, NULL, 'u1', 'image', 'image/png', 10, ?, 'pending', ?, ?)").run(id, `notice-board/embedded-media/${id}/original`, NOW, NOW);
};
const columns = (db: SqliteDatabase) => db.prepare("SELECT name, type, \"notnull\" AS required FROM pragma_table_info('embedded_media') WHERE name IN ('width', 'height') ORDER BY name").all();

describe("migration 0065 adds the embedded image dimensions (#611)", () => {
  it("is journaled as idx 65, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim());
    expect(statements.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE |__new_|PRAGMA|UPDATE |NOT NULL|CHECK/i);
    expect(statements).toEqual(["ALTER TABLE embedded_media ADD COLUMN width integer;", "ALTER TABLE embedded_media ADD COLUMN height integer;"]);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 65 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 65).map((candidate) => candidate.when)));
  });

  it("adds two nullable columns and leaves every existing row with no size", () => {
    const db = localSqlite();
    applyThrough(db, 64);
    insertMedia(db, "old-1");
    expect(columns(db)).toEqual([]);
    applyMigration(db);
    expect(columns(db)).toEqual([{ name: "height", type: "INTEGER", required: 0 }, { name: "width", type: "INTEGER", required: 0 }]);
    expect(db.prepare("SELECT width, height FROM embedded_media WHERE id = 'old-1'").get()).toEqual({ width: null, height: null });
    db.prepare("UPDATE embedded_media SET width = 511, height = 384 WHERE id = 'old-1'").run();
    expect(db.prepare("SELECT width, height FROM embedded_media WHERE id = 'old-1'").get()).toEqual({ width: 511, height: 384 });
  });

  it("is backwards compatible: the insert an older Worker makes still works against the new schema", () => {
    const db = localSqlite();
    applyThrough(db, 65);
    insertMedia(db, "from-old-worker");
    expect(db.prepare("SELECT width, height FROM embedded_media WHERE id = 'from-old-worker'").get()).toEqual({ width: null, height: null });
  });
});
