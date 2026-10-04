import {
  automaticDeadlineFor,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS,
  PROJECT_DEADLINE_ZONE,
  planDeadlineOccurrences,
} from "@quincy/shared";
import type { PreparedStatementBundle } from "./stage-board-bundles";

/**
 * Automatic Deadline (#484, #479): a Project that gains a canonical Shoot date while its Deadline is
 * empty is given the first Monday-Friday after the shoot at 17:00 Sydney time, source `automatic`,
 * with the default reminders. Every route that gains a Shoot date appends this bundle at the END of
 * its own batch, in the same atomic write as the date.
 *
 *  1. an UPDATE of the five `deadline_*` columns, the offsets, the version and the source. Its WHERE
 *     holds the whole eligibility rule in SQL (Deadline empty, Shoot date is the one just written,
 *     not archived, not Delivered) and is gated on the caller's own winner audit row, never on
 *     `changes()` of whatever statement came before, so a lost race writes nothing;
 *  2. a system audit INSERT gated on `changes() = 1`, which is safe because it directly follows (1);
 *  3. one occurrence INSERT per reminder, gated on that audit row.
 *
 * It writes no activity, outbox row or notification: the audit row is the whole record.
 */
export type AutomaticDeadlineIndexes = { update: number; audit: number };
export type AutomaticDeadlineReason = "create" | "details" | "tonomo_create" | "tonomo_update" | "shoot_date_fill";

export const AUTOMATIC_DEADLINE_AUDIT_ACTION = "project.deadline.automatic_set";

export type AutomaticDeadlineGate =
  /** The caller's winner audit row (or any row that only a winning write inserts). */
  | { kind: "audit"; auditId: string }
  /** No audit row exists to gate on: the UPDATE's own predicates are the gate (Tonomo create and update). */
  | { kind: "none" };

const UPDATE_HEAD = `UPDATE projects SET
  deadline_local_civil = ?1, deadline_zone = ?2, deadline_utc_offset_minutes = ?3, deadline_fold = ?4,
  deadline_at = ?5, deadline_reminder_offsets_json = ?6, deadline_version = deadline_version + 1,
  deadline_source = 'automatic', updated_at = ?7
WHERE id = ?8 AND deadline_at IS NULL AND shoot_date = ?9 AND archived_at IS NULL AND stage_key <> 'delivered'`;
const AUDIT_SQL = `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
SELECT ?1, NULL, '${AUTOMATIC_DEADLINE_AUDIT_ACTION}', 'project', ?2,
  json_object('actor', 'system', 'reason', ?3, 'shootDate', ?4, 'deadlineLocalCivil', ?5, 'reminderOffsetsMinutes', json(?6),
    'version', (SELECT deadline_version FROM projects WHERE id = ?2)),
  ?7
WHERE changes() = 1
RETURNING id;`;
const OCCURRENCE_SQL = `INSERT INTO project_deadline_occurrences
  (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at,
   deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold,
   status, terminal_reason, fired_at, created_by, created_at, updated_at)
SELECT ?1, ?2, p.deadline_version, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14, ?14
FROM projects p
WHERE p.id = ?2 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?15)
RETURNING id;`;

/** Undefined unless `shootDate` is a canonical calendar date (free text is never guessed at). */
export function buildAutomaticDeadlineBundle(input: {
  db: D1Database;
  projectId: string;
  shootDate: string;
  gate: AutomaticDeadlineGate;
  /** The id this bundle's own system audit row is written under. */
  auditId: string;
  reason: AutomaticDeadlineReason;
  now: number;
}): PreparedStatementBundle<AutomaticDeadlineIndexes> | undefined {
  const deadline = automaticDeadlineFor(input.shootDate);
  if (!deadline) return undefined;
  const offsetsJson = JSON.stringify([...PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS]);
  const gateSql = input.gate.kind === "audit" ? "\nAND EXISTS (SELECT 1 FROM audit_log WHERE id = ?10)" : "";
  const updateSql = `${UPDATE_HEAD}${gateSql}\nRETURNING id, deadline_version;`;
  const updateBinds: unknown[] = [deadline.localCivil, PROJECT_DEADLINE_ZONE, deadline.utcOffsetMinutes, deadline.fold, deadline.epochMs, offsetsJson, input.now, input.projectId, input.shootDate];
  if (input.gate.kind === "audit") updateBinds.push(input.gate.auditId);
  const update = input.db.prepare(updateSql).bind(...updateBinds);
  const audit = input.db.prepare(AUDIT_SQL).bind(input.auditId, input.projectId, input.reason, input.shootDate, deadline.localCivil, offsetsJson, input.now);
  const occurrences = planDeadlineOccurrences(deadline.epochMs, PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS, input.now, { skipElapsedDueNow: true }).map((occurrence) =>
    input.db.prepare(OCCURRENCE_SQL).bind(
      crypto.randomUUID(), input.projectId, occurrence.kind, occurrence.offsetMinutes, occurrence.fireAt, deadline.epochMs,
      deadline.localCivil, PROJECT_DEADLINE_ZONE, deadline.utcOffsetMinutes, deadline.fold, occurrence.status, occurrence.terminalReason,
      PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, input.now, input.auditId,
    ));
  return { statements: [update, audit, ...occurrences], indexes: { update: 0, audit: 1 } };
}

/** True only when this bundle's UPDATE changed exactly one row. */
export function automaticDeadlineLanded(results: readonly D1Result<unknown>[], indexes: AutomaticDeadlineIndexes | undefined): boolean {
  if (!indexes) return false;
  return (results[indexes.update]?.meta.changes ?? 0) === 1;
}
