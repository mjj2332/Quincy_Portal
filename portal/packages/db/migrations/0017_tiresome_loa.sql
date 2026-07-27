CREATE TABLE `autohdr_manual_ingest_leases` (
	`mapping_id` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `autohdr_output_mappings`(`id`) ON UPDATE no action ON DELETE cascade
);
