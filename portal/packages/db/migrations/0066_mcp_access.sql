-- MCP access foundation (#701, plan #699 ticket 1a): the mcp_access feature flag, seeded off, and the mcp_connections record of authority.
-- The flag is operator-owned from the moment it exists, so the seed yields on conflict and never restamps enabled or updated_by.
-- mcp_connections holds one row per consented AI client connection. scopes is a JSON array of read, write and admin. authorization_epoch is the user's epoch at consent. Times are epoch milliseconds.
-- Additive only, so a Worker older than this change ignores both and a rollback is safe. No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 0, NULL, unixepoch('now') * 1000) ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
CREATE TABLE mcp_connections (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_name text NOT NULL,
  redirect_host text NOT NULL,
  scopes text NOT NULL,
  authorization_epoch integer NOT NULL,
  oauth_grant_id text UNIQUE,
  created_at integer NOT NULL,
  last_used_at integer,
  revoked_at integer,
  revoked_by text,
  revoke_reason text
);
--> statement-breakpoint
CREATE INDEX mcp_connections_user_revoked_idx ON mcp_connections (user_id, revoked_at);
--> statement-breakpoint
CREATE INDEX mcp_connections_client_idx ON mcp_connections (client_id);
