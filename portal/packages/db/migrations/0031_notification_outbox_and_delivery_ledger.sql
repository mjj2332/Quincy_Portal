CREATE TABLE notification_outbox (
  id text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL,
  event_type text NOT NULL,
  source_key text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  recipient_id text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'queued', 'processing', 'completed',
      'suppressed', 'failed', 'dlq', 'discarded'
    )),
  available_at integer NOT NULL,
  queue_published_at integer,
  lease_token text,
  lease_expires_at integer,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error_code text,
  last_error text,
  completed_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status != 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (event_type, source_key, recipient_id)
);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_available_idx
  ON notification_outbox (status, available_at, created_at, id);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_lease_idx
  ON notification_outbox (status, lease_expires_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_queue_idx
  ON notification_outbox (status, queue_published_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_status_updated_idx
  ON notification_outbox (status, updated_at, id);
--> statement-breakpoint

CREATE TABLE notification_delivery_ledger (
  id text PRIMARY KEY NOT NULL,
  outbox_id text NOT NULL REFERENCES notification_outbox(id) ON DELETE restrict,
  event_type text NOT NULL,
  source_key text NOT NULL,
  recipient_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'sent', 'suppressed',
      'failed', 'unknown', 'discarded'
    )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  notification_id text REFERENCES notifications(id) ON DELETE set null,
  email_message_id text,
  last_error_code text,
  last_error text,
  last_attempt_at integer,
  delivered_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  UNIQUE (outbox_id, channel),
  UNIQUE (event_type, source_key, recipient_id, channel)
);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_outbox_idx
  ON notification_delivery_ledger (outbox_id, channel);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_status_updated_idx
  ON notification_delivery_ledger (status, updated_at, id);
--> statement-breakpoint
CREATE INDEX notification_delivery_ledger_notification_idx
  ON notification_delivery_ledger (notification_id);
