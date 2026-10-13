-- Review status (#863): the internal review state of each Video Version, in_review by default or approved_internal.
-- Published is never stored here, it is derived from the latest Published set when the Video is read.
-- Every existing Version reads in_review. Additive only with a non-null default, so a Worker older than this change ignores the column and a rollback is safe.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE video_version_meta ADD COLUMN review_status text NOT NULL DEFAULT 'in_review' CHECK (review_status IN ('in_review', 'approved_internal'));
