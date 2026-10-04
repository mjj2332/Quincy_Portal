-- #490 Project activity in Email digests. notification_preferences gains include_project_activity (1 = on, the
-- default, so every existing user keeps receiving Project activity in their digest). A bare ADD COLUMN with an
-- inline CHECK: no table rebuild and no backfill. 0057 is reserved by another open change.
ALTER TABLE `notification_preferences` ADD COLUMN `include_project_activity` integer NOT NULL DEFAULT 1 CHECK(`include_project_activity` IN (0, 1));
