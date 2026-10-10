-- Video Trash schema (#776 slice A). Times are epoch milliseconds. No route reads the new columns yet and nothing is removed.
-- Additive only: ADD COLUMN, one backfill UPDATE and four partial indexes. No table is rebuilt and no PRAGMA is used, so a Worker older than this change ignores every new column and a code rollback is safe.
-- videos.removed_at, removed_by and purge_at mark a removed Video. A live Video has all three NULL. purge_at is frozen when the Video is removed so the days left never shift if the retention changes later.
-- video_version_meta carries the same three columns for a removed Version, plus removed_with_video, which is 1 when the Version was bundled into a Video removal and so comes back with a Video restore. A Version removed on its own keeps its own clock.
-- videos.version_high_water is the highest Version number ever reserved for the Video, so a purged number is never reused. It is backfilled from the highest video-kind Asset sharing version_group_id with the Video id.
-- removed_by is an FK to user(id) added by ALTER. It defaults to NULL as SQLite requires, which also matches the 0069 revoked_by precedent.
-- Every CHECK is single-column, because a cross-column CHECK would need a rebuild and would block a later DROP COLUMN of a column it names. The rule that removed_at, removed_by and purge_at are set together is enforced in the route SQL and pinned by tests in a later slice.
-- Rollback: a code rollback is safe. Dropping the columns means a D1 Time Travel restore, which loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE videos ADD COLUMN removed_at integer CHECK (removed_at IS NULL OR typeof(removed_at) = 'integer');
--> statement-breakpoint
ALTER TABLE videos ADD COLUMN removed_by text REFERENCES user(id);
--> statement-breakpoint
ALTER TABLE videos ADD COLUMN purge_at integer CHECK (purge_at IS NULL OR typeof(purge_at) = 'integer');
--> statement-breakpoint
ALTER TABLE videos ADD COLUMN version_high_water integer NOT NULL DEFAULT 0 CHECK (version_high_water >= 0);
--> statement-breakpoint
UPDATE videos SET version_high_water = COALESCE((SELECT MAX(assets.version) FROM assets WHERE assets.kind = 'video' AND assets.version_group_id = videos.id), 0);
--> statement-breakpoint
ALTER TABLE video_version_meta ADD COLUMN removed_at integer CHECK (removed_at IS NULL OR typeof(removed_at) = 'integer');
--> statement-breakpoint
ALTER TABLE video_version_meta ADD COLUMN removed_by text REFERENCES user(id);
--> statement-breakpoint
ALTER TABLE video_version_meta ADD COLUMN purge_at integer CHECK (purge_at IS NULL OR typeof(purge_at) = 'integer');
--> statement-breakpoint
ALTER TABLE video_version_meta ADD COLUMN removed_with_video integer NOT NULL DEFAULT 0 CHECK (removed_with_video IN (0, 1));
--> statement-breakpoint
CREATE INDEX videos_project_removed_idx ON videos (project_id, removed_at) WHERE removed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX videos_purge_idx ON videos (purge_at) WHERE purge_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX video_version_meta_removed_idx ON video_version_meta (removed_at) WHERE removed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX video_version_meta_purge_idx ON video_version_meta (purge_at) WHERE purge_at IS NOT NULL;
