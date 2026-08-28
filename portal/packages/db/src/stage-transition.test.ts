import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardedStageTransition } from "./stage-transition";
import { notificationCopy } from "./notifications";

function database(changes: number): D1Database {
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
    batch: vi.fn().mockResolvedValue([{ meta: { changes } }, { meta: { changes: changes ? 1 : 0 } }]),
  } as unknown as D1Database;
}

describe("guardedStageTransition post-success hook", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("runs once only for a real guarded transition", async () => {
    const hook = vi.fn();
    expect(await guardedStageTransition(database(1), { projectId: "p", from: "awaiting_raw", to: "raw_review", meta: {}, onSuccess: hook })).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await guardedStageTransition(database(0), { projectId: "p", from: "awaiting_raw", to: "raw_review", meta: {}, onSuccess: hook })).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed hook from the committed transition", async () => {
    const error = new Error("email failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(guardedStageTransition(database(1), { projectId: "p", from: "editing_autohdr", to: "edited_review", meta: {}, onSuccess: () => { throw error; } })).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith("Guarded stage transition post-success hook failed", expect.objectContaining({ projectId: "p", error }));
  });
});

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes?: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process.getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

class LocalD1Statement {
  constructor(private readonly db: SqliteDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = this.db.prepare(this.sql);
    return {
      run: async () => {
        const result = statement.run(...values);
        return { meta: { changes: Number(result.changes ?? 0) } };
      },
    } as unknown as D1PreparedStatement;
  }
}

function localD1(db: SqliteDatabase): D1Database {
  return {
    prepare: (sql: string) => new LocalD1Statement(db, sql),
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe("guardedStageTransition current append contract", () => {
  it("appends at MAX + 1024, writes one audit, and only hooks the winning batch", async () => {
    const sqlite = localSqlite();
    try {
      sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, stage_key TEXT NOT NULL, board_position REAL NOT NULL, archived_at INTEGER, updated_at INTEGER NOT NULL)");
      sqlite.exec("CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, meta_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
      sqlite.exec("INSERT INTO projects (id, stage_key, board_position, updated_at) VALUES ('target', 'awaiting_raw', 0, 1), ('raw-a', 'raw_review', 1024, 1), ('raw-b', 'raw_review', 1536, 1)");

      const hook = vi.fn();
      const d1 = localD1(sqlite);
      await expect(guardedStageTransition(d1, {
        projectId: "target",
        from: "awaiting_raw",
        to: "raw_review",
        meta: { trigger: "characterization" },
        auditId: "audit-target",
        now: new Date(2),
        onSuccess: hook,
      })).resolves.toBe(true);

      expect(sqlite.prepare("SELECT stage_key, board_position FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "raw_review", board_position: 2560 });
      expect(sqlite.prepare("SELECT action, target_id, meta_json FROM audit_log WHERE target_id = 'target'").all()).toEqual([
        { action: "stage.auto_advance", target_id: "target", meta_json: JSON.stringify({ from: "awaiting_raw", to: "raw_review", trigger: "characterization" }) },
      ]);
      expect(hook).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("notification copy", () => {
  it("keeps integration vendor details out of every recipient-facing AutoHDR copy field", () => {
    for (const type of ["sent_to_editing", "autohdr_stalled"] as const) {
      const copy = notificationCopy(type, "6/120 Beach Street");
      expect(`${copy.title} ${copy.body}`).not.toContain("AutoHDR");
      expect(`${copy.title} ${copy.body}`).not.toContain("connection");
      expect(`${copy.title} ${copy.body}`).not.toContain("folder");
    }
  });
});
