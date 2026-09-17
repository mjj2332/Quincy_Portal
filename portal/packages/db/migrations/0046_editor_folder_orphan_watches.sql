-- One orphan-upload watch per committed Editor tree move (#195). Replaces the single
-- `editor_folder_mappings.moved_from_path` column, which a second reschedule inside the 30-minute
-- window overwrote, silently dropping the watch on the first old root. A new table, so the
-- 20-table foreign-key rebuild hazard at docs/lessons.md:27-62 never applies.
--
-- `status` is `watching` until the sweep either finds files at `old_path` (then `found`, which
-- stays until an admin acknowledges it — acknowledging deletes the row and writes an audit entry)
-- or the watch lapses empty at `watch_until` (then the row is deleted).
CREATE TABLE `editor_folder_orphan_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`move_revision` integer NOT NULL,
	`old_path` text NOT NULL,
	`old_path_key` text NOT NULL,
	`status` text DEFAULT 'watching' NOT NULL,
	`watch_until` integer NOT NULL,
	`found_at` integer,
	`found_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `editor_folder_mappings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "editor_folder_orphan_watches_status_check" CHECK(`status` IN ('watching', 'found'))
);--> statement-breakpoint
-- A commit replayed for the same revision is a no-op rather than a second (or resurrected) watch.
CREATE UNIQUE INDEX `editor_folder_orphan_watches_mapping_revision_unique` ON `editor_folder_orphan_watches` (`mapping_id`,`move_revision`);--> statement-breakpoint
CREATE INDEX `editor_folder_orphan_watches_status_due_idx` ON `editor_folder_orphan_watches` (`status`,`watch_until`);--> statement-breakpoint
-- Carry any watch still open under the old column across. The revision is the mapping's current
-- one: the column only ever held the latest move's old root. A missing completion time makes the
-- watch due at once rather than never. `lower()` folds ASCII only, unlike the app's
-- `dropboxPathKey`; the key is used only to spot a move back onto the old path, so the cost of a
-- non-ASCII root is at worst one spurious report an admin acknowledges.
INSERT INTO `editor_folder_orphan_watches` (`id`, `mapping_id`, `move_revision`, `old_path`, `old_path_key`, `status`, `watch_until`, `created_at`, `updated_at`)
-- The id is shaped as a v4 UUID, which is what the app's admin routes validate.
SELECT lower(substr(`h`, 1, 8) || '-' || substr(`h`, 9, 4) || '-4' || substr(`h`, 14, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(`h`, 18, 3) || '-' || substr(`h`, 21, 12)),
	`id`, `root_revision`, `moved_from_path`, lower(`moved_from_path`), 'watching',
	COALESCE(`move_completed_at`, 0) + 1800000, unixepoch() * 1000, unixepoch() * 1000
FROM (SELECT hex(randomblob(16)) AS `h`, * FROM `editor_folder_mappings` WHERE `moved_from_path` IS NOT NULL);--> statement-breakpoint
UPDATE `editor_folder_mappings` SET `moved_from_path` = NULL, `move_completed_at` = NULL WHERE `moved_from_path` IS NOT NULL OR `move_completed_at` IS NOT NULL;
