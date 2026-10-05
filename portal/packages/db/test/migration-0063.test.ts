import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0063_embedded_media_heic_rendition.sql";
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

function insertMedia(db: SqliteDatabase, id: string, extra = ""): void {
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?) ON CONFLICT(id) DO NOTHING").run(NOW, NOW);
  db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('p1', 'S', 'editing', 0, ?, ?) ON CONFLICT(id) DO NOTHING").run(NOW, NOW);
  db.prepare(`INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at${extra ? `, ${extra.split("=")[0]}` : ""}) VALUES (?, 'project_comment', NULL, 'p1', 'u1', 'image', 'image/heic', 10, ?, 'pending', ?, ?${extra ? `, ${extra.split("=")[1]}` : ""})`).run(id, `projects/p1/embedded-media/${id}/original`, NOW, NOW);
}
function applyMigration(db: SqliteDatabase): void {
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

describe("migration 0063 adds the HEIC display-copy columns and seeds the flag (#495)", () => {
  it("is journaled as idx 63, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP |DELETE |__new_|PRAGMA|UPDATE /i);
    expect(sql.match(/ALTER TABLE embedded_media ADD COLUMN/g)).toHaveLength(10);
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(1);
    // Settlement 9: one column-level CHECK on the status, and no cross-column CHECK.
    expect(sql.match(/CHECK/g)).toHaveLength(1);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
      expect(code.endsWith(";"), code.slice(0, 60)).toBe(true);
      expect(code.slice(0, -1), code.slice(0, 60)).not.toContain(";");
    }
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 63 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 63).map((candidate) => candidate.when)));
  });

  it("makes every existing row not_required with no display copy, and seeds the flag off", () => {
    const db = localSqlite();
    applyThrough(db, 62);
    insertMedia(db, "old-1"); insertMedia(db, "old-2");
    applyMigration(db);
    expect(db.prepare("SELECT id, rendition_status AS status, display_key AS displayKey, display_content_type AS ct, display_bytes AS bytes, rendition_attempts AS attempts, rendition_lease_until AS lease, rendition_requested_at AS requested, rendition_resent_at AS resent, rendition_error AS error FROM embedded_media ORDER BY id").all())
      .toEqual([{ id: "old-1", status: "not_required", displayKey: null, ct: null, bytes: null, attempts: 0, lease: null, requested: null, resent: null, error: null }, { id: "old-2", status: "not_required", displayKey: null, ct: null, bytes: null, attempts: 0, lease: null, requested: null, resent: null, error: null }]);
    expect(db.prepare("SELECT key, enabled, updated_by AS updatedBy FROM feature_flags WHERE key = 'embedded_heic_uploads'").all()).toEqual([{ key: "embedded_heic_uploads", enabled: 0, updatedBy: null }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("never restamps a flag an operator already turned on", () => {
    const db = localSqlite();
    applyThrough(db, 62);
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('embedded_heic_uploads', 1, 'u1', ?)").run(NOW);
    applyMigration(db);
    expect(db.prepare("SELECT enabled, updated_by AS updatedBy, updated_at AS updatedAt FROM feature_flags WHERE key = 'embedded_heic_uploads'").get()).toEqual({ enabled: 1, updatedBy: "u1", updatedAt: NOW });
    db.close();
  });

  it("accepts the four statuses and refuses any other, and NULL", () => {
    const db = localSqlite();
    applyThrough(db, 63);
    for (const status of ["not_required", "pending", "ready", "failed"]) insertMedia(db, `ok-${status}`, `rendition_status='${status}'`);
    for (const status of ["done", "PENDING", "", "queued"]) expect(() => insertMedia(db, `bad-${status}`, `rendition_status='${status}'`), status).toThrow(/CHECK/i);
    expect(() => insertMedia(db, "null-status", "rendition_status=NULL")).toThrow(/NOT NULL/i);
    expect(() => db.prepare("UPDATE embedded_media SET rendition_status = 'oops' WHERE id = 'ok-ready'").run()).toThrow(/CHECK/i);
    expect(db.prepare("SELECT count(*) AS n FROM embedded_media").get()).toEqual({ n: 4 });
    db.close();
  });

  it("serves the recovery scan from the index", () => {
    const db = localSqlite();
    applyThrough(db, 63);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM embedded_media WHERE rendition_status = 'pending' AND rendition_requested_at < 5").all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("embedded_media_rendition_idx");
    db.close();
  });
});
