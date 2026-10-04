import { sydneyBusinessDate, type StageKey } from "@quincy/shared";
import { buildAutomaticDeadlineBundle, buildAutomaticDeadlineMoveBundle } from "./automatic-deadline";
import type { PreparedStatementBundle } from "./stage-board-bundles";

/**
 * Shoot date fill: when a Project leaves Awaiting RAW, or a Deadline is set outside it, and its
 * Shoot date is empty, the Shoot date becomes today's Australia/Sydney date. Empty means SQL NULL
 * only; a canonical date or any held text (even an empty string) is never touched.
 *
 * The fill is two adjacent statements appended to the caller's existing batch:
 *  1. an UPDATE gated on SQL-level state and on the trigger's own audit row (this attempt's fresh
 *     winner audit id), never on `changes()` of whichever statement happened to precede it, and
 *  2. an audit INSERT gated on `changes() = 1`, which is safe because it directly follows (1).
 *
 * The audit deliberately carries no `eventReceivedAt`, so a later verified Tonomo appointment is
 * not fenced out by it (see commitShootDateChange).
 */
export type ShootDateFillIndexes = {
  update: number;
  audit: number;
  /**
   * The Automatic Deadline UPDATE (#484), present only on a stage-move fill: leaving Awaiting RAW
   * gives the Shoot date it just filled an Automatic Deadline when the Deadline is empty, gated on
   * this fill's own audit row so it lands exactly when the fill did.
   */
  automaticDeadline?: number;
  /**
   * The Automatic Deadline move UPDATE (#510), after the set bundle: a Deadline the system set earlier and that
   * outlived a cleared Shoot date follows the date the fill wrote. Mutually exclusive with the set bundle (the set
   * needs `deadline_at IS NULL`, the move needs it held), gated on the same fill audit row, and it takes no
   * Deadline version the caller read (see docs/lessons.md, #485).
   */
  automaticDeadlineMove?: number;
};
export type ShootDateFillReason = "stage_move" | "deadline_set";
export type ShootDateFillTrigger =
  | { kind: "stage_move"; destinationStage: StageKey; winnerAuditId: string; winnerAuditAction: "stage.set" | "stage.auto_advance" }
  | { kind: "deadline_set"; winnerAuditId: string };

export const SHOOT_DATE_FILL_AUDIT_ACTION = "project.shoot_date.changed";
const DEADLINE_SAVED_AUDIT_ACTION = "project.deadline.schedule_saved";

/** A Stage move fills only when it leaves Awaiting RAW for some other Stage. */
export function stageMoveFillsShootDate(from: StageKey, to: StageKey): boolean {
  return from === "awaiting_raw" && to !== "awaiting_raw";
}

const FILL_UPDATE_HEAD = `UPDATE projects SET shoot_date = ?1, updated_at = ?2
WHERE id = ?3 AND shoot_date IS NULL AND archived_at IS NULL`;
const FILL_UPDATE_TAIL = `AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?4 AND action = ?5 AND target_type = 'project' AND target_id = ?3)
RETURNING id, shoot_date;`;
const STAGE_FILL_UPDATE_SQL = `${FILL_UPDATE_HEAD}
AND stage_key = ?6
${FILL_UPDATE_TAIL}`;
const DEADLINE_FILL_UPDATE_SQL = `${FILL_UPDATE_HEAD}
AND stage_key <> 'awaiting_raw' AND deadline_at IS NOT NULL
${FILL_UPDATE_TAIL}`;
const FILL_AUDIT_SQL = `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
SELECT ?1, ?2, '${SHOOT_DATE_FILL_AUDIT_ACTION}', 'project', ?3, ?4, ?5
WHERE changes() = 1
RETURNING id;`;

