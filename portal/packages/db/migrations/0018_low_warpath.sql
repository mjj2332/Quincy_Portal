CREATE TABLE `notice_board_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notice_board_posts_created_idx` ON `notice_board_posts` (`created_at`);