-- Video note rich media and mentions (#835, sub-ticket M). Schema only, no route reads the new columns yet.
-- embedded_media is rebuilt ONCE so owner_kind can admit video_note and uploader_id can be NULL for a guest uploader (SQLite cannot alter a CHECK or drop NOT NULL in place).
-- This is the documented exception to the no-table-rebuild rule (docs/Guides/CI-Deploy.md section 0075): foreign_keys stays ON, there is no PRAGMA and no __new_ name,
-- the only table that references embedded_media is link_previews (ON DELETE SET NULL, no CASCADE child), and its image_media_id values are stashed in a plain column first.
-- DROP TABLE embedded_media then fires SET NULL on link_previews, and the final UPDATE puts every value back before the stash column is dropped.
-- uploader_guest_id names the guest who uploaded the file, and exactly one of uploader_id and uploader_guest_id is set.
-- A video_note row requires a project_id, so the notice_post tie still holds.
-- video_notes.content_json holds the rich note document, at most 32768 bytes. NULL for every existing note, which renders from body.
-- video_note_mentions records who a note mentions. It cascades with the note.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE link_previews ADD COLUMN image_media_id_0075 text;
--> statement-breakpoint
UPDATE link_previews SET image_media_id_0075 = image_media_id;
--> statement-breakpoint
CREATE TABLE embedded_media_0075 (
  id text PRIMARY KEY NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('project_comment', 'notice_post', 'whiteboard', 'video_note')),
  owner_id text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id text REFERENCES user(id),
  uploader_guest_id text REFERENCES guest_reviewers(id),
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
  rendition_status text NOT NULL DEFAULT 'not_required' CHECK (rendition_status IN ('not_required', 'pending', 'ready', 'failed')),
  display_content_type text,
  display_bytes integer,
  display_width integer,
  display_height integer,
  rendition_attempts integer NOT NULL DEFAULT 0,
  rendition_lease_until integer,
  rendition_requested_at integer,
  rendition_resent_at integer,
  rendition_error text,
  width integer,
  height integer,
  CHECK ((state IN ('uploading', 'pending')) = (owner_id IS NULL)),
  CHECK ((state = 'detached') = (detached_at IS NOT NULL)),
  CHECK ((owner_kind = 'notice_post') = (project_id IS NULL)),
  CHECK (owner_kind <> 'video_note' OR project_id IS NOT NULL),
  CHECK ((uploader_id IS NULL) <> (uploader_guest_id IS NULL))
);
--> statement-breakpoint
INSERT INTO embedded_media_0075 (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, poster_key, upload_id, state, detached_at, created_at, updated_at, rendition_status, display_content_type, display_bytes, display_width, display_height, rendition_attempts, rendition_lease_until, rendition_requested_at, rendition_resent_at, rendition_error, width, height)
SELECT id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, poster_key, upload_id, state, detached_at, created_at, updated_at, rendition_status, display_content_type, display_bytes, display_width, display_height, rendition_attempts, rendition_lease_until, rendition_requested_at, rendition_resent_at, rendition_error, width, height FROM embedded_media;
--> statement-breakpoint
DROP TABLE embedded_media;
--> statement-breakpoint
ALTER TABLE embedded_media_0075 RENAME TO embedded_media;
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
CREATE INDEX embedded_media_rendition_idx ON embedded_media (rendition_status, rendition_requested_at);
--> statement-breakpoint
CREATE INDEX embedded_media_uploader_guest_idx ON embedded_media (uploader_guest_id);
--> statement-breakpoint
UPDATE link_previews SET image_media_id = image_media_id_0075;
--> statement-breakpoint
ALTER TABLE link_previews DROP COLUMN image_media_id_0075;
--> statement-breakpoint
ALTER TABLE video_notes ADD COLUMN content_json text CHECK (content_json IS NULL OR length(CAST(content_json AS BLOB)) <= 32768);
--> statement-breakpoint
CREATE TABLE video_note_mentions (
  id text PRIMARY KEY NOT NULL,
  note_id text NOT NULL REFERENCES video_notes(id) ON DELETE CASCADE,
  mentioned_user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  UNIQUE (note_id, mentioned_user_id)
);
--> statement-breakpoint
CREATE INDEX video_note_mentions_user_idx ON video_note_mentions (mentioned_user_id);
