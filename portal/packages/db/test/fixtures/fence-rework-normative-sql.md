# Fence-rework normative SQL blocks

Extracted from `docs/plans/implemented/tb5a/fence-rework-sol-design.md` (deleted in commit
`0dbeca7`). These 27 fenced SQL blocks are **normative**: the `NORMATIVE_*_SQL`
constants in `src/stage-board-bundles.ts` are pinned byte-for-byte against them via the
`toBe(...)` assertions in `stage-board-bundles.test.ts` and `tb5a-migration-proof.test.ts`.
Changing a block here without a deliberate, reviewed change to the corresponding constant
defeats the proof.

This fixture lives beside the tests that consume it. The file it replaces previously lived
four levels up in the documentation tree (`docs/plans/implemented/tb5a/...`), reachable from
here only via a fragile `../../../../` relative path into a planning doc that was never meant
to be a durable test dependency — that fragility is exactly what issue #58 removed.

---

```sql
SELECT
  stage_key AS stageKey,
  board_revision AS boardRevision,
  archived_at AS archivedAt
FROM projects
WHERE id = ?1;
```

```sql
SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
```

```sql
WITH
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
workflow_premise AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE (json_extract(?10, '$.kind') = 'none')
OR (
  json_extract(?10, '$.kind') = 'raw_reconciliation'
  AND EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?5
    AND p.archived_at IS NULL
    AND p.shoot_date IS json_extract(?10, '$.shootDate')
)
AND (
  json_extract(?10, '$.claimId') IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = json_extract(?10, '$.claimId')
      AND rc.project_id = ?5
      AND rc.state IN (
        SELECT value
        FROM json_each(json_extract(?10, '$.claimStates'))
      )
  )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_handoff'
  AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?10, '$.handoffId')
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.expectedStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
    AND (
      json_extract(?10, '$.jobId') IS NULL
      OR h.job_id = json_extract(?10, '$.jobId')
    )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_mapping'
  AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = json_extract(?10, '$.mappingId')
    AND m.project_id = ?5
    AND m.handoff_id = json_extract(?10, '$.handoffId')
    AND m.connection_id = json_extract(?10, '$.connectionId')
    AND m.generation = json_extract(?10, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.mappingStates'))
    )
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.handoffStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_final_claim'
  AND EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = json_extract(?10, '$.mappingId')
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = json_extract(?10, '$.fetchClaimId')
   AND f.project_id = ?5
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = json_extract(?10, '$.collectionId')
    AND esc.source_path_key = json_extract(?10, '$.sourcePathKey')
    AND esc.current_asset_id = json_extract(?10, '$.currentAssetId')
    AND esc.handoff_id = json_extract(?10, '$.handoffId')
    AND c.project_id = ?5
    AND c.kind = 'edited'
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.handoffStates'))
    )
    AND h.manifest_version = json_extract(?10, '$.manifestVersion')
    AND h.editing_entry_board_revision = ?7
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
    AND m.project_id = ?5
    AND m.connection_id = json_extract(?10, '$.connectionId')
    AND m.generation = json_extract(?10, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.mappingStates'))
    )
    AND m.final_path_key = json_extract(?10, '$.finalPathKey')
    AND f.connection_id = json_extract(?10, '$.connectionId')
    AND f.mapping_generation = json_extract(?10, '$.generation')
    AND f.job_id = json_extract(?10, '$.fetchJobId')
    AND f.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.fetchStates'))
    )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_job'
  AND json_extract(?10, '$.mode') = 'entry'
  AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?10, '$.jobId')
    AND j.kind = json_extract(?10, '$.jobKind')
    AND j.project_id = ?5
    AND j.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.jobStates'))
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?5
    AND CAST(json_extract(j.payload_json, '$.generation') AS INTEGER) =
        json_extract(?10, '$.generation')
    AND j.stage_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_job'
  AND json_extract(?10, '$.mode') = 'completion'
  AND EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source ON source.id = json_extract(?10, '$.sourceJobId')
  WHERE completion.id = json_extract(?10, '$.jobId')
    AND completion.kind = json_extract(?10, '$.jobKind')
    AND completion.project_id = ?5
    AND completion.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.jobStates'))
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?5
    AND json_extract(completion.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(completion.payload_json, '$.stageEntryGeneration') =
        json_extract(?10, '$.generation')
    AND source.kind IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.sourceJobKinds'))
    )
    AND source.project_id = ?5
    AND source.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.sourceJobStates'))
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?5
    AND json_extract(source.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(source.payload_json, '$.stageEntryGeneration') =
        json_extract(?10, '$.generation')
    AND source.stage_entry_board_revision = ?7
    AND source.stage_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
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
  AND EXISTS (SELECT 1 FROM workflow_premise)
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
```

