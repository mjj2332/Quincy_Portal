import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0082_attachments.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function migrated(): SqliteDatabase {
  const db = localSqlite();
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= 81).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec(`INSERT INTO guest_reviewers (id, email_normalized, created_at) VALUES ('g1', 'g@example.test', ${NOW})`);
  return db;
}

type Fields = Record<string, unknown>;
const row = (overrides: Fields = {}): Fields => ({
  id: "a1", owner_kind: "project_comment", owner_id: null, project_id: "p1", uploader_id: "u1", uploader_guest_id: null, file_name: "plan.pdf",
  content_type: "application/pdf", bytes: 10, storage_key: "projects/p1/attachments/a1/original", state: "pending", created_at: NOW, updated_at: NOW, ...overrides,
});
function insert(db: SqliteDatabase, fields: Fields): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO attachments (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}

describe("migration 0082 adds the attachments table (#952)", () => {
  it("is journaled as idx 82, additive only, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP |DELETE FROM|__new_|PRAGMA|UPDATE |ALTER |INSERT INTO/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 82 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 82).map((candidate) => candidate.when)));
  });

  it("takes a staff upload, a guest upload on a video note and a Notice board row", () => {
    const db = migrated();
    insert(db, row());
    insert(db, row({ id: "a2", storage_key: "k2", owner_kind: "video_note", uploader_id: null, uploader_guest_id: "g1" }));
    insert(db, row({ id: "a3", storage_key: "k3", owner_kind: "notice_post", project_id: null, state: "attached", owner_id: "post1" }));
    insert(db, row({ id: "a4", storage_key: "k4", state: "detached", owner_id: "c1", detached_at: NOW }));
    expect((db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(4);
  });

  it.each([
    ["both uploaders", { uploader_guest_id: "g1" }],
    ["neither uploader", { uploader_id: null }],
    ["a Notice board row with a Project", { owner_kind: "notice_post" }],
    ["a Project row with no Project", { project_id: null }],
    ["a pending row with an owner", { owner_id: "c1" }],
    ["an attached row with no owner", { state: "attached" }],
    ["a detached row with no time", { state: "detached", owner_id: "c1" }],
    ["zero bytes", { bytes: 0 }],
    ["an empty name", { file_name: "" }],
    ["a name over 255 characters", { file_name: "x".repeat(256) }],
    ["an unknown owner kind", { owner_kind: "whiteboard" }],
    ["an unknown state", { state: "ready" }],
    ["a non-integer time", { created_at: "x" }],
  ])("refuses %s", (_label, overrides) => {
    const db = migrated();
    expect(() => insert(db, row(overrides as Fields))).toThrow();
  });

  it("keeps storage keys unique and cascades with the Project", () => {
    const db = migrated();
    insert(db, row());
    expect(() => insert(db, row({ id: "a2" }))).toThrow();
    db.exec("DELETE FROM projects WHERE id = 'p1'");
    expect((db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
  });
});
