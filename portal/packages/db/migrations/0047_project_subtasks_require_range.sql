-- Every Subtask has a complete range (ADR 0011, #343): the database now refuses a row without one.
--
-- One bare ADD COLUMN whose inline CHECK encodes the range predicate. SQLite tests an added column's
-- CHECK against every existing row, so this migration REFUSES TO APPLY while any range-less row
-- exists (a failed D1 migration is not recorded, and the table is untouched). Afterwards every INSERT
-- and UPDATE of a row is checked. It is not a table rebuild, so the foreign-key hazard recorded at
-- docs/lessons.md:27-62 (migration 0020) never applies, and it adds no trigger.
--
-- The predicate is EXACTLY portal/scripts/subtask-range-backfill-verify.sql, so the pre-merge
-- production verify returning 0 guarantees this applies. It is structural only: it cannot see a
-- Sydney DST resolution mismatch, which the serializer catches at read time.
--
-- COALESCE(..., 0) = 1: a CHECK PASSES on NULL, so a NULL anywhere in the predicate would otherwise
-- accept the row. `schedule_range_required` itself is a constant marker (always 1, never read or
-- written by the app); the UPDATE of it to 0 or NULL is refused too.
--
-- Rollback is a forward migration: ALTER TABLE project_subtasks DROP COLUMN schedule_range_required.
-- Any later migration that drops a schedule column or `due_date` MUST drop that column first: SQLite
-- refuses to drop a column an existing CHECK references.
ALTER TABLE `project_subtasks` ADD COLUMN `schedule_range_required` integer NOT NULL DEFAULT 1 CHECK (
  `schedule_range_required` = 1 AND COALESCE((
    `schedule_version` >= 1
    AND `schedule_zone` IS 'Australia/Sydney'
    AND `schedule_start_kind` IS NOT NULL
    AND `schedule_start_kind` IS `schedule_end_kind`
    AND `schedule_start_civil` IS NOT NULL
    AND `due_date` IS NOT NULL
    AND (
      (`schedule_start_kind` = 'date'
        AND `schedule_start_at` IS NULL AND `schedule_start_utc_offset_minutes` IS NULL AND `schedule_start_fold` IS NULL
        AND `schedule_end_at` IS NULL AND `schedule_end_utc_offset_minutes` IS NULL AND `schedule_end_fold` IS NULL
        AND `schedule_start_civil` <= `due_date`)
      OR
      (`schedule_start_kind` = 'timed'
        AND `schedule_start_at` IS NOT NULL AND `schedule_start_utc_offset_minutes` IS NOT NULL AND `schedule_start_fold` IS NOT NULL
        AND `schedule_end_at` IS NOT NULL AND `schedule_end_utc_offset_minutes` IS NOT NULL AND `schedule_end_fold` IS NOT NULL
        AND `schedule_start_at` < `schedule_end_at`)
    )
  ), 0) = 1
);