```sql
WITH
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
workflow_premise AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE (json_extract(?10, '$.kind') = 'none')
OR (
  json_extract(?10, '$.kind') = 'raw_reconciliation'
  AND EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?5
    AND p.archived_at IS NULL
    AND p.shoot_date IS json_extract(?10, '$.shootDate')
)
AND (
  json_extract(?10, '$.claimId') IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = json_extract(?10, '$.claimId')
      AND rc.project_id = ?5
      AND rc.state IN (
        SELECT value
        FROM json_each(json_extract(?10, '$.claimStates'))
      )
  )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_handoff'
  AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?10, '$.handoffId')
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.expectedStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
    AND (
      json_extract(?10, '$.jobId') IS NULL
      OR h.job_id = json_extract(?10, '$.jobId')
    )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_mapping'
  AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = json_extract(?10, '$.mappingId')
    AND m.project_id = ?5
    AND m.handoff_id = json_extract(?10, '$.handoffId')
    AND m.connection_id = json_extract(?10, '$.connectionId')
    AND m.generation = json_extract(?10, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.mappingStates'))
    )
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.handoffStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_final_claim'
  AND EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = json_extract(?10, '$.mappingId')
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = json_extract(?10, '$.fetchClaimId')
   AND f.project_id = ?5
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = json_extract(?10, '$.collectionId')
    AND esc.source_path_key = json_extract(?10, '$.sourcePathKey')
    AND esc.current_asset_id = json_extract(?10, '$.currentAssetId')
    AND esc.handoff_id = json_extract(?10, '$.handoffId')
    AND c.project_id = ?5
    AND c.kind = 'edited'
    AND h.project_id = ?5
    AND h.connection_id = json_extract(?10, '$.connectionId')
    AND h.generation = json_extract(?10, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.handoffStates'))
    )
    AND h.manifest_version = json_extract(?10, '$.manifestVersion')
    AND h.editing_entry_board_revision = ?7
    AND h.editing_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
    AND m.project_id = ?5
    AND m.connection_id = json_extract(?10, '$.connectionId')
    AND m.generation = json_extract(?10, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.mappingStates'))
    )
    AND m.final_path_key = json_extract(?10, '$.finalPathKey')
    AND f.connection_id = json_extract(?10, '$.connectionId')
    AND f.mapping_generation = json_extract(?10, '$.generation')
    AND f.job_id = json_extract(?10, '$.fetchJobId')
    AND f.state IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.fetchStates'))
    )
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_job'
  AND json_extract(?10, '$.mode') = 'entry'
  AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?10, '$.jobId')
    AND j.kind = json_extract(?10, '$.jobKind')
    AND j.project_id = ?5
    AND j.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.jobStates'))
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?5
    AND CAST(json_extract(j.payload_json, '$.generation') AS INTEGER) =
        json_extract(?10, '$.generation')
    AND j.stage_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
)
OR (
  json_extract(?10, '$.kind') = 'autohdr_job'
  AND json_extract(?10, '$.mode') = 'completion'
  AND EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source ON source.id = json_extract(?10, '$.sourceJobId')
  WHERE completion.id = json_extract(?10, '$.jobId')
    AND completion.kind = json_extract(?10, '$.jobKind')
    AND completion.project_id = ?5
    AND completion.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.jobStates'))
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?5
    AND json_extract(completion.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(completion.payload_json, '$.stageEntryGeneration') =
        json_extract(?10, '$.generation')
    AND source.kind IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.sourceJobKinds'))
    )
    AND source.project_id = ?5
    AND source.status IN (
      SELECT value
      FROM json_each(json_extract(?10, '$.sourceJobStates'))
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?5
    AND json_extract(source.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(source.payload_json, '$.stageEntryGeneration') =
        json_extract(?10, '$.generation')
    AND source.stage_entry_board_revision = ?7
    AND source.stage_entry_board_revision IS json_extract(?10, '$.expectedPriorToken')
)
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
  AND EXISTS (SELECT 1 FROM workflow_premise)
)
UPDATE projects AS p
SET
  stage_key = ?4,
  board_position = (
    SELECT COALESCE(MAX(board_position) + 1024, 0)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ),
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
```

