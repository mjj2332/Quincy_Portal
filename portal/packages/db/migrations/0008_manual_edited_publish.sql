ALTER TABLE assets ADD COLUMN publish_status text NOT NULL DEFAULT 'ready';
CREATE INDEX assets_publish_status_idx ON assets (publish_status);

-- One live publisher owns a manual asset at a time. Terminal job rows remain as retry history.
CREATE UNIQUE INDEX jobs_manual_edited_publish_active_unique
  ON jobs (correlation_id)
  WHERE kind = 'manual_edited_publish' AND status IN ('queued', 'running');
