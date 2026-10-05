import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0060_link_previews.sql";
const CHECK_FAILED = /CHECK constraint failed/i;
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

type Row = Partial<{ id: string; owner_kind: string; owner_id: string | null; project_id: string | null; image_media_id: string | null; created_at: number }>;
function insert(db: SqliteDatabase, row: Row = {}): void {
  const value = { id: "l1", owner_kind: "project_comment", owner_id: null, project_id: "p1", image_media_id: null, created_at: NOW, ...row };
  db.prepare("INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, title, description, site_name, image_media_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'u1', 'https://example.com/', 'T', 'D', 'S', ?, ?, ?)")
    .run(value.id, value.owner_kind, value.owner_id, value.project_id, value.image_media_id, value.created_at, value.created_at);
}

function seeded(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 60);
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'S', 'editing', 0, ?, ?)").run(NOW, NOW);
  return db;
}

describe("migration 0060 adds link previews (#497)", () => {
  it("is journaled, adds a table and indexes only, and has no trigger or semicolon in a comment", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((item) => item.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(60);
  });

  it("applies on top of 0059 as a plain batch and creates no rows", () => {
    const db = localSqlite();
    applyThrough(db, 59);
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    db.exec("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) db.exec(statement);
    db.exec("COMMIT");
    expect(db.prepare("SELECT count(*) AS n FROM link_previews").get()).toEqual({ n: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("holds a pending preview with no owner or an owned one, for a comment or a notice", () => {
    const db = seeded();
    insert(db, { id: "pending" });
    insert(db, { id: "owned", owner_id: "c1" });
    insert(db, { id: "notice", owner_kind: "notice_post", owner_id: "n1", project_id: null });
    insert(db, { id: "notice-pending", owner_kind: "notice_post", project_id: null });
    expect(db.prepare("SELECT count(*) AS n FROM link_previews").get()).toEqual({ n: 4 });
    db.close();
  });

  it("ties a Project to a comment preview and none to a Notice board preview", () => {
    const db = seeded();
    expect(() => insert(db, { id: "a", owner_kind: "notice_post", project_id: "p1" })).toThrow(CHECK_FAILED);
    expect(() => insert(db, { id: "b", owner_kind: "project_comment", project_id: null })).toThrow(CHECK_FAILED);
    expect(() => insert(db, { id: "c", owner_kind: "whiteboard" })).toThrow(CHECK_FAILED);
    db.close();
  });

  it("requires a requester that exists and a url", () => {
    const db = seeded();
    expect(() => db.prepare("INSERT INTO link_previews (id, owner_kind, project_id, requester_id, url, created_at, updated_at) VALUES ('x', 'project_comment', 'p1', 'nobody', 'https://e.com/', ?, ?)").run(NOW, NOW)).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare("INSERT INTO link_previews (id, owner_kind, project_id, requester_id, created_at, updated_at) VALUES ('x', 'project_comment', 'p1', 'u1', ?, ?)").run(NOW, NOW)).toThrow(/NOT NULL/i);
    db.close();
  });

  it("is removed with its Project by the cascade", () => {
    const db = seeded();
    insert(db, { id: "a" });
    insert(db, { id: "b", owner_id: "c1" });
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM link_previews").get()).toEqual({ n: 0 });
    db.close();
  });

  it("clears its image reference, keeping the preview, when the image row goes", () => {
    const db = seeded();
    db.prepare("INSERT INTO embedded_media (id, owner_kind, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at) VALUES ('m1', 'project_comment', 'p1', 'u1', 'preview_image', 'image/png', 10, 'k', 'pending', ?, ?)").run(NOW, NOW);
    insert(db, { id: "a", image_media_id: "m1" });
    db.prepare("DELETE FROM embedded_media WHERE id = 'm1'").run();
    expect(db.prepare("SELECT id, image_media_id FROM link_previews").all()).toEqual([{ id: "a", image_media_id: null }]);
    db.close();
  });

  it("has indexes for the rate limit, the owner lookup and the unowned sweep", () => {
    const db = seeded();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'link_previews'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["link_previews_requester_created_idx", "link_previews_owner_idx", "link_previews_pending_idx"]));
    db.close();
  });

  describe("link_preview_attempts, the durable count behind the hourly limit", () => {
    const attempt = (db: SqliteDatabase, id: string, status: string, url = "https://e.com/a", kind = "project_comment", context = "p1") =>
      db.prepare("INSERT INTO link_preview_attempts (id, requester_id, owner_kind, context_id, url, status, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?, ?, ?)").run(id, kind, context, url, status, NOW, NOW);

    it("lets one fetch per person, place and address be in flight, and any number finish", () => {
      const db = seeded();
      attempt(db, "a1", "fetching");
      expect(() => attempt(db, "a2", "fetching")).toThrow(/UNIQUE/i);
      attempt(db, "a3", "fetching", "https://e.com/b");
      attempt(db, "a4", "fetching", "https://e.com/a", "notice_post", "notice_board");
      db.prepare("UPDATE link_preview_attempts SET status = 'done' WHERE id = 'a1'").run();
      attempt(db, "a5", "fetching");
      attempt(db, "a6", "failed");
      attempt(db, "a7", "done");
      db.close();
    });

    it("is not removed with a Project or a preview, so deleting a card does not give back a fetch", () => {
      const db = seeded();
      insert(db, { id: "l9" });
      attempt(db, "a1", "done");
      db.prepare("DELETE FROM link_previews WHERE id = 'l9'").run();
      db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
      expect(db.prepare("SELECT count(*) AS n FROM link_preview_attempts").get()).toEqual({ n: 1 });
      db.close();
    });

    it("checks its kind and status, and needs a requester that exists", () => {
      const db = seeded();
      expect(() => attempt(db, "x", "waiting")).toThrow(CHECK_FAILED);
      expect(() => attempt(db, "y", "done", "https://e.com/a", "whiteboard")).toThrow(CHECK_FAILED);
      expect(() => db.prepare("INSERT INTO link_preview_attempts (id, requester_id, owner_kind, context_id, url, status, created_at, updated_at) VALUES ('z', 'nobody', 'project_comment', 'p1', 'u', 'done', ?, ?)").run(NOW, NOW)).toThrow(/FOREIGN KEY/i);
      db.close();
    });

    it("is indexed for the hourly count and the sweep", () => {
      const db = seeded();
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'link_preview_attempts'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual(expect.arrayContaining(["link_preview_attempts_requester_created_idx", "link_preview_attempts_created_idx", "link_preview_attempts_in_flight_idx"]));
      db.close();
    });
  });
});
