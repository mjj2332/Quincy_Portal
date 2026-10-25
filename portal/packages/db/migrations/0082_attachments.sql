-- Attachments (#945, tracer #952): any file shared on a post and only ever downloaded. A separate table from embedded_media
-- on purpose: every reader of embedded_media assumes an image or a video and serves it inline, so a file kind there would be
-- one missed WHERE away from being served inline. owner_kind and owner_id name what holds it (a Project comment in #952, a
-- Notice board post in #954, a Video note or a Guest note in #955 and #956). owner_id has no foreign key because it is
-- polymorphic, so application code attaches and detaches rows in the same batch as the post. project_id cascades.
-- Exactly one uploader: a staff user, or a guest reviewer on a Review link (#956).
-- file_name is the sanitised original name, served in Content-Disposition. content_type is the sanitised declared type, kept
-- for the icon and the audit and never used to serve: every object is stored and served as application/octet-stream.
-- state mirrors embedded_media: uploading (presigned, no bytes confirmed), pending (uploaded, not yet in a post), attached,
-- detached. Only an attached row is ever served. Objects no row owns any more go to embedded_media_cleanup, keyed by storage key.
-- Additive only: one CREATE TABLE and its indexes, no rebuild. No trigger and no semicolon inside a comment.
CREATE TABLE attachments (
  id text PRIMARY KEY NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('project_comment', 'notice_post', 'video_note')),
  owner_id text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id text REFERENCES user(id),
  uploader_guest_id text REFERENCES guest_reviewers(id),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content_type text NOT NULL,
  bytes integer NOT NULL CHECK (bytes > 0),
  storage_key text NOT NULL,
  upload_id text,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'pending', 'attached', 'detached')),
  detached_at integer,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer'),
  CHECK ((state IN ('uploading', 'pending')) = (owner_id IS NULL)),
  CHECK ((state = 'detached') = (detached_at IS NOT NULL)),
  CHECK ((owner_kind = 'notice_post') = (project_id IS NULL)),
  CHECK ((uploader_id IS NULL) <> (uploader_guest_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX attachments_storage_key_unique ON attachments (storage_key);
--> statement-breakpoint
CREATE INDEX attachments_owner_idx ON attachments (owner_kind, owner_id);
--> statement-breakpoint
CREATE INDEX attachments_state_detached_idx ON attachments (state, detached_at);
--> statement-breakpoint
CREATE INDEX attachments_state_created_idx ON attachments (state, created_at);
--> statement-breakpoint
CREATE INDEX attachments_project_idx ON attachments (project_id);
--> statement-breakpoint
CREATE INDEX attachments_uploader_guest_idx ON attachments (uploader_guest_id);
