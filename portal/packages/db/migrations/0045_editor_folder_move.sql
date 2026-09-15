-- Additive columns for moving a ready (or hand-linked) Editor tree on a reschedule (#153). No
-- table rebuild: every column below is a bare ALTER TABLE ADD COLUMN, so the 20-table foreign-key
-- rebuild hazard at docs/lessons.md:27-62 never applies here.
ALTER TABLE `editor_folder_mappings` ADD COLUMN `root_revision` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_status` text CHECK(`move_status` IS NULL OR `move_status` IN ('moving', 'blocked'));--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_target_path` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_target_path_key` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_target_shoot_date` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_token` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_expires_at` integer;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_note` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `moved_from_path` text;--> statement-breakpoint
ALTER TABLE `editor_folder_mappings` ADD COLUMN `move_completed_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `editor_folder_mappings_connection_move_target_key_unique` ON `editor_folder_mappings` (`connection_id`,`move_target_path_key`) WHERE `move_target_path_key` IS NOT NULL;