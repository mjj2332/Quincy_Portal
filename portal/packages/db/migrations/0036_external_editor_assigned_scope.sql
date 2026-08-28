ALTER TABLE `projects` ADD COLUMN `production_notes` text;
--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `authorization_epoch` integer NOT NULL DEFAULT 0 CHECK (`authorization_epoch` >= 0);
--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD COLUMN `recipient_authorization_epoch` integer;
--> statement-breakpoint
CREATE TABLE `external_edited_upload_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `collection_id` text NOT NULL REFERENCES `collections`(`id`) ON DELETE cascade,
  `asset_id` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `user`(`id`),
  `membership_cycle_id` text NOT NULL,
  `authorization_epoch` integer NOT NULL CHECK (`authorization_epoch` >= 0),
  `original_filename` text NOT NULL,
  `bytes` integer NOT NULL CHECK (`bytes` > 0 AND `bytes` <= 5368709120),
  `r2_key` text NOT NULL,
  `r2_upload_id` text NOT NULL,
  `part_bytes` integer NOT NULL CHECK (`part_bytes` > 0),
  `part_count` integer NOT NULL CHECK (`part_count` > 0),
  `status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open','completing','completed','aborting','aborted','expired')),
  `completion_lease_token` text,
  `completion_lease_expires_at` integer,
  `expires_at` integer NOT NULL,
  `completed_at` integer,
  `terminal_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (
    (`status`='completing' AND `completion_lease_token` IS NOT NULL AND `completion_lease_expires_at` IS NOT NULL)
    OR (`status`!='completing' AND `completion_lease_token` IS NULL AND `completion_lease_expires_at` IS NULL)
  ),
  CHECK (
    (`status`='completed' AND `completed_at` IS NOT NULL AND `terminal_at` IS NOT NULL)
    OR (`status` IN ('aborted','expired') AND `completed_at` IS NULL AND `terminal_at` IS NOT NULL)
    OR (`status` IN ('open','completing','aborting') AND `completed_at` IS NULL AND `terminal_at` IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE `external_edited_upload_parts` (
  `session_id` text NOT NULL REFERENCES `external_edited_upload_sessions`(`id`) ON DELETE cascade,
  `part_number` integer NOT NULL CHECK (`part_number` > 0),
  `expected_bytes` integer NOT NULL CHECK (`expected_bytes` > 0),
  `received_bytes` integer,
  `etag` text,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','uploading','uploaded')),
  `upload_lease_token` text,
  `upload_lease_expires_at` integer,
  `uploaded_at` integer,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_id`,`part_number`),
  CHECK (
    (`status`='uploading' AND `upload_lease_token` IS NOT NULL AND `upload_lease_expires_at` IS NOT NULL)
    OR (`status`!='uploading' AND `upload_lease_token` IS NULL AND `upload_lease_expires_at` IS NULL)
  ),
  CHECK (
    (`status`='uploaded' AND `received_bytes`=`expected_bytes` AND `etag` IS NOT NULL AND `uploaded_at` IS NOT NULL)
    OR (`status`!='uploaded' AND `etag` IS NULL AND `uploaded_at` IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_edited_upload_sessions_token_hash_idx` ON `external_edited_upload_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `external_edited_upload_sessions_principal_status_idx` ON `external_edited_upload_sessions` (`created_by`,`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `external_edited_upload_sessions_sweep_idx` ON `external_edited_upload_sessions` (`status`,`expires_at`,`completion_lease_expires_at`,`id`);
