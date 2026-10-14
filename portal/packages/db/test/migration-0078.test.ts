import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0078_video_version_review_status.sql";

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
function seed(db: SqliteDatabase): void {
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
}
function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}
describe("migration 0078 adds video_version_meta.review_status (#863)", () => {
  it("is journaled as idx 78, one additive ALTER, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code).toHaveLength(1);
    expect(code[0]).toMatch(/^ALTER TABLE video_version_meta ADD COLUMN review_status text NOT NULL DEFAULT 'in_review' CHECK/);
    expect(code.join("\n")).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |INSERT INTO/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 78 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 78).map((candidate) => candidate.when)));
  });

  it("reads in_review for every existing Version and for a new insert that omits the column", () => {
    const db = localSqlite(); applyUpTo(db, 77); seed(db);
    insertVersion(db, "a1", "v1");
    applyMigration(db);
    const info = (db.prepare("PRAGMA table_info(video_version_meta)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>).find((c) => c.name === "review_status");
    expect(info).toMatchObject({ notnull: 1, dflt_value: "'in_review'" });
    expect(db.prepare("SELECT review_status FROM video_version_meta WHERE asset_id = 'a1'").get()).toEqual({ review_status: "in_review" });
    insertVersion(db, "a2", "v1");
    expect(db.prepare("SELECT review_status FROM video_version_meta WHERE asset_id = 'a2'").get()).toEqual({ review_status: "in_review" });
  });

  it("accepts approved_internal and rejects any other value", () => {
    const db = localSqlite(); applyUpTo(db, 77); seed(db); insertVersion(db, "a1", "v1"); applyMigration(db);
    db.prepare("UPDATE video_version_meta SET review_status = 'approved_internal' WHERE asset_id = 'a1'").run();
    expect(db.prepare("SELECT review_status FROM video_version_meta").get()).toEqual({ review_status: "approved_internal" });
    expect(() => db.prepare("UPDATE video_version_meta SET review_status = 'approved' WHERE asset_id = 'a1'").run()).toThrow();
    expect(() => db.prepare("UPDATE video_version_meta SET review_status = 'published' WHERE asset_id = 'a1'").run()).toThrow();
    expect(() => db.prepare("UPDATE video_version_meta SET review_status = NULL WHERE asset_id = 'a1'").run()).toThrow();
  });
});

let counter = 0;
function insertVersion(db: SqliteDatabase, assetId: string, videoId: string): void {
  counter += 1;
  if (!db.prepare("SELECT 1 FROM collections WHERE id = 'c1'").get()) {
    db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
  }
  if (!db.prepare("SELECT 1 FROM videos WHERE id = ?").get(videoId)) {
    db.prepare("INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES (?, 'p1', 'c1', 'Tour', 'u1', 1, 1)").run(videoId);
  }
  db.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, 'c1', 'video', ?, 'a.mp4', 10, 'upload', ?, ?, 'ready', 1, 1)").run(assetId, `k-${counter}`, videoId, counter);
  db.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', 25, 0, 1, 1, 1, 'u1', 1)").run(assetId, videoId);
}
