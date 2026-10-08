import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0067_project_activity_via.sql";
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

const insertActivity = (db: SqliteDatabase, id: string, via: string | null | undefined) =>
  db.prepare(`INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at${via === undefined ? "" : ", via_client"})
    VALUES (?, 1, 'project.comment.created', 'comment', 'p1', 'user', 'u1', ?, 'project_comment', ?, ?, '{}', 'project', '/projects/p1', ?${via === undefined ? "" : ", ?"})`)
    .run(...[id, NOW, id, `project-comment:${id}:created`, NOW, ...(via === undefined ? [] : [via])]);

describe("migration 0067 adds project_activity_events.via_client (#704)", () => {
  it("is journaled as idx 67, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE /i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 67 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 67).map((candidate) => candidate.when)));
  });

  it("adds a nullable TEXT via_client column and leaves existing rows NULL", () => {
    const db = localSqlite();
    applyThrough(db, 66);
    db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
    db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
    insertActivity(db, "before", undefined);
    applyMigration(db);
    expect(db.prepare("SELECT name, type, \"notnull\" AS required FROM pragma_table_info('project_activity_events') WHERE name = 'via_client'").get()).toEqual({ name: "via_client", type: "TEXT", required: 0 });
    expect(db.prepare("SELECT via_client FROM project_activity_events WHERE id = 'before'").get()).toEqual({ via_client: null });
    insertActivity(db, "browser", undefined);
    insertActivity(db, "mcp", "Claude");
    expect(db.prepare("SELECT id, via_client FROM project_activity_events WHERE id IN ('browser', 'mcp') ORDER BY id").all()).toEqual([{ id: "browser", via_client: null }, { id: "mcp", via_client: "Claude" }]);
  });
});
