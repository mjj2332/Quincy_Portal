-- Multi-assignee Subtasks, expand step (#364, PRD #358, ADR 0012). One row per Subtask assignee.
-- project_subtasks.assignee_id stays and mirrors the first assignee until #373 retires it.
-- Additive only: no rebuild, no PRAGMA, no trigger (docs/lessons.md:27-62; the worker test
-- harness splits migration SQL on semicolons, so a trigger body cannot be loaded).
-- assignment_version is the Subtask's assignment_version when this person was added: the
-- per-person identity notification re-validation uses. CHECK is >= 0 so every existing assigned
-- row is copied whatever its version, rather than the migration refusing to apply.
-- added_at is backfilled from updated_at, an upper bound on when the assignee was set.
-- Rows written by pre-#364 code between this apply and the #364 deploy (or by a rolled-back
-- Worker) are re-synced by 0049 (#368), which is applied while #364's dual-write is live.
CREATE TABLE `project_subtask_assignees` (
  `subtask_id` text NOT NULL REFERENCES `project_subtasks`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `assignment_version` integer NOT NULL CHECK (typeof(`assignment_version`) = 'integer' AND `assignment_version` >= 0),
  `added_at` integer NOT NULL,
  PRIMARY KEY (`subtask_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `project_subtask_assignees_user_idx` ON `project_subtask_assignees` (`user_id`, `subtask_id`);
--> statement-breakpoint
INSERT INTO `project_subtask_assignees` (`subtask_id`, `user_id`, `assignment_version`, `added_at`)
SELECT `id`, `assignee_id`, `assignment_version`, `updated_at`
FROM `project_subtasks`
WHERE `assignee_id` IS NOT NULL;
