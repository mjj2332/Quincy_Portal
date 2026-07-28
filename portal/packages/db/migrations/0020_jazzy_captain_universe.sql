ALTER TABLE `projects` ADD COLUMN `priority` integer CHECK("projects"."priority" IS NULL OR (typeof("projects"."priority") = 'integer' AND "projects"."priority" >= 1 AND "projects"."priority" <= 10));--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `board_position` real DEFAULT 0 NOT NULL;
