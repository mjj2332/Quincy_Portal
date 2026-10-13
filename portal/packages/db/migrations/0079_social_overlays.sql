-- Social overlay library (#869): generic 9:16 platform graphics (Instagram Reel, TikTok, YouTube Shorts) an Admin uploads and the Video viewer lays over a Video.
-- The PNG bytes live in R2 at image_key (social-overlays/{id}/{uuid}.png) and the key is never overwritten, so a replace writes a new key and the old one is deleted after commit.
-- image_rev is the row revision: it starts at 1 and every mutation (rename, replace, archive, unarchive) adds 1, so a stale expectedRevision is a 409.
-- is_default marks the one overlay offered when a Project has no other usable one. The first overlay created claims it and a Default is never archived (table CHECK).
-- Names are unique ignoring case. archived_at hides an overlay from pickers while its image stays readable. No trigger and no semicolon inside a comment.
CREATE TABLE social_overlays (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  platform_label text NOT NULL CHECK (length(platform_label) BETWEEN 1 AND 40),
  image_key text NOT NULL,
  image_rev integer NOT NULL DEFAULT 1 CHECK (typeof(image_rev) = 'integer' AND image_rev >= 1),
  width integer NOT NULL CHECK (typeof(width) = 'integer' AND width > 0),
  height integer NOT NULL CHECK (typeof(height) = 'integer' AND height > 0),
  bytes integer NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes > 0),
  is_default integer NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at integer CHECK (archived_at IS NULL OR (typeof(archived_at) = 'integer' AND archived_at >= 0)),
  archived_by text REFERENCES user(id),
  created_by text NOT NULL REFERENCES user(id),
  updated_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
  CHECK (NOT (is_default = 1 AND archived_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX social_overlays_image_key_unique ON social_overlays (image_key);
--> statement-breakpoint
CREATE UNIQUE INDEX social_overlays_default_unique ON social_overlays (is_default) WHERE is_default = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX social_overlays_name_unique ON social_overlays (name COLLATE NOCASE);
