ALTER TABLE user ADD COLUMN banned integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN ban_reason text;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN ban_expires integer;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN impersonated_by text;
--> statement-breakpoint
CREATE TABLE feature_flags (
  key text PRIMARY KEY NOT NULL,
  enabled integer NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by text REFERENCES user(id) ON DELETE set null,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX feature_flags_updated_by_idx ON feature_flags (updated_by);
--> statement-breakpoint
INSERT INTO feature_flags (key, enabled, updated_by, updated_at)
VALUES ('user_impersonation', 0, NULL, unixepoch('now') * 1000);
