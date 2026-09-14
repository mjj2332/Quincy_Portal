-- Tonomo's `created` webhook often omits `when.start_time`, so `shootDateFrom`
-- (packages/shared/src/tonomo.ts) used to store the payload's display text verbatim —
-- e.g. "Thursday, 17 Sep, 2026" — into `projects.shoot_date` instead of an ISO date. A
-- later `changed` event usually carries `when.start_time`, but `updateProject`
-- (workers/background/src/tonomo/process.ts) only filled null fields, so the display text
-- was never replaced. Every ISO-only reader (Editor folder candidate discovery,
-- awaiting-RAW reconciliation, board sort) silently skipped those rows. The ingest path is
-- fixed separately (parseTonomoDisplayDate normalises at parse time, and updateProject now
-- has a narrow rule that lets a canonical incoming value replace a non-canonical stored
-- one); this migration backfills the display text already sitting in `projects` for rows
-- Tonomo will not touch again.
--
-- `awaiting_raw` rows are deliberately excluded here even though some of them match the
-- same display-text shape: the hourly reconciliation in reconcile-awaiting-raw.ts advances
-- any `awaiting_raw` project whose `shoot_date` is on/before today's Sydney business date
-- to `raw_review`. Converting a past-dated display string to ISO in this migration would
-- make every one of those rows due in the same reconciliation run. Those rows are held for
-- a later, separately approved migration that accounts for that side effect.
UPDATE `projects`
SET `shoot_date` = (
  substr(`shoot_date`, -4, 4) || '-' ||
  CASE substr(`shoot_date`, instr(`shoot_date`, ', ') + 5, 3)
    WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
    WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
    WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
  END || '-' ||
  substr(`shoot_date`, instr(`shoot_date`, ', ') + 2, 2)
)
WHERE `stage_key` <> 'awaiting_raw'
  AND `shoot_date` IS NOT NULL
  AND date(`shoot_date`) IS NULL
  AND `shoot_date` LIKE '%, __ ___, ____'
  AND substr(`shoot_date`, 1, instr(`shoot_date`, ',') - 1) IN
    ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
  AND CASE substr(`shoot_date`, instr(`shoot_date`, ', ') + 5, 3)
    WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
    WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
    WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
  END IS NOT NULL
  AND date(
    substr(`shoot_date`, -4, 4) || '-' ||
    CASE substr(`shoot_date`, instr(`shoot_date`, ', ') + 5, 3)
      WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
      WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
      WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
    END || '-' ||
    substr(`shoot_date`, instr(`shoot_date`, ', ') + 2, 2)
  ) = (
    substr(`shoot_date`, -4, 4) || '-' ||
    CASE substr(`shoot_date`, instr(`shoot_date`, ', ') + 5, 3)
      WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
      WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
      WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
    END || '-' ||
    substr(`shoot_date`, instr(`shoot_date`, ', ') + 2, 2)
  )
  AND CASE strftime('%w',
    substr(`shoot_date`, -4, 4) || '-' ||
    CASE substr(`shoot_date`, instr(`shoot_date`, ', ') + 5, 3)
      WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
      WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
      WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12'
    END || '-' ||
    substr(`shoot_date`, instr(`shoot_date`, ', ') + 2, 2)
  )
    WHEN '0' THEN 'Sunday' WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday' WHEN '3' THEN 'Wednesday'
    WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday' WHEN '6' THEN 'Saturday'
  END = substr(`shoot_date`, 1, instr(`shoot_date`, ',') - 1);
