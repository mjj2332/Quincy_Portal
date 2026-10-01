import { SUBTASK_REMINDER_DEFAULT_OFFSETS, type SubtaskReminderKind, type SubtaskReminderState } from "@quincy/shared";
import type { PreparedStatementBundle } from "./stage-board-bundles";

/**
 * Subtask reminder scheduling (#424, ADR 0016): one INSERT...SELECT that materialises occurrences for the current schedule version, and
 * one three-statement suppression that mirrors `buildDeadlineSuppressionBundle`. Migration 0053 writes the same predicate once for the
 * backfill, and `test/migration-0053.test.ts` pins the two against each other. Every statement here is built from SQL text plus bound
 * values (`...Sql` functions), so a node:sqlite test can run exactly what D1 runs.
 */
export type SubtaskReminderMaterializationScope =
  | { kind: "subtask"; subtaskId: string }
  | { kind: "project"; projectId: string }
  | { kind: "all" };

export type SubtaskReminderSuppressionScope =
  | { kind: "subtask"; projectId: string; subtaskId: string }
  | { kind: "project"; projectId: string };

export type SubtaskReminderSuppressionReason = "schedule_replaced" | "subtask_completed" | "project_archived" | "subtask_deleted";

export type SqlWithValues = { sql: string; values: unknown[] };

const SUBTASK_REMINDER_EVENT = "project.subtask.reminder";

/** The same UUID-shaped SQL expression `project-deadline.ts` uses for its outbox ids. */
export const SQL_UUID_V4 = "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";

const AUDIT_GATE = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";

export function subtaskReminderMaterializationSql(input: { scope: SubtaskReminderMaterializationScope; now: number; createdBy: string | null; gateAuditId?: string }): SqlWithValues {
  const scopeClause = input.scope.kind === "subtask" ? "AND s.id = ?" : input.scope.kind === "project" ? "AND s.project_id = ?" : "";
  const scopeValues = input.scope.kind === "subtask" ? [input.scope.subtaskId] : input.scope.kind === "project" ? [input.scope.projectId] : [];
  const sql = `
    INSERT INTO project_subtask_reminder_occurrences
      (id, subtask_id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, due_at, due_local_civil,
       due_zone, due_utc_offset_minutes, due_fold, status, terminal_reason, fired_at, created_by, created_at, updated_at)
    SELECT ${SQL_UUID_V4}, s.id, s.project_id, s.schedule_version,
      CASE WHEN o.value = 0 THEN 'due_now' ELSE 'advance' END,
      o.value, s.schedule_end_at - (o.value * 60000), s.schedule_end_at, s.due_date,
      'Australia/Sydney', s.schedule_end_utc_offset_minutes, s.schedule_end_fold, 'pending', NULL, NULL, ?, ?, ?
    FROM project_subtasks s
    JOIN projects p ON p.id = s.project_id,
    json_each(json_insert(s.reminder_offsets_json, '$[#]', 0)) o
    WHERE typeof(o.value) = 'integer' AND o.value BETWEEN 0 AND 43200
      AND s.done = 0 AND p.archived_at IS NULL AND s.due_reminder_sent_at IS NULL
      AND s.schedule_end_at IS NOT NULL AND s.schedule_zone = 'Australia/Sydney'
      AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IN (0, 1)
      AND s.schedule_end_at - (o.value * 60000) > ?
      ${scopeClause}
      AND NOT EXISTS (
        SELECT 1 FROM project_subtask_reminder_occurrences live
        WHERE live.subtask_id = s.id AND live.schedule_version = s.schedule_version
          AND live.reminder_offset_minutes = o.value
          AND live.kind = CASE WHEN o.value = 0 THEN 'due_now' ELSE 'advance' END
          AND live.status IN ('pending', 'fired')
      )
      ${input.gateAuditId === undefined ? "" : `AND ${AUDIT_GATE}`}
    GROUP BY s.id, o.value
  `;
  return { sql, values: [input.createdBy, input.now, input.now, input.now, ...scopeValues, ...(input.gateAuditId === undefined ? [] : [input.gateAuditId])] };
}

