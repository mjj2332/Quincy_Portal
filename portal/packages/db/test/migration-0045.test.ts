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

/** Seeds a mapping using only columns migration 0041 created, for a fixture applied before 0045. */
function seedLegacyMapping(db: SqliteDatabase, input: { id: string; projectId: string; connectionId: string; rootPath: string; now: number }): void {
  db.prepare(`
    INSERT INTO editor_folder_mappings (
      id, project_id, connection_id, root_path, root_path_key, shoot_date, project_folder_name,
      photographer_evidence_json, editing_notes_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2026-10-02', 'Example', '{}', ?, ?, ?)
  `).run(input.id, input.projectId, input.connectionId, input.rootPath, input.rootPath.toLowerCase(), `${input.rootPath}/Editing Notes`, input.now, input.now);
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

describe("migration 0045 editor folder move", () => {
  it("applies cleanly, adds the move columns with the documented defaults, and leaves existing mappings unaffected", () => {
    const now = 1_791_100_000_000;
    const db = localSqlite();
    applyMigrations(db, 44);
    db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection-1', 'dropbox', 'connected', ?, ?)").run(now, now);
    seedProject(db, "project-existing", now);
    seedLegacyMapping(db, { id: "mapping-existing", projectId: "project-existing", connectionId: "connection-1", rootPath: "/Editor/01_ACTIVE EDITS/09. September/01/Existing", now });

    db.exec(readFileSync(new URL("../migrations/0045_editor_folder_move.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));

    const columns = (db.prepare("PRAGMA table_info(editor_folder_mappings)").all()) as { name: string; notnull: number; dflt_value: string | null }[];
    const byName = (name: string) => columns.find((row) => row.name === name);
    expect(byName("root_revision")).toMatchObject({ notnull: 1, dflt_value: "0" });
    // NOT NULL DEFAULT 0 so an existing mapping starts at zero attempts rather than NULL, which
    // the >= comparison that stops a wedged move would never satisfy.
    expect(byName("move_commit_attempts")).toMatchObject({ notnull: 1, dflt_value: "0" });
    for (const nullable of ["move_status", "move_target_path", "move_target_path_key", "move_target_shoot_date", "move_token", "move_expires_at", "move_note", "moved_from_path", "move_completed_at"]) {
      expect(byName(nullable)).toMatchObject({ notnull: 0, dflt_value: null });
    }

    const existing = db.prepare("SELECT root_revision, move_status, move_target_path_key, move_commit_attempts FROM editor_folder_mappings WHERE id = 'mapping-existing'").get();
    expect(existing).toEqual({ root_revision: 0, move_status: null, move_target_path_key: null, move_commit_attempts: 0 });

    db.close();
  });

  it("rejects a move_status outside NULL/moving/blocked", () => {
    const now = 1_791_100_000_000;
    const db = localSqlite();
    applyMigrations(db, 45);
    db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection-1', 'dropbox', 'connected', ?, ?)").run(now, now);
    seedProject(db, "project-1", now);
    seedMapping(db, { id: "mapping-1", projectId: "project-1", connectionId: "connection-1", rootPath: "/Editor/01_ACTIVE EDITS/09. September/01/One", now });
    expect(() => db.prepare("UPDATE editor_folder_mappings SET move_status = 'done' WHERE id = 'mapping-1'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE id = 'mapping-1'").run();
    db.prepare("UPDATE editor_folder_mappings SET move_status = 'blocked' WHERE id = 'mapping-1'").run();
    db.prepare("UPDATE editor_folder_mappings SET move_status = NULL WHERE id = 'mapping-1'").run();
    db.close();
  });

  it("lets two mappings share a NULL move_target_path_key but not the same non-NULL key on one connection", () => {
    const now = 1_791_100_000_000;
    const db = localSqlite();
    applyMigrations(db, 45);
    db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection-1', 'dropbox', 'connected', ?, ?)").run(now, now);
    seedProject(db, "project-a", now);
    seedProject(db, "project-b", now);
    seedProject(db, "project-c", now);

    // Two NULL move_target_path_key rows on the same connection are fine (the common case: no move in flight).
    seedMapping(db, { id: "mapping-a", projectId: "project-a", connectionId: "connection-1", rootPath: "/Editor/01_ACTIVE EDITS/09. September/01/A", now });
    seedMapping(db, { id: "mapping-b", projectId: "project-b", connectionId: "connection-1", rootPath: "/Editor/01_ACTIVE EDITS/09. September/02/B", now });

    db.prepare("UPDATE editor_folder_mappings SET move_target_path_key = '/editor/01_active edits/09. september/03/target' WHERE id = 'mapping-a'").run();
    seedMapping(db, { id: "mapping-c", projectId: "project-c", connectionId: "connection-1", rootPath: "/Editor/01_ACTIVE EDITS/09. September/03/C", now });

    // A second mapping cannot target the same key on the same connection while mapping-a still holds it.
    expect(() => db.prepare("UPDATE editor_folder_mappings SET move_target_path_key = '/editor/01_active edits/09. september/03/target' WHERE id = 'mapping-c'").run())
      .toThrow(/UNIQUE constraint failed/);

    // A different connection may target the identical key.
    db.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('connection-2', 'dropbox', 'connected', ?, ?)").run(now, now);
    seedProject(db, "project-d", now);
    seedMapping(db, {
      id: "mapping-d",
      projectId: "project-d",
      connectionId: "connection-2",
      rootPath: "/Editor/01_ACTIVE EDITS/09. September/03/D",
      now,
      moveTargetPathKey: "/editor/01_active edits/09. september/03/target",
    });

    db.close();
  });

  it("keeps the migration journal in order", () => {
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Record<string, unknown>[] };
    const at = journal.entries.findIndex((entry) => entry.idx === 45);
    expect(journal.entries[at]).toMatchObject({ idx: 45, tag: "0045_editor_folder_move", breakpoints: true });
    expect(journal.entries[at - 1]).toMatchObject({ idx: 44 });
    expect((journal.entries[at] as { when: number }).when).toBeGreaterThan((journal.entries[at - 1] as { when: number }).when);
  });
});
