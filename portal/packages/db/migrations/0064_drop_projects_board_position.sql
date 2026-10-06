-- Board order Stage C (#476): drop projects.board_position. The Board order is derived from data since #470, and Stage B (#475) stopped every read and write of the column.
-- The index goes first because SQLite refuses to drop an indexed column.
-- project_board_order_0037_rollback and its index are NOT touched: board-schema-variant.ts detects the schema by that table, and dropping it puts every gated route into board_schema_maintenance.
-- Rollback floor is the Stage B Worker. Restoring the column is a D1 Time Travel restore.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
DROP INDEX projects_stage_archive_board_order_idx;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN board_position;
