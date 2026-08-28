import { buildNonCompactingStageWinner, buildWorkflowTail, composeStageBundle } from "./stage-board-bundles";
import { boardContractEnabled, boardSchemaVariant } from "./board-schema-variant";

export type GuardedStageTransitionInput = {
  projectId: string;
  from: string;
  to: string;
  action?: string;
  actorId?: string | null;
  meta: Record<string, unknown>;
  /** The caller may preallocate this to make a replay use the same audit identity. */
  auditId?: string;
  now?: Date;
};

/**
 * Compatibility wrapper for the old callers. The production writer is now the DB-owned
 * non-compacting winner bundle; this helper deliberately has no post-commit hook.
 */
export async function guardedStageTransition(
  d1: D1Database,
  input: GuardedStageTransitionInput,
): Promise<boolean> {
  const variant = await boardSchemaVariant(d1);
  if (variant === "pre_0037" || !await boardContractEnabled(d1, variant)) return false;
  const now = input.now ?? new Date();
  const auditId = input.auditId ?? crypto.randomUUID();
  const source = await d1.prepare("SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL")
    .bind(input.projectId, input.from).first<{ boardRevision: number }>();
  if (!source) return false;
  const target = await d1.prepare("SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id")
    .bind(input.to, input.projectId).all<{ projectId: string; stageKey: string; boardPosition: number; boardRevision: number }>();
  const stage = buildNonCompactingStageWinner({
    db: d1,
    projectId: input.projectId,
    sourceStageKey: input.from as never,
    targetStageKey: input.to as never,
    oldBoardRevision: source.boardRevision,
    expectedTarget: target.results.map((row) => ({ ...row, stageKey: row.stageKey as never })),
    expectedTargetRowCount: target.results.length,
    placement: "append",
    auditId,
    actorId: input.actorId,
    auditAction: input.action ?? "stage.auto_advance",
    auditMetaJson: JSON.stringify({ from: input.from, to: input.to, ...input.meta }),
    updatedAt: now.getTime(),
  });
  const bundle = composeStageBundle({ stage, workflow: buildWorkflowTail({ db: d1, auditId, kind: "none" }, "none") });
  const result = await d1.batch(bundle.statements);
  return (result[bundle.indexes.stage.winner]?.meta.changes ?? 0) === 1
    && (result[bundle.indexes.stage.auditMarker]?.meta.changes ?? 0) === 1;
}