```sql
WITH
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
workflow_premise AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE (json_extract(?11, '$.kind') = 'none')
OR (
  json_extract(?11, '$.kind') = 'raw_reconciliation'
  AND EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?7
    AND p.archived_at IS NULL
    AND p.shoot_date IS json_extract(?11, '$.shootDate')
)
AND (
  json_extract(?11, '$.claimId') IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = json_extract(?11, '$.claimId')
      AND rc.project_id = ?7
      AND rc.state IN (
        SELECT value
        FROM json_each(json_extract(?11, '$.claimStates'))
      )
  )
)
)
OR (
  json_extract(?11, '$.kind') = 'autohdr_handoff'
  AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?11, '$.handoffId')
    AND h.project_id = ?7
    AND h.connection_id = json_extract(?11, '$.connectionId')
    AND h.generation = json_extract(?11, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.expectedStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?11, '$.expectedPriorToken')
    AND (
      json_extract(?11, '$.jobId') IS NULL
      OR h.job_id = json_extract(?11, '$.jobId')
    )
)
)
OR (
  json_extract(?11, '$.kind') = 'autohdr_mapping'
  AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = json_extract(?11, '$.mappingId')
    AND m.project_id = ?7
    AND m.handoff_id = json_extract(?11, '$.handoffId')
    AND m.connection_id = json_extract(?11, '$.connectionId')
    AND m.generation = json_extract(?11, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.mappingStates'))
    )
    AND h.project_id = ?7
    AND h.connection_id = json_extract(?11, '$.connectionId')
    AND h.generation = json_extract(?11, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.handoffStates'))
    )
    AND h.editing_entry_board_revision IS json_extract(?11, '$.expectedPriorToken')
)
)
OR (
  json_extract(?11, '$.kind') = 'autohdr_final_claim'
  AND EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = json_extract(?11, '$.mappingId')
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = json_extract(?11, '$.fetchClaimId')
   AND f.project_id = ?7
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = json_extract(?11, '$.collectionId')
    AND esc.source_path_key = json_extract(?11, '$.sourcePathKey')
    AND esc.current_asset_id = json_extract(?11, '$.currentAssetId')
    AND esc.handoff_id = json_extract(?11, '$.handoffId')
    AND c.project_id = ?7
    AND c.kind = 'edited'
    AND h.project_id = ?7
    AND h.connection_id = json_extract(?11, '$.connectionId')
    AND h.generation = json_extract(?11, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.handoffStates'))
    )
    AND h.manifest_version = json_extract(?11, '$.manifestVersion')
    AND h.editing_entry_board_revision = ?9
    AND h.editing_entry_board_revision IS json_extract(?11, '$.expectedPriorToken')
    AND m.project_id = ?7
    AND m.connection_id = json_extract(?11, '$.connectionId')
    AND m.generation = json_extract(?11, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.mappingStates'))
    )
    AND m.final_path_key = json_extract(?11, '$.finalPathKey')
    AND f.connection_id = json_extract(?11, '$.connectionId')
    AND f.mapping_generation = json_extract(?11, '$.generation')
    AND f.job_id = json_extract(?11, '$.fetchJobId')
    AND f.state IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.fetchStates'))
    )
)
)
OR (
  json_extract(?11, '$.kind') = 'autohdr_job'
  AND json_extract(?11, '$.mode') = 'entry'
  AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?11, '$.jobId')
    AND j.kind = json_extract(?11, '$.jobKind')
    AND j.project_id = ?7
    AND j.status IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.jobStates'))
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?7
    AND CAST(json_extract(j.payload_json, '$.generation') AS INTEGER) =
        json_extract(?11, '$.generation')
    AND j.stage_entry_board_revision IS json_extract(?11, '$.expectedPriorToken')
)
)
OR (
  json_extract(?11, '$.kind') = 'autohdr_job'
  AND json_extract(?11, '$.mode') = 'completion'
  AND EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source ON source.id = json_extract(?11, '$.sourceJobId')
  WHERE completion.id = json_extract(?11, '$.jobId')
    AND completion.kind = json_extract(?11, '$.jobKind')
    AND completion.project_id = ?7
    AND completion.status IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.jobStates'))
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?7
    AND json_extract(completion.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(completion.payload_json, '$.stageEntryGeneration') =
        json_extract(?11, '$.generation')
    AND source.kind IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.sourceJobKinds'))
    )
    AND source.project_id = ?7
    AND source.status IN (
      SELECT value
      FROM json_each(json_extract(?11, '$.sourceJobStates'))
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?7
    AND json_extract(source.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(source.payload_json, '$.stageEntryGeneration') =
        json_extract(?11, '$.generation')
    AND source.stage_entry_board_revision = ?9
    AND source.stage_entry_board_revision IS json_extract(?11, '$.expectedPriorToken')
)
)
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
    WHERE new_board_position IS NOT CAST(desired_rank * 1024 AS REAL)
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
  AND EXISTS (SELECT 1 FROM workflow_premise)
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
```

