PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`street` text NOT NULL,
	`suburb` text,
	`postcode` text,
	`agency_name` text,
	`agent_name` text,
	`agent_email` text,
	`agent_phone` text,
	`agency_id` text,
	`agent_id` text,
	`shoot_date` text,
	`time_window` text,
	`stage_key` text DEFAULT 'awaiting_raw' NOT NULL,
	`priority` integer,
	`board_position` real DEFAULT 0 NOT NULL,
	`order_no` text,
	`order_id` text,
	`invoice_amount` real,
	`payment_status` text,
	`notes` text,
	`raw_folder_link` text,
	`raw_folder_path` text,
	`cover_asset_id` text,
	`archived_at` integer,
	`archived_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`archived_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "projects_priority_check" CHECK("__new_projects"."priority" IS NULL OR (typeof("__new_projects"."priority") = 'integer' AND "__new_projects"."priority" >= 1 AND "__new_projects"."priority" <= 10))
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "street", "suburb", "postcode", "agency_name", "agent_name", "agent_email", "agent_phone", "agency_id", "agent_id", "shoot_date", "time_window", "stage_key", "priority", "board_position", "order_no", "order_id", "invoice_amount", "payment_status", "notes", "raw_folder_link", "raw_folder_path", "cover_asset_id", "archived_at", "archived_by", "created_at", "updated_at") SELECT "id", "street", "suburb", "postcode", "agency_name", "agent_name", "agent_email", "agent_phone", "agency_id", "agent_id", "shoot_date", "time_window", "stage_key", NULL, 0, "order_no", "order_id", "invoice_amount", "payment_status", "notes", "raw_folder_link", "raw_folder_path", "cover_asset_id", "archived_at", "archived_by", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `projects_stage_idx` ON `projects` (`stage_key`);--> statement-breakpoint
CREATE INDEX `projects_order_idx` ON `projects` (`order_id`);--> statement-breakpoint
CREATE INDEX `projects_archived_idx` ON `projects` (`archived_at`);
