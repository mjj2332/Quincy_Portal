import { describe, expect, it } from "vitest";
import { applyBoardProofSchema, localSqlite } from "./tb5a-proof-support";

describe("projects.board_position default (Board order Stage B, #475)", () => {
  it("accepts an INSERT that omits board_position across the full migration chain and lands 0", () => {
    const db = localSqlite();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyBoardProofSchema(db);
      db.prepare("INSERT INTO projects (id, street, stage_key, board_revision, created_at, updated_at) VALUES ('p1', 'Street', 'awaiting_raw', 0, 1, 1)").run();
      expect(db.prepare("SELECT board_position, board_revision FROM projects WHERE id = 'p1'").get()).toEqual({ board_position: 0, board_revision: 0 });
    } finally {
      db.close();
    }
  });
});
