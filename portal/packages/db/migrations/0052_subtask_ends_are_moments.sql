-- Every Subtask end is a moment (ADR 0016, #423): date-only ranges become 09:00 start and 17:00 end.
--
-- Step 1 converts every date-only row in place. Sydney wall time at 09:00 and 17:00 is never inside a
-- daylight-saving gap or fold, so each endpoint has exactly one instant and fold is always 0. The offset
-- is +660 while daylight saving runs and +600 otherwise. Daylight saving runs from the first Sunday of
-- October to the first Sunday of April (the rule since 2008), so a civil day d is in daylight saving when
-- d is on or after the first Sunday of its October, or before the first Sunday of its April. The first
-- Sunday of a month is date(year-month-01, 'weekday 0'). The instant is the civil minute read as UTC
-- minus the offset. packages/db/test/migration-0052.test.ts proves every day from 2008 to 2040 against
-- normalizeChecklistSchedule, so the pre-merge preflight in docs/Guides/CI-Deploy.md must confirm every
-- date-only row lies inside that window (a row before 2008 would be wrong by an hour in a few weeks).
-- A malformed date yields a NULL instant, which the 0047 range CHECK refuses, so this migration then
-- fails whole and a failed D1 migration is not recorded.
--
-- schedule_version goes up by one, so an open editor holding the old version gets the normal 409.
-- due_reminder_sent_at and updated_at are left alone: this is a representation change, not an edit, so
-- no audit row, no activity and no notification is written, and a reminder already sent stays sent.
-- Completed and archived Subtasks convert too. Rows that are already timed are not touched.
UPDATE `project_subtasks` SET
  `due_date` = `due_date` || 'T17:00',
  `schedule_start_civil` = `schedule_start_civil` || 'T09:00',
  `schedule_start_at` = (CAST(strftime('%s', `schedule_start_civil` || ' 09:00') AS INTEGER) - 60 * CASE WHEN (`schedule_start_civil` >= date(substr(`schedule_start_civil`, 1, 4) || '-10-01', 'weekday 0') OR `schedule_start_civil` < date(substr(`schedule_start_civil`, 1, 4) || '-04-01', 'weekday 0')) THEN 660 ELSE 600 END) * 1000,
  `schedule_start_utc_offset_minutes` = CASE WHEN (`schedule_start_civil` >= date(substr(`schedule_start_civil`, 1, 4) || '-10-01', 'weekday 0') OR `schedule_start_civil` < date(substr(`schedule_start_civil`, 1, 4) || '-04-01', 'weekday 0')) THEN 660 ELSE 600 END,
  `schedule_start_fold` = 0,
  `schedule_end_at` = (CAST(strftime('%s', `due_date` || ' 17:00') AS INTEGER) - 60 * CASE WHEN (`due_date` >= date(substr(`due_date`, 1, 4) || '-10-01', 'weekday 0') OR `due_date` < date(substr(`due_date`, 1, 4) || '-04-01', 'weekday 0')) THEN 660 ELSE 600 END) * 1000,
  `schedule_end_utc_offset_minutes` = CASE WHEN (`due_date` >= date(substr(`due_date`, 1, 4) || '-10-01', 'weekday 0') OR `due_date` < date(substr(`due_date`, 1, 4) || '-04-01', 'weekday 0')) THEN 660 ELSE 600 END,
  `schedule_end_fold` = 0,
  `schedule_start_kind` = 'timed',
  `schedule_end_kind` = 'timed',
  `schedule_version` = `schedule_version` + 1
WHERE `schedule_start_kind` = 'date';
--> statement-breakpoint
-- Step 2 seals it: one bare ADD COLUMN whose inline CHECK refuses any row that is not timed at both
-- ends, on insert and on update. SQLite tests an added column's CHECK against every existing row, so
-- this refuses to apply if step 1 left a date row (the whole file rolls back). The kind columns stay as
-- constant markers (always 'timed'), so no table is rebuilt and no trigger is added (docs/lessons.md:27-62).
-- COALESCE(..., 0) = 1 because a CHECK passes on NULL. The column is a constant marker (always 1).
-- Rollback is a forward migration: ALTER TABLE project_subtasks DROP COLUMN schedule_timed_required.
-- The data stays timed. Any later migration that drops a schedule kind column MUST drop this column first.
ALTER TABLE `project_subtasks` ADD COLUMN `schedule_timed_required` integer NOT NULL DEFAULT 1 CHECK (
  `schedule_timed_required` = 1 AND COALESCE((`schedule_start_kind` IS 'timed' AND `schedule_end_kind` IS 'timed'), 0) = 1
);
