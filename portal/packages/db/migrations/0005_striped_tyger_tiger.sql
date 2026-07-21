CREATE TABLE `document_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`created_by` text NOT NULL,
	`kind` text NOT NULL,
	`version_group_id` text NOT NULL,
	`version` integer NOT NULL,
	`pdf_asset_id` text NOT NULL,
	`pdf_key` text NOT NULL,
	`pdf_filename` text NOT NULL,
	`pdf_bytes` integer NOT NULL,
	`pdf_content_type` text NOT NULL,
	`pdf_upload_id` text,
	`pdf_supersedes_asset_id` text,
	`preview_asset_id` text,
	`preview_key` text,
	`preview_filename` text,
	`preview_bytes` integer,
	`preview_content_type` text,
	`preview_upload_id` text,
	`preview_supersedes_asset_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`completing_at` integer,
	`completed_at` integer,
	`completion_audit_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `document_uploads_status_check` CHECK(`status` IN ('pending', 'completing', 'aborting', 'completed', 'expired', 'failed')),
	CONSTRAINT `document_uploads_kind_preview_check` CHECK((`kind` = 'copy_pdf' AND `preview_asset_id` IS NULL AND `preview_key` IS NULL AND `preview_filename` IS NULL AND `preview_bytes` IS NULL AND `preview_content_type` IS NULL AND `preview_upload_id` IS NULL AND `preview_supersedes_asset_id` IS NULL) OR (`kind` = 'floorplan' AND `preview_asset_id` IS NOT NULL AND `preview_key` IS NOT NULL AND `preview_filename` IS NOT NULL AND `preview_bytes` IS NOT NULL AND `preview_content_type` = 'image/jpeg')),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_uploads_pdf_key_unique` ON `document_uploads` (`pdf_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_uploads_preview_key_unique` ON `document_uploads` (`preview_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_uploads_completion_audit_id_unique` ON `document_uploads` (`completion_audit_id`);--> statement-breakpoint
CREATE INDEX `document_uploads_project_creator_idx` ON `document_uploads` (`project_id`,`created_by`);--> statement-breakpoint
CREATE INDEX `document_uploads_collection_idx` ON `document_uploads` (`collection_id`);--> statement-breakpoint
CREATE INDEX `document_uploads_status_expiry_idx` ON `document_uploads` (`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_uploads_active_group_unique` ON `document_uploads` (`version_group_id`) WHERE `status` IN ('pending', 'completing', 'aborting');--> statement-breakpoint
-- Existing deployments may contain redelivered logical links. Prefer immutable Tonomo rows,
-- then the oldest row. Windowing makes the survivor deterministic before the unique index.
DELETE FROM `collection_links` WHERE rowid IN (
  SELECT rowid FROM (
    SELECT rowid, row_number() OVER (PARTITION BY `collection_id`, `url` ORDER BY CASE `source` WHEN 'tonomo' THEN 0 ELSE 1 END, `created_at`, rowid) AS rn
    FROM `collection_links`
  ) WHERE rn > 1
);--> statement-breakpoint
-- Counts are derived data, including collections that were already stale before dedupe.
UPDATE `collections` SET `received_count` = (SELECT count(*) FROM `collection_links` WHERE `collection_id` = `collections`.`id`) + (SELECT count(*) FROM `assets` WHERE `collection_id` = `collections`.`id`), `status` = CASE WHEN ((SELECT count(*) FROM `collection_links` WHERE `collection_id` = `collections`.`id`) + (SELECT count(*) FROM `assets` WHERE `collection_id` = `collections`.`id`)) > 0 THEN 'received' ELSE 'empty' END, `updated_at` = unixepoch() * 1000;--> statement-breakpoint
CREATE UNIQUE INDEX `collection_links_collection_url_unique` ON `collection_links` (`collection_id`,`url`);
