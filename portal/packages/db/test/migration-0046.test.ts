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

function seedProject(db: SqliteDatabase, id: string, now: number): void {
  db.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, '123 Example St', 'awaiting_raw', ?, ?)").run(id, now, now);
}

function seedMapping(db: SqliteDatabase, input: { id: string; projectId: string; connectionId: string; rootPath: string; now: number; moveTargetPathKey?: string | null }): void {
  db.prepare(`
    INSERT INTO editor_folder_mappings (
      id, project_id, connection_id, root_path, root_path_key, shoot_date, project_folder_name,
      photographer_evidence_json, editing_notes_path, move_target_path_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2026-10-02', 'Example', '{}', ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.connectionId,
    input.rootPath,
    input.rootPath.toLowerCase(),
    `${input.rootPath}/Editing Notes`,
    input.moveTargetPathKey ?? null,
    input.now,
    input.now,
  );
}

describe("migration 0046 editor folder orphan watches (#195)", () => {
  const apply0046 = (db: SqliteDatabase) => db.exec(readFileSync(new URL("../migrations/0046_editor_folder_orphan_watches.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));

  function prepared(now: number): SqliteDatabase {
    const db = localSqlite();
    applyMigrations(db, 45);
    db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection-1', 'dropbox', 'connected', ?, ?)").run(now, now);
    for (const name of ["watched", "no-time", "idle"]) {
      seedProject(db, `project-${name}`, now);
      seedMapping(db, { id: `mapping-${name}`, projectId: `project-${name}`, connectionId: "connection-1", rootPath: `/Editor/01_ACTIVE EDITS/09. September/01/${name}`, now });
    }
    db.prepare("UPDATE editor_folder_mappings SET root_revision = 3, moved_from_path = '/Editor/01_ACTIVE EDITS/08. August/01/Watched', move_completed_at = ? WHERE id = 'mapping-watched'").run(now - 5 * 60_000);
    db.prepare("UPDATE editor_folder_mappings SET root_revision = 1, moved_from_path = '/Editor/Old/No-Time' WHERE id = 'mapping-no-time'").run();
    // A completion time with no path: nothing to watch, but the stale value is still cleared.
    db.prepare("UPDATE editor_folder_mappings SET move_completed_at = ? WHERE id = 'mapping-idle'").run(now);
    return db;
  }

  it("carries each open watch across and clears the legacy columns", () => {
    const now = 1_791_100_000_000;
    const db = prepared(now);
    apply0046(db);

    const watches = db.prepare("SELECT mapping_id, move_revision, old_path, old_path_key, status, watch_until, found_at FROM editor_folder_orphan_watches ORDER BY mapping_id").all();
    expect(watches).toEqual([
      // No completion time: due at once, never "never".
      { mapping_id: "mapping-no-time", move_revision: 1, old_path: "/Editor/Old/No-Time", old_path_key: "/editor/old/no-time", status: "watching", watch_until: 1_800_000, found_at: null },
      { mapping_id: "mapping-watched", move_revision: 3, old_path: "/Editor/01_ACTIVE EDITS/08. August/01/Watched", old_path_key: "/editor/01_active edits/08. august/01/watched", status: "watching", watch_until: now + 25 * 60_000, found_at: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM editor_folder_mappings WHERE moved_from_path IS NOT NULL OR move_completed_at IS NOT NULL").get()).toEqual({ n: 0 });
    const ids = db.prepare("SELECT id FROM editor_folder_orphan_watches").all() as { id: string }[];
    for (const { id } of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids.map(({ id }) => id)).size).toBe(ids.length);
    db.close();
  });

  it("holds one watch per mapping revision, only known statuses, and drops watches with their mapping", () => {
    const now = 1_791_100_000_000;
    const db = prepared(now);
    apply0046(db);
    db.exec("PRAGMA foreign_keys = ON");
    const insert = db.prepare("INSERT INTO editor_folder_orphan_watches (id, mapping_id, move_revision, old_path, old_path_key, status, watch_until, created_at, updated_at) VALUES (?, 'mapping-idle', ?, '/a', '/a', ?, 0, 0, 0)");
    insert.run("w1", 7, "watching");
    expect(() => insert.run("w2", 7, "watching")).toThrow(/UNIQUE constraint failed/);
    insert.run("w3", 8, "found");
    expect(() => insert.run("w4", 9, "acknowledged")).toThrow(/CHECK/);
    db.prepare("DELETE FROM editor_folder_mappings WHERE id = 'mapping-idle'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM editor_folder_orphan_watches WHERE mapping_id = 'mapping-idle'").get()).toEqual({ n: 0 });
    db.close();
  });

  it("keeps the migration journal in order", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Record<string, unknown>[] };
    const at = journal.entries.findIndex((entry) => entry.idx === 46);
    expect(journal.entries[at]).toMatchObject({ idx: 46, tag: "0046_editor_folder_orphan_watches", breakpoints: true });
    expect(journal.entries[at - 1]).toMatchObject({ idx: 45 });
    expect((journal.entries[at] as { when: number }).when).toBeGreaterThan((journal.entries[at - 1] as { when: number }).when);
  });
});
