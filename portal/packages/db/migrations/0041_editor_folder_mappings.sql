CREATE TABLE `editor_folder_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`root_path` text NOT NULL,
	`root_path_key` text NOT NULL,
	`root_folder_id` text,
	`shoot_date` text NOT NULL,
	`project_folder_name` text NOT NULL,
	`tonomo_raw_folder_path` text,
	`photographer_evidence_json` text NOT NULL,
	`input_roots_json` text DEFAULT '[]' NOT NULL,
	`output_roots_json` text DEFAULT '[]' NOT NULL,
	`editing_notes_path` text NOT NULL,
	`editing_notes_folder_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`recovery_proof_json` text,
	`provision_lease_token` text,
	`provision_lease_expires_at` integer,
	`initial_sync_completed_at` integer,
	`reviewed_at` integer,
	`reviewed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "editor_folder_mappings_state_check" CHECK("editor_folder_mappings"."state" IN ('pending', 'ready', 'needs_review')),
	CONSTRAINT "editor_folder_mappings_input_roots_json_check" CHECK(json_valid("editor_folder_mappings"."input_roots_json")),
	CONSTRAINT "editor_folder_mappings_output_roots_json_check" CHECK(json_valid("editor_folder_mappings"."output_roots_json")),
	CONSTRAINT "editor_folder_mappings_photographer_evidence_json_check" CHECK(json_valid("editor_folder_mappings"."photographer_evidence_json")),
	CONSTRAINT "editor_folder_mappings_recovery_proof_json_check" CHECK("editor_folder_mappings"."recovery_proof_json" IS NULL OR json_valid("editor_folder_mappings"."recovery_proof_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editor_folder_mappings_connection_root_key_unique` ON `editor_folder_mappings` (`connection_id`,`root_path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `editor_folder_mappings_project_unique` ON `editor_folder_mappings` (`project_id`);--> statement-breakpoint
CREATE INDEX `editor_folder_mappings_state_updated_idx` ON `editor_folder_mappings` (`state`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `editor_folder_mappings_connection_state_idx` ON `editor_folder_mappings` (`connection_id`,`state`);
