import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECONCILE_AWAITING_RAW_BATCH_SIZE, RECONCILE_AWAITING_RAW_SCAN_SQL } from "../../../workers/background/src/reconcile-awaiting-raw";

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

function apply0043(db: SqliteDatabase): void {
  const migration = readFileSync(new URL("../migrations/0043_normalise_remaining_tonomo_display_shoot_dates.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
}

describe("migration 0043 normalise remaining Tonomo display shoot dates", () => {
  it("converts the awaiting_raw display shoot dates 0042 left behind, and nothing else", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 42);

    const now = 1_791_000_000_000;
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('tc3-user', 'TC3 User', 'tc3-user@example.test', 1, 'admin', 1, ?, ?)").run(now, now);

    const rows: { id: string; street: string; stageKey: string; shootDate: string | null; archivedAt: number | null }[] = [
      { id: "tc3-awaiting-raw", street: "Awaiting Raw Street", stageKey: "awaiting_raw", shootDate: "Friday, 11 Sep, 2026", archivedAt: null },
      // Reconciliation excludes archived rows, so converting them has no stage side effect.
      { id: "tc3-awaiting-archived", street: "Awaiting Archived Street", stageKey: "awaiting_raw", shootDate: "Friday, 11 Sep, 2026", archivedAt: now },
      { id: "tc3-awaiting-wrong-weekday", street: "Wrong Weekday Street", stageKey: "awaiting_raw", shootDate: "Monday, 11 Sep, 2026", archivedAt: null },
      { id: "tc3-awaiting-invalid-day", street: "Invalid Day Street", stageKey: "awaiting_raw", shootDate: "Thursday, 31 Sep, 2026", archivedAt: null },
      { id: "tc3-awaiting-tomorrow", street: "Tomorrow Street", stageKey: "awaiting_raw", shootDate: "tomorrow", archivedAt: null },
      { id: "tc3-awaiting-iso", street: "Iso Street", stageKey: "awaiting_raw", shootDate: "2026-09-11", archivedAt: null },
      { id: "tc3-awaiting-null", street: "Null Street", stageKey: "awaiting_raw", shootDate: null, archivedAt: null },
    ];
    for (const row of rows) {
      db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.street, row.stageKey, row.shootDate, row.archivedAt, now, now);
    }

    // A seeded activity row unrelated to shoot_date, to prove the migration touches only
    // `projects.shoot_date` and nothing in `project_activity_events`.
    db.prepare(`
      INSERT INTO project_activity_events
        (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at)
      VALUES
        ('tc3-activity', 1, 'project.priority.changed', 'priority', 'tc3-awaiting-raw', 'user', 'tc3-user', ?, 'project_priority', 'tc3-awaiting-raw', 'project-priority:tc3-awaiting-raw:change:tc3-activity', '{"priority":3}', 'project', '/projects/tc3-awaiting-raw', ?)
    `).run(now, now);
    const activityBefore = db.prepare("SELECT * FROM project_activity_events ORDER BY id").all();

    // Inserted after 0042 ran, i.e. seeded here (before 0043), to prove the unconstrained sweep.
    db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("tc3-delivered-late", "Delivered Late Street", "delivered", "Wednesday, 16 Sep, 2026", now, now);

    apply0043(db);

    expect(db.prepare("SELECT id, shoot_date FROM projects ORDER BY id").all()).toEqual([
      { id: "tc3-awaiting-archived", shoot_date: "2026-09-11" },
      { id: "tc3-awaiting-invalid-day", shoot_date: "Thursday, 31 Sep, 2026" },
      { id: "tc3-awaiting-iso", shoot_date: "2026-09-11" },
      { id: "tc3-awaiting-null", shoot_date: null },
      { id: "tc3-awaiting-raw", shoot_date: "2026-09-11" },
      { id: "tc3-awaiting-tomorrow", shoot_date: "tomorrow" },
      { id: "tc3-awaiting-wrong-weekday", shoot_date: "Monday, 11 Sep, 2026" },
      { id: "tc3-delivered-late", shoot_date: "2026-09-16" },
    ]);

    // project_activity_events is completely untouched, row for row.
    expect(db.prepare("SELECT * FROM project_activity_events ORDER BY id").all()).toEqual(activityBefore);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });

    db.close();
  });

  it("is idempotent", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 42);

    const now = 1_791_000_000_000;
    const rows: { id: string; street: string; stageKey: string; shootDate: string | null; archivedAt: number | null }[] = [
      { id: "tc3b-awaiting-raw", street: "Awaiting Raw Street", stageKey: "awaiting_raw", shootDate: "Friday, 11 Sep, 2026", archivedAt: null },
      { id: "tc3b-awaiting-archived", street: "Awaiting Archived Street", stageKey: "awaiting_raw", shootDate: "Friday, 11 Sep, 2026", archivedAt: now },
      { id: "tc3b-awaiting-wrong-weekday", street: "Wrong Weekday Street", stageKey: "awaiting_raw", shootDate: "Monday, 11 Sep, 2026", archivedAt: null },
      { id: "tc3b-awaiting-invalid-day", street: "Invalid Day Street", stageKey: "awaiting_raw", shootDate: "Thursday, 31 Sep, 2026", archivedAt: null },
      { id: "tc3b-awaiting-tomorrow", street: "Tomorrow Street", stageKey: "awaiting_raw", shootDate: "tomorrow", archivedAt: null },
      { id: "tc3b-awaiting-iso", street: "Iso Street", stageKey: "awaiting_raw", shootDate: "2026-09-11", archivedAt: null },
      { id: "tc3b-awaiting-null", street: "Null Street", stageKey: "awaiting_raw", shootDate: null, archivedAt: null },
    ];
    for (const row of rows) {
      db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.street, row.stageKey, row.shootDate, row.archivedAt, now, now);
    }
    db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("tc3b-delivered-late", "Delivered Late Street", "delivered", "Wednesday, 16 Sep, 2026", now, now);

    apply0043(db);
    const afterFirst = db.prepare("SELECT id, shoot_date FROM projects ORDER BY id").all();
    apply0043(db);
    const afterSecond = db.prepare("SELECT id, shoot_date FROM projects ORDER BY id").all();

    expect(afterSecond).toEqual(afterFirst);

    db.close();
  });

  it("leaves no display-text shoot date in any stage after 0042 and 0043", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 41);

    const now = 1_791_000_000_000;
    const stageKeys = ["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"];
    for (const stageKey of stageKeys) {
      db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`tc3c-${stageKey}`, `${stageKey} Street`, stageKey, "Friday, 11 Sep, 2026", now, now);
    }

    const migration0042 = readFileSync(new URL("../migrations/0042_normalise_tonomo_display_shoot_dates.sql", import.meta.url), "utf8");
    db.exec(migration0042.replaceAll("--> statement-breakpoint", ""));
    apply0043(db);

    expect(db.prepare("SELECT count(*) AS remaining FROM projects WHERE shoot_date IS NOT NULL AND date(shoot_date) IS NULL").get()).toEqual({ remaining: 0 });

    db.close();
  });

  it("makes the converted awaiting_raw rows due for the hourly reconciliation", () => {
    const db = localSqlite();
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, 42);

    const now = 1_791_000_000_000;
    db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("tc3d-awaiting-raw", "Awaiting Raw Street", "awaiting_raw", "Friday, 11 Sep, 2026", null, now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("tc3d-awaiting-archived", "Awaiting Archived Street", "awaiting_raw", "Friday, 11 Sep, 2026", now, now, now);
    db.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("tc3d-awaiting-future", "Awaiting Future Street", "awaiting_raw", "Wednesday, 30 Sep, 2026", null, now, now);

    apply0043(db);

    const due = db.prepare(RECONCILE_AWAITING_RAW_SCAN_SQL).all("2026-09-14", RECONCILE_AWAITING_RAW_BATCH_SIZE) as { id: string }[];
    expect(due.map((row) => row.id)).toEqual(["tc3d-awaiting-raw"]);

    db.close();
  });

  it("applies as the 43rd migration directly after 0042", () => {
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
    const position = names.indexOf("0043_normalise_remaining_tonomo_display_shoot_dates.sql");
    expect(position).toBeGreaterThan(0);
    expect(names[position - 1]).toBe("0042_normalise_tonomo_display_shoot_dates.sql");

    // The journal is what `wrangler d1 migrations apply` walks, so the filename order alone is not enough.
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Record<string, unknown>[] };
    expect(journal.entries.at(-1)).toEqual({ idx: 43, version: "6", when: 1789380000000, tag: "0043_normalise_remaining_tonomo_display_shoot_dates", breakpoints: true });
    expect(journal.entries.at(-2)).toMatchObject({ idx: 42, tag: "0042_normalise_tonomo_display_shoot_dates" });
  });
});
