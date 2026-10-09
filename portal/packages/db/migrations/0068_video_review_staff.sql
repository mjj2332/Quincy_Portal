-- Staff-side video review (#741 PR 3): guest_reviewers, videos, video_version_meta, video_upload_reservations, video_notes and video_note_markup. Times are epoch milliseconds.
-- guest_reviewers holds one row per external reviewer, keyed by normalized email.
-- videos.id equals assets.version_group_id of that Video's Versions. position orders Videos inside a Collection.
-- video_version_meta is the probed media facts for one Version (one Asset), with the frame rate as the fps_num over fps_den rational and the timecode origin in frames.
-- video_upload_reservations tracks an upload from reservation to completion. video_id and asset_id carry no FK on purpose because the Video row and the Asset row are created only at completion.
-- Only one reservation per video_id may be active (pending, completing or aborting) at a time. version 1 carries new_video_title and a later version does not.
-- video_notes are frame-anchored notes and replies. A note has exactly one author (a user or a guest) and a guest note is always public. A root note has a start_frame and a reply has none.
-- A copied note keeps the original author name, role and version and is copied at most once per Asset. video_note_markup holds the drawing strokes JSON for a note, capped at 524288 bytes.
-- Additive only, so a Worker older than this change ignores all six tables and a rollback is safe. No feature flag row is written here since flags are operator-set.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
CREATE TABLE guest_reviewers (
  id text PRIMARY KEY NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  display_name text,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer')
);
--> statement-breakpoint
CREATE TABLE videos (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  premium integer NOT NULL DEFAULT 0 CHECK (premium IN (0, 1)),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer')
);
--> statement-breakpoint
CREATE INDEX videos_collection_position_idx ON videos (collection_id, position, id);
--> statement-breakpoint
CREATE INDEX videos_project_idx ON videos (project_id);
--> statement-breakpoint
CREATE TABLE video_version_meta (
  asset_id text PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  fps_num integer NOT NULL CHECK (fps_num > 0),
  fps_den integer NOT NULL CHECK (fps_den > 0),
  media_timescale integer NOT NULL CHECK (media_timescale > 0),
  frame_delta integer NOT NULL CHECK (frame_delta > 0),
  frame_count integer NOT NULL CHECK (frame_count > 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  codec text NOT NULL CHECK (codec IN ('avc1', 'avc3')),
  codec_string text NOT NULL,
  start_tc_frames integer CHECK (start_tc_frames IS NULL OR start_tc_frames >= 0),
  tc_nominal_fps integer NOT NULL CHECK (tc_nominal_fps > 0),
  tc_drop_frame integer NOT NULL CHECK (tc_drop_frame IN (0, 1)),
  fast_start integer NOT NULL CHECK (fast_start IN (0, 1)),
  has_audio integer NOT NULL CHECK (has_audio IN (0, 1)),
  probe_version integer NOT NULL CHECK (probe_version > 0),
  poster_key text UNIQUE,
  uploaded_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer')
);
--> statement-breakpoint
CREATE INDEX video_version_meta_video_idx ON video_version_meta (video_id);
--> statement-breakpoint
CREATE TABLE video_upload_reservations (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES user(id),
  video_id text NOT NULL,
  new_video_title text,
  version integer NOT NULL CHECK (version >= 1),
  asset_id text NOT NULL UNIQUE,
  r2_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 2000000000),
  content_type text NOT NULL CHECK (content_type = 'video/mp4'),
  upload_id text,
  supersedes_asset_id text,
  client_probe_json text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completing', 'aborting', 'completed', 'rejected', 'expired', 'failed')),
  reject_reason text,
  expires_at integer NOT NULL,
  completing_at integer,
  completed_at integer,
  completion_audit_id text NOT NULL UNIQUE,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer'),
  CHECK ((version = 1) = (new_video_title IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX video_upload_reservations_active_video_unique ON video_upload_reservations (video_id) WHERE status IN ('pending', 'completing', 'aborting');
--> statement-breakpoint
CREATE INDEX video_upload_reservations_status_expiry_idx ON video_upload_reservations (status, expires_at);
--> statement-breakpoint
CREATE INDEX video_upload_reservations_project_creator_idx ON video_upload_reservations (project_id, created_by);
--> statement-breakpoint
CREATE TABLE video_notes (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  parent_id text REFERENCES video_notes(id) ON DELETE CASCADE,
  author_user_id text REFERENCES user(id),
  author_guest_id text REFERENCES guest_reviewers(id),
  author_role text NOT NULL CHECK (author_role IN ('admin', 'editor', 'external_editor', 'photographer', 'guest')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  start_frame integer CHECK (start_frame IS NULL OR start_frame >= 0),
  end_frame integer,
  drawing_frame integer CHECK (drawing_frame IS NULL OR drawing_frame >= 0),
  body text NOT NULL CHECK (length(body) <= 10000),
  resolved_at integer,
  resolved_by text REFERENCES user(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at integer,
  copied_from_note_id text REFERENCES video_notes(id) ON DELETE SET NULL,
  copied_from_version integer,
  original_author_name text,
  original_author_role text,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  edited_at integer,
  CHECK ((author_user_id IS NULL) <> (author_guest_id IS NULL)),
  CHECK (author_guest_id IS NULL OR (visibility = 'public' AND author_role = 'guest')),
  CHECK ((parent_id IS NULL) = (start_frame IS NOT NULL)),
  CHECK (end_frame IS NULL OR (start_frame IS NOT NULL AND end_frame > start_frame)),
  CHECK (parent_id IS NULL OR (drawing_frame IS NULL AND resolved_at IS NULL AND copied_from_version IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK ((copied_from_version IS NULL) = (original_author_name IS NULL) AND (copied_from_version IS NULL) = (original_author_role IS NULL)),
  CHECK (copied_from_note_id IS NULL OR copied_from_version IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX video_notes_asset_frame_idx ON video_notes (asset_id, parent_id, start_frame);
--> statement-breakpoint
CREATE INDEX video_notes_parent_idx ON video_notes (parent_id);
--> statement-breakpoint
CREATE INDEX video_notes_video_idx ON video_notes (video_id);
--> statement-breakpoint
CREATE INDEX video_notes_project_created_idx ON video_notes (project_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX video_notes_copy_unique ON video_notes (asset_id, copied_from_note_id) WHERE copied_from_note_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE video_note_markup (
  note_id text PRIMARY KEY NOT NULL REFERENCES video_notes(id) ON DELETE CASCADE,
  strokes_json text NOT NULL CHECK (length(CAST(strokes_json AS BLOB)) <= 524288),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer')
);