export function buildShootDateFillBundle(input: {
  db: D1Database;
  projectId: string;
  trigger: ShootDateFillTrigger;
  fillAuditId: string;
  /** The requesting user, or null when the path's own stage audit has no actor. */
  actorId: string | null;
  /** The Admin impersonating `actorId`, when there is one (mirrors `auditMeta`). */
  impersonatedBy?: string | null;
  now: number;
}): PreparedStatementBundle<ShootDateFillIndexes> {
  const shootDate = sydneyBusinessDate(input.now);
  const reason: ShootDateFillReason = input.trigger.kind;
  const meta: Record<string, unknown> = { shootDate, previousShootDate: null, reason };
  if (input.impersonatedBy) meta.impersonatedBy = input.impersonatedBy;
  const update = input.trigger.kind === "stage_move"
    ? input.db.prepare(STAGE_FILL_UPDATE_SQL).bind(shootDate, input.now, input.projectId, input.trigger.winnerAuditId, input.trigger.winnerAuditAction, input.trigger.destinationStage)
    : input.db.prepare(DEADLINE_FILL_UPDATE_SQL).bind(shootDate, input.now, input.projectId, input.trigger.winnerAuditId, DEADLINE_SAVED_AUDIT_ACTION);
  const audit = input.db.prepare(FILL_AUDIT_SQL).bind(input.fillAuditId, input.actorId, input.projectId, JSON.stringify(meta), input.now);
  // A `deadline_set` fill never qualifies: that Project already holds a Deadline by definition.
  const automaticDeadline = input.trigger.kind === "stage_move"
    ? buildAutomaticDeadlineBundle({ db: input.db, projectId: input.projectId, shootDate, gate: { kind: "audit", auditId: input.fillAuditId }, auditId: crypto.randomUUID(), reason: "shoot_date_fill", now: input.now })
    : undefined;
  const automaticDeadlineMove = input.trigger.kind === "stage_move"
    ? buildAutomaticDeadlineMoveBundle({ db: input.db, projectId: input.projectId, shootDate, gate: { kind: "audit", auditId: input.fillAuditId }, auditId: crypto.randomUUID(), reason: "shoot_date_fill", now: input.now })
    : undefined;
  if (!automaticDeadline || !automaticDeadlineMove) return { statements: [update, audit], indexes: { update: 0, audit: 1 } };
  const moveOffset = 2 + automaticDeadline.statements.length;
  return {
    statements: [update, audit, ...automaticDeadline.statements, ...automaticDeadlineMove.statements],
    indexes: { update: 0, audit: 1, automaticDeadline: 2 + automaticDeadline.indexes.update, automaticDeadlineMove: moveOffset + automaticDeadlineMove.indexes.update },
  };
}

/**
 * Stage-move flavour: undefined unless the move leaves Awaiting RAW. `to` is also the SQL stage
 * guard, so a Project that has since moved again is never filled by this attempt.
 */
export function buildStageShootDateFill(input: {
  db: D1Database;
  projectId: string;
  from: StageKey;
  to: StageKey;
  winnerAuditId: string;
  winnerAuditAction: "stage.set" | "stage.auto_advance";
  fillAuditId: string;
  actorId: string | null;
  impersonatedBy?: string | null;
  now: number;
}): PreparedStatementBundle<ShootDateFillIndexes> | undefined {
  if (!stageMoveFillsShootDate(input.from, input.to)) return undefined;
  return buildShootDateFillBundle({
    db: input.db,
    projectId: input.projectId,
    trigger: { kind: "stage_move", destinationStage: input.to, winnerAuditId: input.winnerAuditId, winnerAuditAction: input.winnerAuditAction },
    fillAuditId: input.fillAuditId,
    actorId: input.actorId,
    impersonatedBy: input.impersonatedBy,
    now: input.now,
  });
}

/** True only when this batch's fill UPDATE changed exactly one row (the follow-up gate). */
export function shootDateFillLanded(results: readonly D1Result<unknown>[], indexes: ShootDateFillIndexes | undefined): boolean {
  if (!indexes) return false;
  return (results[indexes.update]?.meta.changes ?? 0) === 1;
}
