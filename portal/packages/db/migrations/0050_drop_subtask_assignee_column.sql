-- Multi-assignee Subtasks, contract step (#373, PRD #358, ADR 0012). Retires project_subtasks.assignee_id.
-- The relation project_subtask_assignees (0048, resynced by 0049) is the only source of truth; the
-- runtime detached from the column in #373 part 1, so nothing reads or writes it any more.
-- No table rebuild and no PRAGMA (docs/lessons.md:27-62): a plain DROP COLUMN is enough.
-- The index goes first because SQLite refuses to drop an indexed column.
-- A column-level REFERENCES goes with its column, so SQLite allows the drop (migration-0050.test.ts
-- proves it with foreign keys on). 0040 is the precedent for DROP COLUMN on remote D1.
-- The flag DELETE retires the inert subtask_multi_assignee row. It is not a re-assertion of a flag
-- value (lessons #160), and it makes #403 the rollback floor: a Worker older than #403 cannot run
-- against this schema.
DROP INDEX IF EXISTS `project_subtasks_assignee_idx`;
--> statement-breakpoint
ALTER TABLE `project_subtasks` DROP COLUMN `assignee_id`;
--> statement-breakpoint
DELETE FROM `feature_flags` WHERE `key` = 'subtask_multi_assignee';
