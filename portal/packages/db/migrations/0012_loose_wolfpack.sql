DROP INDEX `jobs_manual_edited_publish_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_manual_upload_publish_active_unique` ON `jobs` (`correlation_id`) WHERE "jobs"."kind" in ('manual_edited_publish', 'manual_raw_publish') and "jobs"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE `assets` ADD `manifest_id` text REFERENCES upload_manifests(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `assets_manifest_idx` ON `assets` (`manifest_id`);--> statement-breakpoint
ALTER TABLE `upload_manifests` ADD `status` text DEFAULT 'active' NOT NULL;
