import {
  projectActivityDeepLink,
  type ProjectActivityType,
  type StageKey,
} from "@quincy/shared";
import { buildProjectActivityStatements } from "./project-activity";

export type PreparedStatementBundle<TIndexes> = {
  statements: D1PreparedStatement[];
  indexes: TIndexes;
};

export type StageWinnerIndexes = {
  winner: number;
  auditMarker: number;
};

export type ActivityBundleIndexes = {
  activity: number;
  broadOutbox: number;
  broadLedger: number;
};

export type DeadlineSuppressionIndexes = {
  occurrences: number;
  ledgers: number;
  outboxes: number;
};

export type GuardedTransitionPrerequisite =
  | { kind: "none" }
  | { kind: "raw_reconciliation"; claimId: string; shootDate: string }
  | {
      kind: "autohdr_handoff";
      handoffId: string;
      generation: number;
      connectionId: string;
    }
  | {
      kind: "autohdr_mapping";
      mappingId: string;
      handoffId: string;
      generation: number;
    }
  | {
      kind: "autohdr_final_claim";
      claimId: string;
      handoffId: string;
      mappingId: string;
      currentAssetId: string;
    }
  | {
      kind: "autohdr_job";
      jobId: string;
      generation: number;
      projectId: string;
    };

export type WorkflowTailIndexes =
  | { kind: "none" }
  | {
      kind: "raw_reconciliation";
      prerequisiteMarker: number;
    }
  | {
      kind: "autohdr_handoff_entry";
      prerequisiteMarker: number;
      handoffState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_mapping_entry";
      prerequisiteMarker: number;
      handoffState: number;
      mappingState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_final_completion";
      prerequisiteMarker: number;
      handoffState: number;
      mappingState: number;
      finalClaimState: number;
    }
  | {
      kind: "autohdr_job_entry";
      prerequisiteMarker: number;
      jobState: number;
      editingEntryToken: number;
    }
  | {
      kind: "autohdr_job_completion";
      prerequisiteMarker: number;
      sourceEntryJob: number;
      completionJobState: number;
    };

export type ComposedStageBundleIndexes = {
  stage: StageWinnerIndexes;
  activity?: ActivityBundleIndexes;
  deadline?: DeadlineSuppressionIndexes;
  workflow: WorkflowTailIndexes;
};

export type CommittedStageFinalizerIntent = {
  publicationIds: string[];
  legacyWorkflowNotification?:
    | "raw_ready"
    | "sent_to_editing"
    | "edited_landed";
};

export type ExpectedTargetPlacementRow = {
  projectId: string;
  stageKey: StageKey;
  boardPosition: number;
  boardRevision: number;
};

export type ExpectedTargetCompactionRow = ExpectedTargetPlacementRow & {
  newBoardPosition: number;
};

export type ChangedCompactionRow = {
  projectId: string;
  oldStageKey: StageKey;
  oldBoardPosition: number;
  oldBoardRevision: number;
  newBoardPosition: number;
  isTarget: 0 | 1;
};

export type StageWinnerInput = {
  db: D1Database;
  projectId: string;
  /** Compatibility naming for the plan's source Stage. */
  from?: StageKey;
  /** Compatibility naming for the plan's destination Stage. */
  to?: StageKey;
  sourceStageKey?: StageKey;
  targetStageKey?: StageKey;
  oldBoardRevision?: number;
  targetOldBoardRevision?: number;
  expectedTargetJson?: string;
  expectedTarget?: readonly ExpectedTargetPlacementRow[] | readonly ExpectedTargetCompactionRow[];
  expectedTargetRowCount?: number;
  featureFlagKey?: string;
  auditId: string;
  actorId?: string | null;
  action?: string;
  auditAction?: string;
  meta?: Record<string, unknown>;
  auditMetaJson?: string;
  auditMeta?: Record<string, unknown>;
  now?: number;
  updatedAt?: number;
};

export type NonCompactingStageWinnerInput = StageWinnerInput & {
  placement: "append" | "exact";
  boardPosition?: number;
  exactBoardPosition?: number;
  position?: number;
};

