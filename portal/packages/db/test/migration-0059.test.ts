import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0059_embedded_media_cleanup_claim.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
}

function seeded(through: number): SqliteDatabase {
  const db = localSqlite();
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) db.exec(migrationSql(name));
  return db;
}

describe("migration 0059 adds the cleanup lease (#494)", () => {
  it("is journaled, and is one bare ADD COLUMN with no semicolon in a comment", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TABLE|__new_|PRAGMA/i);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--"))) expect(line, line).not.toContain(";");
    const code = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE `embedded_media_cleanup` ADD COLUMN `claimed_until` integer;");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.tag === MIGRATION.replace(/\.sql$/, ""))).toBeDefined();
  });

  it("leaves every existing entry unclaimed and unchanged, and takes a lease only when one is set", () => {
    const db = seeded(58);
    db.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at, attempts) VALUES ('k', 'u', 'p1', ?, 2)").run(NOW);
    db.exec(migrationSql(MIGRATION));
    expect(db.prepare("SELECT storage_key, upload_id, project_id, queued_at, attempts, claimed_until FROM embedded_media_cleanup").all()).toEqual([{ storage_key: "k", upload_id: "u", project_id: "p1", queued_at: NOW, attempts: 2, claimed_until: null }]);
    db.prepare("INSERT INTO embedded_media_cleanup (storage_key, queued_at) VALUES ('k2', ?)").run(NOW);
    expect(db.prepare("SELECT claimed_until FROM embedded_media_cleanup WHERE storage_key = 'k2'").get()).toEqual({ claimed_until: null });
    db.prepare("UPDATE embedded_media_cleanup SET claimed_until = ? WHERE storage_key = 'k2'").run(NOW + 600_000);
    expect(db.prepare("SELECT claimed_until FROM embedded_media_cleanup WHERE storage_key = 'k2'").get()).toEqual({ claimed_until: NOW + 600_000 });
    db.close();
  });
});
