-- Embedded media (#493): an image placed inside a post. owner_kind and owner_id name what holds it
-- (a Project comment today, a Notice board post or a Project whiteboard later). owner_id has no foreign key
-- because it is polymorphic, so application code attaches and detaches rows in the same batch as the post.
-- project_id cascades, so a Project hard delete leaves no rows (its objects are purged by prefix first).
-- state: uploading (presigned, no bytes confirmed), pending (uploaded, not yet in a post), attached, detached.
-- A detached row is reclaimed 7 days after detached_at, and an uploading or pending row 7 days after created_at.
-- embedded_media_cleanup is the durable queue of R2 objects and multipart uploads that no row owns any more
-- (a Project hard delete, a sweep claim, a rejected or late completion). project_id has no foreign key on purpose:
-- the Project is usually gone by the time the queue is drained. Rows leave only once the object is deleted.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
CREATE TABLE embedded_media (
  id text PRIMARY KEY NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('project_comment', 'notice_post', 'whiteboard')),
  owner_id text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id text NOT NULL REFERENCES user(id),
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'preview_image')),
  content_type text NOT NULL,
  bytes integer NOT NULL CHECK (bytes > 0),
  original_key text NOT NULL,
  display_key text,
  poster_key text,
  upload_id text,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'pending', 'attached', 'detached')),
  detached_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK ((state IN ('uploading', 'pending')) = (owner_id IS NULL)),
  CHECK ((state = 'detached') = (detached_at IS NOT NULL)),
  CHECK ((owner_kind = 'notice_post') = (project_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX embedded_media_original_key_unique ON embedded_media (original_key);
--> statement-breakpoint
CREATE INDEX embedded_media_owner_idx ON embedded_media (owner_kind, owner_id);
--> statement-breakpoint
CREATE INDEX embedded_media_state_detached_idx ON embedded_media (state, detached_at);
--> statement-breakpoint
CREATE INDEX embedded_media_state_created_idx ON embedded_media (state, created_at);
--> statement-breakpoint
CREATE INDEX embedded_media_project_idx ON embedded_media (project_id);
--> statement-breakpoint
CREATE TABLE embedded_media_cleanup (
  storage_key text PRIMARY KEY NOT NULL,
  upload_id text,
  project_id text,
  queued_at integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX embedded_media_cleanup_queued_idx ON embedded_media_cleanup (queued_at);
