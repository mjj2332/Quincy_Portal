CREATE TABLE `autohdr_sent_files` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`dropbox_path` text NOT NULL,
	`dropbox_path_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_sent_files_handoff_asset_unique` ON `autohdr_sent_files` (`handoff_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `autohdr_sent_files_handoff_idx` ON `autohdr_sent_files` (`handoff_id`);