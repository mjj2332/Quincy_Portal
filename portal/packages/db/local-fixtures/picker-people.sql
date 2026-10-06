-- LOCAL-ONLY QA fixture for the picker polish pass (#550). NEVER apply to a remote/production D1.
-- Apply:  npm run fixtures:picker-people:apply   (wrangler d1 execute ... --local; see docs/Guides/Local-QA-Fixtures.md)
-- Remove: picker-people-remove.sql, by the fixed `qa550-` ids below.
--
-- CAPABILITY FENCE: every statement is conditional on `__quincy_local_capability`, the table
-- `setup-local.mjs` creates only in a local D1 (the same fence qa-seed uses). Against a database without it
-- (production) each statement dies with `no such table: __quincy_local_capability`; with the table
-- present but the row missing it inserts nothing.
--
-- Two people share the full name "Jordan Lee" (different emails) and two share a long name, so the Team
-- chips show the collision label (name + email) and the long one wraps. One throwaway Project holds all five.
-- Idempotent (INSERT OR IGNORE). One row per statement: local D1 caps compound SELECTs at 5 terms.
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT 'qa550-user-jordan-photo', 'Jordan Lee', 'jordan.lee.photography@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT 'qa550-user-jordan-edit', 'Jordan Lee', 'jordan.lee.editing@qa550.test', 0, 'editor', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT 'qa550-user-alex-photo', 'Alexandria Montgomery-Featherstonehaugh', 'alexandria.montgomery.featherstonehaugh.photography@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT 'qa550-user-alex-edit', 'Alexandria Montgomery-Featherstonehaugh', 'alexandria.montgomery.featherstonehaugh.editing@qa550.test', 0, 'editor', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT 'qa550-user-sam', 'Sam Rivera', 'sam.rivera@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO projects (id, street, suburb, postcode, stage_key, created_at, updated_at)
SELECT 'qa550-project', '550 Picker Polish Street', 'Testville', '2000', 'awaiting_raw', unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT 'qa550-member-jordan-photo', 'qa550-project', 'qa550-user-jordan-photo', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT 'qa550-member-jordan-edit', 'qa550-project', 'qa550-user-jordan-edit', 'editor', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT 'qa550-member-alex-photo', 'qa550-project', 'qa550-user-alex-photo', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT 'qa550-member-alex-edit', 'qa550-project', 'qa550-user-alex-edit', 'editor', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT 'qa550-member-sam', 'qa550-project', 'qa550-user-sam', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
