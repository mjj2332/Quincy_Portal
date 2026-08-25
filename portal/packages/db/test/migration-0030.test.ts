import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyBaseline(db: SqliteDatabase): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 29).sort();
  for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  return names;
}

function rowNames(rows: unknown[]): string[] { return rows.map((row) => (row as { name: string }).name); }

describe("migration 0030 project comment read markers", () => {
  it("applies the complete baseline and proves exact additive shape, seeks, cascades, and safety", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    const applied = applyBaseline(db);
    expect(applied).toHaveLength(30);
    expect(applied[0]).toMatch(/^0000_/);
    expect(applied.at(-1)).toBe("0029_collection_link_positions.sql");

    const now = 1_787_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run("tb3-user-1", "TB3 User One", "tb3-user-1@example.test", now, now);
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run("tb3-user-2", "TB3 User Two", "tb3-user-2@example.test", now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").run("tb3-project-1", "TB3 Marker Lane", now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").run("tb3-project-2", "TB3 Other Lane", now, now);
    db.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("tb3-comment-1", "tb3-project-1", "tb3-user-1", "high water", '{"type":"doc","content":[{"type":"paragraph"}]}', now + 1);

    const source = readFileSync(new URL("../migrations/0030_project_comment_read_markers.sql", import.meta.url), "utf8");
    const normalized = source.replace(/\s+/g, " ").trim();
    expect(normalized).toBe("CREATE TABLE project_comment_read_markers ( user_id text NOT NULL REFERENCES user(id) ON DELETE cascade, project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade, last_read_comment_id text NOT NULL, last_read_comment_created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (user_id, project_id) ); --> statement-breakpoint CREATE INDEX project_comment_read_markers_project_idx ON project_comment_read_markers (project_id, last_read_comment_created_at);");
    expect(normalized).not.toMatch(/\bDROP TABLE\b|\bALTER TABLE\b|\bPRAGMA\b|\bCREATE TABLE\s+\S+\s+AS\b|\bINSERT INTO\s+\S+\s+SELECT\b|\bBACKFILL\b|\bCOPY\b/i);
    db.exec(source.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("PRAGMA table_info('project_comment_read_markers')").all()).toEqual([
      { cid: 0, name: "user_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "project_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: "last_read_comment_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "last_read_comment_created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    const foreignKeys = db.prepare("PRAGMA foreign_key_list('project_comment_read_markers')").all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(foreignKeys.map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }))).toEqual(expect.arrayContaining([
      { table: "user", from: "user_id", to: "id", on_delete: "CASCADE" },
      { table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" },
    ]));
    const indexes = db.prepare("PRAGMA index_list('project_comment_read_markers')").all() as Array<{ name: string; unique: number }>;
    expect(indexes.find((index) => index.name === "project_comment_read_markers_project_idx")).toMatchObject({ name: "project_comment_read_markers_project_idx", unique: 0 });
    expect(indexes.some((index) => index.unique === 1 && index.name.startsWith("sqlite_autoindex_project_comment_read_markers_"))).toBe(true);
    expect(db.prepare("PRAGMA index_info('project_comment_read_markers_project_idx')").all()).toEqual([
      { seqno: 0, cid: 1, name: "project_id" },
      { seqno: 1, cid: 3, name: "last_read_comment_created_at" },
    ]);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT last_read_comment_created_at FROM project_comment_read_markers WHERE project_id = ?").all("tb3-project-1") as Array<{ detail: string }>;
    expect(plan.some((entry) => /USING COVERING INDEX project_comment_read_markers_project_idx \(project_id=\?\)/.test(entry.detail))).toBe(true);

    db.prepare("INSERT INTO project_comment_read_markers (user_id, project_id, last_read_comment_id, last_read_comment_created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tb3-user-1", "tb3-project-1", "tb3-comment-1", now + 1, now + 2);
    expect(() => db.prepare("INSERT INTO project_comment_read_markers (user_id, project_id, last_read_comment_id, last_read_comment_created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tb3-user-1", "tb3-project-1", "tb3-comment-duplicate", now + 2, now + 3)).toThrow();
    db.prepare("INSERT INTO project_comment_read_markers (user_id, project_id, last_read_comment_id, last_read_comment_created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tb3-user-2", "tb3-project-1", "tb3-comment-1", now + 1, now + 2);
    db.prepare("INSERT INTO project_comment_read_markers (user_id, project_id, last_read_comment_id, last_read_comment_created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("tb3-user-1", "tb3-project-2", "tb3-comment-1", now + 1, now + 2);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    db.prepare("DELETE FROM project_comments WHERE id = ?").run("tb3-comment-1");
    expect(db.prepare("SELECT last_read_comment_id, last_read_comment_created_at FROM project_comment_read_markers WHERE user_id = ? AND project_id = ?").get("tb3-user-1", "tb3-project-1")).toEqual({ last_read_comment_id: "tb3-comment-1", last_read_comment_created_at: now + 1 });
    db.prepare("DELETE FROM projects WHERE id = ?").run("tb3-project-2");
    expect(db.prepare("SELECT 1 AS present FROM project_comment_read_markers WHERE project_id = ?").get("tb3-project-2")).toBeUndefined();
    db.prepare("DELETE FROM user WHERE id = ?").run("tb3-user-2");
    expect(db.prepare("SELECT 1 AS present FROM project_comment_read_markers WHERE user_id = ?").get("tb3-user-2")).toBeUndefined();
    expect(rowNames(db.prepare("PRAGMA index_list('project_comment_read_markers')").all())).toContain("project_comment_read_markers_project_idx");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
