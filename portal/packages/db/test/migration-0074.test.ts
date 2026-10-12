import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FILM_TITLE_CASES } from "../../shared/src/testing/film-title-cases";
import { FILM_TITLE_SQL } from "../../../workers/app/src/lib/video-live-sql";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0074_film_title_from_latest_version.sql";
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
const migrationText = () => readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
function applyMigration(db: SqliteDatabase): number {
  let changes = 0;
  db.exec("BEGIN");
  for (const statement of migrationText().split("--> statement-breakpoint")) {
    const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
    if (code) changes += Number(db.prepare(code.replace(/;$/, "")).run().changes);
  }
  db.exec("COMMIT");
  return changes;
}
function seed(db: SqliteDatabase): void {
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
}
/** A Video with one Version per file name (the last the newest) and its stored title. `removed` marks Versions (by index) and the Video itself as in Trash. */
function film(db: SqliteDatabase, id: string, title: string, names: string[], removed: { video?: boolean; versions?: number[] } = {}): void {
  db.prepare("INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at, removed_at) VALUES (?, 'p1', 'c1', ?, 'u1', ?, ?, ?)").run(id, title, NOW, NOW, removed.video ? NOW : null);
  names.forEach((name, index) => {
    const asset = `${id}-a${index + 1}`;
    db.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, 'c1', 'video', ?, ?, 10, 'upload', ?, ?, 'ready', ?, ?)").run(asset, `k-${asset}`, name, id, index + 1, NOW, NOW);
    db.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, uploaded_by, created_at, removed_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', 25, 0, 1, 1, 1, 'u1', ?, ?)").run(asset, id, NOW, removed.versions?.includes(index) ? NOW : null);
  });
}
const titleOf = (db: SqliteDatabase, id: string) => (db.prepare("SELECT title FROM videos WHERE id = ?").get(id) as { title: string }).title;

describe("migration 0074 retitles every film from its latest live Version (#828)", () => {
  it("is journaled as idx 74, one data-only UPDATE, and keeps the worker harness's splitting rules", () => {
    const sql = migrationText();
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).filter(Boolean);
    expect(code).toHaveLength(1);
    expect(code[0]).toMatch(/^UPDATE videos SET title = /);
    expect(code.join("\n")).not.toMatch(/CREATE |ALTER |DROP |DELETE FROM|__new_|PRAGMA|INSERT INTO/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 74 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 74).map((candidate) => candidate.when)));
  });

  it("carries the rule text of FILM_TITLE_SQL, so the backfill and the live recompute cannot drift", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(flat(migrationText())).toContain(flat(FILM_TITLE_SQL("ta.original_filename")));
  });

  it("titles a live film from the newest live Version, ignoring a Version in Trash, and leaves a Video in Trash alone", () => {
    const db = localSqlite(); applyUpTo(db, 73); seed(db);
    film(db, "v-one", "Typed by hand", ["Kitchen.mp4"]);
    film(db, "v-many", "Typed by hand", ["Alpha.mp4", "Beta.MOV ", "Gamma.mp4"]);
    film(db, "v-newest-gone", "Typed by hand", ["Alpha.mp4", "Beta.mp4", "Gamma.mp4"], { versions: [2] });
    film(db, "v-no-live", "Kept title", ["Alpha.mp4"], { versions: [0] });
    film(db, "v-trashed", "Frozen title", ["Alpha.mp4", "Beta.mp4"], { video: true });
    film(db, "v-empty", "Only an extension", [".mp4"]);
    film(db, "v-nothing", "No Versions at all", []);
    applyMigration(db);
    expect(titleOf(db, "v-one")).toBe("Kitchen");
    expect(titleOf(db, "v-many")).toBe("Gamma");
    expect(titleOf(db, "v-newest-gone")).toBe("Beta");
    expect(titleOf(db, "v-no-live")).toBe("Kept title");
    expect(titleOf(db, "v-trashed")).toBe("Frozen title");
    expect(titleOf(db, "v-empty")).toBe("Untitled film");
    expect(titleOf(db, "v-nothing")).toBe("No Versions at all");
  });

  it("falls back past a trashed newest Version", () => {
    const db = localSqlite(); applyUpTo(db, 73); seed(db);
    film(db, "v1", "Typed", ["Alpha.mp4", "Beta.mp4", "Gamma.mp4"], { versions: [2] });
    applyMigration(db);
    expect(titleOf(db, "v1")).toBe("Beta");
  });

  it("is idempotent: a second run changes no row", () => {
    const db = localSqlite(); applyUpTo(db, 73); seed(db);
    film(db, "v1", "Typed", ["Alpha.mp4", "Beta.mp4"]); film(db, "v2", "Typed", ["Other.mov"]);
    expect(applyMigration(db)).toBe(2);
    expect(applyMigration(db)).toBe(0);
    expect(titleOf(db, "v1")).toBe("Beta"); expect(titleOf(db, "v2")).toBe("Other");
  });

  it("satisfies the title CHECK (1 to 200 characters after trim) for every case in the shared table", () => {
    const db = localSqlite(); applyUpTo(db, 73); seed(db);
    FILM_TITLE_CASES.forEach(([filename], index) => film(db, `v${index}`, "Typed", [filename]));
    applyMigration(db);
    FILM_TITLE_CASES.forEach(([, title], index) => expect(titleOf(db, `v${index}`), `case ${index}`).toBe(title));
  });
});
