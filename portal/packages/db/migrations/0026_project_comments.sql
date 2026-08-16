CREATE TABLE project_comments (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  author_id text NOT NULL REFERENCES user(id),
  body text NOT NULL,
  content_json text NOT NULL,
  created_at integer NOT NULL,
  edited_at integer
);
--> statement-breakpoint
CREATE INDEX project_comments_project_created_idx
  ON project_comments (project_id, created_at, id);
--> statement-breakpoint
CREATE TABLE project_comment_mentions (
  id text PRIMARY KEY NOT NULL,
  comment_id text NOT NULL REFERENCES project_comments(id) ON DELETE cascade,
  mentioned_user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_comment_mentions_unique
  ON project_comment_mentions (comment_id, mentioned_user_id);
