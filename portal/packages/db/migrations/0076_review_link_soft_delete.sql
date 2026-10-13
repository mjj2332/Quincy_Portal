-- Review link soft delete (#846). Additive only: two nullable columns on client_links, no default, no backfill, no rebuild, no PRAGMA, so a Worker older than this change ignores them and a code rollback is safe.
-- deleted_at and deleted_by mark a revoked Review link that staff deleted. The row is never removed: six child tables cascade on client_links, and a hard delete would erase guest notes, approvals and history.
-- Every existing link stays NULL in both columns. A deleted link is always a revoked link, so the guest path needs no new branch.
-- No CHECK can say that deleted_at and deleted_by are written together, or that deleted means revoked: 0069 rules out cross-column CHECKs on client_links. The route SQL enforces both.
-- Rollback: a code rollback is safe. Dropping the columns means a D1 Time Travel restore, which loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE client_links ADD COLUMN deleted_at integer CHECK (deleted_at IS NULL OR typeof(deleted_at) = 'integer');
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN deleted_by text REFERENCES user(id);
