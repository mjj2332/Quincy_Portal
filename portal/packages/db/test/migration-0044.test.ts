import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Statement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => Statement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

describe("migration 0044 user default editor", () => {
  it("adds default_editor as NOT NULL DEFAULT 0 and leaves existing users unflagged", () => {
    const now = 1_791_000_000_000;
    const fresh = localSqlite();
    applyMigrations(fresh, 43);
    fresh.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('existing', 'Existing', 'existing@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    fresh.exec(readFileSync(new URL("../migrations/0044_user_default_editor.sql", import.meta.url), "utf8"));
    const column = (fresh.prepare("PRAGMA table_info(user)").all() as { name: string; notnull: number; dflt_value: string | null }[]).find((row) => row.name === "default_editor");
    expect(column).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(fresh.prepare("SELECT default_editor FROM user WHERE id = 'existing'").get()).toEqual({ default_editor: 0 });
    fresh.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('new', 'New', 'new@example.test', 1, 'admin', 1, ?, ?)").run(now, now);
    expect(fresh.prepare("SELECT default_editor FROM user WHERE id = 'new'").get()).toEqual({ default_editor: 0 });

    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Record<string, unknown>[] };
    const at = journal.entries.findIndex((entry) => entry.idx === 44);
    expect(journal.entries[at]).toMatchObject({ idx: 44, tag: "0044_user_default_editor", breakpoints: true });
    expect(journal.entries[at - 1]).toMatchObject({ idx: 43 });
    fresh.close();
  });
});
