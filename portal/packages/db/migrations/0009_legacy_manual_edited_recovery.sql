-- Temporary, deliberately narrow recovery ownership for legacy manually-uploaded Edited assets.
-- Terminal rows remain as operator/audit history; only queued/running work is single-flight.
CREATE UNIQUE INDEX jobs_legacy_manual_edited_recovery_active_unique
  ON jobs (correlation_id)
  WHERE kind = 'legacy_manual_edited_recovery' AND status IN ('queued', 'running');
