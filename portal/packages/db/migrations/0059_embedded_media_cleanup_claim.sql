-- #494 Embedded media cleanup lease. embedded_media_cleanup gains claimed_until, a nullable epoch millisecond.
-- The background sweep claims a queue entry by setting it to now plus a lease, cleans the object, and only then deletes the entry.
-- NULL means unclaimed. A claim that is past its time can be taken again, so a sweep that dies mid-cleanup loses nothing.
-- A bare ADD COLUMN with no default and no backfill: every existing entry is unclaimed.
ALTER TABLE `embedded_media_cleanup` ADD COLUMN `claimed_until` integer;
