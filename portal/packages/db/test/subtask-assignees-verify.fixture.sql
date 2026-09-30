-- #364 invariant check, expected output mismatches = 0. Read-only.
-- Valid only while the multi-assignee gate is closed (until the flag flip). A test fixture for the migration 0048 and 0049 tests (moved from scripts/ in #373 part 1); goes with them in part 2.
SELECT
  (SELECT COUNT(*) FROM project_subtasks s WHERE s.assignee_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM project_subtask_assignees a WHERE a.subtask_id = s.id AND a.user_id = s.assignee_id AND a.assignment_version = s.assignment_version))
+ (SELECT COUNT(*) FROM project_subtask_assignees a WHERE NOT EXISTS (
     SELECT 1 FROM project_subtasks s WHERE s.id = a.subtask_id AND s.assignee_id = a.user_id AND s.assignment_version = a.assignment_version))
AS mismatches
