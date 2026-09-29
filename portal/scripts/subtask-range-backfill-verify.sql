-- Subtask range backfill (#341) — post-apply verification, SELECT only. Not mutating.
--
-- Counts Subtasks whose stored schedule is not a structurally complete range. After the apply it must
-- return without_complete_range = 0. It is a necessary condition only: DST resolution mismatches are
-- visible to JS alone, so the runbook also re-runs the dry run and requires "0 to convert".
-- Run through `--command "$(grep -v '^--' ...)"`; see docs/Guides/Subtask-Range-Backfill.md.
SELECT COUNT(*) AS without_complete_range
FROM project_subtasks AS s
-- COALESCE: a NULL anywhere in the predicate counts the row as incomplete rather than dropping it.
WHERE COALESCE((
  s.schedule_version >= 1
  AND s.schedule_zone IS 'Australia/Sydney'
  AND s.schedule_start_kind IS NOT NULL
  AND s.schedule_start_kind IS s.schedule_end_kind
  AND s.schedule_start_civil IS NOT NULL
  AND s.due_date IS NOT NULL
  AND (
    (s.schedule_start_kind = 'date'
      AND s.schedule_start_at IS NULL AND s.schedule_start_utc_offset_minutes IS NULL AND s.schedule_start_fold IS NULL
      AND s.schedule_end_at IS NULL AND s.schedule_end_utc_offset_minutes IS NULL AND s.schedule_end_fold IS NULL
      AND s.schedule_start_civil <= s.due_date)
    OR
    (s.schedule_start_kind = 'timed'
      AND s.schedule_start_at IS NOT NULL AND s.schedule_start_utc_offset_minutes IS NOT NULL AND s.schedule_start_fold IS NOT NULL
      AND s.schedule_end_at IS NOT NULL AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IS NOT NULL
      AND s.schedule_start_at < s.schedule_end_at)
  )
), 0) = 0;
