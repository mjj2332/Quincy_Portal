CREATE TABLE `rendition_dlq_events` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`received_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `rendition_dlq_events_asset_idx` ON `rendition_dlq_events` (`asset_id`);--> statement-breakpoint
CREATE INDEX `rendition_dlq_events_status_received_idx` ON `rendition_dlq_events` (`status`,`received_at`);