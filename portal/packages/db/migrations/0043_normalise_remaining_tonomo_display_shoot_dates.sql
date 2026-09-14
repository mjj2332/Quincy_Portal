-- Second half of 0042. That migration converted Tonomo display-text shoot dates
-- ("Friday, 11 Sep, 2026") to ISO for every stage except awaiting_raw, because the hourly
-- reconciliation in workers/background/src/reconcile-awaiting-raw.ts advances any
-- awaiting_raw project whose ISO shoot_date is on or before today's Sydney business date,
-- and converting past-dated rows makes all of them due at once. That side effect is now
-- intended: those projects did shoot on the stored date and belong in raw_review. The
-- reconciliation batch size is lowered in the same release so the backlog drains over
-- several hourly runs rather than one.
--
-- No stage filter this time. Every predicate below is self-validating (the derived ISO date
-- must round-trip through date() and its weekday must match strftime('%w')), so the UPDATE
-- is a no-op on rows 0042 already converted and also sweeps any display-text row ingested
-- between the two applies.
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
WHERE `shoot_date` IS NOT NULL
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
