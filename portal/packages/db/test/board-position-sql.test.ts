import { describe, expect, it } from "vitest";

describe("atomic append-to-bottom expression", () => {
  it("uses zero for an empty stage and distinct positions for serialized arrivals", () => {
    const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
    const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...values: unknown[]) => unknown; all: () => Array<{ board_position: number }> } } };
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, stage_key TEXT NOT NULL, board_position REAL NOT NULL DEFAULT 0, archived_at INTEGER)");
    const move = db.prepare("UPDATE projects SET stage_key = ?, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?) WHERE id = ? AND stage_key = ? AND archived_at IS NULL");
    db.prepare("INSERT INTO projects (id, stage_key) VALUES (?, ?)").run("a", "raw_review");
    db.prepare("INSERT INTO projects (id, stage_key) VALUES (?, ?)").run("b", "raw_review");
    move.run("edited_review", "edited_review", "a", "a", "raw_review");
    move.run("edited_review", "edited_review", "b", "b", "raw_review");
    expect(db.prepare("SELECT board_position FROM projects WHERE stage_key = 'edited_review' ORDER BY board_position").all().map((row) => row.board_position)).toEqual([0, 1024]);
  });
});
