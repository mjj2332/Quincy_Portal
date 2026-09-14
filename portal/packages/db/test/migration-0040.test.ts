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

describe("migration 0040 narrow project priority to 1-5", () => {
  it("clamps stored priorities and historical activity payloads via a column swap, with no table rebuild", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 39);

    const now = 1_791_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tb8-user', 'TB8 User', 'tb8-user@example.test', 1, 'admin', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO agencies (id, name, created_at, updated_at) VALUES ('tb8-agency', 'TB8 Agency', ?, ?)").run(now, now);
    db.prepare("INSERT INTO agents (id, agency_id, name, created_at, updated_at) VALUES ('tb8-agent', 'tb8-agency', 'TB8 Agent', ?, ?)").run(now, now);

    // Four rows: above 5, exactly 5, below 5, and null — plus one referencing the
    // agency/agent FKs so they can be proven still intact after the column swap, not
    // just assumed (the swap never touches or rebuilds the table those FKs live on).
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-above', 'Above Street', 'edited_review', 10, 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-six', 'Six Street', 'edited_review', 6, 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-exact', 'Exact Street', 'edited_review', 5, 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at, agency_id, agent_id) VALUES ('tb8-below', 'Below Street', 'awaiting_raw', 1, 0, ?, ?, 'tb8-agency', 'tb8-agent')").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-null', 'Null Street', 'awaiting_raw', NULL, 0, ?, ?)").run(now, now);

    // A historical activity payload above the new max, and one already within range —
    // proving the rewrite only touches rows that need it.
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tb8-activity-above', 1, 'project.priority.changed', 'priority', 'tb8-above', 'user', 'tb8-user', ?, 'project_priority', 'tb8-above', 'project-priority:tb8-above:change:tb8-activity-above', '{"priority":10}', 'project', '/projects/tb8-above', ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tb8-activity-below', 1, 'project.priority.changed', 'priority', 'tb8-below', 'user', 'tb8-user', ?, 'project_priority', 'tb8-below', 'project-priority:tb8-below:change:tb8-activity-below', '{"priority":1}', 'project', '/projects/tb8-below', ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tb8-activity-null', 1, 'project.priority.changed', 'priority', 'tb8-null', 'user', 'tb8-user', ?, 'project_priority', 'tb8-null', 'project-priority:tb8-null:change:tb8-activity-null', '{"priority":null}', 'project', '/projects/tb8-null', ?)
    `).run(now, now);

    const migration = readFileSync(new URL("../migrations/0040_project_priority_1_to_5.sql", import.meta.url), "utf8");
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    // Clamped as expected: min(n, 5).
    expect(db.prepare("SELECT id, priority FROM projects ORDER BY id").all()).toEqual([
      { id: "tb8-above", priority: 5 },
      { id: "tb8-below", priority: 1 },
      { id: "tb8-exact", priority: 5 },
      { id: "tb8-null", priority: null },
      { id: "tb8-six", priority: 5 },
    ]);

    // Historical activity payloads rewritten the same way; already-in-range and null
    // payloads are left byte-identical.
    expect(db.prepare("SELECT id, safe_payload_json FROM project_activity_events ORDER BY id").all()).toEqual([
      { id: "tb8-activity-above", safe_payload_json: '{"priority":5}' },
      { id: "tb8-activity-below", safe_payload_json: '{"priority":1}' },
      { id: "tb8-activity-null", safe_payload_json: '{"priority":null}' },
    ]);

    // The CHECK now rejects 6 and still accepts null.
    expect(() => db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-reject', 'Reject Street', 'awaiting_raw', 6, 0, ?, ?)").run(now, now)).toThrow();
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-accept', 'Accept Street', 'awaiting_raw', 5, 0, ?, ?)").run(now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, created_at, updated_at) VALUES ('tb8-accept-null', 'Accept Null Street', 'awaiting_raw', NULL, 0, ?, ?)").run(now, now);

    // The resulting projects DDL carries a real CHECK bounding priority at 5, not a
    // trigger or an app-level clamp — so a future regression to either fails here.
    const projectsDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string }).sql;
    expect(projectsDdl).toContain('"priority" >= 1 AND "projects"."priority" <= 5');

    // No table was rebuilt, so every index survived untouched...
    expect(db.prepare("PRAGMA index_list('projects')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "projects_stage_idx" }),
      expect.objectContaining({ name: "projects_order_idx" }),
      expect.objectContaining({ name: "projects_archived_idx" }),
    ]));
    // ...and every foreign key...
    expect(db.prepare("PRAGMA foreign_key_list('projects')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "agencies", from: "agency_id", to: "id" }),
      expect.objectContaining({ table: "agents", from: "agent_id", to: "id" }),
      expect.objectContaining({ table: "user", from: "archived_by", to: "id" }),
    ]));
    // ...and every other CHECK constraint (spot-checked via a value that only the
    // deadline-zone CHECK would reject) — these assertions now prove nothing was lost
    // by the column swap, rather than proving a rebuild carried them across.
    expect(() => db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at, deadline_zone) VALUES ('tb8-bad-zone', 'Bad Zone Street', 'awaiting_raw', 0, ?, ?, 'UTC')").run(now, now)).toThrow();

    // The FK relationship on the surviving row is intact after the swap.
    expect(db.prepare("SELECT agency_id, agent_id FROM projects WHERE id = 'tb8-below'").get()).toEqual({ agency_id: "tb8-agency", agent_id: "tb8-agent" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });

    db.close();
  });

  it("applies as the 40th migration directly after 0039", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
    const position = names.indexOf("0040_project_priority_1_to_5.sql");
    expect(position).toBeGreaterThan(0);
    expect(names[position - 1]).toBe("0039_notice_board_read_markers.sql");
  });
});
