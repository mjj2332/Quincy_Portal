-- Project activity provenance (#704, plan #699 ticket 4): which MCP client acted, so the feed can show "via client".
-- via_client is filled in the activity INSERT from the gating audit row's meta_json, and stays NULL for a browser action and for a row written before this change.
-- Additive and nullable, so a Worker older than this change ignores it and a rollback is safe. No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE project_activity_events ADD COLUMN via_client TEXT;
