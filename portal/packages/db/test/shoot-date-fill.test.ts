import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildNonCompactingStageWinner,
  buildShootDateFillBundle,
  buildStageShootDateFill,
  buildStageActivityBundle,
  buildWorkflowTail,
  composeStageBundle,
  shootDateFillLanded,
  stageMoveFillsShootDate,
} from "../src/index";

type SqliteRow = Record<string, unknown>;
type SqliteStatement = {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
};
type SqliteDatabase = {
  close: () => void;
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
};

type LocalStatement = {
  source: string;
  values: unknown[];
  execute: () => { results: unknown[]; meta: { changes: number } };
};

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

const BREAKPOINT = "--> statement-breakpoint";

function migrationNames(): string[] {
  const directory = new URL("../migrations/", import.meta.url);
  return readdirSync(directory)
    .filter((value) => /^\d{4}_.*\.sql$/.test(value))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function applyAllMigrations(db: SqliteDatabase): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of migrationNames()) {
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const segment of source.split(BREAKPOINT).map((value) => value.trim()).filter(Boolean)) db.exec(segment);
  }
}

function localD1(db: SqliteDatabase): D1Database {
  class LocalD1Statement implements LocalStatement {
    constructor(readonly source: string, readonly values: unknown[] = []) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new LocalD1Statement(this.source, values) as unknown as D1PreparedStatement;
    }

    execute(): { results: unknown[]; meta: { changes: number } } {
      const statement = db.prepare(this.source);
      let results: unknown[] = [];
      try {
        results = statement.all(...this.values);
      } catch {
        statement.run(...this.values);
      }
      const changes = Number((db.prepare("SELECT changes() AS changes").get() as { changes: number }).changes);
      return { results, meta: { changes } };
    }
  }

  return {
    prepare: (source: string) => new LocalD1Statement(source) as unknown as D1PreparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map((statement) => (statement as unknown as LocalStatement).execute());
        db.exec("COMMIT");
        return results as unknown as D1Result<unknown>[];
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled back the transaction.
        }
        throw error;
      }
    },
  } as unknown as D1Database;
}


const NOW = Date.parse("2026-10-01T14:30:00Z"); // Sydney 2026-10-02 00:30, a different UTC day

function seedProject(db: SqliteDatabase, input: { id?: string; stageKey?: string; shootDate?: string | null; archived?: boolean; deadlineAt?: number | null } = {}): string {
  const id = input.id ?? "p1";
  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, deadline_at, created_at, updated_at) VALUES (?, 'Fill Street', ?, ?, ?, ?, 1, 1)")
    .run(id, input.shootDate ?? null, input.stageKey ?? "raw_review", input.archived ? 1 : null, input.deadlineAt ?? null);
  return id;
}

function seedAudit(db: SqliteDatabase, id: string, action: string, targetId = "p1"): void {
  db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, ?, 'project', ?, '{}', 1)").run(id, action, targetId);
}

function database() {
  const db = localSqlite();
  applyAllMigrations(db);
  // audit_log.actor_id is a foreign key to user(id).
  db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('user-1', 'U', 'u@example.test', 1, 'admin', 1, 1, 1)").run();
  return { db, d1: localD1(db) };
}

const shootDateOf = (db: SqliteDatabase, id = "p1") => (db.prepare("SELECT shoot_date FROM projects WHERE id = ?").get(id) as { shoot_date: string | null }).shoot_date;
const fillAudits = (db: SqliteDatabase) => db.prepare("SELECT id, actor_id, meta_json FROM audit_log WHERE action = 'project.shoot_date.changed'").all() as Array<{ id: string; actor_id: string | null; meta_json: string }>;

describe("stageMoveFillsShootDate", () => {
  it("is true only for an exit from Awaiting RAW", () => {
    expect(stageMoveFillsShootDate("awaiting_raw", "raw_review")).toBe(true);
    expect(stageMoveFillsShootDate("awaiting_raw", "delivered")).toBe(true);
    expect(stageMoveFillsShootDate("awaiting_raw", "awaiting_raw")).toBe(false);
    expect(stageMoveFillsShootDate("raw_review", "awaiting_raw")).toBe(false);
    expect(stageMoveFillsShootDate("raw_review", "editing_autohdr")).toBe(false);
  });

  it("builds no stage fill for a non-qualifying transition", () => {
    const prepared: string[] = [];
    const db = { prepare(source: string) { prepared.push(source); return { bind: () => ({}) }; } } as unknown as D1Database;
    expect(buildStageShootDateFill({ db, projectId: "p1", from: "raw_review", to: "editing_autohdr", winnerAuditId: "w", winnerAuditAction: "stage.set", fillAuditId: "f", actorId: "u", now: NOW })).toBeUndefined();
    expect(prepared).toEqual([]);
  });
});

