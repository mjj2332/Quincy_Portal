ALTER TABLE `assets` ADD `section` text;
--> statement-breakpoint
-- Legacy premium assets were sourced from the historical EXTRAS folder.
UPDATE `assets` SET `section` = 'EXTRAS', `is_premium` = 0 WHERE `is_premium` = 1;
