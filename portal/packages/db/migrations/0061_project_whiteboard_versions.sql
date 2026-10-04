-- Project whiteboard versions (#500): the index of immutable snapshots of a Project's whiteboard. The scene itself lives in the
-- Project's Durable Object and each snapshot's bytes live in R2 at r2_key (projects/{project}/whiteboard/versions/{id}.json), so this
-- table is metadata only. A row is written only AFTER its object exists, so a ready row never points at a missing object.
-- ordinal is the Project's own monotonic counter (assigned by the Durable Object, single writer) and orders the history.
-- generation is the board generation the snapshot was taken in (a restore starts a new generation).
-- reason: interval (30 s cadence while the board changes), last_leave (the last person left a changed board), pre_restore (the backup taken before a restore).
-- state: ready (offered and restorable) or pruning (beyond the newest 30, its object is being deleted and the row goes with it).
-- project_id cascades, so a Project hard delete leaves no rows (its objects are purged by prefix first).
-- created_by is the last person who changed the board (the restoring person for pre_restore) and becomes NULL if that user is deleted.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
CREATE TABLE project_whiteboard_versions (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  ordinal integer NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  generation integer NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0),
  scene_revision integer NOT NULL CHECK (typeof(scene_revision) = 'integer' AND scene_revision >= 0),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  created_by text REFERENCES user(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('interval', 'last_leave', 'pre_restore')),
  scene_sha256 text NOT NULL,
  byte_count integer NOT NULL CHECK (typeof(byte_count) = 'integer' AND byte_count >= 0),
  element_count integer NOT NULL CHECK (typeof(element_count) = 'integer' AND element_count >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'pruning'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_whiteboard_versions_r2_key_unique ON project_whiteboard_versions (r2_key);
--> statement-breakpoint
CREATE UNIQUE INDEX project_whiteboard_versions_project_ordinal_unique ON project_whiteboard_versions (project_id, ordinal);
--> statement-breakpoint
CREATE INDEX project_whiteboard_versions_project_state_ordinal_idx ON project_whiteboard_versions (project_id, state, ordinal DESC);
