ALTER TABLE project_subtasks ADD COLUMN schedule_start_kind TEXT CHECK (schedule_start_kind IS NULL OR schedule_start_kind IN ('date', 'timed'));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_start_civil TEXT;
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_start_at INTEGER CHECK (schedule_start_at IS NULL OR typeof(schedule_start_at) = 'integer');
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_start_utc_offset_minutes INTEGER CHECK (schedule_start_utc_offset_minutes IS NULL OR (typeof(schedule_start_utc_offset_minutes) = 'integer' AND schedule_start_utc_offset_minutes BETWEEN -840 AND 840));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_start_fold INTEGER CHECK (schedule_start_fold IS NULL OR schedule_start_fold IN (0, 1));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_end_kind TEXT CHECK (schedule_end_kind IS NULL OR schedule_end_kind IN ('date', 'timed'));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_end_at INTEGER CHECK (schedule_end_at IS NULL OR typeof(schedule_end_at) = 'integer');
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_end_utc_offset_minutes INTEGER CHECK (schedule_end_utc_offset_minutes IS NULL OR (typeof(schedule_end_utc_offset_minutes) = 'integer' AND schedule_end_utc_offset_minutes BETWEEN -840 AND 840));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_end_fold INTEGER CHECK (schedule_end_fold IS NULL OR schedule_end_fold IN (0, 1));
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_zone TEXT CHECK (schedule_zone IS NULL OR schedule_zone = 'Australia/Sydney');
--> statement-breakpoint
ALTER TABLE project_subtasks ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(schedule_version) = 'integer' AND schedule_version >= 0);
