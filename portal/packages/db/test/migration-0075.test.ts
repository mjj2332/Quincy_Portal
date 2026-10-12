import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0075_video_note_rich_media.sql";
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

/** Applies 0075 statement by statement with foreign_keys=ON throughout and no PRAGMA (D1 does not honour a toggle). */
function apply0075(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

type Fields = Record<string, unknown>;
function insert(db: SqliteDatabase, table: string, fields: Fields): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

const media = (overrides: Fields = {}): Fields => ({
  id: "em1", owner_kind: "project_comment", owner_id: "owner1", project_id: "p1", uploader_id: "u1", kind: "image", content_type: "image/png", bytes: 10,
  original_key: "k-em1", state: "attached", created_at: NOW, updated_at: NOW, ...overrides,
});

/** A populated 0074 database: one row of each of the 3 existing owner kinds, plus link previews pointing at them. */
function legacy(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 74);
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
  db.exec("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('a1', 'c1', 'k1', 'a.mp4', 10, 'upload', 1, 1)");
  db.exec(`INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('v1', 'p1', 'c1', 'Tour', 'u1', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO guest_reviewers (id, email_normalized, created_at) VALUES ('g1', 'g@example.test', ${NOW})`);
  insert(db, "embedded_media", media());
  insert(db, "embedded_media", media({ id: "em2", owner_kind: "notice_post", project_id: null, original_key: "k-em2", kind: "preview_image", width: 640, height: 480 }));
  insert(db, "embedded_media", media({ id: "em3", owner_kind: "whiteboard", original_key: "k-em3", state: "detached", detached_at: NOW, display_key: "d3", rendition_status: "ready", display_width: 5 }));
  db.exec(`INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, image_media_id, created_at, updated_at) VALUES ('lp1', 'project_comment', 'owner1', 'p1', 'u1', 'https://a.test', 'em1', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, image_media_id, created_at, updated_at) VALUES ('lp2', 'notice_post', 'o2', NULL, 'u1', 'https://b.test', 'em2', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, image_media_id, created_at, updated_at) VALUES ('lp3', 'project_comment', 'owner1', 'p1', 'u1', 'https://c.test', NULL, ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO video_notes (id, project_id, video_id, asset_id, author_user_id, author_role, visibility, start_frame, body, created_at) VALUES ('n1', 'p1', 'v1', 'a1', 'u1', 'admin', 'public', 0, 'hello', ${NOW})`);
  return db;
}