export type CompactingStageWinnerInput = StageWinnerInput & {
  expectedTargetJson?: string;
  expectedTarget?: readonly ExpectedTargetCompactionRow[];
  changedPlanJson?: string;
  changedPlan?: readonly ChangedCompactionRow[];
  expectedChangedRowCount?: number;
};

export type StageWinnerResultRow = {
  projectId: string;
  stageKey: StageKey;
  boardPosition: number;
  boardRevision: number;
};

export type StageFinalizerWinnerResult =
  | {
      kind: "winner";
      row: StageWinnerResultRow;
      auditId: string;
      publicationIds?: readonly string[];
      legacyWorkflowNotification?: CommittedStageFinalizerIntent["legacyWorkflowNotification"];
    }
  | { kind: "loser" | "no_op" | "conflict" | "inconsistent" };

const NON_COMPACTING_EXACT_SQL = String.raw`WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?2
      AND enabled = 1
  )
  AND json_valid(?1)
  AND (SELECT COUNT(*) FROM expected_target) = ?3
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?4
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
  )
  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ) = ?3
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?4
      AND p.archived_at IS NULL
      AND p.id <> ?5
      AND e.project_id IS NULL
  )
)
UPDATE projects AS p
SET
  stage_key = ?4,
  board_position = ?8,
  board_revision = p.board_revision + 1,
  updated_at = ?9
FROM fence
WHERE p.id = ?5
  AND p.stage_key = ?6
  AND p.board_revision = ?7
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
`;

export const APPEND_STAGE_BOTTOM_SQL = String.raw`SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
`;

const NON_COMPACTING_APPEND_SQL = NON_COMPACTING_EXACT_SQL.replace(
  "board_position = ?8",
  `board_position = (${APPEND_STAGE_BOTTOM_SQL.replace("?1", "?4").replace("?2", "?5").trimEnd()})`,
);

const COMPACTING_SQL = String.raw`WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
changed_plan AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.oldStageKey') AS old_stage_key,
    json_type(value, '$.oldStageKey') AS old_stage_key_type,
    CAST(json_extract(value, '$.oldBoardPosition') AS REAL) AS old_board_position,
    json_type(value, '$.oldBoardPosition') AS old_board_position_type,
    CAST(json_extract(value, '$.oldBoardRevision') AS INTEGER) AS old_board_revision,
    json_type(value, '$.oldBoardRevision') AS old_board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type,
    CAST(json_extract(value, '$.isTarget') AS INTEGER) AS is_target,
    json_type(value, '$.isTarget') AS is_target_type
  FROM json_each(
    CASE WHEN json_valid(?2) THEN ?2 ELSE '[]' END
  )
),
required_changed AS (
  SELECT ?7 AS project_id
  UNION ALL
  SELECT project_id
  FROM expected_target
  WHERE new_board_position IS NOT board_position
),
planned_destination AS (
  SELECT project_id, new_board_position
  FROM expected_target
  UNION ALL
  SELECT project_id, new_board_position
  FROM changed_plan
  WHERE is_target = 1
),
ordered_destination AS (
  SELECT
    project_id,
    new_board_position,
    ROW_NUMBER() OVER (
      ORDER BY new_board_position, project_id
    ) - 1 AS desired_rank
  FROM planned_destination
),
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?3
      AND enabled = 1
  )
  AND json_valid(?1)
  AND json_valid(?2)

  AND (SELECT COUNT(*) FROM expected_target) = ?5
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?6
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
  )

  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?6
      AND archived_at IS NULL
      AND id <> ?7
  ) = ?5
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?6
      AND p.archived_at IS NULL
      AND p.id <> ?7
      AND e.project_id IS NULL
  )

  AND (SELECT COUNT(*) FROM changed_plan) = ?4
  AND (SELECT COUNT(DISTINCT project_id) FROM changed_plan) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE project_id_type <> 'text'
       OR old_stage_key_type <> 'text'
       OR old_board_position_type NOT IN ('integer', 'real')
       OR old_board_revision_type <> 'integer'
       OR old_board_revision < 0
       OR old_board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
       OR is_target_type <> 'integer'
       OR is_target NOT IN (0, 1)
  )
  AND (
    SELECT COUNT(*)
    FROM changed_plan
    WHERE is_target = 1
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE is_target = 1
      AND project_id = ?7
      AND old_stage_key = ?8
      AND old_board_revision = ?9
  )

  AND (SELECT COUNT(*) FROM required_changed) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM required_changed r
    LEFT JOIN changed_plan c
      ON c.project_id = r.project_id
    WHERE c.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    LEFT JOIN required_changed r
      ON r.project_id = c.project_id
    WHERE r.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    WHERE c.is_target = 0
      AND NOT EXISTS (
        SELECT 1
        FROM expected_target e
        WHERE e.project_id = c.project_id
          AND e.stage_key = c.old_stage_key
          AND e.board_position IS c.old_board_position
          AND e.board_revision = c.old_board_revision
          AND e.new_board_position IS c.new_board_position
      )
  )

  AND (SELECT COUNT(*) FROM planned_destination) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT project_id)
    FROM planned_destination
  ) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT new_board_position)
    FROM planned_destination
  ) = ?5 + 1
  AND NOT EXISTS (
    SELECT 1
    FROM ordered_destination
    WHERE new_board_position
          IS NOT CAST(desired_rank * 1024 AS REAL)
  )

  AND (
    SELECT COUNT(*)
    FROM changed_plan c
    JOIN projects p
      ON p.id = c.project_id
    WHERE p.stage_key = c.old_stage_key
      AND p.board_position IS c.old_board_position
      AND p.board_revision = c.old_board_revision
      AND p.archived_at IS NULL
  ) = ?4
)
UPDATE projects AS p
SET
  stage_key = CASE
    WHEN c.is_target = 1 THEN ?6
    ELSE p.stage_key
  END,
  board_position = c.new_board_position,
  board_revision = p.board_revision + 1,
  updated_at = ?10
FROM changed_plan c, fence
WHERE p.id = c.project_id
  AND p.stage_key = c.old_stage_key
  AND p.board_position IS c.old_board_position
  AND p.board_revision = c.old_board_revision
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
`;

