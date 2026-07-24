CREATE TABLE `asset_ingest_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`identity_key` text NOT NULL,
	`asset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_ingest_identities_collection_key_unique` ON `asset_ingest_identities` (`collection_id`,`identity_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_ingest_identities_asset_unique` ON `asset_ingest_identities` (`asset_id`);--> statement-breakpoint
CREATE TABLE `autohdr_fetch_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`mapping_id` text NOT NULL,
	`mapping_generation` integer NOT NULL,
	`connection_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`job_id` text NOT NULL,
	`state` text DEFAULT 'starting' NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`trigger` text NOT NULL,
	`trigger_json` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mapping_id`) REFERENCES `autohdr_output_mappings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_fetch_claims_workflow_id_unique` ON `autohdr_fetch_claims` (`workflow_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_fetch_claims_active_unique` ON `autohdr_fetch_claims` (`project_id`,`mapping_generation`) WHERE "autohdr_fetch_claims"."state" in ('starting', 'running');--> statement-breakpoint
CREATE INDEX `autohdr_fetch_claims_mapping_idx` ON `autohdr_fetch_claims` (`mapping_id`);--> statement-breakpoint
CREATE TABLE `autohdr_final_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`readiness_unit_key` text NOT NULL,
	`match_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_final_associations_unique` ON `autohdr_final_associations` (`handoff_id`,`asset_id`,`readiness_unit_key`);--> statement-breakpoint
CREATE INDEX `autohdr_final_associations_unit_idx` ON `autohdr_final_associations` (`handoff_id`,`readiness_unit_key`);--> statement-breakpoint
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
	`initiated_by` text NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_workflow_id_unique` ON `autohdr_handoffs` (`workflow_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_project_generation_unique` ON `autohdr_handoffs` (`project_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_active_project_unique` ON `autohdr_handoffs` (`project_id`) WHERE "autohdr_handoffs"."state" in ('starting', 'started', 'blocked');--> statement-breakpoint
CREATE INDEX `autohdr_handoffs_connection_idx` ON `autohdr_handoffs` (`connection_id`);--> statement-breakpoint
CREATE TABLE `autohdr_output_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text DEFAULT 'pending_discovery' NOT NULL,
	`final_path` text,
	`final_path_key` text,
	`folder_id` text,
	`diagnostic` text,
	`observed_at` integer,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_output_mappings_handoff_id_unique` ON `autohdr_output_mappings` (`handoff_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_output_mappings_project_generation_unique` ON `autohdr_output_mappings` (`project_id`,`generation`);--> statement-breakpoint
CREATE INDEX `autohdr_output_mappings_connection_state_idx` ON `autohdr_output_mappings` (`connection_id`,`state`);--> statement-breakpoint
CREATE TABLE `autohdr_path_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`candidate` text NOT NULL,
	`path` text NOT NULL,
	`path_key` text NOT NULL,
	`folder_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`diagnostic` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `autohdr_output_mappings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_path_claims_connection_path_unique` ON `autohdr_path_claims` (`connection_id`,`path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_path_claims_mapping_candidate_unique` ON `autohdr_path_claims` (`mapping_id`,`candidate`);--> statement-breakpoint
CREATE INDEX `autohdr_path_claims_handoff_idx` ON `autohdr_path_claims` (`handoff_id`);--> statement-breakpoint
CREATE TABLE `dropbox_monitor_health` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`scope` text NOT NULL,
	`root` text NOT NULL,
	`cursor_fingerprint` text,
	`cursor_updated_at` integer,
	`last_successful_page_at` integer,
	`last_error` text,
	`reset_count` integer DEFAULT 0 NOT NULL,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`routed_project_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dropbox_monitor_health_scope_unique` ON `dropbox_monitor_health` (`connection_id`,`scope`);--> statement-breakpoint
CREATE TABLE `edited_source_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`source_path_key` text NOT NULL,
	`current_asset_id` text,
	`content_hash` text,
	`handoff_id` text,
	`reservation_token` text,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`handoff_id`) REFERENCES `autohdr_handoffs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edited_source_claims_collection_path_unique` ON `edited_source_claims` (`collection_id`,`source_path_key`);--> statement-breakpoint
CREATE INDEX `edited_source_claims_current_asset_idx` ON `edited_source_claims` (`current_asset_id`);--> statement-breakpoint
CREATE TABLE `raw_reconciliation_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_job_id` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_reconciliation_claims_active_unique` ON `raw_reconciliation_claims` (`project_id`) WHERE "raw_reconciliation_claims"."state" = 'running';--> statement-breakpoint
ALTER TABLE `assets` ADD `source_path_key` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `superseded_at` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `replaced_by_asset_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `autohdr_handoff_id` text;--> statement-breakpoint
CREATE INDEX `assets_source_path_key_idx` ON `assets` (`collection_id`,`source_path_key`);--> statement-breakpoint
CREATE INDEX `assets_current_idx` ON `assets` (`collection_id`,`superseded_at`);--> statement-breakpoint
CREATE INDEX `assets_autohdr_handoff_idx` ON `assets` (`autohdr_handoff_id`);