```sql
INSERT INTO audit_log (
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
```

```sql
UPDATE autohdr_handoffs
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
```

```sql
UPDATE jobs
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
```

```sql
WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS destination_stage,
    ?3 AS old_board_revision,
    ?4 AS premise_doc,
    ?5 AS stage_audit_id,
    ?6 AS winner_required,
    ?7 AS asserted_at,
    ?8 AS coupling_doc
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'stage.auto_advance.bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT COALESCE(json_valid(i.premise_doc), 0)
  OR NOT COALESCE(json_valid(i.coupling_doc), 0)
  OR (
    (
      i.winner_required = 1
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
    )
    OR (
      EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM projects p
          WHERE p.id = i.project_id
            AND p.stage_key = i.destination_stage
            AND p.board_revision = i.old_board_revision + 1
            AND p.archived_at IS NULL
        )
        OR NOT COALESCE((1), 0)
        OR NOT COALESCE((1), 0)
      )
    )
  );
```

```sql
WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS asserted_at,
    ?3 AS coupling_doc,
    ?4 AS destination_stage
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'automatic.closed_bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT COALESCE(json_valid(i.coupling_doc), 0)
  OR NOT COALESCE(
    EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = i.project_id
        AND p.stage_key = i.destination_stage
        AND p.archived_at IS NULL
    ),
    0
  )
  OR NOT COALESCE((1), 0);
```

```sql
EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?1
    AND p.shoot_date IS json_extract(?4, '$.shootDate')
)
AND (
  json_extract(?4, '$.claimId') IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = json_extract(?4, '$.claimId')
      AND rc.project_id = ?1
      AND rc.state IN (
        SELECT value
        FROM json_each(json_extract(?4, '$.claimStates'))
      )
  )
)
```

```sql
EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?4, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
    AND (
      json_extract(?4, '$.jobId') IS NULL
      OR h.job_id = json_extract(?4, '$.jobId')
    )
)
```

```sql
EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = json_extract(?4, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?4, '$.handoffId')
    AND m.connection_id = json_extract(?4, '$.connectionId')
    AND m.generation = json_extract(?4, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.mappingStates'))
    )
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
)
```