const AUDIT_MARKER_SQL = String.raw`INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  ?1,
  ?2,
  ?3,
  'project',
  ?4,
  ?5,
  ?6
WHERE changes() = ?7
RETURNING id;
`;

const HANDOFF_EDITING_ENTRY_TOKEN_SQL = String.raw`UPDATE autohdr_handoffs
SET
  editing_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND project_id = ?1
  AND connection_id = ?4
  AND generation = ?5
  AND state = ?6
  AND editing_entry_board_revision IS ?7
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?8
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  generation,
  editing_entry_board_revision;
`;

const JOB_EDITING_ENTRY_TOKEN_SQL = String.raw`UPDATE jobs
SET
  stage_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND kind = ?4
  AND project_id = ?1
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.projectId') = ?1
  AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ?5
  AND stage_entry_board_revision IS ?6
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?7
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  stage_entry_board_revision;
`;

function jsonRows<T>(json: string | undefined, rows: readonly T[] | undefined): { json: string; count: number } {
  if (json !== undefined) {
    let count = 0;
    try {
      const parsed: unknown = JSON.parse(json);
      count = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      // The normative SQL must receive malformed JSON unchanged for its fence to reject it.
    }
    return { json, count };
  }
  const value = rows ?? [];
  return { json: JSON.stringify(value), count: value.length };
}

function stageValues(input: StageWinnerInput): { from: StageKey; to: StageKey; oldRevision: number } {
  const from = input.sourceStageKey ?? input.from;
  const to = input.targetStageKey ?? input.to;
  const oldRevision = input.oldBoardRevision ?? input.targetOldBoardRevision;
  if (!from || !to || oldRevision === undefined) throw new Error("Stage winner requires source/destination Stage and old board revision");
  return { from, to, oldRevision };
}

function auditValues(input: StageWinnerInput, from: StageKey, to: StageKey, changedRows: number): [string, string | null, string, string, string, number, number] {
  const metaJson = input.auditMetaJson ?? JSON.stringify(input.auditMeta ?? input.meta ?? { from, to, changedRows });
  return [
    input.auditId,
    input.actorId ?? null,
    input.auditAction ?? input.action ?? "stage.auto_advance",
    input.projectId,
    metaJson,
    input.updatedAt ?? input.now ?? Date.now(),
    changedRows,
  ];
}

