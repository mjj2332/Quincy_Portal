import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0068_video_review_staff.sql";
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

function migrated(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 67);
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
  db.exec("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('a1', 'c1', 'k1', 'a.mp4', 10, 'upload', 1, 1)");
  db.exec(`INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('v1', 'p1', 'c1', 'Tour', 'u1', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO guest_reviewers (id, email_normalized, created_at) VALUES ('g1', 'g@example.test', ${NOW})`);
  return db;
}

type Fields = Record<string, unknown>;
function insert(db: SqliteDatabase, table: string, fields: Fields): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

const note = (overrides: Fields): Fields => ({
  id: "n1", project_id: "p1", video_id: "v1", asset_id: "a1", author_user_id: "u1", author_role: "admin", visibility: "public",
  start_frame: 10, body: "hi", created_at: NOW, ...overrides,
});

const reservation = (overrides: Fields): Fields => ({
  id: "r1", project_id: "p1", collection_id: "c1", created_by: "u1", video_id: "v2", new_video_title: "New", version: 1, asset_id: "ra1",
  r2_key: "rk1", original_filename: "a.mp4", bytes: 100, content_type: "video/mp4", expires_at: NOW, completion_audit_id: "au1", created_at: NOW, updated_at: NOW, ...overrides,
});

describe("migration 0068 adds the staff-side video review tables (#741)", () => {
  it("is journaled as idx 68, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |INSERT INTO feature_flags/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 68 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 68).map((candidate) => candidate.when)));
  });

  it("creates all six tables", () => {
    const db = migrated();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_reviewers','videos','video_version_meta','video_upload_reservations','video_notes','video_note_markup') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["guest_reviewers", "video_note_markup", "video_notes", "video_upload_reservations", "video_version_meta", "videos"]);
  });

  it("rejects non-integer created_at and updated_at", () => {
    const db = migrated();
    expect(() => db.exec("INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('v9', 'p1', 'c1', 'T', 'u1', 'x', 1)")).toThrow();
    expect(() => insert(db, "video_upload_reservations", reservation({ updated_at: "x" }))).toThrow();
  });

  describe("video_notes constraints", () => {
    it("accepts a plain root note and a reply", () => {
      const db = migrated();
      insert(db, "video_notes", note({}));
      insert(db, "video_notes", note({ id: "n2", parent_id: "n1", start_frame: null }));
    });
    it("rejects a guest-authored internal note", () => {
      const db = migrated();
      expect(() => insert(db, "video_notes", note({ author_user_id: null, author_guest_id: "g1", author_role: "guest", visibility: "internal" }))).toThrow();
      insert(db, "video_notes", note({ author_user_id: null, author_guest_id: "g1", author_role: "guest", visibility: "public" }));
    });
    it("rejects both authors and neither author", () => {
      const db = migrated();
      expect(() => insert(db, "video_notes", note({ author_guest_id: "g1" }))).toThrow();
      expect(() => insert(db, "video_notes", note({ author_user_id: null }))).toThrow();
    });
    it("rejects a reply with start_frame and a root without start_frame", () => {
      const db = migrated();
      insert(db, "video_notes", note({}));
      expect(() => insert(db, "video_notes", note({ id: "n2", parent_id: "n1", start_frame: 5 }))).toThrow();
      expect(() => insert(db, "video_notes", note({ id: "n3", start_frame: null }))).toThrow();
    });
    it("rejects end_frame at or before start_frame", () => {
      const db = migrated();
      expect(() => insert(db, "video_notes", note({ end_frame: 10 }))).toThrow();
      expect(() => insert(db, "video_notes", note({ end_frame: 9 }))).toThrow();
      insert(db, "video_notes", note({ end_frame: 11 }));
    });
    it("rejects a duplicate (asset_id, copied_from_note_id) but allows many non-copies", () => {
      const db = migrated();
      insert(db, "video_notes", note({}));
      insert(db, "video_notes", note({ id: "n2" }));
      const copy = { copied_from_note_id: "n1", copied_from_version: 1, original_author_name: "U", original_author_role: "admin" };
      insert(db, "video_notes", note({ id: "n3", ...copy }));
      expect(() => insert(db, "video_notes", note({ id: "n4", ...copy }))).toThrow();
    });
    it("cascades a note delete to its markup", () => {
      const db = migrated();
      insert(db, "video_notes", note({}));
      insert(db, "video_note_markup", { note_id: "n1", strokes_json: "[]", created_at: NOW, updated_at: NOW });
      db.exec("DELETE FROM video_notes WHERE id = 'n1'");
      expect(db.prepare("SELECT count(*) AS n FROM video_note_markup").get()).toEqual({ n: 0 });
    });
  });

  describe("video_upload_reservations constraints", () => {
    it("rejects a second active reservation for the same video_id but allows it once the first is terminal", () => {
      const db = migrated();
      insert(db, "video_upload_reservations", reservation({}));
      expect(() => insert(db, "video_upload_reservations", reservation({ id: "r2", asset_id: "ra2", r2_key: "rk2", completion_audit_id: "au2" }))).toThrow();
      db.exec("UPDATE video_upload_reservations SET status = 'completed' WHERE id = 'r1'");
      insert(db, "video_upload_reservations", reservation({ id: "r2", asset_id: "ra2", r2_key: "rk2", completion_audit_id: "au2", version: 2, new_video_title: null }));
    });
    it("rejects bytes over 2000000000 and accepts the limit", () => {
      const db = migrated();
      expect(() => insert(db, "video_upload_reservations", reservation({ bytes: 2_000_000_001 }))).toThrow();
      insert(db, "video_upload_reservations", reservation({ bytes: 2_000_000_000 }));
    });
    it("requires a title exactly when version is 1", () => {
      const db = migrated();
      expect(() => insert(db, "video_upload_reservations", reservation({ new_video_title: null }))).toThrow();
      expect(() => insert(db, "video_upload_reservations", reservation({ version: 2 }))).toThrow();
    });
  });
});
