-- Post-deploy drain for migration 0046 (#195). Run once with `wrangler d1 execute` after the new
-- background worker is live. A move the old worker committed between the migration and that
-- deploy wrote its watch into the retired `moved_from_path` column, which nothing reads now; this
-- copies it into `editor_folder_orphan_watches` and clears the column. Safe to run again: with the
-- column empty it does nothing.
--
-- The revision the old worker moved at is not recorded, and the new worker may already have moved
-- the tree again and written a watch at the current `root_revision`. So the copied watch takes
-- `-root_revision`, which no commit ever writes (revisions start at 1). It stays unique per mapping
-- and still sorts below every later move, so moving the tree back onto that root clears it.
INSERT INTO editor_folder_orphan_watches (id, mapping_id, move_revision, old_path, old_path_key, status, watch_until, created_at, updated_at)
SELECT lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12)),
  id, -root_revision, moved_from_path, lower(moved_from_path), 'watching',
  COALESCE(move_completed_at, 0) + 1800000, unixepoch() * 1000, unixepoch() * 1000
FROM (SELECT hex(randomblob(16)) AS h, * FROM editor_folder_mappings WHERE moved_from_path IS NOT NULL);
UPDATE editor_folder_mappings SET moved_from_path = NULL, move_completed_at = NULL WHERE moved_from_path IS NOT NULL OR move_completed_at IS NOT NULL;