```sql
EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = json_extract(?4, '$.mappingId')
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = json_extract(?4, '$.fetchClaimId')
   AND f.project_id = ?1
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = json_extract(?4, '$.collectionId')
    AND esc.source_path_key = json_extract(?4, '$.sourcePathKey')
    AND esc.current_asset_id = json_extract(?4, '$.currentAssetId')
    AND esc.handoff_id = json_extract(?4, '$.handoffId')
    AND c.project_id = ?1
    AND c.kind = 'edited'
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.handoffStates'))
    )
    AND h.manifest_version = json_extract(?4, '$.manifestVersion')
    AND h.editing_entry_board_revision = ?3
    AND m.project_id = ?1
    AND m.connection_id = json_extract(?4, '$.connectionId')
    AND m.generation = json_extract(?4, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.mappingStates'))
    )
    AND m.final_path_key = json_extract(?4, '$.finalPathKey')
    AND f.connection_id = json_extract(?4, '$.connectionId')
    AND f.mapping_generation = json_extract(?4, '$.generation')
    AND f.job_id = json_extract(?4, '$.fetchJobId')
    AND f.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.fetchStates'))
    )
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source
    ON source.id = json_extract(?4, '$.sourceJobId')
  WHERE completion.id = json_extract(?4, '$.jobId')
    AND completion.kind = json_extract(?4, '$.jobKind')
    AND completion.project_id = ?1
    AND completion.status IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.jobStates'))
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?1
    AND json_extract(
          completion.payload_json,
          '$.stageEntrySourceJobId'
        ) = source.id
    AND json_extract(
          completion.payload_json,
          '$.stageEntryGeneration'
        ) = json_extract(?4, '$.generation')
    AND source.kind IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.sourceJobKinds'))
    )
    AND source.project_id = ?1
    AND source.status IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.sourceJobStates'))
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?1
    AND json_extract(
          source.payload_json,
          '$.stageEntrySourceJobId'
        ) = source.id
    AND json_extract(
          source.payload_json,
          '$.stageEntryGeneration'
        ) = json_extract(?4, '$.generation')
    AND source.stage_entry_board_revision = ?3
)
```

```sql
AND j.stage_entry_board_revision = ?3 + 1
```

```sql
EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.state = 'started'
    AND h.started_at IS NOT NULL
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = json_extract(?8, '$.jobKind')
    AND j.project_id = ?1
    AND j.status IN (
      SELECT value
      FROM json_each(json_extract(?8, '$.jobStates'))
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') =
        json_extract(?8, '$.generation')
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') =
        json_extract(?8, '$.jobId')
    AND json_extract(j.payload_json, '$.stageEntryGeneration') =
        json_extract(?8, '$.generation')
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?3, '$.jobId')
    AND j.kind = 'autohdr_api_send'
    AND j.project_id = ?1
    AND j.status IN ('running', 'done')
    AND j.error IS NULL
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') = 1
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') =
        json_extract(?3, '$.jobId')
    AND json_extract(j.payload_json, '$.stageEntryGeneration') = 1
    AND json_extract(j.payload_json, '$.phase') = 'finalized'
    AND json_extract(j.payload_json, '$.uid') =
        json_extract(?3, '$.uid')
)
AND EXISTS (
  SELECT 1
  FROM audit_log a
  WHERE a.id = json_extract(?3, '$.finalizedAuditId')
    AND a.action = 'project.autohdr_api_send.finalized'
    AND a.target_type = 'project'
    AND a.target_id = ?1
    AND json_valid(a.meta_json)
    AND json_extract(a.meta_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(a.meta_json, '$.jobId') =
        json_extract(?3, '$.jobId')
    AND json_extract(a.meta_json, '$.uid') =
        json_extract(?3, '$.uid')
    AND json_extract(a.meta_json, '$.assetCount') =
        json_extract(?3, '$.assetCount')
    AND json_extract(a.meta_json, '$.retrievalEnabled') = 0
)
```

