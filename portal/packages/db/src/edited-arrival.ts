import { EDITED_ARRIVAL_SOURCE_STAGES } from "@quincy/shared";

const SOURCE_STAGES_SQL = EDITED_ARRIVAL_SOURCE_STAGES.map((stage) => `'${stage}'`).join(", ");

/**
 * Records a Project's latest Edited-media arrival (#486) as one statement of the caller's atomic
 * D1 batch. `gateSql` must be an EXISTS(...) fence proving THIS attempt created the Edited asset
 * (its fresh ingest audit row, or its freshly inserted row), so an unchanged rescan, a rejected
 * hash, a losing supersede or a duplicate completion can never restart the quiet period.
 *
 * Only a Project that could still move (a source Stage, not Archived) records an arrival, which
 * keeps the marker from accumulating on Edited review and Delivered Projects. An arrival is not a
 * Project edit: this never bumps `updated_at` or `board_revision`.
 */
export function buildEditedArrivalRecord(
  db: D1Database,
  input: { projectId: string; now: number; gateSql: string; gateBindings: readonly unknown[] },
): D1PreparedStatement {
  return db.prepare(
    `UPDATE projects SET edited_arrived_at = MAX(COALESCE(edited_arrived_at, 0), ?), edited_arrival_attempts = 0, edited_arrival_retry_at = NULL WHERE id = ? AND archived_at IS NULL AND stage_key IN (${SOURCE_STAGES_SQL}) AND ${input.gateSql}`,
  ).bind(input.now, input.projectId, ...input.gateBindings);
}
