-- Subtask reminders fire (#424, ADR 0016). Every Subtask gets the default reminder set, "1 day before" plus
-- "Due now", counted back from its due (the end of its range). The set is stored as advance offsets only
-- (reminder_offsets_json) and "Due now" is always implied, exactly like the Project Deadline reminders of 0033.
-- Occurrences are scheduled rows in project_subtask_reminder_occurrences and the every-minute scan fires them.
--
-- Step 1 adds the offsets column. It is one bare ADD COLUMN whose CHECK references only its own column,
-- so it is not a table rebuild and adds no trigger (docs/lessons.md, the 0020 and 364 entries). Every existing
-- row takes the default one day, completed and archived Subtasks included.
ALTER TABLE project_subtasks ADD COLUMN reminder_offsets_json text NOT NULL DEFAULT '[1440]'
  CHECK (CASE WHEN json_valid(reminder_offsets_json) THEN json_type(reminder_offsets_json) = 'array' ELSE 0 END);
--> statement-breakpoint
-- Step 2 creates the occurrence table, mirroring project_deadline_occurrences. schedule_version is the Subtask
-- schedule_version the occurrence was generated for, so a changed range supersedes the old set. created_by is NULL
-- for rows the system or this migration wrote. A live (pending or fired) row is unique per version, kind and offset.
CREATE TABLE project_subtask_reminder_occurrences (
  id text PRIMARY KEY NOT NULL,
  subtask_id text NOT NULL REFERENCES project_subtasks(id) ON DELETE cascade,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  schedule_version integer NOT NULL
    CHECK (typeof(schedule_version) = 'integer' AND schedule_version >= 1),
  kind text NOT NULL CHECK (kind IN ('advance', 'due_now')),
  reminder_offset_minutes integer NOT NULL
    CHECK (typeof(reminder_offset_minutes) = 'integer' AND
      reminder_offset_minutes BETWEEN 0 AND 43200),
  fire_at integer NOT NULL,
  due_at integer NOT NULL,
  due_local_civil text NOT NULL,
  due_zone text NOT NULL CHECK (due_zone = 'Australia/Sydney'),
  due_utc_offset_minutes integer NOT NULL,
  due_fold integer NOT NULL CHECK (due_fold IN (0, 1)),
  status text NOT NULL
    CHECK (status IN ('pending', 'fired', 'superseded')),
  terminal_reason text CHECK (terminal_reason IS NULL OR terminal_reason IN (
    'schedule_replaced', 'reminders_changed', 'subtask_completed',
    'project_archived', 'due_elapsed', 'legacy_due_today_sent'
  )),
  fired_at integer,
  created_by text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK (
    (kind = 'due_now' AND reminder_offset_minutes = 0) OR
    (kind = 'advance' AND reminder_offset_minutes BETWEEN 1 AND 43200)
  ),
  CHECK (fire_at = due_at - (reminder_offset_minutes * 60000)),
  CHECK (
    (status = 'pending' AND terminal_reason IS NULL AND fired_at IS NULL) OR
    (status = 'fired' AND terminal_reason IS NULL AND fired_at IS NOT NULL) OR
    (status = 'superseded' AND terminal_reason IS NOT NULL AND fired_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX project_subtask_reminder_occurrences_due_idx
  ON project_subtask_reminder_occurrences (status, fire_at, id);
--> statement-breakpoint
CREATE INDEX project_subtask_reminder_occurrences_subtask_idx
  ON project_subtask_reminder_occurrences (subtask_id, status);
--> statement-breakpoint
CREATE INDEX project_subtask_reminder_occurrences_project_idx
  ON project_subtask_reminder_occurrences (project_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX project_subtask_reminder_occurrences_live_unique
  ON project_subtask_reminder_occurrences (subtask_id, schedule_version, kind, reminder_offset_minutes)
  WHERE status IN ('pending', 'fired');
--> statement-breakpoint
-- Step 3 adds the "Subtask reminder emails" preference. It is on by default and is read with COALESCE(..., 1),
-- so an old Worker that upserts a preferences row without this column still leaves it at 1.
ALTER TABLE notification_preferences ADD COLUMN subtask_reminder_emails integer NOT NULL DEFAULT 1
  CHECK (subtask_reminder_emails IN (0, 1));
--> statement-breakpoint
-- Step 4 first repairs the legacy stamp. The retired 08:00 pass set due_reminder_sent_at before its queued delivery went out,
-- so a stamped Subtask whose legacy due-today outbox row is still waiting (or was suppressed) and has no sent ledger row was never
-- alerted. Clearing its stamp lets the backfill below and the hourly reconcile treat it like any other live Subtask, while step 5
-- still suppresses the legacy delivery so nobody gets both. A stamped Subtask whose alert was delivered keeps its stamp.
UPDATE project_subtasks SET due_reminder_sent_at = NULL
WHERE due_reminder_sent_at IS NOT NULL AND done = 0
  AND EXISTS (
    SELECT 1 FROM notification_outbox o
    WHERE o.event_type = 'project.subtask.due_today' AND o.status IN ('pending', 'queued', 'suppressed')
      AND json_valid(o.payload_json) AND json_extract(o.payload_json, '$.assignment.subtaskId') = project_subtasks.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM notification_outbox o2
    JOIN notification_delivery_ledger l ON l.outbox_id = o2.id
    WHERE o2.event_type = 'project.subtask.due_today' AND l.status = 'sent'
      AND json_valid(o2.payload_json) AND json_extract(o2.payload_json, '$.assignment.subtaskId') = project_subtasks.id
  );
--> statement-breakpoint
-- Step 4b backfills the occurrences that are still ahead. Only a live Subtask in a live Project qualifies
-- (not done, Project not archived, no legacy 08:00 alert already sent for the current end), and only an offset whose
-- fire time is in the future becomes pending, so nothing already elapsed is stored and nothing fires on deploy.
-- The offsets are the stored advance offsets plus the implied due-now offset 0. The same predicate is written by
-- buildSubtaskReminderMaterialization in packages/db/src/subtask-reminder-bundles.ts, and
-- packages/db/test/migration-0053.test.ts pins the two against each other. No audit row and no activity is written.
INSERT INTO project_subtask_reminder_occurrences
  (id, subtask_id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, due_at, due_local_civil,
   due_zone, due_utc_offset_minutes, due_fold, status, terminal_reason, fired_at, created_by, created_at, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  s.id, s.project_id, s.schedule_version,
  CASE WHEN o.value = 0 THEN 'due_now' ELSE 'advance' END,
  o.value, s.schedule_end_at - (o.value * 60000), s.schedule_end_at, s.due_date,
  'Australia/Sydney', s.schedule_end_utc_offset_minutes, s.schedule_end_fold, 'pending', NULL, NULL, NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM project_subtasks s
JOIN projects p ON p.id = s.project_id,
json_each(json_insert(s.reminder_offsets_json, '$[#]', 0)) o
WHERE typeof(o.value) = 'integer' AND o.value BETWEEN 0 AND 43200
  AND s.done = 0 AND p.archived_at IS NULL AND s.due_reminder_sent_at IS NULL
  AND s.schedule_end_at IS NOT NULL AND s.schedule_zone = 'Australia/Sydney'
  AND s.schedule_end_utc_offset_minutes IS NOT NULL AND s.schedule_end_fold IN (0, 1)
  AND s.schedule_end_at - (o.value * 60000) > CAST(strftime('%s', 'now') AS INTEGER) * 1000
GROUP BY s.id, o.value;
--> statement-breakpoint
-- Step 5 is the cutover. The hourly 08:00 due-today alert is retired by this change, so a legacy due-today delivery
-- that was written but not yet sent is suppressed now, and nobody gets both alerts. Ledger rows go first because the
-- outbox row is only closed once none of its ledger rows is still waiting. Delivered rows are history and stay readable.
UPDATE notification_delivery_ledger
SET status = 'suppressed', last_error_code = 'reauthorization_suppressed',
    last_error = 'Legacy Subtask due-today alert retired by Subtask reminders.',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE event_type = 'project.subtask.due_today' AND status = 'pending';
--> statement-breakpoint
UPDATE notification_outbox
SET status = 'suppressed', lease_token = NULL, lease_expires_at = NULL,
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    last_error_code = 'reauthorization_suppressed',
    last_error = 'Legacy Subtask due-today alert retired by Subtask reminders.',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE event_type = 'project.subtask.due_today' AND status IN ('pending', 'queued')
  AND NOT EXISTS (
    SELECT 1 FROM notification_delivery_ledger l
    WHERE l.outbox_id = notification_outbox.id AND l.status IN ('pending', 'processing')
  );