function winnerBundle(winner: D1PreparedStatement, audit: D1PreparedStatement): PreparedStatementBundle<StageWinnerIndexes> {
  return { statements: [winner, audit], indexes: { winner: 0, auditMarker: 1 } };
}

export function buildNonCompactingStageWinner(input: NonCompactingStageWinnerInput): PreparedStatementBundle<StageWinnerIndexes> {
  const { from, to, oldRevision } = stageValues(input);
  const expected = jsonRows(input.expectedTargetJson, input.expectedTarget);
  const count = input.expectedTargetRowCount ?? expected.count;
  const updatedAt = input.updatedAt ?? input.now ?? Date.now();
  const winnerSql = input.placement === "append"
    ? NON_COMPACTING_APPEND_SQL
    : NON_COMPACTING_EXACT_SQL;
  const position = input.boardPosition ?? input.exactBoardPosition ?? input.position;
  if (input.placement === "exact" && position === undefined) throw new Error("Exact Stage placement requires boardPosition");
  const winner = input.placement === "append"
    ? input.db.prepare(winnerSql).bind(expected.json, input.featureFlagKey ?? "tb5a_board_contract_enabled", count, to, input.projectId, from, oldRevision, null, updatedAt)
    : input.db.prepare(winnerSql).bind(expected.json, input.featureFlagKey ?? "tb5a_board_contract_enabled", count, to, input.projectId, from, oldRevision, position, updatedAt);
  const audit = input.db.prepare(AUDIT_MARKER_SQL).bind(...auditValues(input, from, to, 1));
  return winnerBundle(winner, audit);
}

export function buildCompactingStageWinner(input: CompactingStageWinnerInput): PreparedStatementBundle<StageWinnerIndexes> {
  const { from, to, oldRevision } = stageValues(input);
  const expected = jsonRows(input.expectedTargetJson, input.expectedTarget);
  const changed = jsonRows(input.changedPlanJson, input.changedPlan);
  const expectedCount = input.expectedTargetRowCount ?? expected.count;
  const changedCount = input.expectedChangedRowCount ?? changed.count;
  const updatedAt = input.updatedAt ?? input.now ?? Date.now();
  const winner = input.db.prepare(COMPACTING_SQL).bind(
    expected.json,
    changed.json,
    input.featureFlagKey ?? "tb5a_board_contract_enabled",
    changedCount,
    expectedCount,
    to,
    input.projectId,
    from,
    oldRevision,
    updatedAt,
  );
  const audit = input.db.prepare(AUDIT_MARKER_SQL).bind(...auditValues(input, from, to, changedCount));
  return winnerBundle(winner, audit);
}

export type StageActivityBundleInput = {
  db: D1Database;
  projectId: string;
  activityId: string;
  actorId: string;
  occurredAt?: number;
  createdAt?: number;
  winnerAuditId: string;
  excludeRecipientId?: string;
};

export function buildStageActivityBundle(input: StageActivityBundleInput): PreparedStatementBundle<ActivityBundleIndexes> {
  const occurredAt = input.occurredAt ?? Date.now();
  const activityType: ProjectActivityType = "project.stage.changed";
  const activity = buildProjectActivityStatements({
    db: input.db,
    winnerAuditId: input.winnerAuditId,
    excludeRecipientId: input.excludeRecipientId,
    createdAt: input.createdAt ?? occurredAt,
    intent: {
      schemaVersion: 1,
      activity: {
        id: input.activityId,
        type: activityType,
        projectId: input.projectId,
        actorId: input.actorId,
        actorKind: "user",
        occurredAt,
        source: {
          kind: "project_stage",
          id: input.activityId,
          key: `project-stage:${input.projectId}:transition:${input.activityId}`,
        },
        safePayload: {},
        deepLink: projectActivityDeepLink(activityType, input.projectId),
      },
      broadDelivery: {
        registryKey: activityType,
        sourceActivityId: input.activityId,
        coalesce: null,
      },
    },
  });
  return {
    statements: activity.statements,
    indexes: {
      activity: activity.activityIndex,
      broadOutbox: activity.broadOutboxIndex,
      broadLedger: activity.broadLedgerIndex,
    },
  };
}

