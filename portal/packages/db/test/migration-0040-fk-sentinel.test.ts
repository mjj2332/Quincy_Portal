import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// node:sqlite honours `PRAGMA foreign_keys=OFF` correctly, so a migration test that just
// replays 0040's SQL verbatim (including its own PRAGMA statements, if it had any) proves
// nothing about D1, which does NOT honour that pragma in remote migration execution
// (docs/lessons.md:27-62). To actually simulate D1's behaviour, this test strips every
// `PRAGMA` statement out of 0040's SQL before executing it, and re-asserts
// `PRAGMA foreign_keys = ON` immediately beforehand. That is what makes this a sentinel:
// if 0040 is ever regressed back to a table-rebuild (CREATE TABLE __new_projects ...,
// DROP TABLE projects, RENAME), removing the pragma that would normally hide the cascade
// means the DROP TABLE fires real foreign-key enforcement, and this test goes red instead
// of green. Do not "fix" this by restoring the pragma strip.

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

function stripPragmas(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*PRAGMA\b/i.test(line.trim()))
    .join("\n");
}

describe("migration 0040 FK sentinel", () => {
  it("cannot destroy child rows even under an engine that enforces foreign keys throughout", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 39);

    const now = 1_792_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb9-user', 'TB9 User', 'tb9-user@example.test', 1, 'admin', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb9-editor', 'TB9 Editor', 'tb9-editor@example.test', 1, 'editor', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb9-project', 'Sentinel Street', 'awaiting_raw', 10, 0, ?, ?)").run(now, now);

    // Three tables that declare `ON DELETE CASCADE` on `projects.id` (schema.ts).
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tb9-activity', 1, 'project.priority.changed', 'priority', 'tb9-project', 'user', 'tb9-user', ?, 'project_priority', 'tb9-project', 'project-priority:tb9-project:change:tb9-activity', '{"priority":10}', 'project', '/projects/tb9-project', ?)
    `).run(now, now);
    db.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES ('tb9-member', 'tb9-project', 'tb9-editor', 'editor', ?)").run(now);
    db.prepare(`
      INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at)
      VALUES ('tb9-comment', 'tb9-project', 'tb9-user', 'sentinel comment', '{"type":"doc","content":[]}', ?)
    `).run(now);

    const childCountsBefore = {
      activity: db.prepare("SELECT count(*) AS n FROM project_activity_events WHERE project_id = 'tb9-project'").get(),
      members: db.prepare("SELECT count(*) AS n FROM project_members WHERE project_id = 'tb9-project'").get(),
      comments: db.prepare("SELECT count(*) AS n FROM project_comments WHERE project_id = 'tb9-project'").get(),
    };
    expect(childCountsBefore).toEqual({ activity: { n: 1 }, members: { n: 1 }, comments: { n: 1 } });

    const migrationSource = readFileSync(new URL("../migrations/0040_project_priority_1_to_5.sql", import.meta.url), "utf8");
    const stripped = stripPragmas(migrationSource).replaceAll("--> statement-breakpoint", "");
    // Re-assert immediately before applying — this is the D1-shaped condition under test.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(stripped);

    expect(db.prepare("SELECT id, priority FROM projects WHERE id = 'tb9-project'").get()).toEqual({ id: "tb9-project", priority: 5 });

    const childCountsAfter = {
      activity: db.prepare("SELECT count(*) AS n FROM project_activity_events WHERE project_id = 'tb9-project'").get(),
      members: db.prepare("SELECT count(*) AS n FROM project_members WHERE project_id = 'tb9-project'").get(),
      comments: db.prepare("SELECT count(*) AS n FROM project_comments WHERE project_id = 'tb9-project'").get(),
    };
    expect(childCountsAfter).toEqual(childCountsBefore);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM projects WHERE id = 'tb9-project'").get()).toEqual({ id: "tb9-project" });

    db.close();
  });
});