```sql
EXISTS (
  SELECT 1
  FROM autohdr_output_mappings old_m
  WHERE old_m.id = json_extract(?8, '$.retiredMappingId')
    AND old_m.handoff_id = json_extract(?8, '$.retiredHandoffId')
    AND old_m.project_id = ?1
    AND old_m.state = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs old_h
  WHERE old_h.id = json_extract(?8, '$.retiredHandoffId')
    AND old_h.project_id = ?1
    AND old_h.state = 'retired'
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims old_pc
  WHERE old_pc.mapping_id = json_extract(?8, '$.retiredMappingId')
    AND old_pc.state IN ('active', 'pending', 'blocked')
)
AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'queued'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.handoffId') =
        json_extract(?8, '$.handoffId')
    AND json_extract(j.payload_json, '$.generation') =
        json_extract(?8, '$.generation')
    AND json_extract(j.payload_json, '$.connectionId') =
        json_extract(?8, '$.connectionId')
    AND json_extract(j.payload_json, '$.retiredHandoffId') =
        json_extract(?8, '$.retiredHandoffId')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.selection_hash = json_extract(?8, '$.selectionHash')
    AND h.state =
        json_extract(?8, '$.expectedFinalHandoffState')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = json_extract(?8, '$.generation')
    AND m.state = 'pending_discovery'
)
AND (
  SELECT COUNT(*)
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.state = 'pending'
) = 2
AND json_array_length(json_extract(?8, '$.pathClaims')) = 2
AND NOT EXISTS (
  SELECT 1
  FROM json_each(json_extract(?8, '$.pathClaims')) expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM autohdr_path_claims pc
    WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
      AND pc.handoff_id = json_extract(?8, '$.handoffId')
      AND pc.project_id = ?1
      AND pc.connection_id = json_extract(?8, '$.connectionId')
      AND pc.path_key = json_extract(expected.value, '$.pathKey')
      AND pc.state = 'pending'
  )
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?8, '$.targetPath')
    AND json_extract(j.payload_json, '$.isCollision') = 0
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = 1
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = 1
    AND m.state = 'active'
    AND m.final_path_key = json_extract(?8, '$.targetPathKey')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.path_key = json_extract(?8, '$.targetPathKey')
    AND pc.state = 'active'
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.backfill') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?8, '$.targetPath')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = json_extract(?8, '$.generation')
    AND m.state = 'active'
    AND m.final_path_key = json_extract(?8, '$.targetPathKey')
    AND m.folder_id = json_extract(?8, '$.folderId')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.path_key = json_extract(?8, '$.targetPathKey')
    AND pc.folder_id = json_extract(?8, '$.folderId')
    AND pc.state = 'active'
)
```

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?3, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.project_id = ?1
    AND j.status = 'failed'
    AND j.error = json_extract(?3, '$.diagnostic')
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?3, '$.targetPath')
    AND json_extract(j.payload_json, '$.isCollision') = 1
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?3, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?3, '$.connectionId')
    AND h.generation = 1
    AND h.job_id = json_extract(?3, '$.jobId')
    AND h.workflow_id = json_extract(?3, '$.workflowId')
    AND h.state = 'retired'
    AND h.last_error = json_extract(?3, '$.diagnostic')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?3, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?3, '$.handoffId')
    AND m.connection_id = json_extract(?3, '$.connectionId')
    AND m.generation = 1
    AND m.state = 'blocked_collision'
    AND m.final_path_key = json_extract(?3, '$.targetPathKey')
    AND m.diagnostic = json_extract(?3, '$.diagnostic')
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?3, '$.mappingId')
     OR (
       pc.connection_id = json_extract(?3, '$.connectionId')
       AND pc.path_key = json_extract(?3, '$.targetPathKey')
       AND pc.project_id = ?1
     )
)
```

```sql
UPDATE autohdr_handoffs
SET
  state = 'started',
  started_at = COALESCE(started_at, ?2),
  updated_at = ?2
WHERE id = ?3
  AND project_id = ?1
  AND connection_id = ?4
  AND generation = ?5
  AND state IN (
    SELECT value FROM json_each(?6)
  )
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?7
      AND action = 'stage.auto_advance'
      AND target_type = 'project'
      AND target_id = ?1
  )
RETURNING
  id,
  project_id,
  connection_id,
  generation,
  state,
  started_at,
  editing_entry_board_revision;
```

```sql
UPDATE jobs
SET
  error = NULL,
  payload_json = ?1,
  updated_at = ?2
WHERE id = ?3
  AND kind = 'autohdr_api_send'
  AND project_id = ?4
  AND status IN ('running', 'done')
RETURNING id, project_id, status, payload_json;
```

```sql
INSERT INTO audit_log (
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
  'project.autohdr_api_send.finalized',
  'project',
  ?3,
  ?4,
  ?5
WHERE EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ?6
    AND j.kind = 'autohdr_api_send'
    AND j.project_id = ?3
    AND j.status IN ('running', 'done')
    AND j.payload_json = ?7
)
ON CONFLICT(id) DO NOTHING
RETURNING id;
```

```sql
SELECT
  stage_key AS stageKey,
  board_revision AS boardRevision,
  archived_at AS archivedAt
FROM projects
WHERE id = ?1;
```
