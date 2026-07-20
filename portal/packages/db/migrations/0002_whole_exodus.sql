CREATE TABLE `collection_links` (`id` text PRIMARY KEY NOT NULL, `collection_id` text NOT NULL, `url` text NOT NULL, `label` text, `source` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `collection_links_collection_idx` ON `collection_links` (`collection_id`);
