-- Priority narrows from 1-10 to 1-5, per ADR 0001 (docs/adr/0001-project-priority-1-to-5.md).
-- This deliberately avoids the shadow-table rebuild drizzle-kit generates by default for a
-- narrowed CHECK (build a replacement table, copy every row across, drop the original, and
-- rename the replacement into place, wrapped in a foreign-key-enforcement toggle that D1
-- does not honour during remote migration execution). Twenty tables reference projects.id,
-- eighteen of them ON DELETE CASCADE, so dropping the original table there is exactly the
-- production hazard recorded at docs/lessons.md:27-62. This migration instead does a
-- column-level swap: add a new column with the narrower CHECK, backfill it, drop the old
-- column, and rename the new one into place. The live `priority` column's CHECK is an
-- inline column constraint (added as a bare ALTER TABLE ADD COLUMN in migration 0020), not
-- a table-level named constraint, which is what makes DROP COLUMN legal here without a
-- rebuild. No table is ever dropped, so no foreign-key clause ever fires.
ALTER TABLE `projects` ADD COLUMN `priority_next` integer CHECK("projects"."priority_next" IS NULL OR (typeof("projects"."priority_next") = 'integer' AND "projects"."priority_next" >= 1 AND "projects"."priority_next" <= 5));--> statement-breakpoint
-- Priority narrows by clamping (min(n, 5)), not compression, per ADR 0001. SQLite's
-- multi-argument min() passes NULL through unchanged, so unset priorities stay unset.
UPDATE `projects` SET `priority_next` = min(`priority`, 5);--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `priority`;--> statement-breakpoint
ALTER TABLE `projects` RENAME COLUMN `priority_next` TO `priority`;--> statement-breakpoint
-- Historical `project.priority.changed` activity payloads recorded the raw 1-10 value the
-- actor set. Clamp any payload above 5 the same way, so the payload schema's new 1-5 max
-- (packages/shared/src/project-activity.ts) can read every existing row. Ordered last and
-- touches no `projects` row, so it cannot interact with the column swap above.
UPDATE `project_activity_events`
SET `safe_payload_json` = json_set(`safe_payload_json`, '$.priority', min(json_extract(`safe_payload_json`, '$.priority'), 5))
WHERE `event_type` = 'project.priority.changed'
  AND json_extract(`safe_payload_json`, '$.priority') > 5;
