-- Existing scaffold rows were never validated. Keep them visibly non-current; generators
-- always write image/webp, measured dimensions, and v1 explicitly.
ALTER TABLE `asset_renditions` ADD `content_type` text DEFAULT 'application/octet-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_renditions` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `asset_renditions` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `asset_renditions` ADD `spec_version` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
CREATE INDEX `asset_renditions_current_spec_idx` ON `asset_renditions` (`asset_id`,`spec_version`);
