CREATE TABLE project_activity_events (
  id text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  event_type text NOT NULL,
  category text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_id text,
  occurred_at integer NOT NULL CHECK (typeof(occurred_at) = 'integer'),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_key text NOT NULL,
  safe_payload_json text NOT NULL CHECK (json_valid(safe_payload_json)),
  deep_link_kind text NOT NULL CHECK (deep_link_kind IN ('project', 'project_collaboration')),
  deep_link_path text NOT NULL,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  CHECK (
    (actor_kind = 'user' AND actor_id IS NOT NULL)
    OR (actor_kind = 'system' AND actor_id IS NULL)
  ),
  UNIQUE (event_type, source_key)
);
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN coalesce_key text;
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN coalesce_until integer;
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN recipient_membership_cycle_id text;
--> statement-breakpoint
CREATE INDEX notification_outbox_coalesce_idx
  ON notification_outbox(
    event_type,
    recipient_id,
    recipient_membership_cycle_id,
    coalesce_key,
    coalesce_until
  );
