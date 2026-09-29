-- Subtask range backfill (#341) — dry-run read, SELECT only. Not a migration, not mutating.
--
-- Returns EVERY Subtask (done ones and those on archived Projects included) with the Project inputs the
-- default range needs. Classification is not done here: subtask-range-backfill.ts runs each row through
-- the shared serializeChecklistSchedule, because SQL cannot see DST resolution mismatches, non-calendar
-- dates or cleared versioned rows. Before running anything against production:
--   1. Back up first: `wrangler d1 export ...`.
--   2. Get the owner's explicit approval to proceed.
--   3. Run this through `--command "$(grep -v '^--' ...)"`, not `--file` (a remote --file run returns
--      import counts, not rows). See docs/Guides/Subtask-Range-Backfill.md for the exact command.
--
-- Two statements, two result sets: every Subtask, then every existing backfill audit row. `prepare` refuses
-- output without both, and refuses while any audit is unpaired (its Subtask still at the audit's old version).
SELECT
  s.id AS subtask_id,
  s.project_id AS project_id,
  p.street AS street,
  s.title AS title,
  s.done AS done,
  s.assignee_id AS assignee_id,
  s.due_reminder_sent_at AS due_reminder_sent_at,
  s.due_date AS due_date,
  s.schedule_start_kind AS schedule_start_kind,
  s.schedule_start_civil AS schedule_start_civil,
  s.schedule_start_at AS schedule_start_at,
  s.schedule_start_utc_offset_minutes AS schedule_start_utc_offset_minutes,
  s.schedule_start_fold AS schedule_start_fold,
  s.schedule_end_kind AS schedule_end_kind,
  s.schedule_end_at AS schedule_end_at,
  s.schedule_end_utc_offset_minutes AS schedule_end_utc_offset_minutes,
  s.schedule_end_fold AS schedule_end_fold,
  s.schedule_zone AS schedule_zone,
  s.schedule_version AS schedule_version,
  p.shoot_date AS shoot_date,
  p.created_at AS project_created_at,
  p.deadline_at AS deadline_at,
  p.deadline_local_civil AS deadline_local_civil,
  p.archived_at AS archived_at
FROM project_subtasks s
JOIN projects p ON p.id = s.project_id
ORDER BY p.street, s.project_id, s.position, s.id;
SELECT
  a.id AS audit_id,
  a.target_id AS audit_subtask_id,
  json_extract(a.meta_json, '$.fromVersion') AS audit_from_version,
  json_extract(a.meta_json, '$.proposal') AS audit_proposal,
  a.created_at AS audit_created_at
FROM audit_log a
WHERE a.action = 'project_subtask.update'
  AND a.target_type = 'project_subtask'
  AND json_extract(a.meta_json, '$.source') = 'subtask_range_backfill'
ORDER BY a.created_at, a.id;
