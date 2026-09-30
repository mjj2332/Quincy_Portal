-- Re-sync (#368): relation := projection of the column, for rows written by pre-#364 code between
-- 0048 and the #364 deploy, or by a rolled-back Worker. Applied while #364's dual-write is live and
-- before #368 code makes the relation authoritative. A migration applies once, so this never runs
-- over multi-assignee data (more than one assignee is gated off until well after this).
DELETE FROM `project_subtask_assignees`
WHERE NOT EXISTS (
  SELECT 1 FROM `project_subtasks` s
  WHERE s.`id` = `project_subtask_assignees`.`subtask_id`
    AND s.`assignee_id` = `project_subtask_assignees`.`user_id`
    AND s.`assignment_version` = `project_subtask_assignees`.`assignment_version`
);
--> statement-breakpoint
INSERT INTO `project_subtask_assignees` (`subtask_id`, `user_id`, `assignment_version`, `added_at`)
SELECT `id`, `assignee_id`, `assignment_version`, `updated_at` FROM `project_subtasks`
WHERE `assignee_id` IS NOT NULL
ON CONFLICT(`subtask_id`, `user_id`) DO NOTHING;
--> statement-breakpoint
-- Multi-assignee write gate (#358), seeded off. Operator-owned from here (docs/lessons.md, #160):
-- never re-assert it in a later migration.
INSERT INTO `feature_flags` (`key`, `enabled`, `updated_by`, `updated_at`)
VALUES ('subtask_multi_assignee', 0, NULL, unixepoch('now') * 1000)
ON CONFLICT(`key`) DO NOTHING;
