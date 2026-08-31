CREATE INDEX project_activity_events_project_occurred_idx
  ON project_activity_events(project_id, occurred_at DESC, id DESC);