export type SubtaskReminderMaterializationBundleInput = {
  db: D1Database;
  scope: SubtaskReminderMaterializationScope;
  now: number;
  /** The acting user, or null for the system (the hourly reconcile). */
  createdBy: string | null;
  /** Fence the INSERT on the winning audit row so a lost compare-and-swap writes nothing. */
  gateAuditId?: string;
};

/** Inserts the pending occurrences the Subtask's current schedule version still lacks. Idempotent: a live row blocks its repeat. */
export function buildSubtaskReminderMaterialization(input: SubtaskReminderMaterializationBundleInput): PreparedStatementBundle<{ materialize: number }> {
  const { sql, values } = subtaskReminderMaterializationSql(input);
  return { statements: [input.db.prepare(sql).bind(...values)], indexes: { materialize: 0 } };
}

function occurrenceStaleSql(reason: SubtaskReminderSuppressionReason): string {
  switch (reason) {
    case "subtask_completed": return "EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = x.subtask_id AND s.done = 1)";
    case "project_archived": return "EXISTS (SELECT 1 FROM projects p WHERE p.id = x.project_id AND p.archived_at IS NOT NULL)";
    case "schedule_replaced": return "EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = x.subtask_id AND s.schedule_version <> x.schedule_version)";
    case "subtask_deleted": return "NOT EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = x.subtask_id)";
  }
}

function outboxStaleSql(reason: SubtaskReminderSuppressionReason): string {
  const subtaskId = "json_extract(o.payload_json, '$.reminder.subtaskId')";
  switch (reason) {
    case "subtask_completed": return `EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = ${subtaskId} AND s.done = 1)`;
    case "project_archived": return "EXISTS (SELECT 1 FROM projects p WHERE p.id = o.project_id AND p.archived_at IS NOT NULL)";
    case "schedule_replaced": return `EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = ${subtaskId} AND s.schedule_version <> json_extract(o.payload_json, '$.reminder.scheduleVersion'))`;
    case "subtask_deleted": return `NOT EXISTS (SELECT 1 FROM project_subtasks s WHERE s.id = ${subtaskId})`;
  }
}

/** The three suppression statements as SQL plus values, in order: occurrences (omitted for a deleted Subtask, whose rows cascade), ledgers, outboxes. */
export function subtaskReminderSuppressionSql(input: { scope: SubtaskReminderSuppressionScope; reason: SubtaskReminderSuppressionReason; now: number; gateAuditId: string }): { occurrences: SqlWithValues | null; ledgers: SqlWithValues; outboxes: SqlWithValues } {
  const message = `Subtask reminder suppressed: ${input.reason}.`;
  const occurrenceScope = input.scope.kind === "subtask" ? "x.subtask_id = ?" : "x.project_id = ?";
  const scopeId = input.scope.kind === "subtask" ? input.scope.subtaskId : input.scope.projectId;
  // Not LIKE: D1 refuses a LIKE pattern over 50 bytes, and `subtask-reminder:<uuid>:%` is 55. The prefix is compared exactly instead.
  const sourceKeyPrefix = input.scope.kind === "subtask" ? `subtask-reminder:${input.scope.subtaskId}:` : "";
  const outboxScope = input.scope.kind === "subtask"
    ? `o.project_id = ? AND substr(o.source_key, 1, ${sourceKeyPrefix.length}) = ?`
    : "o.project_id = ?";
  const outboxScopeValues = input.scope.kind === "subtask" ? [input.scope.projectId, sourceKeyPrefix] : [input.scope.projectId];
  const stale = outboxStaleSql(input.reason);
  return {
    occurrences: input.reason === "subtask_deleted" ? null : {
      sql: `UPDATE project_subtask_reminder_occurrences AS x
        SET status = 'superseded', terminal_reason = ?, fired_at = NULL, updated_at = ?
        WHERE ${occurrenceScope} AND x.status = 'pending' AND ${occurrenceStaleSql(input.reason)}
          AND ${AUDIT_GATE}`,
      values: [input.reason, input.now, scopeId, input.gateAuditId],
    },
    ledgers: {
      sql: `UPDATE notification_delivery_ledger
        SET status = 'suppressed', last_error_code = 'reauthorization_suppressed', last_error = ?, updated_at = ?
        WHERE event_type = '${SUBTASK_REMINDER_EVENT}' AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM notification_outbox o
            WHERE o.id = notification_delivery_ledger.outbox_id AND o.event_type = '${SUBTASK_REMINDER_EVENT}'
              AND ${outboxScope} AND ${stale}
          )
          AND ${AUDIT_GATE}`,
      values: [message, input.now, ...outboxScopeValues, input.gateAuditId],
    },
    outboxes: {
      sql: `UPDATE notification_outbox AS o
        SET status = 'suppressed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?,
            last_error_code = 'reauthorization_suppressed', last_error = ?, updated_at = ?
        WHERE o.event_type = '${SUBTASK_REMINDER_EVENT}' AND o.status IN ('pending', 'queued')
          AND ${outboxScope} AND ${stale}
          AND NOT EXISTS (
            SELECT 1 FROM notification_delivery_ledger
            WHERE outbox_id = o.id AND status IN ('pending', 'processing')
          )
          AND ${AUDIT_GATE}`,
      values: [input.now, message, input.now, ...outboxScopeValues, input.gateAuditId],
    },
  };
}

