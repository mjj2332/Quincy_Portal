ALTER TABLE notice_board_posts ADD COLUMN content_json text;
--> statement-breakpoint
ALTER TABLE notice_board_posts ADD COLUMN edited_at integer;
--> statement-breakpoint
CREATE TABLE notice_board_post_mentions (
  id text PRIMARY KEY NOT NULL,
  post_id text NOT NULL REFERENCES notice_board_posts(id) ON DELETE cascade,
  mentioned_user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX notice_board_post_mentions_unique
  ON notice_board_post_mentions (post_id, mentioned_user_id);
