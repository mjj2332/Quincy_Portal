-- Project whiteboard media (#501): the embedded media ids each snapshot of a Project's whiteboard references.
-- media_ids is a JSON array of embedded_media ids (the non-deleted Quincy media image elements of the captured scene, sorted and unique).
-- The Durable Object writes it in the same INSERT as the version's index row, so a ready row always carries its list and a pruned row takes it along.
-- The media reconcile after each snapshot reads it with json_each: media referenced by any ready version stays attached, so restoring an old version never finds its images gone.
-- Existing rows default to an empty list, which is correct because image elements were refused by the server until now.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE project_whiteboard_versions ADD COLUMN media_ids text NOT NULL DEFAULT '[]' CHECK (json_valid(media_ids) AND json_type(media_ids) = 'array');
