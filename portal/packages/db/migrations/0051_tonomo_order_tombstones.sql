-- Tonomo order tombstones. Tonomo re-sends a webhook whenever anything changes on an order, and
-- deleting a Project lost its order_id, so the next webhook re-created it. A tombstone records
-- "this order's Project was deleted on purpose" so findProject can ignore the event.
-- Additive: one table plus a seed, no rebuild, no CHECK constraint. Old Workers ignore the table.
-- The column is deleted_project_id (not project_id) because the Project no longer exists: it is a
-- historical value, not a foreign key, and qa-seed-teardown pattern-matches project_id columns.
CREATE TABLE `tonomo_order_tombstones` (`order_id` text PRIMARY KEY NOT NULL, `deleted_project_id` text NOT NULL, `street` text, `deleted_at` integer, `deleted_by` text, `source` text NOT NULL, `created_at` integer NOT NULL);
--> statement-breakpoint
-- Seed from the audit trail: any Project that an audit row tied to a Tonomo order and that no longer
-- exists. The newest audit row wins per order (ORDER BY created_at DESC, INSERT OR IGNORE keeps the
-- first). The project.delete row, when present, supplies street, deleted_at and deleted_by.
INSERT OR IGNORE INTO tonomo_order_tombstones (order_id, deleted_project_id, street, deleted_at, deleted_by, source, created_at)
SELECT CAST(json_extract(a.meta_json,'$.orderId') AS TEXT), a.target_id, json_extract(d.meta_json,'$.street'), d.created_at, d.actor_id, 'migration_0051', CAST(unixepoch('now') AS INTEGER) * 1000
FROM audit_log a LEFT JOIN audit_log d ON d.action='project.delete' AND d.target_type='project' AND d.target_id=a.target_id
WHERE a.target_type='project' AND json_valid(a.meta_json) AND TRIM(COALESCE(CAST(json_extract(a.meta_json,'$.orderId') AS TEXT),'')) != '' AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=a.target_id)
ORDER BY a.created_at DESC;
