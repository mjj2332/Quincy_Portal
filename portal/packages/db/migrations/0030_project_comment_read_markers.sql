CREATE TABLE project_comment_read_markers (
  user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  last_read_comment_id text NOT NULL,
  last_read_comment_created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
--> statement-breakpoint
CREATE INDEX project_comment_read_markers_project_idx
  ON project_comment_read_markers (project_id, last_read_comment_created_at);