export type ProjectDeadlineSuppressionReason = "project_delivered" | "project_archived";

export type DeadlineSuppressionBundleInput = {
  db: D1Database;
  projectId: string;
  now?: number;
  reason: ProjectDeadlineSuppressionReason;
  auditId: string;
};

export function buildDeadlineSuppressionBundle(input: DeadlineSuppressionBundleInput): PreparedStatementBundle<DeadlineSuppressionIndexes> {
  const now = input.now ?? Date.now();
  const message = `Deadline reminder suppressed: ${input.reason}.`;
  const occurrences = input.db.prepare(`
      UPDATE project_deadline_occurrences
      SET status = 'superseded', terminal_reason = ?, fired_at = NULL, updated_at = ?
      WHERE project_id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM projects p
          WHERE p.id = project_deadline_occurrences.project_id
            AND ((? = 'project_archived' AND p.archived_at IS NOT NULL) OR (? = 'project_delivered' AND p.stage_key = 'delivered'))
        )
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(input.reason, now, input.projectId, input.reason, input.reason, input.auditId);
  const ledgers = input.db.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = 'reauthorization_suppressed',
        last_error = ?, updated_at = ?
      WHERE event_type = 'project.deadline.reminder' AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.id = notification_delivery_ledger.outbox_id
            AND o.project_id = ? AND o.event_type = 'project.deadline.reminder'
            AND o.source_key IN (SELECT id FROM project_deadline_occurrences WHERE project_id = ?)
        )
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(message, now, input.projectId, input.projectId, input.auditId);
  const outboxes = input.db.prepare(`
      UPDATE notification_outbox
      SET status = 'suppressed', lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, last_error_code = 'reauthorization_suppressed',
        last_error = ?, updated_at = ?
      WHERE project_id = ? AND event_type = 'project.deadline.reminder'
        AND status IN ('pending', 'queued')
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = notification_outbox.id AND status IN ('pending', 'processing'))
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(now, message, now, input.projectId, input.auditId);
  return { statements: [occurrences, ledgers, outboxes], indexes: { occurrences: 0, ledgers: 1, outboxes: 2 } };
}

export type EditingEntryTokenTailIndexes = { editingEntryToken: number };

export type EditingEntryTokenTailInput =
  | {
      db: D1Database;
      owner: "handoff";
      projectId: string;
      handoffId: string;
      connectionId: string;
      generation: number;
      state: string;
      expectedPriorToken: number | null;
      auditId: string;
      updatedAt?: number;
    }
  | {
      db: D1Database;
      owner: "job";
      projectId: string;
      jobId: string;
      jobKind: string;
      generation: number;
      expectedPriorToken: number | null;
      auditId: string;
      updatedAt?: number;
    };

export function buildEditingEntryTokenTail(input: EditingEntryTokenTailInput): PreparedStatementBundle<EditingEntryTokenTailIndexes> {
  const now = input.updatedAt ?? Date.now();
  const statement = input.owner === "handoff"
    ? input.db.prepare(HANDOFF_EDITING_ENTRY_TOKEN_SQL).bind(
      input.projectId,
      now,
      input.handoffId,
      input.connectionId,
      input.generation,
      input.state,
      input.expectedPriorToken,
      input.auditId,
    )
    : input.db.prepare(JOB_EDITING_ENTRY_TOKEN_SQL).bind(
      input.projectId,
      now,
      input.jobId,
      input.jobKind,
      input.generation,
      input.expectedPriorToken,
      input.auditId,
    );
  return { statements: [statement], indexes: { editingEntryToken: 0 } };
}

export type WorkflowTailKind = WorkflowTailIndexes["kind"];

type WorkflowTailRuntime = {
  db: D1Database;
  auditId: string;
  now?: number;
  projectId?: string;
  connectionId?: string;
  handoffState?: string;
  mappingState?: string;
  jobKind?: string;
  expectedPriorToken?: number | null;
};

export type WorkflowTailPrerequisite = GuardedTransitionPrerequisite & WorkflowTailRuntime;

const AUDIT_EXISTS = "AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";

