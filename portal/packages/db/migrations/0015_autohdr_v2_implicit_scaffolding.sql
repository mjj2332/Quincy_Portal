-- Migration 0015: AutoHDR V2 implicit scaffolding and nullable system-initiated handoffs.

CREATE TABLE IF NOT EXISTS `autohdr_scaffold_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`scaffold_path` text NOT NULL,
	`scaffold_path_key` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `autohdr_scaffold_claims_connection_path_key_unique` ON `autohdr_scaffold_claims` (`connection_id`, `scaffold_path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `autohdr_scaffold_claims_active_project_unique` ON `autohdr_scaffold_claims` (`project_id`) WHERE `state` = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `autohdr_scaffold_claims_project_idx` ON `autohdr_scaffold_claims` (`project_id`);--> statement-breakpoint

CREATE TABLE `_bk_autohdr_handoffs` AS SELECT * FROM `autohdr_handoffs`;--> statement-breakpoint
CREATE TABLE `_bk_autohdr_output_mappings` AS SELECT * FROM `autohdr_output_mappings`;--> statement-breakpoint
CREATE TABLE `_bk_autohdr_path_claims` AS SELECT * FROM `autohdr_path_claims`;--> statement-breakpoint
CREATE TABLE `_bk_autohdr_fetch_claims` AS SELECT * FROM `autohdr_fetch_claims`;--> statement-breakpoint
CREATE TABLE `_bk_edited_source_claims` AS SELECT * FROM `edited_source_claims`;--> statement-breakpoint
CREATE TABLE `_bk_autohdr_final_associations` AS SELECT * FROM `autohdr_final_associations`;--> statement-breakpoint

DELETE FROM `autohdr_final_associations`;--> statement-breakpoint
DELETE FROM `autohdr_fetch_claims`;--> statement-breakpoint
DELETE FROM `autohdr_path_claims`;--> statement-breakpoint
DELETE FROM `edited_source_claims`;--> statement-breakpoint
DELETE FROM `autohdr_output_mappings`;--> statement-breakpoint

DROP TABLE `autohdr_handoffs`;--> statement-breakpoint
CREATE TABLE `autohdr_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`generation` integer NOT NULL,
	`manifest_version` integer DEFAULT 1 NOT NULL,
	`selection_hash` text NOT NULL,
	`selected_asset_ids_json` text NOT NULL,
	`readiness_units_json` text NOT NULL,
	`frozen_raw_folder_path` text NOT NULL,
	`initiated_by` text,
	`expected_origin_stage` text DEFAULT 'raw_review' NOT NULL,
	`state` text DEFAULT 'starting' NOT NULL,
	`workflow_id` text NOT NULL,
	`job_id` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`started_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`initiated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_workflow_id_unique` ON `autohdr_handoffs` (`workflow_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_project_generation_unique` ON `autohdr_handoffs` (`project_id`, `generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_active_project_unique` ON `autohdr_handoffs` (`project_id`) WHERE "autohdr_handoffs"."state" in ('starting', 'started', 'blocked');--> statement-breakpoint
CREATE INDEX `autohdr_handoffs_connection_idx` ON `autohdr_handoffs` (`connection_id`);--> statement-breakpoint

INSERT INTO `autohdr_handoffs` SELECT * FROM `_bk_autohdr_handoffs`;--> statement-breakpoint
INSERT INTO `autohdr_output_mappings` SELECT * FROM `_bk_autohdr_output_mappings`;--> statement-breakpoint
INSERT INTO `autohdr_path_claims` SELECT * FROM `_bk_autohdr_path_claims`;--> statement-breakpoint
INSERT INTO `autohdr_fetch_claims` SELECT * FROM `_bk_autohdr_fetch_claims`;--> statement-breakpoint
INSERT INTO `edited_source_claims` SELECT * FROM `_bk_edited_source_claims`;--> statement-breakpoint
INSERT INTO `autohdr_final_associations` SELECT * FROM `_bk_autohdr_final_associations`;--> statement-breakpoint

CREATE TABLE `_migration_assert` (
	`name` text PRIMARY KEY NOT NULL,
	`passed` integer NOT NULL CHECK (`passed` = 1)
);--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_handoffs_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_handoffs`) = (SELECT COUNT(*) FROM `_bk_autohdr_handoffs`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_output_mappings_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_output_mappings`) = (SELECT COUNT(*) FROM `_bk_autohdr_output_mappings`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_path_claims_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_path_claims`) = (SELECT COUNT(*) FROM `_bk_autohdr_path_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_fetch_claims_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_fetch_claims`) = (SELECT COUNT(*) FROM `_bk_autohdr_fetch_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'edited_source_claims_count', CASE WHEN (SELECT COUNT(*) FROM `edited_source_claims`) = (SELECT COUNT(*) FROM `_bk_edited_source_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_final_associations_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_final_associations`) = (SELECT COUNT(*) FROM `_bk_autohdr_final_associations`) THEN 1 ELSE 0 END;--> statement-breakpoint
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'foreign_key_integrity', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM pragma_foreign_key_check();--> statement-breakpoint

DROP TABLE `_migration_assert`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_handoffs`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_output_mappings`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_path_claims`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_fetch_claims`;--> statement-breakpoint
DROP TABLE `_bk_edited_source_claims`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_final_associations`;--> statement-breakpoint
