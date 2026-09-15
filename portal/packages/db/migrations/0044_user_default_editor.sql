-- Default editors (#135). A user flagged here is added as an `editor` member of every Project created
-- afterwards (manual create and Tonomo create), while the flag is set, the account is active, and the
-- global role is still editor-eligible (editor, external_editor, admin). Nothing re-adds the membership
-- later, so a default editor removed from one Project stays removed. Existing Projects are not touched
-- by this migration; the one-off backfill is a separate, operator-run script.
ALTER TABLE user ADD COLUMN default_editor integer NOT NULL DEFAULT 0;