function selectStatement(db: D1Database, source: string, values: unknown[]): D1PreparedStatement {
  return db.prepare(source).bind(...values);
}

function requiredRuntimeValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Workflow tail requires ${name}`);
  return value;
}

export function buildWorkflowTail(
  prerequisite: WorkflowTailPrerequisite,
  kind: WorkflowTailKind,
): PreparedStatementBundle<WorkflowTailIndexes> {
  const now = prerequisite.now ?? Date.now();
  if (kind === "none") return { statements: [], indexes: { kind: "none" } };
  if (kind === "raw_reconciliation") {
    if (prerequisite.kind !== "raw_reconciliation") throw new Error("raw_reconciliation tail requires its matching prerequisite");
    return {
      statements: [selectStatement(prerequisite.db, `SELECT id FROM raw_reconciliation_claims WHERE id = ? AND state = 'running' AND EXISTS (SELECT 1 FROM projects WHERE projects.id = raw_reconciliation_claims.project_id AND projects.shoot_date = ?) ${AUDIT_EXISTS}`, [prerequisite.claimId, prerequisite.shootDate, prerequisite.auditId])],
      indexes: { kind, prerequisiteMarker: 0 },
    };
  }
  if (kind === "autohdr_handoff_entry") {
    if (prerequisite.kind !== "autohdr_handoff") throw new Error("autohdr_handoff_entry tail requires its matching prerequisite");
    const projectId = requiredRuntimeValue(prerequisite.projectId, "projectId");
    const prerequisiteMarker = selectStatement(prerequisite.db, `SELECT id FROM autohdr_handoffs WHERE id = ? AND generation = ? AND connection_id = ? ${AUDIT_EXISTS}`, [prerequisite.handoffId, prerequisite.generation, prerequisite.connectionId, prerequisite.auditId]);
    const handoffState = selectStatement(prerequisite.db, `SELECT id, state FROM autohdr_handoffs WHERE id = ? AND generation = ? AND connection_id = ? AND state IN ('starting', 'started', 'blocked') ${AUDIT_EXISTS}`, [prerequisite.handoffId, prerequisite.generation, prerequisite.connectionId, prerequisite.auditId]);
    const token = buildEditingEntryTokenTail({
      db: prerequisite.db,
      owner: "handoff",
      projectId,
      handoffId: prerequisite.handoffId,
      connectionId: prerequisite.connectionId,
      generation: prerequisite.generation,
      state: prerequisite.handoffState ?? "started",
      expectedPriorToken: prerequisite.expectedPriorToken ?? null,
      auditId: prerequisite.auditId,
      updatedAt: now,
    });
    return {
      statements: [prerequisiteMarker, handoffState, ...token.statements],
      indexes: { kind, prerequisiteMarker: 0, handoffState: 1, editingEntryToken: 2 },
    };
  }
  if (kind === "autohdr_mapping_entry") {
    if (prerequisite.kind !== "autohdr_mapping") throw new Error("autohdr_mapping_entry tail requires its matching prerequisite");
    const projectId = requiredRuntimeValue(prerequisite.projectId, "projectId");
    const connectionId = requiredRuntimeValue(prerequisite.connectionId, "connectionId");
    const prerequisiteMarker = selectStatement(prerequisite.db, `SELECT id FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ? AND generation = ? ${AUDIT_EXISTS}`, [prerequisite.mappingId, prerequisite.handoffId, prerequisite.generation, prerequisite.auditId]);
    const handoffState = selectStatement(prerequisite.db, `SELECT id, state FROM autohdr_handoffs WHERE id = ? AND generation = ? ${AUDIT_EXISTS}`, [prerequisite.handoffId, prerequisite.generation, prerequisite.auditId]);
    const mappingState = selectStatement(prerequisite.db, `SELECT id, state FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ? AND generation = ? AND state = ? ${AUDIT_EXISTS}`, [prerequisite.mappingId, prerequisite.handoffId, prerequisite.generation, prerequisite.mappingState ?? "active", prerequisite.auditId]);
    const token = buildEditingEntryTokenTail({
      db: prerequisite.db,
      owner: "handoff",
      projectId,
      handoffId: prerequisite.handoffId,
      connectionId,
      generation: prerequisite.generation,
      state: prerequisite.handoffState ?? "started",
      expectedPriorToken: prerequisite.expectedPriorToken ?? null,
      auditId: prerequisite.auditId,
      updatedAt: now,
    });
    return {
      statements: [prerequisiteMarker, handoffState, mappingState, ...token.statements],
      indexes: { kind, prerequisiteMarker: 0, handoffState: 1, mappingState: 2, editingEntryToken: 3 },
    };
  }
  if (kind === "autohdr_final_completion") {
    if (prerequisite.kind !== "autohdr_final_claim") throw new Error("autohdr_final_completion tail requires its matching prerequisite");
    const prerequisiteMarker = selectStatement(prerequisite.db, `SELECT id FROM edited_source_claims WHERE id = ? AND handoff_id = ? AND current_asset_id = ? AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ?) ${AUDIT_EXISTS}`, [prerequisite.claimId, prerequisite.handoffId, prerequisite.currentAssetId, prerequisite.mappingId, prerequisite.handoffId, prerequisite.auditId]);
    const handoffState = selectStatement(prerequisite.db, `SELECT id, state FROM autohdr_handoffs WHERE id = ? ${AUDIT_EXISTS}`, [prerequisite.handoffId, prerequisite.auditId]);
    const mappingState = selectStatement(prerequisite.db, `SELECT id, state FROM autohdr_output_mappings WHERE id = ? AND handoff_id = ? ${AUDIT_EXISTS}`, [prerequisite.mappingId, prerequisite.handoffId, prerequisite.auditId]);
    const finalClaimState = selectStatement(prerequisite.db, `SELECT id, current_asset_id FROM edited_source_claims WHERE id = ? AND handoff_id = ? AND current_asset_id = ? ${AUDIT_EXISTS}`, [prerequisite.claimId, prerequisite.handoffId, prerequisite.currentAssetId, prerequisite.auditId]);
    return { statements: [prerequisiteMarker, handoffState, mappingState, finalClaimState], indexes: { kind, prerequisiteMarker: 0, handoffState: 1, mappingState: 2, finalClaimState: 3 } };
  }
  if (kind === "autohdr_job_entry") {
    if (prerequisite.kind !== "autohdr_job") throw new Error("autohdr_job_entry tail requires its matching prerequisite");
    const prerequisiteMarker = selectStatement(prerequisite.db, `SELECT id FROM jobs WHERE id = ? AND project_id = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ? ${AUDIT_EXISTS}`, [prerequisite.jobId, prerequisite.projectId, prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
    const jobState = selectStatement(prerequisite.db, `SELECT id, status FROM jobs WHERE id = ? AND project_id = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ? AND status IN ('queued', 'running') ${AUDIT_EXISTS}`, [prerequisite.jobId, prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
    const token = buildEditingEntryTokenTail({
      db: prerequisite.db,
      owner: "job",
      projectId: prerequisite.projectId,
      jobId: prerequisite.jobId,
      jobKind: prerequisite.jobKind ?? "autohdr",
      generation: prerequisite.generation,
      expectedPriorToken: prerequisite.expectedPriorToken ?? null,
      auditId: prerequisite.auditId,
      updatedAt: now,
    });
    return { statements: [prerequisiteMarker, jobState, ...token.statements], indexes: { kind, prerequisiteMarker: 0, jobState: 1, editingEntryToken: 2 } };
  }
  if (kind === "autohdr_job_completion") {
    if (prerequisite.kind !== "autohdr_job") throw new Error("autohdr_job_completion tail requires its matching prerequisite");
    const prerequisiteMarker = selectStatement(prerequisite.db, `SELECT id FROM jobs WHERE id = ? AND project_id = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ? ${AUDIT_EXISTS}`, [prerequisite.jobId, prerequisite.projectId, prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
    const sourceEntryJob = selectStatement(prerequisite.db, `SELECT id, project_id, stage_entry_board_revision FROM jobs WHERE id = json_extract((SELECT payload_json FROM jobs WHERE id = ?), '$.stageEntrySourceJobId') AND project_id = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ? AND stage_entry_board_revision IS NOT NULL ${AUDIT_EXISTS}`, [prerequisite.jobId, prerequisite.projectId, prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
    const completionJobState = selectStatement(prerequisite.db, `SELECT id, status FROM jobs WHERE id = ? AND project_id = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ? AND status IN ('queued', 'running', 'done') ${AUDIT_EXISTS}`, [prerequisite.jobId, prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
    return { statements: [prerequisiteMarker, sourceEntryJob, completionJobState], indexes: { kind, prerequisiteMarker: 0, sourceEntryJob: 1, completionJobState: 2 } };
  }
  const exhaustive: never = kind;
  return exhaustive;
}

export function composeStageBundle(input: {
  stage: PreparedStatementBundle<StageWinnerIndexes>;
  activity?: PreparedStatementBundle<ActivityBundleIndexes>;
  deadline?: PreparedStatementBundle<DeadlineSuppressionIndexes>;
  workflow: PreparedStatementBundle<WorkflowTailIndexes>;
}): PreparedStatementBundle<ComposedStageBundleIndexes> {
  const statements: D1PreparedStatement[] = [];
  function append<T extends Record<string, number>>(bundle: PreparedStatementBundle<T>): T {
    const offset = statements.length;
    statements.push(...bundle.statements);
    return Object.fromEntries(Object.entries(bundle.indexes).map(([key, value]) => [key, value + offset])) as T;
  }
  const stage = append(input.stage);
  const activity = input.activity ? append(input.activity) : undefined;
  const deadline = input.deadline ? append(input.deadline) : undefined;
  const workflowOffset = statements.length;
  statements.push(...input.workflow.statements);
  const workflow = Object.fromEntries(Object.entries(input.workflow.indexes).map(([key, value]) => [key, typeof value === "number" ? value + workflowOffset : value])) as WorkflowTailIndexes;
  return { statements, indexes: { stage, ...(activity ? { activity } : {}), ...(deadline ? { deadline } : {}), workflow } };
}

export function deriveStageFinalizerIntent(winnerResults: readonly StageFinalizerWinnerResult[]): CommittedStageFinalizerIntent | undefined {
  const validWinner = (result: StageFinalizerWinnerResult): result is Extract<StageFinalizerWinnerResult, { kind: "winner" }> => {
    if (result.kind !== "winner" || !result.auditId || !result.row || !result.row.projectId || !result.row.stageKey) return false;
    if (!Number.isFinite(result.row.boardPosition) || !Number.isInteger(result.row.boardRevision) || result.row.boardRevision < 0) return false;
    if (result.publicationIds !== undefined && !result.publicationIds.every((id) => typeof id === "string" && id.length > 0)) return false;
    return result.legacyWorkflowNotification === undefined || ["raw_ready", "sent_to_editing", "edited_landed"].includes(result.legacyWorkflowNotification);
  };
  if (winnerResults.length === 0 || winnerResults.some((result) => !validWinner(result))) return undefined;
  const first = winnerResults[0];
  if (!first || !validWinner(first)) return undefined;
  for (const result of winnerResults.slice(1)) {
    if (!validWinner(result)) return undefined;
    if (result.auditId !== first.auditId || result.row.projectId !== first.row.projectId || result.row.stageKey !== first.row.stageKey || result.row.boardPosition !== first.row.boardPosition || result.row.boardRevision !== first.row.boardRevision || result.legacyWorkflowNotification !== first.legacyWorkflowNotification) return undefined;
  }
  const publicationIds = [...new Set(winnerResults.flatMap((result) => validWinner(result) ? result.publicationIds ?? [] : []))];
  return {
    publicationIds,
    ...(first.legacyWorkflowNotification ? { legacyWorkflowNotification: first.legacyWorkflowNotification } : {}),
  };
}

export const NORMATIVE_NON_COMPACTING_EXACT_SQL = NON_COMPACTING_EXACT_SQL;
export const NORMATIVE_COMPACTING_SQL = COMPACTING_SQL;
export const NORMATIVE_AUDIT_MARKER_SQL = AUDIT_MARKER_SQL;
export const NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL = HANDOFF_EDITING_ENTRY_TOKEN_SQL;
export const NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL = JOB_EDITING_ENTRY_TOKEN_SQL;
