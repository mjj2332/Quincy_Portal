import { sql, type SQL } from "drizzle-orm";

/** SQL expression used in the same stage-changing statement as the stage write. */
export function appendToStageBottomExpr(stageKey: string, excludeProjectId: string): SQL {
  return sql`(SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ${stageKey} AND archived_at IS NULL AND id != ${excludeProjectId})`;
}

export function computeInsertPosition(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return after! - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}
