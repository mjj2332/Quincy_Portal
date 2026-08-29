import { BOARD_CONTRACT_FLAG } from "./board-schema-variant";

/**
 * Restore the positions captured by migration 0037 while its board contract is still disabled.
 *
 * The guard insert deliberately lives in the same D1 batch as the update. A drifted row makes
 * the CHECK fail, which rolls back the guard-table creation and every otherwise matching update.
 */
export async function rollbackBoardOrder0037PreEnable(d1: D1Database): Promise<{ rolledBack: number }> {
  const row = await d1
    .prepare("SELECT COUNT(*) AS count FROM project_board_order_0037_rollback")
    .first<{ count: number }>();
  const expectedCount = Number(row?.count ?? 0);
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    throw new Error("Migration 0037 rollback requires a positive captured row count");
  }

  await d1.batch([
    d1.prepare(`
      CREATE TABLE _tb5a_0037_position_rollback_guard (
        ok INTEGER NOT NULL CHECK (ok = 1)
      )
    `),
    d1.prepare(`
      INSERT INTO _tb5a_0037_position_rollback_guard (ok)
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM projects p
          WHERE p.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM project_board_order_0037_rollback r
              WHERE r.project_id = p.id
            )
        ) THEN 1
        ELSE 0
      END
    `),
    d1.prepare(`
      INSERT INTO _tb5a_0037_position_rollback_guard (ok)
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM feature_flags WHERE key = ?1)
           AND NOT EXISTS (
             SELECT 1
             FROM feature_flags
             WHERE key = ?1
               AND enabled = 1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM projects
             WHERE archived_at IS NULL
               AND board_revision >= 2
           ) THEN 1
        ELSE 0
      END
    `).bind(BOARD_CONTRACT_FLAG),
    d1.prepare(`
      UPDATE projects AS p
      SET board_position = r.old_board_position
      FROM project_board_order_0037_rollback AS r
      WHERE p.id = r.project_id
        AND p.archived_at IS NULL
        AND p.stage_key = r.stage_key
        AND p.board_position IS r.normalized_board_position
        AND p.board_revision = ?1
    `).bind(1),
    d1.prepare(`
      INSERT INTO _tb5a_0037_position_rollback_guard (ok)
      VALUES (
        CASE
          WHEN changes() = ?1 THEN 1
          ELSE 0
        END
      )
    `).bind(expectedCount),
    d1.prepare("DROP TABLE _tb5a_0037_position_rollback_guard"),
  ]);

  return { rolledBack: expectedCount };
}