describe("migration 0075 rebuilds embedded_media for video notes (#835)", () => {
  it("is journaled as idx 75, uses no PRAGMA or __new_ name, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|__new_|PRAGMA|legacy_alter_table|INSERT INTO feature_flags/i);
    expect(code.match(/DROP TABLE \w+/gi)).toEqual(["DROP TABLE embedded_media"]);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 75 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 75).map((candidate) => candidate.when)));
  });

  describe("applied over a populated 0074 database with foreign_keys=ON", () => {
    it("keeps every row, every column value and every link_previews.image_media_id, with an empty foreign_key_check", () => {
      const db = legacy();
      const before = db.prepare("SELECT * FROM embedded_media ORDER BY id").all();
      apply0075(db);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      const after = (db.prepare("SELECT * FROM embedded_media ORDER BY id").all() as Fields[]).map((row) => {
        const { uploader_guest_id, ...rest } = row;
        expect(uploader_guest_id).toBeNull();
        return rest;
      });
      expect(after).toEqual(before);
      expect(count(db, "SELECT count(*) AS n FROM embedded_media")).toBe(3);
      expect(db.prepare("SELECT id, image_media_id FROM link_previews ORDER BY id").all()).toEqual([
        { id: "lp1", image_media_id: "em1" }, { id: "lp2", image_media_id: "em2" }, { id: "lp3", image_media_id: null },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect((db.prepare("PRAGMA table_info(link_previews)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("image_media_id_0075");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_0075%'").all()).toEqual([]);
    });

    it("still enforces the SET NULL link between link_previews and the rebuilt table", () => {
      const db = legacy();
      apply0075(db);
      db.exec("DELETE FROM embedded_media WHERE id = 'em1'");
      expect(db.prepare("SELECT image_media_id FROM link_previews WHERE id = 'lp1'").get()).toEqual({ image_media_id: null });
    });

    it("recreates all seven indexes by name", () => {
      const db = legacy();
      apply0075(db);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'embedded_media' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual([
        "embedded_media_original_key_unique", "embedded_media_owner_idx", "embedded_media_project_idx", "embedded_media_rendition_idx",
        "embedded_media_state_created_idx", "embedded_media_state_detached_idx", "embedded_media_uploader_guest_idx",
      ]);
    });

    it("admits video_note and guest uploaders and refuses the invalid shapes, while old kinds still insert", () => {
      const db = legacy();
      apply0075(db);
      insert(db, "embedded_media", media({ id: "n-ok", owner_kind: "video_note", owner_id: "n1", original_key: "k-n-ok" }));
      insert(db, "embedded_media", media({ id: "g-ok", owner_kind: "video_note", uploader_id: null, uploader_guest_id: "g1", state: "pending", owner_id: null, original_key: "k-g-ok" }));
      insert(db, "embedded_media", media({ id: "old1", owner_kind: "project_comment", original_key: "k-old1" }));
      insert(db, "embedded_media", media({ id: "old2", owner_kind: "notice_post", project_id: null, original_key: "k-old2" }));
      insert(db, "embedded_media", media({ id: "old3", owner_kind: "whiteboard", original_key: "k-old3" }));
      expect(() => insert(db, "embedded_media", media({ id: "x1", owner_kind: "video_note", project_id: null, original_key: "k-x1" }))).toThrow(/CHECK/);
      expect(() => insert(db, "embedded_media", media({ id: "x2", uploader_id: null, uploader_guest_id: null, original_key: "k-x2" }))).toThrow(/CHECK/);
      expect(() => insert(db, "embedded_media", media({ id: "x3", uploader_guest_id: "g1", original_key: "k-x3" }))).toThrow(/CHECK/);
      expect(() => insert(db, "embedded_media", media({ id: "x4", uploader_id: null, uploader_guest_id: "nope", original_key: "k-x4" }))).toThrow(/FOREIGN KEY/);
      expect(() => insert(db, "embedded_media", media({ id: "x5", owner_kind: "bogus", original_key: "k-x5" }))).toThrow(/CHECK/);
      expect(() => insert(db, "embedded_media", media({ id: "x6", original_key: "k-em1" }))).toThrow(/UNIQUE/);
      expect(() => insert(db, "embedded_media", media({ id: "x7", state: "uploading", original_key: "k-x7" }))).toThrow(/CHECK/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("adds video_notes.content_json (nullable, at most 32768 bytes) and leaves legacy notes alone", () => {
      const db = legacy();
      apply0075(db);
      expect(db.prepare("SELECT body, content_json FROM video_notes WHERE id = 'n1'").get()).toEqual({ body: "hello", content_json: null });
      db.prepare("UPDATE video_notes SET content_json = ? WHERE id = 'n1'").run("a".repeat(32768));
      expect(() => db.prepare("UPDATE video_notes SET content_json = ? WHERE id = 'n1'").run("a".repeat(32769))).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE video_notes SET content_json = ? WHERE id = 'n1'").run("é".repeat(16385))).toThrow(/CHECK/);
    });

    it("creates video_note_mentions: unique per note and person, cascading with the note", () => {
      const db = legacy();
      apply0075(db);
      insert(db, "video_note_mentions", { id: "m1", note_id: "n1", mentioned_user_id: "u1", created_at: NOW });
      expect(() => insert(db, "video_note_mentions", { id: "m2", note_id: "n1", mentioned_user_id: "u1", created_at: NOW })).toThrow(/UNIQUE/);
      expect(() => insert(db, "video_note_mentions", { id: "m3", note_id: "missing", mentioned_user_id: "u1", created_at: NOW })).toThrow(/FOREIGN KEY/);
      expect(() => insert(db, "video_note_mentions", { id: "m4", note_id: "n1", mentioned_user_id: "ghost", created_at: NOW })).toThrow(/FOREIGN KEY/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'video_note_mentions' AND name NOT LIKE 'sqlite_autoindex%'").all()).toEqual([{ name: "video_note_mentions_user_idx" }]);
      db.exec("DELETE FROM video_notes WHERE id = 'n1'");
      expect(count(db, "SELECT count(*) AS n FROM video_note_mentions")).toBe(0);
    });
  });
});
