import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0070_video_trash.sql";
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

/** Applies 0070 statement by statement with foreign_keys=ON throughout (D1 does not honour a PRAGMA toggle). */
function apply0070(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

function asset(db: SqliteDatabase, id: string, fields: { kind: string; version: number; group: string | null }): void {
  db.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, kind, version, version_group_id, created_at, updated_at) VALUES (?, 'c1', ?, 'a.mp4', 10, 'upload', ?, ?, ?, 1, 1)").run(id, `k-${id}`, fields.kind, fields.version, fields.group);
}

function meta(db: SqliteDatabase, assetId: string, videoId: string): void {
  db.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, uploaded_by, created_at) VALUES (?, ?, 30, 1, 30000, 1000, 300, 10000, 1920, 1080, 'avc1', 'avc1.64001f', 30, 0, 1, 1, 1, 'u1', ?)").run(assetId, videoId, NOW);
}

/** A populated 0069 database: v1 has versions 1 and 3 (a gap), v2 has none, v3 has a photo asset sharing its group and a version 2. */
function legacy(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 69);
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
  for (const id of ["v1", "v2", "v3"]) {
    db.exec(`INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('${id}', 'p1', 'c1', 'T ${id}', 'u1', ${NOW}, ${NOW})`);
  }
  asset(db, "a1", { kind: "video", version: 1, group: "v1" });
  asset(db, "a3", { kind: "video", version: 3, group: "v1" });
  asset(db, "a-photo", { kind: "photo", version: 9, group: "v3" });
  asset(db, "a-v3", { kind: "video", version: 2, group: "v3" });
  asset(db, "a-other", { kind: "video", version: 7, group: "elsewhere" });
  meta(db, "a1", "v1");
  meta(db, "a3", "v1");
  db.exec(`INSERT INTO guest_reviewers (id, email_normalized, created_at) VALUES ('g1', 'g@example.test', ${NOW})`);
  return db;
}

function sqlCode(): string {
  const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
  return sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
}

