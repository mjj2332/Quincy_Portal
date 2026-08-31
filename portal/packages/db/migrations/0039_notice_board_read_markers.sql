CREATE TABLE notice_board_read_markers (
  user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
  last_read_post_id text NOT NULL,
  last_read_post_created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (user_id)
);
