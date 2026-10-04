-- Link previews (#497): the card a post shows for a link inside it. A post stores only the id of its preview and the server fills
-- the title, description, site name, URL and image in when it serves the post, so a browser can never put its own text on a link.
-- owner_kind and owner_id name what holds the preview (a Project comment or a Notice board post). owner_id has no foreign key
-- because it is polymorphic, so application code attaches and removes rows in the same batch as the post.
-- owner_id is NULL while a preview is pending (fetched but not yet saved in a post). A pending row older than seven days is swept.
-- project_id cascades, so a Project hard delete leaves no rows. A Notice board preview has no Project.
-- image_media_id names the preview image in embedded_media (kind preview_image). It is cleared when that row goes, and the card shows no image.
-- requester_id is who asked the server to fetch it, and the per-person limit of 30 fetches an hour is counted from these rows.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
CREATE TABLE link_previews (
  id text PRIMARY KEY NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('project_comment', 'notice_post')),
  owner_id text,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  requester_id text NOT NULL REFERENCES user(id),
  url text NOT NULL,
  title text,
  description text,
  site_name text,
  image_media_id text REFERENCES embedded_media(id) ON DELETE SET NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK ((owner_kind = 'notice_post') = (project_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX link_previews_owner_idx ON link_previews (owner_kind, owner_id);
--> statement-breakpoint
CREATE INDEX link_previews_requester_created_idx ON link_previews (requester_id, created_at);
--> statement-breakpoint
CREATE INDEX link_previews_pending_idx ON link_previews (created_at) WHERE owner_id IS NULL;
--> statement-breakpoint
CREATE INDEX link_previews_project_idx ON link_previews (project_id);
--> statement-breakpoint
CREATE INDEX link_previews_image_idx ON link_previews (image_media_id);