const columns = (db: SqliteDatabase, table: string) => db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt FROM pragma_table_info('${table}')`).all() as Array<{ name: string; type: string; nn: number; dflt: string | null }>;
const column = (db: SqliteDatabase, table: string, name: string) => columns(db, table).find((value) => value.name === name);

describe("migration 0070 adds the video Trash columns (#776 slice A)", () => {
  it("is journaled as idx 70, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sqlCode();
    expect(code).not.toMatch(/CREATE TRIGGER|CREATE TABLE|DROP |DELETE FROM|__new_|PRAGMA|RENAME|INSERT INTO/i);
    const statements = code.split("\n").filter((line) => line.trim() !== "");
    // Every statement is an ADD COLUMN, a backfill UPDATE of the new column, or a partial CREATE INDEX.
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.split("\n").filter((line) => !line.startsWith("--")).join(" ").trim().replace(/;$/, "")).filter(Boolean)) {
      expect(statement, statement).toMatch(/^(ALTER TABLE (videos|video_version_meta) ADD COLUMN |UPDATE videos SET version_high_water = |CREATE INDEX \w+ ON \w+ \([^)]*\) WHERE \w+ IS NOT NULL$)/);
    }
    expect(statements.length).toBeGreaterThan(0);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 70 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 70).map((candidate) => candidate.when)));
  });

  it("adds the columns with the specified types, nullability and defaults, under foreign_keys=ON", () => {
    const db = legacy();
    apply0070(db);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    for (const table of ["videos", "video_version_meta"]) {
      expect(column(db, table, "removed_at")).toMatchObject({ type: "INTEGER", nn: 0, dflt: null });
      expect(column(db, table, "removed_by")).toMatchObject({ type: "TEXT", nn: 0, dflt: null });
      expect(column(db, table, "purge_at")).toMatchObject({ type: "INTEGER", nn: 0, dflt: null });
    }
    expect(column(db, "videos", "version_high_water")).toMatchObject({ type: "INTEGER", nn: 1, dflt: "0" });
    expect(column(db, "video_version_meta", "removed_with_video")).toMatchObject({ type: "INTEGER", nn: 1, dflt: "0" });
    expect(column(db, "videos", "removed_with_video")).toBeUndefined();
    expect(column(db, "video_version_meta", "version_high_water")).toBeUndefined();
  });

  it("backfills version_high_water with the highest video-kind version sharing the group, and 0 where there is none", () => {
    const db = legacy();
    apply0070(db);
    const rows = db.prepare("SELECT id, version_high_water AS hw FROM videos ORDER BY id").all();
    expect(rows).toEqual([{ id: "v1", hw: 3 }, { id: "v2", hw: 0 }, { id: "v3", hw: 2 }]);
  });

  it("leaves existing rows live and unchanged apart from the new columns (0068 and 0069 data survive)", () => {
    const db = legacy();
    db.exec(`INSERT INTO client_links (id, project_id, token_hash, expires_at, created_at, kind, created_by, updated_at) VALUES ('l1', 'p1', 'th1', ${NOW + 1000}, ${NOW}, 'video_review', 'u1', ${NOW})`);
    db.exec(`INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) VALUES ('m1', 'l1', 'v1', 'p1', 'u1', ${NOW})`);
    db.exec(`INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) VALUES ('gr1', 'l1', 'v1', 'a1', 'u1', ${NOW})`);
    const before = {
      videos: db.prepare("SELECT id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at FROM videos ORDER BY id").all(),
      meta: db.prepare("SELECT asset_id, video_id, fps_num, width, codec, uploaded_by, created_at FROM video_version_meta ORDER BY asset_id").all(),
    };
    apply0070(db);
    expect(db.prepare("SELECT id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at FROM videos ORDER BY id").all()).toEqual(before.videos);
    expect(db.prepare("SELECT asset_id, video_id, fps_num, width, codec, uploaded_by, created_at FROM video_version_meta ORDER BY asset_id").all()).toEqual(before.meta);
    expect(db.prepare("SELECT count(*) AS n FROM videos WHERE removed_at IS NULL AND removed_by IS NULL AND purge_at IS NULL").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT count(*) AS n FROM video_version_meta WHERE removed_at IS NULL AND removed_by IS NULL AND purge_at IS NULL AND removed_with_video = 0").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM review_link_videos").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM review_link_version_grants").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM guest_reviewers").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces the removed_by foreign key on both tables, which ADD COLUMN accepted", () => {
    const db = legacy();
    apply0070(db);
    for (const table of ["videos", "video_version_meta"]) {
      const keys = db.prepare(`SELECT "from" AS col, "table" AS parent, "to" AS target FROM pragma_foreign_key_list('${table}') WHERE "from" = 'removed_by'`).all();
      expect(keys, table).toEqual([{ col: "removed_by", parent: "user", target: "id" }]);
    }
    expect(() => db.exec(`UPDATE videos SET removed_at = ${NOW}, removed_by = 'nobody', purge_at = ${NOW + 1} WHERE id = 'v1'`)).toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`UPDATE video_version_meta SET removed_at = ${NOW}, removed_by = 'nobody', purge_at = ${NOW + 1} WHERE asset_id = 'a1'`)).toThrow(/FOREIGN KEY/);
    db.exec(`UPDATE videos SET removed_at = ${NOW}, removed_by = 'u1', purge_at = ${NOW + 1} WHERE id = 'v1'`);
    db.exec(`UPDATE video_version_meta SET removed_at = ${NOW}, removed_by = 'u1', purge_at = ${NOW + 1}, removed_with_video = 1 WHERE asset_id = 'a1'`);
    expect(db.prepare("SELECT removed_by, purge_at FROM videos WHERE id = 'v1'").get()).toEqual({ removed_by: "u1", purge_at: NOW + 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects non-integer timestamps, a negative high-water mark and a removed_with_video outside 0 and 1", () => {
    const db = legacy();
    apply0070(db);
    for (const table of ["videos", "video_version_meta"]) {
      const key = table === "videos" ? "id = 'v1'" : "asset_id = 'a1'";
      expect(() => db.exec(`UPDATE ${table} SET removed_at = 'yesterday' WHERE ${key}`), `${table}.removed_at`).toThrow(/CHECK/);
      expect(() => db.exec(`UPDATE ${table} SET removed_at = 1.5 WHERE ${key}`), `${table}.removed_at real`).toThrow(/CHECK/);
      expect(() => db.exec(`UPDATE ${table} SET purge_at = 'soon' WHERE ${key}`), `${table}.purge_at`).toThrow(/CHECK/);
      expect(() => db.exec(`UPDATE ${table} SET purge_at = ${NOW} WHERE ${key}`), `${table}.purge_at ok`).not.toThrow();
      expect(() => db.exec(`UPDATE ${table} SET purge_at = NULL WHERE ${key}`), `${table}.purge_at null`).not.toThrow();
    }
    expect(() => db.exec("UPDATE videos SET version_high_water = -1 WHERE id = 'v1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE video_version_meta SET removed_with_video = 2 WHERE asset_id = 'a1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE video_version_meta SET removed_with_video = 1 WHERE asset_id = 'a1'")).not.toThrow();
    expect(() => db.exec("UPDATE videos SET version_high_water = 9 WHERE id = 'v1'")).not.toThrow();
  });

  it("creates the four partial indexes on the removed and purge columns", () => {
    const db = legacy();
    apply0070(db);
    const indexes = db.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND name IN ('videos_project_removed_idx', 'videos_purge_idx', 'video_version_meta_removed_idx', 'video_version_meta_purge_idx') ORDER BY name").all() as Array<{ name: string; tbl: string; sql: string }>;
    expect(indexes.map((row) => [row.name, row.tbl])).toEqual([
      ["video_version_meta_purge_idx", "video_version_meta"],
      ["video_version_meta_removed_idx", "video_version_meta"],
      ["videos_project_removed_idx", "videos"],
      ["videos_purge_idx", "videos"],
    ]);
    const norm = (value: string) => value.replace(/\s+/g, " ");
    expect(norm(indexes[0]!.sql)).toContain("(purge_at) WHERE purge_at IS NOT NULL");
    expect(norm(indexes[1]!.sql)).toContain("(removed_at) WHERE removed_at IS NOT NULL");
    expect(norm(indexes[2]!.sql)).toContain("(project_id, removed_at) WHERE removed_at IS NOT NULL");
    expect(norm(indexes[3]!.sql)).toContain("(purge_at) WHERE purge_at IS NOT NULL");
  });
});
