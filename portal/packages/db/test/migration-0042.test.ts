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

describe("migration 0042 normalise Tonomo display shoot dates", () => {
  it("converts legacy display shoot dates to ISO, excluding awaiting_raw and anything not a real matching calendar date", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 41);

    const now = 1_791_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tc2-user', 'TC2 User', 'tc2-user@example.test', 1, 'admin', 1, ?, ?)").run(now, now);

    const rows: { id: string; street: string; stageKey: string; shootDate: string | null }[] = [
      { id: "tc2-delivered", street: "Delivered Street", stageKey: "delivered", shootDate: "Thursday, 17 Sep, 2026" },
      { id: "tc2-awaiting-raw", street: "Awaiting Raw Street", stageKey: "awaiting_raw", shootDate: "Thursday, 17 Sep, 2026" },
      { id: "tc2-iso", street: "Iso Street", stageKey: "delivered", shootDate: "2026-09-17" },
      { id: "tc2-null", street: "Null Street", stageKey: "delivered", shootDate: null },
      { id: "tc2-tomorrow", street: "Tomorrow Street", stageKey: "delivered", shootDate: "tomorrow" },
      { id: "tc2-wrong-weekday", street: "Wrong Weekday Street", stageKey: "delivered", shootDate: "Monday, 17 Sep, 2026" },
      { id: "tc2-jan", street: "Jan Street", stageKey: "delivered", shootDate: "Thursday, 15 Jan, 2026" },
      { id: "tc2-dec", street: "Dec Street", stageKey: "delivered", shootDate: "Friday, 25 Dec, 2026" },
      { id: "tc2-invalid-day", street: "Invalid Day Street", stageKey: "delivered", shootDate: "Thursday, 31 Sep, 2026" },
    ];
    for (const row of rows) {
      db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.id, row.street, row.stageKey, row.shootDate, now, now);
    }

    // A seeded activity row unrelated to shoot_date, to prove the migration touches only
    // `projects.shoot_date` and nothing in `project_activity_events`.
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tc2-activity', 1, 'project.priority.changed', 'priority', 'tc2-delivered', 'user', 'tc2-user', ?, 'project_priority', 'tc2-delivered', 'project-priority:tc2-delivered:change:tc2-activity', '{"priority":3}', 'project', '/projects/tc2-delivered', ?)
    `).run(now, now);
    const activityBefore = db.prepare("SELECT * FROM project_activity_events ORDER BY id").all();

    const migration = readFileSync(new URL("../migrations/0042_normalise_tonomo_display_shoot_dates.sql", import.meta.url), "utf8");
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));

    expect(db.prepare("SELECT id, shoot_date FROM projects ORDER BY id").all()).toEqual([
      { id: "tc2-awaiting-raw", shoot_date: "Thursday, 17 Sep, 2026" },
      { id: "tc2-dec", shoot_date: "2026-12-25" },
      { id: "tc2-delivered", shoot_date: "2026-09-17" },
      { id: "tc2-invalid-day", shoot_date: "Thursday, 31 Sep, 2026" },
      { id: "tc2-iso", shoot_date: "2026-09-17" },
      { id: "tc2-jan", shoot_date: "2026-01-15" },
      { id: "tc2-null", shoot_date: null },
      { id: "tc2-tomorrow", shoot_date: "tomorrow" },
      { id: "tc2-wrong-weekday", shoot_date: "Monday, 17 Sep, 2026" },
    ]);

    // project_activity_events is completely untouched, row for row.
    expect(db.prepare("SELECT * FROM project_activity_events ORDER BY id").all()).toEqual(activityBefore);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });

    db.close();
  });

  it("applies as the 42nd migration directly after 0041", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
    const position = names.indexOf("0042_normalise_tonomo_display_shoot_dates.sql");
    expect(position).toBeGreaterThan(0);
    expect(names[position - 1]).toBe("0041_editor_folder_mappings.sql");
  });
});
