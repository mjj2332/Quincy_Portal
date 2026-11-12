-- Editor folder recovery sweep (D1 rows-read overage): the minute cron's move select probes jobs by project, kind and a time
-- bound for every ready mapping, and no index served that probe, so each run scanned the whole jobs table once per mapping.
-- jobs_project_kind_created_idx serves the created-in-the-last-10-minutes throttle and latest-job-per-kind readers.
-- jobs_project_status_kind_updated_idx serves the in-flight throttle and the active-job delete guards. Status comes before kind
-- on purpose: the delete guards filter by project and status with no kind. No partial index: a bound status list will not use one.
-- Additive only: two CREATE INDEX statements, no rebuild, no trigger and no semicolon inside a comment.
CREATE INDEX jobs_project_kind_created_idx ON jobs (project_id, kind, created_at);
--> statement-breakpoint
CREATE INDEX jobs_project_status_kind_updated_idx ON jobs (project_id, status, kind, updated_at);
