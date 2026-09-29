import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeChecklistSchedule, type ChecklistScheduleStorage } from "@quincy/shared";
import {
  buildRangeBackfillSql,
  extractDryrunRows,
  prepareRangeBackfill,
  rangeBackfillAuditId,
  sydneyDayWindowMs,
  type DryrunRow,
  type RangeBackfillManifest,
} from "../../../scripts/subtask-range-backfill";

type Statement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => unknown };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => Statement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

function applyMigrations(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

const DRYRUN_SQL = readFileSync(new URL("../../../scripts/subtask-range-backfill-dryrun.sql", import.meta.url), "utf8");
const VERIFY_SQL = readFileSync(new URL("../../../scripts/subtask-range-backfill-verify.sql", import.meta.url), "utf8");

const TODAY = "2026-09-29";
// A faked D1 clock inside TODAY's Sydney day (AEST, +10): [2026-09-28T14:00Z, 2026-09-29T14:00Z).
const DAY_START = Date.UTC(2026, 8, 28, 14);
const DAY_END = Date.UTC(2026, 8, 29, 14);
const CLOCK = String(Date.UTC(2026, 8, 29, 2));
const STAMP = 1_780_000_000_000;
const NOW = Date.UTC(2026, 8, 1);
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const PROJECT = {
  alpha: "11111111-1111-4111-8111-111111111111", // canonical shoot date, Deadline set
  bravo: "22222222-2222-4222-8222-222222222222", // free-text shoot date, no Deadline (stale local civil), created on a Sydney/UTC date boundary
  charlie: "33333333-3333-4333-8333-333333333333", // archived; Deadline earlier than the shoot date; apostrophe in street
  delta: "44444444-4444-4444-8444-444444444444", // no shoot date, no Deadline, created in AEDT
  echo: "55555555-5555-4555-8555-555555555555", // range ends in the future
};

const SUBTASK = {
  unscheduledV0: "a0000000-0000-4000-8000-000000000001",
  unscheduledV2: "a0000000-0000-4000-8000-000000000002",
  dueDateV0: "a0000000-0000-4000-8000-000000000003",
  dueTimedV0: "a0000000-0000-4000-8000-000000000004",
  dueDateV1: "a0000000-0000-4000-8000-000000000005",
  dueTimedFold1: "a0000000-0000-4000-8000-000000000006",
  legacyLiteral: "a0000000-0000-4000-8000-000000000007",
  legacyNonexistent: "a0000000-0000-4000-8000-000000000008",
  invalidShape: "a0000000-0000-4000-8000-000000000009",
  invalidOrder: "a0000000-0000-4000-8000-00000000000a",
  rangeControl: "a0000000-0000-4000-8000-00000000000b",
  futureLegacy: "a0000000-0000-4000-8000-00000000000c",
};

const CONVERTING = Object.entries(SUBTASK).filter(([key]) => key !== "rangeControl").map(([, id]) => id);

type SubtaskSeed = Partial<{
  title: string; done: number; assignee_id: string | null; due_reminder_sent_at: number | null; due_date: string | null;
  schedule_start_kind: string | null; schedule_start_civil: string | null; schedule_start_at: number | null;
  schedule_start_utc_offset_minutes: number | null; schedule_start_fold: number | null; schedule_end_kind: string | null;
  schedule_end_at: number | null; schedule_end_utc_offset_minutes: number | null; schedule_end_fold: number | null;
  schedule_zone: string | null; schedule_version: number;
}>;

function seed(db: SqliteDatabase): void {
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Ed', 'ed@example.test', 1, 'editor', 1, ?, ?)").run(USER, NOW, NOW);
  const project = db.prepare(
    "INSERT INTO projects (id, street, stage_key, shoot_date, deadline_at, deadline_local_civil, archived_at, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, ?, ?, ?)",
  );
  project.run(PROJECT.alpha, "Alpha Street", "2026-09-10", Date.UTC(2026, 8, 20, 7), "2026-09-20T17:00", null, Date.UTC(2026, 7, 1), NOW);
  project.run(PROJECT.bravo, "Bravo Street", "Thursday, 17 Sep, 2026", null, "2026-12-01T09:00", null, Date.UTC(2026, 8, 14, 14, 30), NOW);
  project.run(PROJECT.charlie, "Charlie's Street", "2026-10-10", Date.UTC(2026, 9, 5, 1), "2026-10-05T12:00", NOW, Date.UTC(2026, 7, 1), NOW);
  project.run(PROJECT.delta, "Delta Street", null, null, null, null, Date.UTC(2026, 1, 28, 20), NOW);
  project.run(PROJECT.echo, "Echo Street", "2026-10-01", Date.UTC(2026, 9, 19, 22), "2026-10-20T09:00", null, Date.UTC(2026, 7, 1), NOW);

  let position = 0;
  const subtask = (id: string, projectId: string, values: SubtaskSeed) => {
    const row = {
      title: `Task ${position}`, done: 0, assignee_id: USER, due_reminder_sent_at: null, due_date: null,
      schedule_start_kind: null, schedule_start_civil: null, schedule_start_at: null, schedule_start_utc_offset_minutes: null,
      schedule_start_fold: null, schedule_end_kind: null, schedule_end_at: null, schedule_end_utc_offset_minutes: null,
      schedule_end_fold: null, schedule_zone: null, schedule_version: 0, ...values,
    };
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO project_subtasks (id, project_id, position, created_by, created_at, updated_at, ${columns.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ${columns.map(() => "?").join(", ")})`,
    ).run(id, projectId, position++, USER, NOW, NOW, ...Object.values(row));
  };

  subtask(SUBTASK.unscheduledV0, PROJECT.alpha, {});
  subtask(SUBTASK.unscheduledV2, PROJECT.bravo, { schedule_version: 2 });
  subtask(SUBTASK.dueDateV0, PROJECT.alpha, { due_date: "2026-10-02" });
  subtask(SUBTASK.dueTimedV0, PROJECT.alpha, { due_date: "2026-10-02T15:30", due_reminder_sent_at: STAMP });
  subtask(SUBTASK.dueDateV1, PROJECT.charlie, { done: 1, due_date: "2026-10-01", schedule_end_kind: "date", schedule_zone: "Australia/Sydney", schedule_version: 1 });
  subtask(SUBTASK.dueTimedFold1, PROJECT.delta, {
    due_date: "2026-04-05T02:30", schedule_end_kind: "timed", schedule_end_at: Date.UTC(2026, 3, 4, 16, 30),
    schedule_end_utc_offset_minutes: 600, schedule_end_fold: 1, schedule_zone: "Australia/Sydney", schedule_version: 3,
  });
  subtask(SUBTASK.legacyLiteral, PROJECT.alpha, { title: "Chase 'next week' due", due_date: "next week", due_reminder_sent_at: STAMP });
  subtask(SUBTASK.legacyNonexistent, PROJECT.bravo, { due_date: "2026-10-04T02:30" });
  subtask(SUBTASK.invalidShape, PROJECT.alpha, { schedule_start_kind: "date", schedule_start_civil: "2026-09-12", schedule_zone: "Australia/Sydney", schedule_version: 1 });
  subtask(SUBTASK.invalidOrder, PROJECT.delta, {
    due_date: "2026-06-01", schedule_start_kind: "date", schedule_start_civil: "2026-06-10", schedule_end_kind: "date",
    schedule_zone: "Australia/Sydney", schedule_version: 4,
  });
  subtask(SUBTASK.rangeControl, PROJECT.alpha, {
    due_date: "2026-12-01", schedule_start_kind: "date", schedule_start_civil: "2026-09-10", schedule_end_kind: "date",
    schedule_zone: "Australia/Sydney", schedule_version: 1, due_reminder_sent_at: STAMP,
  });
  subtask(SUBTASK.futureLegacy, PROJECT.echo, { due_date: "tbc", due_reminder_sent_at: STAMP, assignee_id: null });
}

function freshDb(): SqliteDatabase {
  const db = localSqlite();
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  seed(db);
  return db;
}

/** The dry run's statements, as `grep -v '^--'` leaves them for `--command`. */
function dryrunStatements(): string[] {
  const stripped = DRYRUN_SQL.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  return stripped.split(/;\s*\n/).map((part) => part.trim().replace(/;$/, "")).filter(Boolean);
}

/** What `wrangler d1 execute --json --command` prints: one result set per statement. */
function dryrunOutput(db: SqliteDatabase): Array<{ results: unknown[]; success: boolean }> {
  return dryrunStatements().map((statement) => ({ results: db.prepare(statement).all(), success: true }));
}

function runDryrun(db: SqliteDatabase): DryrunRow[] {
  return dryrunOutput(db)[0]!.results as DryrunRow[];
}

function dryrun(db: SqliteDatabase) {
  return extractDryrunRows(dryrunOutput(db));
}

function verifyCount(db: SqliteDatabase): number {
  const stripped = VERIFY_SQL.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  return (db.prepare(stripped).get() as { without_complete_range: number }).without_complete_range;
}

let idCounter = 0;
function sequentialIds(): () => string {
  return () => `bbbbbbbb-0000-4000-8000-${(++idCounter).toString(16).padStart(12, "0")}`;
}

function generate(db: SqliteDatabase, nowSql = CLOCK): { manifest: RangeBackfillManifest; sql: string; review: string } {
  const prepared = prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY });
  // The manifest is written to disk and read back by the apply step.
  const manifest = JSON.parse(JSON.stringify(prepared.manifest)) as RangeBackfillManifest;
  const { sql } = buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: sequentialIds(), nowSql });
  return { manifest, sql, review: prepared.review };
}

type SubtaskRow = Record<string, unknown> & { id: string };
function subtasks(db: SqliteDatabase): Map<string, SubtaskRow> {
  return new Map((db.prepare("SELECT * FROM project_subtasks ORDER BY id").all() as SubtaskRow[]).map((row) => [row.id, row]));
}

function storage(row: Record<string, unknown>): ChecklistScheduleStorage {
  return {
    dueDate: row.due_date as string | null,
    scheduleStartKind: row.schedule_start_kind as "date" | "timed" | null,
    scheduleStartCivil: row.schedule_start_civil as string | null,
    scheduleStartAt: row.schedule_start_at as number | null,
    scheduleStartUtcOffsetMinutes: row.schedule_start_utc_offset_minutes as number | null,
    scheduleStartFold: row.schedule_start_fold as number | null,
    scheduleEndKind: row.schedule_end_kind as "date" | "timed" | null,
    scheduleEndAt: row.schedule_end_at as number | null,
    scheduleEndUtcOffsetMinutes: row.schedule_end_utc_offset_minutes as number | null,
    scheduleEndFold: row.schedule_end_fold as number | null,
    scheduleZone: row.schedule_zone as string | null,
    scheduleVersion: row.schedule_version as number,
  };
}

function statementsOf(sql: string): string[] {
  return sql.split("\n").filter((line) => !line.startsWith("--")).join("\n").split(/;\n/).map((s) => s.trim()).filter(Boolean).map((s) => `${s};`);
}

function otherTableCounts(db: SqliteDatabase) {
  const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { outbox: n("notification_outbox"), ledger: n("notification_delivery_ledger"), activity: n("project_activity_events"), notifications: n("notifications") };
}

function backfillAudits(db: SqliteDatabase) {
  return db.prepare("SELECT * FROM audit_log WHERE json_extract(meta_json, '$.source') = 'subtask_range_backfill' ORDER BY target_id").all() as Array<Record<string, unknown>>;
}

const EXPECTED_RANGES: Record<string, { start: string; end: string; kind: "date" | "timed"; fromState: string; version: number }> = {
  [SUBTASK.unscheduledV0]: { kind: "date", start: "2026-09-10", end: "2026-09-20", fromState: "unscheduled", version: 1 },
  // Free-text shoot date is ignored; created 2026-09-14T14:30Z is 2026-09-15 in Sydney; the stale local civil is ignored.
  [SUBTASK.unscheduledV2]: { kind: "date", start: "2026-09-15", end: "2026-09-15", fromState: "unscheduled", version: 3 },
  [SUBTASK.dueDateV0]: { kind: "date", start: "2026-09-10", end: "2026-10-02", fromState: "due_only", version: 1 },
  [SUBTASK.dueTimedV0]: { kind: "timed", start: "2026-09-10T00:00", end: "2026-10-02T15:30", fromState: "due_only", version: 1 },
  // Shoot date 2026-10-10 is after the due: collapses to one day on the due.
  [SUBTASK.dueDateV1]: { kind: "date", start: "2026-10-01", end: "2026-10-01", fromState: "due_only", version: 2 },
  // Created 2026-02-28T20:00Z is 2026-03-01 in Sydney (AEDT).
  [SUBTASK.dueTimedFold1]: { kind: "timed", start: "2026-03-01T00:00", end: "2026-04-05T02:30", fromState: "due_only", version: 4 },
  [SUBTASK.legacyLiteral]: { kind: "date", start: "2026-09-10", end: "2026-09-20", fromState: "legacy_unresolved", version: 1 },
  [SUBTASK.legacyNonexistent]: { kind: "date", start: "2026-09-15", end: "2026-09-15", fromState: "legacy_unresolved", version: 1 },
  [SUBTASK.invalidShape]: { kind: "date", start: "2026-09-10", end: "2026-09-20", fromState: "invalid", version: 2 },
  [SUBTASK.invalidOrder]: { kind: "date", start: "2026-03-01", end: "2026-03-01", fromState: "invalid", version: 5 },
  [SUBTASK.futureLegacy]: { kind: "date", start: "2026-10-01", end: "2026-10-20", fromState: "legacy_unresolved", version: 1 },
};

describe("subtask range backfill (#341)", () => {
  it("dry run reads every Subtask, including done ones and those on archived Projects", () => {
    const db = freshDb();
    const rows = runDryrun(db);
    expect(rows.map((row) => row.subtask_id).sort()).toEqual(Object.values(SUBTASK).sort());
    expect(verifyCount(db)).toBe(CONVERTING.length);
    db.close();
  });

  it("classifies with the shared serializer and proposes the shared default range", () => {
    const db = freshDb();
    const { manifest, review } = generate(db);
    expect(manifest.counts).toEqual({ scanned: 12, alreadyRange: 1, converting: 11, byState: { unscheduled: 2, due_only: 4, legacy_unresolved: 3, invalid: 2 } });
    expect(manifest.sydneyToday).toBe(TODAY);
    const proposed = Object.fromEntries(manifest.rows.map((row) => [row.subtaskId, { kind: row.proposed.start.kind, start: row.proposed.start.localCivil, end: row.proposed.end.localCivil, fromState: row.fromState, version: row.proposed.storage.scheduleVersion }]));
    expect(proposed).toEqual(EXPECTED_RANGES);
    expect(manifest.rows.find((row) => row.subtaskId === SUBTASK.rangeControl)).toBeUndefined();

    // review.md lists only rows to convert, with their old and new values and the reminder outcome.
    expect(review).toContain("Charlie's Street");
    expect(review).toContain("Chase 'next week' due");
    expect(review).toContain("`next week`");
    expect(review).not.toContain(SUBTASK.rangeControl);
    expect(review.match(/^\| /gm)?.length).toBe(1 + 11); // header row + one per converting row
    db.close();
  });

  it("apply converts each row once: range endpoints, version bump, one system audit row, no notification or activity rows", () => {
    const db = freshDb();
    const before = subtasks(db);
    const { sql } = generate(db);
    db.exec(sql);
    const after = subtasks(db);

    for (const [id, expected] of Object.entries(EXPECTED_RANGES)) {
      const dto = serializeChecklistSchedule(storage(after.get(id)!));
      expect(dto.state, id).toBe("range");
      expect(dto.version, id).toBe(expected.version);
      expect(dto.start?.kind, id).toBe(expected.kind);
      expect(dto.start?.localCivil, id).toBe(expected.start);
      expect(dto.end?.localCivil, id).toBe(expected.end);
      expect(after.get(id)!.updated_at, id).not.toBe(NOW);
    }
    // Timed values resolve to the right instants; the fold-1 due keeps its original (AEST, second) instant.
    expect(after.get(SUBTASK.dueTimedV0)).toMatchObject({ schedule_start_at: Date.UTC(2026, 8, 9, 14), schedule_end_at: Date.UTC(2026, 9, 2, 5, 30), schedule_end_fold: 0 });
    expect(after.get(SUBTASK.dueTimedFold1)).toMatchObject({
      schedule_start_at: Date.UTC(2026, 1, 28, 13), schedule_start_utc_offset_minutes: 660, schedule_start_fold: 0,
      schedule_end_at: Date.UTC(2026, 3, 4, 16, 30), schedule_end_utc_offset_minutes: 600, schedule_end_fold: 1,
    });
    // The valid range is untouched byte for byte.
    expect(after.get(SUBTASK.rangeControl)).toEqual(before.get(SUBTASK.rangeControl));

    const audits = backfillAudits(db);
    expect(audits.map((row) => row.target_id)).toEqual([...CONVERTING].sort());
    for (const audit of audits) {
      expect(audit).toMatchObject({ actor_id: null, action: "project_subtask.update", target_type: "project_subtask" });
      const meta = JSON.parse(audit.meta_json as string);
      const expected = EXPECTED_RANGES[audit.target_id as string]!;
      expect(meta).toMatchObject({ actor: "system", source: "subtask_range_backfill", fields: ["schedule"], scheduleState: "range", scheduleVersion: expected.version, fromState: expected.fromState });
    }
    expect(otherTableCounts(db)).toEqual({ outbox: 0, ledger: 0, activity: 0, notifications: 0 });
    expect(verifyCount(db)).toBe(0);
    const reprepared = prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY }).manifest;
    expect(reprepared.counts.converting).toBe(0);
    expect(reprepared.unpairedAudits).toEqual([]); // every audit is paired with its conversion
    db.close();
  });

  it("stamps reminders so no stale 'due today' email fires, and leaves due-only reminders alone", () => {
    const db = freshDb();
    const { sql, manifest } = generate(db);
    db.exec(sql);
    const after = subtasks(db);
    const reminder = (id: string) => after.get(id)!.due_reminder_sent_at;

    // Not due-only, new end before today: stamped (an existing stamp is preserved by COALESCE).
    expect(reminder(SUBTASK.unscheduledV0)).toEqual(expect.any(Number));
    expect(reminder(SUBTASK.unscheduledV0)).not.toBe(STAMP);
    expect(reminder(SUBTASK.invalidOrder)).toEqual(expect.any(Number));
    expect(reminder(SUBTASK.legacyLiteral)).toBe(STAMP);
    // Not due-only, new end today or later: re-armed like the Worker does when an end changes.
    expect(reminder(SUBTASK.futureLegacy)).toBeNull();
    // Due-only: end unchanged, so the reminder column is untouched.
    expect(reminder(SUBTASK.dueTimedV0)).toBe(STAMP);
    expect(reminder(SUBTASK.dueDateV0)).toBeNull();

    const labels = Object.fromEntries(manifest.rows.map((row) => [row.subtaskId, row.reminder]));
    expect(labels[SUBTASK.unscheduledV0]).toBe("suppressed");
    expect(labels[SUBTASK.futureLegacy]).toBe("armed");
    expect(labels[SUBTASK.dueTimedV0]).toBe("unchanged");
    db.close();
  });

  it("is idempotent: applying the same file twice changes nothing and audits exactly once", () => {
    const db = freshDb();
    const { sql } = generate(db);
    db.exec(sql);
    const once = { subtasks: db.prepare("SELECT * FROM project_subtasks ORDER BY id").all(), audit: db.prepare("SELECT * FROM audit_log ORDER BY id").all() };
    db.exec(sql);
    const twice = { subtasks: db.prepare("SELECT * FROM project_subtasks ORDER BY id").all(), audit: db.prepare("SELECT * FROM audit_log ORDER BY id").all() };
    expect(twice).toEqual(once);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    db.close();
  });

  it("finishes an interrupted run: audits written before their UPDATEs are not duplicated on the re-run", () => {
    const db = freshDb();
    const { sql } = generate(db);
    const reference = freshDb();
    reference.exec(generate(reference).sql);
    // Interrupted after each audit INSERT, before its UPDATE.
    for (const statement of statementsOf(sql).filter((s) => s.startsWith("INSERT"))) db.exec(statement);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    expect(verifyCount(db)).toBe(CONVERTING.length);
    db.exec(sql);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    expect(verifyCount(db)).toBe(0);
    // Same fixed clock, so the result matches an uninterrupted run exactly.
    expect(subtasks(db)).toEqual(subtasks(reference));
    reference.close();
    db.close();
  });

  it("an UPDATE never runs without its audit (UPDATEs alone change nothing)", () => {
    const db = freshDb();
    const before = subtasks(db);
    const { sql } = generate(db);
    for (const statement of statementsOf(sql).filter((s) => s.startsWith("UPDATE"))) db.exec(statement);
    expect(subtasks(db)).toEqual(before);
    expect(backfillAudits(db)).toHaveLength(0);
    db.close();
  });

  it("writes no audit for a row the user saved to the same range after the dry run", () => {
    const db = freshDb();
    const { sql, manifest } = generate(db);
    const row = manifest.rows.find((r) => r.subtaskId === SUBTASK.unscheduledV0)!;
    const next = row.proposed.storage;
    db.prepare(
      "UPDATE project_subtasks SET due_date=?, schedule_start_kind=?, schedule_start_civil=?, schedule_start_at=?, schedule_start_utc_offset_minutes=?, schedule_start_fold=?, schedule_end_kind=?, schedule_end_at=?, schedule_end_utc_offset_minutes=?, schedule_end_fold=?, schedule_zone=?, schedule_version=? WHERE id=?",
    ).run(next.dueDate, next.scheduleStartKind, next.scheduleStartCivil, next.scheduleStartAt, next.scheduleStartUtcOffsetMinutes, next.scheduleStartFold, next.scheduleEndKind, next.scheduleEndAt, next.scheduleEndUtcOffsetMinutes, next.scheduleEndFold, next.scheduleZone, next.scheduleVersion, SUBTASK.unscheduledV0);
    const saved = subtasks(db).get(SUBTASK.unscheduledV0);
    db.exec(sql);
    expect(subtasks(db).get(SUBTASK.unscheduledV0)).toEqual(saved);
    const audited = backfillAudits(db).map((a) => a.target_id);
    expect(audited).not.toContain(SUBTASK.unscheduledV0);
    expect(audited).toHaveLength(CONVERTING.length - 1);
    db.close();
  });

  it("two apply files generated from one manifest write one audit per conversion", () => {
    const db = freshDb();
    const { manifest, sql } = generate(db);
    const second = buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: sequentialIds(), nowSql: CLOCK }).sql;
    const auditIds = (text: string) => statementsOf(text).filter((s) => s.startsWith("INSERT")).map((s) => /SELECT '([0-9a-f-]{36})'/.exec(s)?.[1]);
    expect(auditIds(second)).toEqual(auditIds(sql));
    expect(new Set(auditIds(sql)).size).toBe(CONVERTING.length);
    db.exec(sql);
    db.exec(second);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    db.close();
  });

  it("changes nothing when run on a Sydney day other than the manifest's", () => {
    for (const clock of [DAY_END, DAY_START - 1, Date.UTC(2026, 8, 30, 2)]) {
      const db = freshDb();
      const before = subtasks(db);
      db.exec(generate(db, String(clock)).sql);
      expect(subtasks(db), String(clock)).toEqual(before);
      expect(backfillAudits(db), String(clock)).toHaveLength(0);
      db.close();
    }
    for (const clock of [DAY_START, DAY_END - 1]) {
      const db = freshDb();
      db.exec(generate(db, String(clock)).sql);
      expect(verifyCount(db), String(clock)).toBe(0);
      db.close();
    }
  });

  it("guards on the reviewed reminder stamp, title, done and assignee: a change after the dry run skips the row", () => {
    const db = freshDb();
    const { sql } = generate(db);
    const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Other', 'other@example.test', 1, 'editor', 1, ?, ?)").run(OTHER, NOW, NOW);
    db.prepare("UPDATE project_subtasks SET due_reminder_sent_at = ? WHERE id = ?").run(STAMP, SUBTASK.dueDateV0); // the 08:00 scan claimed it
    db.prepare("UPDATE project_subtasks SET title = 'Renamed' WHERE id = ?").run(SUBTASK.unscheduledV0);
    db.prepare("UPDATE project_subtasks SET done = 1 WHERE id = ?").run(SUBTASK.invalidShape);
    db.prepare("UPDATE project_subtasks SET assignee_id = ? WHERE id = ?").run(OTHER, SUBTASK.legacyNonexistent);
    const skipped = [SUBTASK.dueDateV0, SUBTASK.unscheduledV0, SUBTASK.invalidShape, SUBTASK.legacyNonexistent];
    const before = subtasks(db);
    db.exec(sql);
    const after = subtasks(db);
    for (const id of skipped) expect(after.get(id), id).toEqual(before.get(id));
    const audited = backfillAudits(db).map((a) => a.target_id);
    for (const id of skipped) expect(audited).not.toContain(id);
    expect(audited).toHaveLength(CONVERTING.length - skipped.length);
    expect(verifyCount(db)).toBe(skipped.length);
    expect(prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY }).manifest.rows.map((r) => r.subtaskId).sort()).toEqual([...skipped].sort());
    db.close();
  });

  it("keeps the reminder stamp when the conversion leaves the due date unchanged", () => {
    const db = freshDb();
    db.prepare("UPDATE project_subtasks SET due_date = '2026-09-20', due_reminder_sent_at = ? WHERE id = ?").run(STAMP, SUBTASK.invalidShape);
    const { sql, manifest } = generate(db);
    const row = manifest.rows.find((r) => r.subtaskId === SUBTASK.invalidShape)!;
    expect(row.fromState).not.toBe("due_only");
    expect(row.proposed.storage.dueDate?.slice(0, 10)).toBe("2026-09-20");
    expect(row.reminder).toBe("unchanged");
    db.exec(sql);
    const after = subtasks(db).get(SUBTASK.invalidShape)!;
    expect(serializeChecklistSchedule(storage(after)).state).toBe("range");
    expect(after.due_reminder_sent_at).toBe(STAMP);
    db.close();
  });

  it("refuses to prepare while a backfill audit has no conversion (interrupted, then the Project changed)", () => {
    const db = freshDb();
    const { sql } = generate(db);
    // The run stopped after the audit INSERTs, before any UPDATE.
    for (const statement of statementsOf(sql).filter((s) => s.startsWith("INSERT"))) db.exec(statement);
    // Then Alpha's Deadline moved, so re-running the old file skips Alpha's UPDATEs but keeps their audits.
    db.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-10-30T18:00' WHERE id = ?").run(Date.UTC(2026, 9, 30, 7), PROJECT.alpha);
    db.exec(sql);
    const alpha = [SUBTASK.unscheduledV0, SUBTASK.dueDateV0, SUBTASK.dueTimedV0, SUBTASK.legacyLiteral, SUBTASK.invalidShape].sort();
    expect(verifyCount(db)).toBe(alpha.length);

    const prepared = prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY });
    const unpaired = prepared.manifest.unpairedAudits;
    expect(unpaired.map((audit) => audit.subtaskId).sort()).toEqual(alpha);
    for (const audit of unpaired) {
      expect(prepared.review).toContain(audit.auditId);
      expect(prepared.review).toContain(audit.inspectSql);
      expect(prepared.review).toContain(audit.removeSql);
      expect(audit.removeSql.startsWith("DELETE FROM audit_log")).toBe(true);
      expect(audit.inspectSql.startsWith("SELECT")).toBe(true);
    }
    expect(prepared.review).toMatch(/REFUSED/);
    // prepare deletes nothing itself.
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    // The generator refuses the manifest, even after it is written and read back.
    expect(() => buildRangeBackfillSql(JSON.parse(JSON.stringify(prepared.manifest)), { sydneyToday: TODAY, newId: sequentialIds(), nowSql: CLOCK })).toThrow(/unpaired/i);

    // The inspect query is read-only and shows the row still at its old version.
    for (const audit of unpaired) expect(db.prepare(audit.inspectSql).all()).toHaveLength(1);
    // After the operator confirms and removes them, a new cycle converts with the new Deadline and audits once.
    for (const audit of unpaired) db.exec(audit.removeSql);
    const again = generate(db);
    expect(again.manifest.unpairedAudits).toEqual([]);
    db.exec(again.sql);
    expect(verifyCount(db)).toBe(0);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    const audit = backfillAudits(db).find((row) => row.target_id === SUBTASK.unscheduledV0)!;
    expect(JSON.parse(audit.meta_json as string).proposal).toEqual(storage(subtasks(db).get(SUBTASK.unscheduledV0)!));
    expect(subtasks(db).get(SUBTASK.unscheduledV0)!.due_date).toBe("2026-10-30");
    db.close();
  });

  it("a remove statement deletes nothing once the audit's conversion has happened", () => {
    const db = freshDb();
    const { sql } = generate(db);
    for (const statement of statementsOf(sql).filter((s) => s.startsWith("INSERT"))) db.exec(statement);
    const [audit] = prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY }).manifest.unpairedAudits;
    db.exec(sql); // the operator re-ran the same file instead: the conversion completed
    db.exec(audit!.removeSql);
    expect(backfillAudits(db)).toHaveLength(CONVERTING.length);
    db.close();
  });

  it("skips a row edited after the dry run (schedule or Project input) and writes no audit for it", () => {
    const db = freshDb();
    const { sql } = generate(db);
    db.prepare("UPDATE project_subtasks SET due_date = '2026-10-05' WHERE id = ?").run(SUBTASK.dueDateV0);
    db.prepare("UPDATE projects SET deadline_at = NULL WHERE id = ?").run(PROJECT.echo);
    db.exec(sql);
    const after = subtasks(db);
    expect(after.get(SUBTASK.dueDateV0)).toMatchObject({ due_date: "2026-10-05", schedule_version: 0 });
    expect(after.get(SUBTASK.futureLegacy)).toMatchObject({ due_date: "tbc", schedule_version: 0 });
    const audited = backfillAudits(db).map((row) => row.target_id);
    expect(audited).not.toContain(SUBTASK.dueDateV0);
    expect(audited).not.toContain(SUBTASK.futureLegacy);
    expect(audited).toHaveLength(CONVERTING.length - 2);
    expect(verifyCount(db)).toBe(2);
    const next = prepareRangeBackfill(dryrun(db), { sydneyToday: TODAY }).manifest;
    expect(next.rows.map((row) => row.subtaskId).sort()).toEqual([SUBTASK.dueDateV0, SUBTASK.futureLegacy].sort());
    db.close();
  });

  it("keeps free text out of apply.sql and hex-encodes unsafe old literals", () => {
    const db = freshDb();
    db.prepare("UPDATE project_subtasks SET due_date = ? WHERE id = ?").run("it's;\n-- DROP", SUBTASK.legacyLiteral);
    db.prepare("UPDATE projects SET shoot_date = ? WHERE id = ?").run("TBC -- ask agent", PROJECT.bravo);
    const { sql } = generate(db);
    expect(sql).not.toContain("Chase");
    expect(sql).not.toContain("Street");
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("ask agent");
    db.exec(sql);
    expect(serializeChecklistSchedule(storage(subtasks(db).get(SUBTASK.legacyLiteral)!)).state).toBe("range");
    db.close();
  });
});

describe("subtask range backfill generator (pure)", () => {
  function manifestFor(): RangeBackfillManifest {
    const db = freshDb();
    const manifest = generate(db).manifest;
    db.close();
    return manifest;
  }

  it("accepts the wrangler --json wrapper or bare rows, and refuses rows without subtask_id", () => {
    const db = freshDb();
    const output = dryrunOutput(db);
    const rows = runDryrun(db);
    db.close();
    expect(output).toHaveLength(2);
    expect(extractDryrunRows(output)).toEqual({ subtasks: rows, audits: [] });
    // The audit read is required: a dry run without it (or bare rows) is refused, not read as "no audits".
    expect(() => extractDryrunRows([output[0]])).toThrow(/two result sets/);
    expect(() => extractDryrunRows(rows)).toThrow(/two result sets/);
    expect(() => extractDryrunRows([])).toThrow(/two result sets/);
    expect(() => extractDryrunRows([{ results: [{ changes: 3 }] }, { results: [] }])).toThrow(/subtask_id/);
    expect(() => extractDryrunRows([{ results: rows }, { results: [{ changes: 3 }] }])).toThrow(/audit_id/);
    expect(() => extractDryrunRows({})).toThrow(/array/);
  });

  it("refuses a bad id", () => {
    const db = freshDb();
    const rows = runDryrun(db).map((row) => (row.subtask_id === SUBTASK.unscheduledV0 ? { ...row, subtask_id: "not-a-uuid" } : row));
    db.close();
    expect(() => prepareRangeBackfill({ subtasks: rows, audits: [] }, { sydneyToday: TODAY })).toThrow(/subtask_id/);
  });

  it("refuses a manifest whose proposed values the shared function does not reproduce", () => {
    const manifest = manifestFor();
    manifest.rows[0]!.proposed.storage.dueDate = "2027-01-01";
    expect(() => buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: sequentialIds() })).toThrow(/do not match/);
  });

  it("refuses to generate apply SQL on a different Sydney day than the reviewed manifest", () => {
    const manifest = manifestFor();
    expect(() => buildRangeBackfillSql(manifest, { sydneyToday: "2026-09-30", newId: sequentialIds() })).toThrow(/2026-09-29/);
  });

  it("an empty manifest gives a header and no statements", () => {
    const { manifest } = prepareRangeBackfill({ subtasks: [], audits: [] }, { sydneyToday: TODAY });
    const { sql } = buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: sequentialIds() });
    expect(sql.startsWith("-- Subtask range backfill (#341)")).toBe(true);
    expect(statementsOf(sql)).toEqual([]);
  });

  it("each audit id is a fixed UUID baked into the file", () => {
    const manifest = manifestFor();
    const { sql } = buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: sequentialIds() });
    const inserts = statementsOf(sql).filter((s) => s.startsWith("INSERT INTO audit_log"));
    expect(inserts).toHaveLength(11);
    expect(() => buildRangeBackfillSql(manifest, { sydneyToday: TODAY, newId: () => "nope" })).toThrow(/UUID/);
  });

  it("computes the Sydney day window across DST changes", () => {
    expect(sydneyDayWindowMs(TODAY)).toEqual({ startMs: DAY_START, endMs: DAY_END });
    // 4 Oct 2026: clocks go forward at 02:00 (23-hour day); 5 Apr 2026: back at 03:00 (25-hour day).
    expect(sydneyDayWindowMs("2026-10-04")).toEqual({ startMs: Date.UTC(2026, 9, 3, 14), endMs: Date.UTC(2026, 9, 4, 13) });
    expect(sydneyDayWindowMs("2026-04-05")).toEqual({ startMs: Date.UTC(2026, 3, 4, 13), endMs: Date.UTC(2026, 3, 5, 14) });
    expect(sydneyDayWindowMs("2026-12-31").endMs).toBe(Date.UTC(2026, 11, 31, 13));
    expect(() => sydneyDayWindowMs("2026-02-30")).toThrow();
  });

  it("derives a stable UUIDv5 audit id from the subtask id, old version and proposed schedule", () => {
    const proposal = manifestFor().rows.find((row) => row.subtaskId === SUBTASK.unscheduledV0)!.proposed.storage;
    const id = rangeBackfillAuditId(SUBTASK.unscheduledV0, 0, proposal);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rangeBackfillAuditId(SUBTASK.unscheduledV0, 0, { ...proposal })).toBe(id);
    expect(rangeBackfillAuditId(SUBTASK.unscheduledV0, 1, proposal)).not.toBe(id);
    expect(rangeBackfillAuditId(SUBTASK.unscheduledV2, 0, proposal)).not.toBe(id);
    // A different proposal can never reuse an older audit id.
    expect(rangeBackfillAuditId(SUBTASK.unscheduledV0, 0, { ...proposal, dueDate: "2026-10-30" })).not.toBe(id);
  });

  it("refuses a manifest without an unpaired-audit check, or with unpaired audits recorded", () => {
    const manifest = manifestFor();
    const missing = { ...manifest } as Partial<RangeBackfillManifest>;
    delete missing.unpairedAudits;
    expect(() => buildRangeBackfillSql(missing as RangeBackfillManifest, { sydneyToday: TODAY, newId: sequentialIds() })).toThrow(/unpaired/i);
  });
});
