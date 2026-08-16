CREATE TABLE project_subtasks (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  title text NOT NULL,
  done integer NOT NULL DEFAULT 0,
  position integer NOT NULL,
  assignee_id text REFERENCES user(id) ON DELETE SET NULL,
  assignment_version integer NOT NULL DEFAULT 0,
  due_date text,
  created_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX project_subtasks_project_position_idx
  ON project_subtasks (project_id, position, id);
--> statement-breakpoint
CREATE INDEX project_subtasks_assignee_idx
  ON project_subtasks (assignee_id);
