-- Project social overlay selection (#870): the Social overlays a Project offers in the Video viewer, chosen in the Project sheet.
-- One row per (Project, overlay). A Project with no usable row resolves to the Default overlay at read time, so nothing is backfilled and no fallback row is ever stored.
-- Deleting a Project removes its rows. An overlay row cannot be deleted while a Project selects it, because overlays are archived and never deleted, and an archived overlay stays selected on the Projects that had it.
-- Provenance lives in the audit log, not here. No trigger and no semicolon inside a comment.
CREATE TABLE project_social_overlays (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  overlay_id text NOT NULL REFERENCES social_overlays(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, overlay_id)
);
--> statement-breakpoint
CREATE INDEX project_social_overlays_overlay_idx ON project_social_overlays (overlay_id);
