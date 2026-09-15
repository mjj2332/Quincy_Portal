-- Default editors backfill (#135) — dry-run manifest, SELECT only. Not a migration, not mutating.
--
-- Run this first, review every row, and only then run default-editors-backfill.mjs to turn the
-- manifest into an `apply.sql` you actually execute. Before running anything against production:
--   1. Back up first: `wrangler d1 export ...`.
--   2. Get the owner's explicit approval to proceed.
--   3. Dry-run first — this file — and read the output before generating apply.sql.
--   4. apply.sql is idempotent: if a run is interrupted partway through, re-run the SAME
--      apply.sql again rather than regenerating it from a fresh dry-run. Never regenerate
--      mid-run — a fresh dry-run after a partial apply will omit pairs the interrupted run
--      already added, which is correct for a *new* apply.sql but wrong for finishing this one.
--
-- One row per (non-archived project, effective default editor) pair that is not already a
-- project_members 'editor' row, was not manually removed from that project as an editor, and was
-- not already recorded by a prior `project.default_editors.backfilled` audit for that project.
SELECT
  p.id AS project_id,
  p.street AS street,
  u.id AS user_id,
  u.email AS user_email
FROM projects p
JOIN user u
  ON u.default_editor = 1
 AND u.active = 1
 AND u.role IN ('editor', 'external_editor', 'admin')
WHERE p.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_members pm
    WHERE pm.project_id = p.id AND pm.user_id = u.id AND pm.role_on_project = 'editor'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log al
    WHERE al.action = 'project.member.remove'
      AND json_extract(al.meta_json, '$.projectId') = p.id
      AND json_extract(al.meta_json, '$.userId') = u.id
      AND json_extract(al.meta_json, '$.roleOnProject') = 'editor'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log al2, json_each(al2.meta_json, '$.userIds') je
    WHERE al2.action = 'project.default_editors.backfilled'
      AND al2.target_type = 'project'
      AND al2.target_id = p.id
      AND je.value = u.id
  )
ORDER BY p.street, p.id, u.email;