describe("Shoot date fill SQL", () => {
  const stageFill = (d1: D1Database, overrides: Partial<Parameters<typeof buildShootDateFillBundle>[0]> = {}) => buildShootDateFillBundle({
    db: d1, projectId: "p1", fillAuditId: "fill-1", actorId: "user-1", now: NOW,
    trigger: { kind: "stage_move", destinationStage: "raw_review", winnerAuditId: "winner-1", winnerAuditAction: "stage.set" },
    ...overrides,
  });

  it("fills a NULL date with the Sydney day and audits it, gated on the winner audit row", async () => {
    const { db, d1 } = database();
    seedProject(db);
    seedAudit(db, "winner-1", "stage.set");
    const bundle = stageFill(d1, { impersonatedBy: "admin-1" });
    const results = await d1.batch(bundle.statements);
    expect(shootDateOf(db)).toBe("2026-10-02");
    expect(shootDateFillLanded(results, bundle.indexes)).toBe(true);
    const [audit] = fillAudits(db);
    expect(audit).toMatchObject({ id: "fill-1", actor_id: "user-1" });
    expect(JSON.parse(audit!.meta_json)).toEqual({ shootDate: "2026-10-02", previousShootDate: null, reason: "stage_move", impersonatedBy: "admin-1" });
    db.close();
  });

  it("does nothing when this attempt's winner audit row is missing (a lost race), whatever else exists", async () => {
    const { db, d1 } = database();
    seedProject(db);
    seedAudit(db, "someone-elses-winner", "stage.set");
    const bundle = stageFill(d1);
    const results = await d1.batch(bundle.statements);
    expect(shootDateOf(db)).toBeNull();
    expect(shootDateFillLanded(results, bundle.indexes)).toBe(false);
    expect(fillAudits(db)).toHaveLength(0);
    db.close();
  });

  it("does nothing for a held canonical date, held text, an empty string, an archived Project, or a different Stage", async () => {
    for (const setup of [{ shootDate: "2026-09-15" }, { shootDate: "TBC next week" }, { shootDate: "" }, { archived: true }, { stageKey: "delivered" }]) {
      const { db, d1 } = database();
      seedProject(db, setup);
      seedAudit(db, "winner-1", "stage.set");
      const bundle = stageFill(d1);
      const results = await d1.batch(bundle.statements);
      expect(shootDateFillLanded(results, bundle.indexes)).toBe(false);
      expect(shootDateOf(db)).toBe(setup.shootDate ?? null);
      expect(fillAudits(db)).toHaveLength(0);
      db.close();
    }
  });

  it("requires the winner audit to be the expected action", async () => {
    const { db, d1 } = database();
    seedProject(db);
    seedAudit(db, "winner-1", "stage.auto_advance");
    await d1.batch(stageFill(d1).statements);
    expect(shootDateOf(db)).toBeNull();
    db.close();
  });

  describe("Deadline trigger", () => {
    const deadlineFill = (d1: D1Database) => buildShootDateFillBundle({ db: d1, projectId: "p1", fillAuditId: "fill-1", actorId: "user-1", now: NOW, trigger: { kind: "deadline_set", winnerAuditId: "deadline-audit" } });

    it("fills past Awaiting RAW when the Project holds a Deadline, with reason deadline_set", async () => {
      const { db, d1 } = database();
      seedProject(db, { stageKey: "editing_autohdr", deadlineAt: NOW + 86_400_000 });
      seedAudit(db, "deadline-audit", "project.deadline.schedule_saved");
      const bundle = deadlineFill(d1);
      const results = await d1.batch(bundle.statements);
      expect(shootDateFillLanded(results, bundle.indexes)).toBe(true);
      expect(shootDateOf(db)).toBe("2026-10-02");
      expect(JSON.parse(fillAudits(db)[0]!.meta_json)).toEqual({ shootDate: "2026-10-02", previousShootDate: null, reason: "deadline_set" });
      db.close();
    });

    it("does not fill in Awaiting RAW, without a Deadline, or without the saved-Deadline audit", async () => {
      for (const setup of [
        { stage: { stageKey: "awaiting_raw", deadlineAt: NOW + 1 }, action: "project.deadline.schedule_saved" },
        { stage: { stageKey: "editing_autohdr", deadlineAt: null }, action: "project.deadline.schedule_saved" },
        { stage: { stageKey: "editing_autohdr", deadlineAt: NOW + 1 }, action: "stage.set" },
      ]) {
        const { db, d1 } = database();
        seedProject(db, setup.stage);
        seedAudit(db, "deadline-audit", setup.action);
        await d1.batch(deadlineFill(d1).statements);
        expect(shootDateOf(db)).toBeNull();
        expect(fillAudits(db)).toHaveLength(0);
        db.close();
      }
    });
  });
});

describe("composeStageBundle shootDateFill slot", () => {
  it("appends the fill last, after the terminal slot, and leaves every other index unchanged when absent", () => {
    const db = { prepare() { return { bind: (...values: unknown[]) => ({ values }) }; } } as unknown as D1Database;
    const stage = buildNonCompactingStageWinner({ db, projectId: "p1", sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", oldBoardRevision: 0, expectedTarget: [], placement: "append", auditId: "winner-1", actorId: "u", auditAction: "stage.set", auditMetaJson: "{}", now: NOW });
    const activity = buildStageActivityBundle({ db, projectId: "p1", activityId: "a0000000-0000-4000-8000-0000000000ff", actorId: "u", winnerAuditId: "winner-1" });
    const workflow = buildWorkflowTail({ db, auditId: "winner-1", kind: "none" }, "none");
    const terminal = { statements: [{} as D1PreparedStatement], indexes: { terminalAssertion: 0 } };
    const fill = buildStageShootDateFill({ db, projectId: "p1", from: "awaiting_raw", to: "raw_review", winnerAuditId: "winner-1", winnerAuditAction: "stage.set", fillAuditId: "f", actorId: "u", now: NOW })!;

    const without = composeStageBundle({ stage, activity, workflow, terminal });
    const withFill = composeStageBundle({ stage, activity, workflow, terminal, shootDateFill: fill });
    expect(without.indexes.shootDateFill).toBeUndefined();
    const { shootDateFill, ...rest } = withFill.indexes;
    expect(rest).toEqual(without.indexes);
    expect(withFill.statements.slice(0, without.statements.length)).toEqual(without.statements);
    expect(shootDateFill).toEqual({ update: without.statements.length, audit: without.statements.length + 1 });
    expect(withFill.statements).toHaveLength(without.statements.length + 2);
  });
});
