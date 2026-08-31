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
  const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 38).sort();
  for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  return names;
}

describe("migration 0039 notice board read markers", () => {
  it("applies the complete baseline and proves exact additive shape, seeks, cascades, and safety", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    const applied = applyBaseline(db);
    expect(applied).toHaveLength(39);
    expect(applied[0]).toMatch(/^0000_/);
    expect(applied.at(-1)).toBe("0038_project_activity_feed_index.sql");

    const now = 1_788_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run("tb7-user-1", "TB7 User One", "tb7-user-1@example.test", now, now);
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)").run("tb7-user-2", "TB7 User Two", "tb7-user-2@example.test", now, now);
    const postId = "tb7-post-1";
    db.prepare("INSERT INTO notice_board_posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)").run(postId, "tb7-user-1", "high water", now + 1);

    const source = readFileSync(new URL("../migrations/0039_notice_board_read_markers.sql", import.meta.url), "utf8");
    const normalized = source.replace(/\s+/g, " ").trim();
    expect(normalized).toBe("CREATE TABLE notice_board_read_markers ( user_id text NOT NULL REFERENCES user(id) ON DELETE cascade, last_read_post_id text NOT NULL, last_read_post_created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (user_id) );");
    expect(normalized).not.toMatch(/\bDROP TABLE\b|\bALTER TABLE\b|\bPRAGMA\b|\bCREATE TABLE\s+\S+\s+AS\b|\bINSERT INTO\s+\S+\s+SELECT\b|\bBACKFILL\b|\bCOPY\b/i);
    db.exec(source);

    expect(db.prepare("PRAGMA table_info('notice_board_read_markers')").all()).toEqual([
      { cid: 0, name: "user_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "last_read_post_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "last_read_post_created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(db.prepare("PRAGMA foreign_key_list('notice_board_read_markers')").all()).toEqual([
      { id: 0, seq: 0, table: "user", from: "user_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE", match: "NONE" },
    ]);
    const indexes = db.prepare("PRAGMA index_list('notice_board_read_markers')").all() as Array<{ name: string; unique: number; origin: string }>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatchObject({ unique: 1, origin: "pk" });
    expect(db.prepare("PRAGMA index_info('sqlite_autoindex_notice_board_read_markers_1')").all()).toEqual([
      { seqno: 0, cid: 0, name: "user_id" },
    ]);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT last_read_post_created_at FROM notice_board_read_markers WHERE user_id = ?").all("tb7-user-1") as Array<{ detail: string }>;
    expect(plan.some((entry) => /USING INDEX sqlite_autoindex_notice_board_read_markers_1 \(user_id=\?\)/.test(entry.detail))).toBe(true);

    db.prepare("INSERT INTO notice_board_read_markers (user_id, last_read_post_id, last_read_post_created_at, updated_at) VALUES (?, ?, ?, ?)").run("tb7-user-1", postId, now + 1, now + 2);
    expect(() => db.prepare("INSERT INTO notice_board_read_markers (user_id, last_read_post_id, last_read_post_created_at, updated_at) VALUES (?, ?, ?, ?)").run("tb7-user-1", "tb7-post-duplicate", now + 2, now + 3)).toThrow();
    db.prepare("INSERT INTO notice_board_read_markers (user_id, last_read_post_id, last_read_post_created_at, updated_at) VALUES (?, ?, ?, ?)").run("tb7-user-2", "deleted-post-id", now + 10, now + 11);
    expect(() => db.prepare("INSERT INTO notice_board_read_markers (user_id, last_read_post_id, last_read_post_created_at, updated_at) VALUES (?, ?, ?, ?)").run("missing-user", postId, now + 20, now + 21)).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    db.prepare("DELETE FROM notice_board_posts WHERE id = ?").run(postId);
    expect(db.prepare("SELECT last_read_post_id, last_read_post_created_at FROM notice_board_read_markers WHERE user_id = ?").get("tb7-user-1")).toEqual({ last_read_post_id: postId, last_read_post_created_at: now + 1 });
    db.prepare("DELETE FROM user WHERE id = ?").run("tb7-user-2");
    expect(db.prepare("SELECT 1 AS present FROM notice_board_read_markers WHERE user_id = ?").get("tb7-user-2")).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
