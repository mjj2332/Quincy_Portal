-- Jobs retention (D1 rows-read hygiene): three tables reference jobs.id and none indexed the referencing column. With foreign keys
-- enforced, every deleted jobs row scanned all three, and the retention candidate select probed them the same way.
-- Each index serves both the foreign key check on a jobs delete and the retention guard that asks whether a job is still referenced.
-- Additive only: three CREATE INDEX statements, no rebuild, no trigger and no semicolon inside a comment.
CREATE INDEX autohdr_handoffs_job_idx ON autohdr_handoffs (job_id);
--> statement-breakpoint
CREATE INDEX autohdr_fetch_claims_job_idx ON autohdr_fetch_claims (job_id);
--> statement-breakpoint
CREATE INDEX raw_reconciliation_claims_owner_job_idx ON raw_reconciliation_claims (owner_job_id);
