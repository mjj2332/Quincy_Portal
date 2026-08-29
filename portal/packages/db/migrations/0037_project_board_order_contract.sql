CREATE TABLE _tb5a_0037_stage_preflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
--> statement-breakpoint
INSERT INTO _tb5a_0037_stage_preflight (ok)
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM projects
    WHERE archived_at IS NULL
      AND stage_key NOT IN (
        'awaiting_raw',
        'raw_review',
        'editing_autohdr',
        'edited_review',
        'delivered'
      )
  )
  THEN 1
  ELSE 0
END;
--> statement-breakpoint
DROP TABLE _tb5a_0037_stage_preflight;
--> statement-breakpoint
ALTER TABLE projects
ADD COLUMN board_revision INTEGER NOT NULL DEFAULT 0
CHECK (
  typeof(board_revision) = 'integer'
  AND board_revision >= 0
  AND board_revision <= 9007199254740991
);
--> statement-breakpoint
ALTER TABLE autohdr_handoffs
ADD COLUMN editing_entry_board_revision INTEGER
CHECK (
  editing_entry_board_revision IS NULL
  OR (
    typeof(editing_entry_board_revision) = 'integer'
    AND editing_entry_board_revision >= 0
    AND editing_entry_board_revision <= 9007199254740991
  )
);
--> statement-breakpoint
ALTER TABLE jobs
ADD COLUMN stage_entry_board_revision INTEGER
CHECK (
  stage_entry_board_revision IS NULL
  OR (
    typeof(stage_entry_board_revision) = 'integer'
    AND stage_entry_board_revision >= 0
    AND stage_entry_board_revision <= 9007199254740991
  )
);
--> statement-breakpoint
INSERT INTO feature_flags (
  key,
  enabled,
  updated_by,
  updated_at
)
VALUES (
  'tb5a_board_contract_enabled',
  0,
  NULL,
  unixepoch('now') * 1000
)
ON CONFLICT(key) DO UPDATE SET
  enabled = 0,
  updated_by = NULL,
  updated_at = excluded.updated_at;
--> statement-breakpoint
CREATE TABLE project_board_order_0037_rollback (
  project_id TEXT PRIMARY KEY NOT NULL,
  stage_key TEXT NOT NULL,
  priority INTEGER,
  old_board_position REAL NOT NULL,
  normalized_board_position REAL NOT NULL,
  visible_rank INTEGER NOT NULL,
  captured_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_board_order_0037_stage_rank_idx
ON project_board_order_0037_rollback(stage_key, visible_rank);
--> statement-breakpoint
CREATE INDEX projects_stage_archive_board_order_idx
ON projects(stage_key, archived_at, board_position, id);
--> statement-breakpoint
CREATE TABLE _tb5a_0037_normalization_postflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id AS project_id,
    stage_key,
    priority,
    board_position AS old_board_position,
    ROW_NUMBER() OVER (
      PARTITION BY stage_key
      ORDER BY
        (priority IS NULL),
        board_position,
        id
    ) AS visible_rank
  FROM projects
  WHERE archived_at IS NULL
)
INSERT INTO project_board_order_0037_rollback (
  project_id,
  stage_key,
  priority,
  old_board_position,
  normalized_board_position,
  visible_rank,
  captured_at
)
SELECT
  project_id,
  stage_key,
  priority,
  old_board_position,
  CAST((visible_rank - 1) * 1024 AS REAL),
  visible_rank,
  unixepoch('now') * 1000
FROM ranked;
--> statement-breakpoint
UPDATE projects AS p
SET
  board_position = r.normalized_board_position,
  board_revision = 1
FROM project_board_order_0037_rollback AS r
WHERE p.id = r.project_id
  AND p.archived_at IS NULL
  AND p.stage_key = r.stage_key
  AND p.priority IS r.priority
  AND p.board_position IS r.old_board_position
  AND p.board_revision = 0;
--> statement-breakpoint
INSERT INTO _tb5a_0037_normalization_postflight (ok)
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM project_board_order_0037_rollback r
    LEFT JOIN projects p
      ON p.id = r.project_id
    WHERE p.id IS NULL
       OR p.archived_at IS NOT NULL
       OR p.stage_key <> r.stage_key
       OR p.priority IS NOT r.priority
       OR p.board_position IS NOT r.normalized_board_position
       OR p.board_revision <> 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    WHERE p.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM project_board_order_0037_rollback r
        WHERE r.project_id = p.id
      )
  )
  THEN 1
  ELSE 0
END;
--> statement-breakpoint
DROP TABLE _tb5a_0037_normalization_postflight;