export type SubtaskReminderSuppressionBundleInput = { db: D1Database; scope: SubtaskReminderSuppressionScope; reason: SubtaskReminderSuppressionReason; now: number; gateAuditId: string };
export type SubtaskReminderSuppressionIndexes = { occurrences: number | null; ledgers: number; outboxes: number };

export function buildSubtaskReminderSuppression(input: SubtaskReminderSuppressionBundleInput): PreparedStatementBundle<SubtaskReminderSuppressionIndexes> {
  const built = subtaskReminderSuppressionSql(input);
  const statements: D1PreparedStatement[] = [];
  let occurrences: number | null = null;
  if (built.occurrences) {
    occurrences = statements.length;
    statements.push(input.db.prepare(built.occurrences.sql).bind(...built.occurrences.values));
  }
  const ledgers = statements.length;
  statements.push(input.db.prepare(built.ledgers.sql).bind(...built.ledgers.values));
  const outboxes = statements.length;
  statements.push(input.db.prepare(built.outboxes.sql).bind(...built.outboxes.values));
  return { statements, indexes: { occurrences, ledgers, outboxes } };
}

const READ_CHUNK = 40;

/**
 * The reminders a Subtask has now, for #425's editor: the stored advance offsets and the next pending occurrence of the current schedule
 * version. Internal: no HTTP route or DTO reads it yet (#424).
 */
export async function readSubtaskReminderState(db: D1Database, subtaskIds: readonly string[], now: number): Promise<Map<string, SubtaskReminderState>> {
  const result = new Map<string, SubtaskReminderState>();
  for (let start = 0; start < subtaskIds.length; start += READ_CHUNK) {
    const chunk = subtaskIds.slice(start, start + READ_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await db.prepare(`
      SELECT s.id AS subtaskId, s.reminder_offsets_json AS offsetsJson,
        (SELECT x.fire_at || ':' || x.kind || ':' || x.reminder_offset_minutes
           FROM project_subtask_reminder_occurrences x
           WHERE x.subtask_id = s.id AND x.schedule_version = s.schedule_version AND x.status = 'pending' AND x.fire_at > ?
           ORDER BY x.fire_at, x.id LIMIT 1) AS next
      FROM project_subtasks s WHERE s.id IN (${placeholders})
    `).bind(now, ...chunk).all<{ subtaskId: string; offsetsJson: string; next: string | null }>()).results;
    for (const row of rows) {
      let offsets: number[] = [...SUBTASK_REMINDER_DEFAULT_OFFSETS];
      try {
        const parsed: unknown = JSON.parse(row.offsetsJson);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number" && Number.isSafeInteger(value))) offsets = (parsed as number[]).slice().sort((a, b) => b - a);
      } catch { /* the column CHECK guarantees a JSON array, so this is unreachable */ }
      let nextReminder: SubtaskReminderState["nextReminder"] = null;
      if (row.next) {
        const [fireAt, kind, offsetMinutes] = row.next.split(":");
        nextReminder = { fireAt: Number(fireAt), kind: kind as SubtaskReminderKind, offsetMinutes: Number(offsetMinutes) };
      }
      result.set(row.subtaskId, { offsetsMinutes: offsets, nextReminder });
    }
  }
  return result;
}
