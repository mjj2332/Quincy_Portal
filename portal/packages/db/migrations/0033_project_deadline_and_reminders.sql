ALTER TABLE projects ADD COLUMN deadline_local_civil text;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_zone text
  CHECK (deadline_zone IS NULL OR deadline_zone = 'Australia/Sydney');
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_utc_offset_minutes integer
  CHECK (deadline_utc_offset_minutes IS NULL OR
    (typeof(deadline_utc_offset_minutes) = 'integer' AND
     deadline_utc_offset_minutes BETWEEN -840 AND 840));
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_fold integer
  CHECK (deadline_fold IS NULL OR deadline_fold IN (0, 1));
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_at integer
  CHECK (deadline_at IS NULL OR typeof(deadline_at) = 'integer');
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_reminder_offsets_json text
  CHECK (deadline_reminder_offsets_json IS NULL OR
    json_valid(deadline_reminder_offsets_json));
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN deadline_version integer NOT NULL DEFAULT 0
  CHECK (typeof(deadline_version) = 'integer' AND deadline_version >= 0);
--> statement-breakpoint
CREATE TABLE project_deadline_occurrences (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  schedule_version integer NOT NULL
    CHECK (typeof(schedule_version) = 'integer' AND schedule_version >= 1),
  kind text NOT NULL CHECK (kind IN ('advance', 'due_now')),
  reminder_offset_minutes integer NOT NULL
    CHECK (typeof(reminder_offset_minutes) = 'integer' AND
      reminder_offset_minutes BETWEEN 0 AND 43200),
  fire_at integer NOT NULL,
  deadline_at integer NOT NULL,
  deadline_local_civil text NOT NULL,
  deadline_zone text NOT NULL CHECK (deadline_zone = 'Australia/Sydney'),
  deadline_utc_offset_minutes integer NOT NULL,
  deadline_fold integer NOT NULL CHECK (deadline_fold IN (0, 1)),
  status text NOT NULL
    CHECK (status IN ('pending', 'fired', 'skipped', 'superseded')),
  terminal_reason text CHECK (terminal_reason IS NULL OR terminal_reason IN (
    'elapsed_at_save', 'schedule_replaced', 'deadline_cleared',
    'project_delivered', 'project_archived'
  )),
  fired_at integer,
  created_by text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK (
    (kind = 'due_now' AND reminder_offset_minutes = 0) OR
    (kind = 'advance' AND reminder_offset_minutes BETWEEN 1 AND 43200)
  ),
  CHECK (fire_at = deadline_at - (reminder_offset_minutes * 60000)),
  CHECK (
    (status = 'pending' AND terminal_reason IS NULL AND fired_at IS NULL) OR
    (status = 'fired' AND terminal_reason IS NULL AND fired_at IS NOT NULL) OR
    (status IN ('skipped', 'superseded') AND terminal_reason IS NOT NULL AND fired_at IS NULL)
  ),
  UNIQUE (project_id, schedule_version, kind, reminder_offset_minutes)
);
--> statement-breakpoint
CREATE INDEX project_deadline_occurrences_due_idx
  ON project_deadline_occurrences (status, fire_at, project_id, id);
--> statement-breakpoint
CREATE INDEX project_deadline_occurrences_project_version_idx
  ON project_deadline_occurrences
    (project_id, schedule_version, status, reminder_offset_minutes, id);
--> statement-breakpoint
CREATE TABLE notification_preferences (
  user_id text PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE cascade,
  project_deadline_reminder_emails integer NOT NULL DEFAULT 1
    CHECK (project_deadline_reminder_emails IN (0, 1)),
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX notification_outbox_project_event_status_idx
  ON notification_outbox (project_id, event_type, status, source_key);
