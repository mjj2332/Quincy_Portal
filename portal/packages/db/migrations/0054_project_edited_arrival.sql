-- Auto-move to Edited review (#486, parent #479). A Project records the time of its latest Edited-media arrival
-- (Editor Output import, Portal upload or External editor upload). The per-minute background pass moves a
-- Project still in Awaiting RAW, RAW review or Editing to Edited review once that time is 15 minutes old.
-- edited_arrived_at is epoch milliseconds and NULL means no arrival is pending. Existing Projects stay NULL, so
-- nothing is inferred from history and no Project moves because of this migration.
-- It is one bare ADD COLUMN whose CHECK references only its own column, so it is not a table rebuild and adds no
-- trigger (docs/lessons.md, the 0020 and 364 entries).
ALTER TABLE projects ADD COLUMN edited_arrived_at integer
  CHECK (edited_arrived_at IS NULL OR typeof(edited_arrived_at) = 'integer');
--> statement-breakpoint
-- A failing candidate is never abandoned: the pass counts attempts and backs off with edited_arrival_retry_at, so a
-- transient error cannot drop a valid arrival and a persistently failing row cannot hold a page slot (#194).
ALTER TABLE projects ADD COLUMN edited_arrival_attempts integer NOT NULL DEFAULT 0
  CHECK (typeof(edited_arrival_attempts) = 'integer' AND edited_arrival_attempts >= 0);
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN edited_arrival_retry_at integer
  CHECK (edited_arrival_retry_at IS NULL OR typeof(edited_arrival_retry_at) = 'integer');
--> statement-breakpoint
-- Partial index so the scan reads only Projects with a pending arrival.
CREATE INDEX projects_edited_arrival_pending_idx ON projects (edited_arrived_at) WHERE edited_arrived_at IS NOT NULL;
