-- #489 Email digest. Three changes, in this order:
-- 1. notification_preferences gains email_digest_cadence. A bare ADD COLUMN with an inline CHECK, so no
--    table rebuild. Every existing user takes the column default (twice_daily) on deploy by design.
-- 2. notification_digests (one row per recipient per hourly slot, UNIQUE on both, which is the
--    idempotency key) and notification_digest_items (a notification whose email waits for a digest).
--    Item links to notifications and ledger rows are SET NULL, never RESTRICT, because project
--    deletion removes ledger rows first.
-- 3. notification_delivery_ledger.status gains 'deferred'. This reuses the column swap of migration
--    0040 (add a new column with the wider inline CHECK, copy, drop the old column, rename) instead of
--    the table rebuild drizzle-kit would generate, which is the production hazard at docs/lessons.md:27-62.
--    Only the 0031 status index references the old column, so it is dropped first and recreated last.
ALTER TABLE `notification_preferences` ADD COLUMN `email_digest_cadence` text NOT NULL DEFAULT 'twice_daily' CHECK(`email_digest_cadence` IN ('immediate', 'hourly', 'twice_daily', 'daily'));--> statement-breakpoint
CREATE TABLE `notification_digests` (
  `id` text PRIMARY KEY NOT NULL,
  `recipient_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `slot_at` integer NOT NULL,
  `cadence` text NOT NULL,
  `status` text NOT NULL CHECK(`status` IN ('claimed', 'sending', 'sent', 'empty', 'failed', 'unknown', 'released')),
  `item_count` integer NOT NULL DEFAULT 0,
  `project_count` integer NOT NULL DEFAULT 0,
  `email_message_id` text,
  `last_error_code` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `notification_digests_recipient_slot_unique` UNIQUE(`recipient_id`, `slot_at`),
  CONSTRAINT `notification_digests_counts_check` CHECK(`item_count` >= 0 AND `project_count` >= 0)
);--> statement-breakpoint
CREATE INDEX `notification_digests_status_updated_idx` ON `notification_digests` (`status`, `updated_at`);--> statement-breakpoint
CREATE TABLE `notification_digest_items` (
  `id` text PRIMARY KEY NOT NULL,
  `recipient_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `notification_id` text REFERENCES `notifications`(`id`) ON DELETE set null,
  `ledger_id` text REFERENCES `notification_delivery_ledger`(`id`) ON DELETE set null,
  `project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
  `notification_type` text NOT NULL,
  `state` text NOT NULL DEFAULT 'pending' CHECK(`state` IN ('pending', 'sent', 'dropped_read', 'suppressed', 'failed', 'unknown')),
  `outcome_code` text,
  `digest_id` text REFERENCES `notification_digests`(`id`) ON DELETE set null,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `notification_digest_items_notification_unique` UNIQUE(`notification_id`)
);--> statement-breakpoint
CREATE INDEX `notification_digest_items_state_recipient_idx` ON `notification_digest_items` (`state`, `recipient_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `notification_digest_items_digest_idx` ON `notification_digest_items` (`digest_id`);--> statement-breakpoint
DROP INDEX `notification_delivery_ledger_status_updated_idx`;--> statement-breakpoint
ALTER TABLE `notification_delivery_ledger` ADD COLUMN `status_next` text NOT NULL DEFAULT 'pending' CHECK(`status_next` IN ('pending', 'processing', 'sent', 'suppressed', 'failed', 'unknown', 'discarded', 'deferred'));--> statement-breakpoint
UPDATE `notification_delivery_ledger` SET `status_next` = `status`;--> statement-breakpoint
ALTER TABLE `notification_delivery_ledger` DROP COLUMN `status`;--> statement-breakpoint
ALTER TABLE `notification_delivery_ledger` RENAME COLUMN `status_next` TO `status`;--> statement-breakpoint
CREATE INDEX `notification_delivery_ledger_status_updated_idx` ON `notification_delivery_ledger` (`status`, `updated_at`, `id`);
